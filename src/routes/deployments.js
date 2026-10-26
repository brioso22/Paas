import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { requireAuth, flash, httpError } from '../middleware/security.js';
import { can, permsFor } from '../lib/authz.js';
import { withProject } from './projects.js';
import { inspectZip, looksLikeZip, ZipError } from '../lib/zip.js';
import { randomToken } from '../crypto.js';
import { openSse } from '../lib/sse.js';
import { storedLines, FINAL_STATUSES } from '../jobs/queue.js';
import { workspacePaths } from '../services/deployer.js';
import { deploymentsView, deploymentDetailView } from '../views/deployments.js';

const ZIP_MIMES = new Set(['application/zip', 'application/x-zip-compressed', 'application/x-zip', 'application/octet-stream', 'multipart/x-zip']);

/** Despliegues que pueden ser destino de un rollback: con revisión de Helm y la imagen aún presente. */
export function rollbackableIds(db, project, deployments) {
  const pruned = new Set(
    db.prepare("SELECT DISTINCT tag FROM deployments WHERE project_id = ? AND kind = 'build' AND image_pruned = 1").pluck().all(project.id),
  );
  const latestRev = Math.max(0, ...deployments.filter((d) => d.status === 'success' && d.helm_revision).map((d) => d.helm_revision));
  return new Set(
    deployments
      .filter((d) => d.status === 'success' && d.helm_revision && d.helm_revision !== latestRev && d.tag && !pruned.has(d.tag) && d.kind !== 'restart')
      .map((d) => d.id),
  );
}

