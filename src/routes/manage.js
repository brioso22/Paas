import { Router } from 'express';
import { flash } from '../middleware/security.js';
import { withProject } from './projects.js';
import * as v from '../lib/validate.js';
import { parseResources, parseScaling } from '../services/projects.js';
import { coveredByWildcard } from '../services/tls.js';
import { openSse } from '../lib/sse.js';
import { envView, logsView, settingsView, domainsView } from '../views/manage.js';
import { webhookView } from '../views/webhook.js';

const MAX_LOG_STREAMS = 5;

/** urlencoded entrega un string si hay un solo valor y un array si hay varios. */
const list = (x) => (x === undefined ? [] : Array.isArray(x) ? x : [x]);

export function parseEnvForm(body) {
  const set = new Map();
  const remove = list(body.delete).map((k) => v.envName(String(k)));
  const keys = list(body.existing_key);
  const values = list(body.existing_value);
  if (keys.length !== values.length && values.length) throw new v.ValidationError('Formulario de variables inconsistente', 'env');
  keys.forEach((k, i) => {
    const key = v.envName(String(k));
    const val = values[i];
    if (!remove.includes(key) && typeof val === 'string' && val !== '') set.set(key, v.envValue(val, key));
  });
  const newKeys = list(body.new_key);
  const newValues = list(body.new_value);
  newKeys.forEach((k, i) => {
    const key = String(k).trim();
    if (!key) return;
    v.envName(key);
    if (set.has(key) || keys.includes(key)) throw new v.ValidationError(`La variable ${key} ya existe; edítala en su fila`, 'env');
    set.set(key, v.envValue(String(newValues[i] ?? ''), key));
  });
  if (set.size + keys.length > v.LIMITS.envVars + remove.length) throw new v.ValidationError(`Máximo ${v.LIMITS.envVars} variables`, 'env');
  return { set, remove };
}

