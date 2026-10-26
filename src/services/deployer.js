import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { safeExtractZip, projectRoot } from '../lib/zip.js';
import { prepareDockerfile, makeTag } from './builder.js';
import { buildValues, writeValuesFile } from './helm.js';

export function workspacePaths(config, project) {
  const root = path.join(config.workspacesDir, project.name);
  return {
    root,
    src: path.join(root, 'src'),
    uploads: path.join(root, 'uploads'),
    lastZip: path.join(root, 'source.zip'),
    values: path.join(root, 'values.yaml'),
  };
}

/** Petición HTTP al ingress con el Host del proyecto, como haría `curl -H Host:`. */
export function probeIngress({ ip, port, host, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const req = http.request({ host: ip, port, path: '/', method: 'GET', headers: { Host: host }, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500 && res.statusCode !== 404, status: res.statusCode });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

/**
 * Orquesta cada tipo de trabajo de la cola. Recibe la fila de deployments y un `log`
 * que publica en vivo (SSE) y persiste. Todo comando pasa por los servicios → exec.
 */
export function createDeployer(ctx) {
  const { config, db, projects, kube, helm, git, builder } = ctx;
  const setDeployment = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE deployments SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  };

  /** En DRY_RUN helm no devuelve historial: se simula la siguiente revisión para poder probar rollbacks. */
  async function currentRevision(project, log) {
    const revision = await helm.latestRevision(project);
    if (revision || !config.dryRun) return revision;
    const prev = db.prepare('SELECT MAX(helm_revision) FROM deployments WHERE project_id = ?').pluck().get(project.id) || 0;
    log(`[DRY_RUN] Revisión de Helm simulada: ${prev + 1}`, 'meta');
    return prev + 1;
  }

  async function prepareSource(project, dep, params, log) {
    const ws = workspacePaths(config, project);
    fs.rmSync(ws.src, { recursive: true, force: true });
    fs.mkdirSync(ws.root, { recursive: true, mode: 0o700 });

    if (project.source === 'zip') {
      const zipPath = params.zipPath || ws.lastZip;
      if (!fs.existsSync(zipPath)) throw new Error('No hay ningún .zip subido para este proyecto');
      log(`==> Extrayendo ${path.basename(zipPath)}`, 'meta');
      const { files, bytes } = safeExtractZip(zipPath, ws.src);
      log(`${files} archivos, ${(bytes / 1024 / 1024).toFixed(1)} MB descomprimidos`);
      return { dir: projectRoot(ws.src), commit: null, zipPath };
    }

    log(`==> Clonando ${project.repo_url} (rama ${project.branch})`, 'meta');
    await git.clone({ repoUrl: project.repo_url, branch: project.branch, dir: ws.src, token: projects.gitToken(project), onLine: log });
    const commit = (await git.headCommit(ws.src)) || (params.commit ? String(params.commit).slice(0, 7) : null);
    return { dir: ws.src, commit };
  }

  async function pruneImages(project, log) {
    const rows = db
      .prepare(
        `SELECT tag, MAX(id) AS last FROM deployments
         WHERE project_id = ? AND kind = 'build' AND tag IS NOT NULL AND image_pruned = 0
         GROUP BY tag ORDER BY last DESC`,
      )
      .all(project.id);
    const current = projects.get(project.id)?.current_tag;
    const keep = new Set(rows.slice(0, config.keepImages).map((r) => r.tag));
    if (current) keep.add(current);
    const stale = rows.filter((r) => !keep.has(r.tag));
    if (!stale.length) return;
    log(`==> Limpiando ${stale.length} imagen(es) antigua(s) (KEEP_IMAGES=${config.keepImages})`, 'meta');
    for (const { tag } of stale) {
      try {
        await builder.removeImage(project, tag, { onLine: log });
      } catch (err) {
        log(`Aviso: no se pudo borrar ${project.name}:${tag}: ${err.message}`, 'stderr');
      }
      db.prepare("UPDATE deployments SET image_pruned = 1 WHERE project_id = ? AND tag = ? AND kind = 'build'").run(project.id, tag);
    }
  }

  /** Secret + values + helm upgrade. Común a builds nuevos y cambios de configuración. */
  async function release(project, dep, tag, log) {
    log('==> Aplicando namespace, cuota, LimitRange y NetworkPolicy', 'meta');
    await kube.ensureTenant(project, { onLine: log });

    const env = projects.envMap(project);
    log(`==> Actualizando Secret ${project.name}-env (${env.size} variables)`, 'meta');
    await kube.applyEnvSecret(project, env, { onLine: log });

    const ws = workspacePaths(config, project);
    const values = buildValues(project, { tag, host: projects.host(project), envKeys: [...env.keys()] });
    writeValuesFile(ws.values, values);
    log(`==> values.yaml escrito (imagen ${project.name}:${tag}, ${project.autoscaling_enabled ? 'HPA' : project.replicas + ' réplica(s)'})`, 'meta');

    await helm.upgradeInstall(project, ws.values, { onLine: log, secrets: [...env.values()] });
    const revision = await currentRevision(project, log);
    setDeployment(dep.id, { helm_revision: revision, tag });
    projects.update(project, { current_tag: tag, status: 'live' });
    if (revision) log(`Revisión de Helm: ${revision}`);
  }

  async function afterRelease(project, log) {
    const host = projects.host(project);
    if (config.dryRun) {
      log(`[DRY_RUN] Se omitiría la prueba: curl -H 'Host: ${host}' http://${config.ingressIp}:${config.ingressNodePort}/`, 'meta');
    } else {
      const r = await probeIngress({ ip: config.ingressIp, port: config.ingressNodePort, host });
      if (r.ok) log(`==> Ingress responde: HTTP ${r.status} para ${host}`, 'meta');
      else log(`Aviso: el ingress no respondió bien para ${host} (${r.status ? 'HTTP ' + r.status : r.error}). Revisa INGRESS_IP/INGRESS_NODEPORT.`, 'stderr');
    }
    if (ctx.publisher) {
      try {
        const res = await ctx.publisher.expose(project);
        log(`Publicación (${ctx.publisher.name}): ${res.exposed ? `publicado en ${res.url}` : res.message}`);
      } catch (err) {
        // La app ya está desplegada; un fallo al publicar no debe marcar el despliegue como fallido.
        log(`Aviso: la publicación externa falló: ${err.message}`, 'stderr');
      }
    }
  }

  async function buildAndRelease(project, dep, { log, setStatus, params }) {
    const src = await prepareSource(project, dep, params, log);
    const tag = makeTag(src.commit, ctx.now());
    setDeployment(dep.id, { tag, commit_sha: src.commit });

    const empty = !fs.existsSync(src.dir) || fs.readdirSync(src.dir).length === 0;
    if (config.dryRun && empty) {
      log('[DRY_RUN] No hay código clonado: se omite la detección del stack y el Dockerfile', 'meta');
    } else {
      const info = prepareDockerfile(src.dir, { port: project.port });
      setDeployment(dep.id, { stack: info.stack });
      log(`==> Stack detectado: ${info.label}${info.stack === 'dockerfile' ? '' : ' (Dockerfile generado)'}`, 'meta');
    }

    log(`==> Construyendo imagen ${project.name}:${tag}`, 'meta');
    await builder.build(project, tag, src.dir, { onLine: log });

    setStatus('deploying');
    projects.setStatus(project.id, 'deploying');
    await release(project, dep, tag, log);

    const { lastZip } = workspacePaths(config, project);
    if (src.zipPath && src.zipPath !== lastZip) fs.renameSync(src.zipPath, lastZip);
    await pruneImages(project, log);
    await afterRelease(project, log);
  }

  const handlers = {
    async build(project, dep, io) {
      io.setStatus('building');
      projects.setStatus(project.id, 'building');
      try {
        await buildAndRelease(project, dep, io);
      } finally {
        // Un zip de un build fallido no se reutiliza: el último bueno queda en source.zip.
        const z = io.params.zipPath;
        if (z && fs.existsSync(z)) fs.rmSync(z, { force: true });
      }
    },

    async config(project, dep, { log, setStatus }) {
      if (!project.current_tag) throw new Error('El proyecto aún no tiene ninguna imagen desplegada');
      setStatus('deploying');
      projects.setStatus(project.id, 'deploying');
      log(`==> Aplicando configuración sobre la imagen actual ${project.name}:${project.current_tag}`, 'meta');
      await release(project, dep, project.current_tag, log);
      await afterRelease(project, log);
    },

    async restart(project, dep, { log, setStatus }) {
      setStatus('deploying');
      const env = projects.envMap(project);
      log(`==> Actualizando Secret ${project.name}-env (${env.size} variables)`, 'meta');
      await kube.applyEnvSecret(project, env, { onLine: log });
      if (!project.current_tag) {
        log('El proyecto aún no está desplegado: no hay pods que reiniciar');
        return;
      }
      log('==> Reiniciando pods (rollout restart) para que lean las variables nuevas', 'meta');
      await kube.rolloutRestart(project, { onLine: log });
      setDeployment(dep.id, { tag: project.current_tag });
    },

    async rollback(project, dep, { log, setStatus }) {
      const target = db.prepare('SELECT * FROM deployments WHERE id = ? AND project_id = ?').get(dep.rollback_of, project.id);
      if (!target || target.status !== 'success' || !target.helm_revision) throw new Error('El despliegue de destino no tiene una revisión de Helm válida');
      setStatus('deploying');
      projects.setStatus(project.id, 'deploying');
      log(`==> Rollback a la revisión ${target.helm_revision} (imagen ${project.name}:${target.tag})`, 'meta');
      await helm.rollback(project, target.helm_revision, { onLine: log });
      const revision = await currentRevision(project, log);
      setDeployment(dep.id, { helm_revision: revision, tag: target.tag });
      projects.update(project, { current_tag: target.tag, status: 'live' });
      await afterRelease(project, log);
    },
  };

  return async function run(dep, io) {
    const project = projects.get(dep.project_id);
    if (!project) throw new Error('El proyecto ya no existe');
    const handler = handlers[dep.kind];
    if (!handler) throw new Error(`Tipo de trabajo desconocido: ${dep.kind}`);
    io.log(`==> ${dep.kind} #${dep.id} de ${project.name} (disparado por ${dep.triggered_by})${config.dryRun ? ' [DRY_RUN]' : ''}`, 'meta');
    try {
      await handler(project, dep, io);
    } catch (err) {
      const fresh = projects.get(project.id);
      if (fresh) projects.setStatus(project.id, fresh.current_tag ? 'live' : 'failed');
      throw err;
    }
  };
}