export function deploymentRoutes(ctx) {
  const { config, db, queue } = ctx;
  const r = Router();
  const load = (action) => withProject(ctx, action);
  const tmpDir = path.join(config.workspacesDir, '.uploads');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

  const upload = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (req, file, cb) => cb(null, `${randomToken(12)}.zip`),
    }),
    limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1, fields: 5, parts: 6, fieldSize: 4096 },
    fileFilter: (req, file, cb) => {
      const okName = /\.zip$/i.test(file.originalname || '');
      if (!okName || !ZIP_MIMES.has(file.mimetype)) return cb(new ZipError('Solo se aceptan archivos .zip'));
      cb(null, true);
    },
  });

  const enqueueBuild = (req, res, project, { params = {}, sourceRef }) => {
    if (queue.hasQueued(project.id, 'build')) {
      flash(req, 'warn', 'Ya hay un build en cola para este proyecto.');
      return res.redirect(`/projects/${project.id}/deployments`);
    }
    const id = queue.enqueue({ projectId: project.id, kind: 'build', triggeredBy: req.user.username, userId: req.user.id, ip: req.ip, sourceRef, params });
    res.redirect(`/deployments/${id}`);
  };

  r.get('/projects/:id/deployments', load('project.view'), (req, res) => {
    const p = req.project;
    const deployments = db.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 50').all(p.id);
    res.page(
      `${p.name} · despliegues`,
      deploymentsView({
        project: p,
        deployments,
        csrfToken: res.locals.csrfToken,
        can: req.can,
        maxUploadMb: config.maxUploadMb,
        rollbackable: rollbackableIds(db, p, deployments),
        hasLastZip: fs.existsSync(workspacePaths(config, p).lastZip),
        webhookUrl: p.source === 'git',
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/deploy/zip', load('project.deploy'), (req, res, next) => {
    const p = req.project;
    if (p.source !== 'zip') return res.errorPage(400, 'Este proyecto se despliega desde git');
    upload.single('archive')(req, res, (err) => {
      const fail = (message) => {
        if (req.file) fs.rmSync(req.file.path, { force: true });
        flash(req, 'error', message);
        res.redirect(`/projects/${p.id}/deployments`);
      };
      if (err instanceof multer.MulterError) {
        return fail(err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera el máximo de ${config.maxUploadMb} MB` : `Subida inválida: ${err.message}`);
      }
      if (err instanceof ZipError) return fail(err.message);
      if (err) return next(err);
      if (!req.file) return fail('Selecciona un archivo .zip');
      try {
        if (!looksLikeZip(req.file.path)) throw new ZipError('El archivo no es un zip válido');
        inspectZip(req.file.path);
      } catch (e) {
        if (e instanceof ZipError) return fail(e.message);
        return next(e);
      }
      const ws = workspacePaths(config, p);
      fs.mkdirSync(ws.uploads, { recursive: true, mode: 0o700 });
      const zipPath = path.join(ws.uploads, path.basename(req.file.path));
      fs.renameSync(req.file.path, zipPath);
      const name = String(req.file.originalname).replace(/[^\w.\- ]/g, '_').slice(0, 100);
      enqueueBuild(req, res, p, { params: { zipPath }, sourceRef: name });
    });
  });

  r.post('/projects/:id/deploy/git', load('project.deploy'), (req, res) => {
    const p = req.project;
    if (p.source !== 'git') return res.errorPage(400, 'Este proyecto se despliega con .zip');
    enqueueBuild(req, res, p, { sourceRef: `${p.branch}` });
  });

  r.post('/projects/:id/deploy/rebuild', load('project.deploy'), (req, res) => {
    const p = req.project;
    if (p.source === 'zip' && !fs.existsSync(workspacePaths(config, p).lastZip)) {
      flash(req, 'error', 'No hay un zip previo; sube uno nuevo.');
      return res.redirect(`/projects/${p.id}/deployments`);
    }
    enqueueBuild(req, res, p, { sourceRef: p.source === 'zip' ? 'source.zip (último)' : p.branch });
  });

  r.post('/projects/:id/deploy/apply', load('project.deploy'), (req, res) => {
    const p = req.project;
    if (!p.current_tag) {
      flash(req, 'error', 'El proyecto aún no tiene una imagen desplegada.');
      return res.redirect(`/projects/${p.id}/deployments`);
    }
    const id = queue.enqueue({ projectId: p.id, kind: 'config', triggeredBy: req.user.username, userId: req.user.id, ip: req.ip, tag: p.current_tag });
    res.redirect(`/deployments/${id}`);
  });

  r.post('/projects/:id/deployments/:depId/rollback', load('project.deploy'), (req, res) => {
    const p = req.project;
    const deployments = db.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 50').all(p.id);
    const target = deployments.find((d) => String(d.id) === String(req.params.depId));
    if (!target || !rollbackableIds(db, p, deployments).has(target.id)) {
      flash(req, 'error', 'Ese despliegue no se puede usar para un rollback.');
      return res.redirect(`/projects/${p.id}/deployments`);
    }
    const id = queue.enqueue({
      projectId: p.id,
      kind: 'rollback',
      triggeredBy: req.user.username,
      userId: req.user.id,
      ip: req.ip,
      tag: target.tag,
      rollbackOf: target.id,
      sourceRef: `rollback a #${target.id} (rev. ${target.helm_revision})`,
    });
    res.redirect(`/deployments/${id}`);
  });

  const loadDeployment = (req, res, next) => {
    const d = /^\d{1,10}$/.test(req.params.id) ? db.prepare('SELECT * FROM deployments WHERE id = ?').get(Number(req.params.id)) : null;
    const project = d && ctx.projects.getFor(d.project_id, req.user);
    // Despliegue de un proyecto ajeno = inexistente.
    if (!project || !can(req.user, 'project.view', project)) return next(httpError(404, 'Despliegue no encontrado'));
    req.deployment = d;
    Object.defineProperty(project, 'can', { value: permsFor(req.user, project), enumerable: false });
    req.project = project;
    next();
  };

  r.get('/deployments/:id', requireAuth, loadDeployment, (req, res) => {
    res.page(`Despliegue #${req.deployment.id}`, deploymentDetailView({ project: req.project, d: req.deployment, queuePosition: queue.position(req.deployment.id) }), {
      active: 'projects',
    });
  });

  r.get('/deployments/:id/stream', requireAuth, loadDeployment, (req, res) => {
    const id = req.deployment.id;
    const sse = openSse(req, res);
    const live = queue.live(id);
    const fresh = () => db.prepare('SELECT status, log FROM deployments WHERE id = ?').get(id);

    if (!live) {
      const d = fresh();
      if (!FINAL_STATUSES.has(d.status)) {
        // En cola: aún no hay buffer en memoria. Se espera a que arranque.
        sse.send('status', d.status);
      } else {
        for (const l of storedLines(d.log)) if (l.seq > sse.lastEventId) sse.send('line', { text: l.text, stream: l.stream }, l.seq);
        sse.send('status', d.status);
        sse.send('end', d.status);
        return sse.end();
      }
    } else {
      sse.send('status', live.status);
      for (const l of live.buffer.linesAfter(sse.lastEventId)) sse.send('line', { text: l.text, stream: l.stream }, l.seq);
      if (FINAL_STATUSES.has(live.status)) {
        sse.send('end', live.status);
        return sse.end();
      }
    }

    const unsubscribe = queue.subscribe(id, (ev) => {
      if (ev.type === 'line') sse.send('line', { text: ev.text, stream: ev.stream }, ev.seq);
      else if (ev.type === 'status') sse.send('status', ev.status);
      else if (ev.type === 'end') {
        sse.send('end', ev.status);
        sse.end();
        unsubscribe();
      }
    });
    sse.onClose(unsubscribe);
  });

  return r;
}