export function manageRoutes(ctx) {
  const { queue, projects, kube } = ctx;
  const r = Router();
  const load = (action) => withProject(ctx, action);
  let activeLogStreams = 0;

  const back = (req, res, tab) => res.redirect(`/projects/${req.project.id}/${tab}`);
  const onValidation = (req, res, tab, err) => {
    if (!(err instanceof v.ValidationError)) throw err;
    flash(req, 'error', err.message);
    back(req, res, tab);
  };
  const enqueue = (req, kind) =>
    queue.enqueue({ projectId: req.project.id, kind, triggeredBy: req.user.username, userId: req.user.id, ip: req.ip, tag: req.project.current_tag });

  // --- Variables ---------------------------------------------------------------

  r.get('/projects/:id/env', load('project.view'), (req, res) => {
    res.page(
      `${req.project.name} · variables`,
      envView({ project: req.project, keys: projects.envKeys(req.project), csrfToken: res.locals.csrfToken, can: req.can, deployed: Boolean(req.project.current_tag) }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/env', load('env.edit'), (req, res) => {
    const p = req.project;
    let changed, form;
    try {
      form = parseEnvForm(req.body || {});
      changed = projects.replaceEnv(p, form);
    } catch (err) {
      return onValidation(req, res, 'env', err);
    }
    const apply = ['restart', 'redeploy', 'none'].includes(req.body.apply) ? req.body.apply : 'none';
    if (!changed) {
      flash(req, 'info', 'No hubo cambios.');
      return back(req, res, 'env');
    }
    ctx.logger.info(`Variables de ${p.name} modificadas por ${req.user.username}`);
    // Solo nombres: los valores nunca llegan a la auditoría.
    ctx.audit.record(req, 'env.update', { project: p, detail: [...[...form.set.keys()].map((k) => `=${k}`), ...form.remove.map((k) => `-${k}`)].join(' ') });
    if (apply === 'none' || !p.current_tag) {
      flash(req, 'success', 'Variables guardadas. Se aplicarán en el próximo despliegue.');
      return back(req, res, 'env');
    }
    const id = enqueue(req, apply === 'redeploy' ? 'config' : 'restart');
    flash(req, 'success', 'Variables guardadas; aplicando en el clúster.');
    res.redirect(`/deployments/${id}`);
  });

  r.post('/projects/:id/env/:key/reveal', load('env.edit'), (req, res) => {
    if (!v.isEnvName(req.params.key)) return res.status(400).json({ error: 'Nombre inválido' });
    const value = projects.envReveal(req.project, req.params.key);
    if (value === null) return res.status(404).json({ error: 'No existe' });
    ctx.logger.info(`${req.user.username} reveló ${req.project.name}/${req.params.key}`);
    ctx.audit.record(req, 'env.reveal', { project: req.project, detail: req.params.key });
    res.set('Cache-Control', 'no-store').json({ value });
  });

  // --- Logs de pods ------------------------------------------------------------

  r.get('/projects/:id/logs', load('project.view'), (req, res) => {
    res.page(`${req.project.name} · logs`, logsView({ project: req.project }), { active: 'projects' });
  });

  r.get('/projects/:id/logs/stream', load('project.view'), (req, res) => {
    if (activeLogStreams >= MAX_LOG_STREAMS) return res.status(429).json({ error: 'Demasiados streams de logs abiertos' });
    activeLogStreams++;
    const sse = openSse(req, res);
    const ac = new AbortController();
    sse.onClose(() => ac.abort());
    // Cada conexión re-lee las últimas líneas: el cliente limpia lo que tenía.
    sse.send('reset', '');
    let seq = 0;
    kube
      .streamLogs(req.project, { signal: ac.signal, onLine: (text, stream) => sse.send('line', { text, stream }, seq++) })
      .then((r2) => sse.send('end', r2.dryRun ? `DRY_RUN: se ejecutaría kubectl logs -f para ${req.project.namespace}` : 'kubectl logs terminó'))
      .catch((err) => {
        if (!err.aborted) sse.send('end', `Error: ${err.message}`);
      })
      .finally(() => {
        activeLogStreams--;
        sse.end();
      });
  });

  // --- Escalado, HPA, recursos, reinicio --------------------------------------

  r.get('/projects/:id/settings', load('project.view'), (req, res) => {
    res.page(
      `${req.project.name} · ajustes`,
      settingsView({
        project: req.project,
        csrfToken: res.locals.csrfToken,
        can: req.can,
        hasToken: Boolean(req.project.git_token_enc),
      }),
      { active: 'projects' },
    );
  });

  r.get('/projects/:id/domains', load('project.view'), (req, res) => {
    res.page(
      `${req.project.name} · dominios y HTTPS`,
      domainsView({
        project: req.project,
        csrfToken: res.locals.csrfToken,
        can: req.can,
        https: {
          url: projects.httpsUrl(req.project),
          host: projects.host(req.project),
          domain: ctx.config.domain,
          wildcard: coveredByWildcard(projects.hosts(req.project), ctx.config.domain),
        },
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/scale', load('project.settings'), async (req, res) => {
    const p = req.project;
    if (p.autoscaling_enabled) {
      flash(req, 'error', 'El HPA está activo: desactívalo para escalar manualmente.');
      return back(req, res, 'settings');
    }
    let replicas;
    try {
      replicas = v.intInRange(req.body.replicas, 0, v.LIMITS.replicas, 'replicas', 'Réplicas');
      ctx.users.checkProjectChange(p, { replicas });
    } catch (err) {
      return onValidation(req, res, 'settings', err);
    }
    const updated = projects.update(p, { replicas });
    if (p.current_tag) {
      try {
        // La cuota depende de las réplicas: se amplía antes de escalar o el scale se quedaría corto.
        await kube.ensureTenant(updated);
        await kube.scale(updated, replicas);
      } catch (err) {
        flash(req, 'error', `Guardado, pero kubectl falló: ${err.message}`);
        return back(req, res, 'settings');
      }
    }
    ctx.logger.info(`${p.name} escalado a ${replicas} por ${req.user.username}`);
    ctx.audit.record(req, 'project.scale', { project: p, detail: `réplicas=${replicas}` });
    flash(req, 'success', `Réplicas: ${replicas}.${p.current_tag ? '' : ' Se aplicará en el primer despliegue.'}`);
    back(req, res, 'settings');
  });

  r.post('/projects/:id/autoscaling', load('project.settings'), (req, res) => {
    const p = req.project;
    try {
      const scaling = parseScaling({ ...req.body, replicas: p.replicas }, p);
      ctx.users.checkProjectChange(p, scaling);
      projects.update(p, scaling);
      ctx.audit.record(req, 'project.autoscaling', { project: p, detail: scaling.autoscaling_enabled ? `${scaling.autoscaling_min}-${scaling.autoscaling_max}` : 'off' });
    } catch (err) {
      return onValidation(req, res, 'settings', err);
    }
    if (!p.current_tag) {
      flash(req, 'success', 'Autoescalado guardado. Se aplicará en el primer despliegue.');
      return back(req, res, 'settings');
    }
    res.redirect(`/deployments/${enqueue(req, 'config')}`);
  });

  r.post('/projects/:id/resources', load('project.settings'), async (req, res) => {
    const p = req.project;
    let updated;
    try {
      const resources = parseResources(req.body || {}, p);
      ctx.users.checkProjectChange(p, resources);
      updated = projects.update(p, resources);
      ctx.audit.record(req, 'project.resources', { project: p, detail: `${resources.cpu_limit}/${resources.memory_limit}` });
    } catch (err) {
      return onValidation(req, res, 'settings', err);
    }
    if (!p.current_tag) {
      try {
        await kube.ensureTenant(updated);
      } catch (err) {
        flash(req, 'error', `Guardado, pero no se pudo actualizar la cuota: ${err.message}`);
        return back(req, res, 'settings');
      }
      flash(req, 'success', 'Recursos guardados y cuota actualizada.');
      return back(req, res, 'settings');
    }
    res.redirect(`/deployments/${enqueue(req, 'config')}`);
  });

  r.post('/projects/:id/restart', load('project.deploy'), (req, res) => {
    if (!req.project.current_tag) {
      flash(req, 'error', 'El proyecto aún no está desplegado.');
      return back(req, res, 'settings');
    }
    res.redirect(`/deployments/${enqueue(req, 'restart')}`);
  });

  r.post('/projects/:id/git', load('project.settings'), (req, res) => {
    const p = req.project;
    if (p.source !== 'git') return res.errorPage(400, 'El proyecto no usa git');
    try {
      const repo_url = v.gitUrl(String(req.body.repo_url || '').trim());
      const branch = v.branch(String(req.body.branch || '').trim());
      const token = v.gitToken(req.body.git_token);
      projects.update(p, { repo_url, branch });
      if (req.body.clear_token === 'on') projects.setGitToken(p, '');
      else if (token) projects.setGitToken(p, token);
      ctx.audit.record(req, 'project.git', { project: p, detail: `${repo_url} ${branch}${token ? ' (token nuevo)' : ''}` });
    } catch (err) {
      return onValidation(req, res, 'settings', err);
    }
    flash(req, 'success', 'Repositorio actualizado.');
    back(req, res, 'settings');
  });

  // --- Webhook -----------------------------------------------------------------

  r.get('/projects/:id/webhook', load('project.view'), (req, res) => {
    const p = req.project;
    const recent = ctx.db
      .prepare("SELECT id, status, source_ref, created_at FROM deployments WHERE project_id = ? AND triggered_by = 'webhook:github' ORDER BY id DESC LIMIT 10")
      .all(p.id);
    res.page(
      `${p.name} · webhook`,
      webhookView({
        project: p,
        url: `${ctx.config.publicBaseUrl}/hooks/github/${p.id}`,
        csrfToken: res.locals.csrfToken,
        can: req.can,
        recent,
        publicBaseUrl: ctx.config.publicBaseUrl,
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/webhook/reveal', load('webhook.manage'), (req, res) => {
    ctx.logger.info(`${req.user.username} reveló el secreto del webhook de ${req.project.name}`);
    ctx.audit.record(req, 'webhook.reveal', { project: req.project });
    res.set('Cache-Control', 'no-store').json({ value: projects.webhookSecret(req.project) });
  });

  r.post('/projects/:id/webhook/rotate', load('webhook.manage'), (req, res) => {
    projects.rotateWebhookSecret(req.project);
    ctx.logger.info(`${req.user.username} regeneró el secreto del webhook de ${req.project.name}`);
    ctx.audit.record(req, 'webhook.rotate', { project: req.project });
    flash(req, 'success', 'Secreto regenerado. Actualízalo en GitHub.');
    back(req, res, 'webhook');
  });

  return r;
}
