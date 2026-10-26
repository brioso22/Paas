import { Router } from 'express';
import { flash } from '../middleware/security.js';
import { withProject } from './projects.js';
import { ValidationError } from '../lib/validate.js';
import {
  parseDbForm,
  checkStorageQuota,
  generatePassword,
  renderDbManifest,
  connectionEnv,
  internalHost,
  explainKubeError,
  DB_ENV_KEYS,
} from '../services/databases.js';
import { databaseFootprint } from '../services/users.js';
import { databasesView } from '../views/databases.js';

export function databaseRoutes(ctx) {
  const { kube, projects, databases, queue } = ctx;
  const r = Router();
  const load = (action) => withProject(ctx, action);

  async function render(req, res, status = 200, extra = {}) {
    const p = req.project;
    let statuses;
    try {
      statuses = await kube.databaseStatus(p);
    } catch (err) {
      statuses = { error: err.message.slice(0, 200) };
    }
    res.status(status).page(`${p.name} · bases de datos`, databasesView({ project: p, databases: databases.list(p), statuses, csrfToken: res.locals.csrfToken, can: req.can, ...extra }), {
      active: 'projects',
    });
  }

  r.get('/projects/:id/databases', load('project.view'), (req, res) => render(req, res));

  r.post('/projects/:id/databases', load('db.manage'), async (req, res) => {
    const p = req.project;
    const body = req.body || {};
    let data;
    try {
      data = parseDbForm(body);
      checkStorageQuota(databases.list(p), data.size_gi);
      ctx.users.checkQuota(ctx.users.ownerOf(p.id), databaseFootprint(data));
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return render(req, res, 400, { values: body, error: err.message });
    }
    const existing = new Set(projects.envKeys(p).map((k) => k.key));
    const conflicts = DB_ENV_KEYS.filter((k) => existing.has(k));
    if (conflicts.length && body.confirm_overwrite !== 'on') {
      return render(req, res, 409, { values: body, conflicts, error: 'Confirma que quieres sobrescribir las variables existentes.' });
    }

    const password = generatePassword();
    const rootPassword = data.engine === 'mysql' ? generatePassword() : null;
    // La fila va primero: ensureTenant la usa para ampliar cuota y LimitRange.
    const d = databases.create(p, data, { password, rootPassword });
    try {
      await kube.ensureTenant(p);
      await kube.applyManifest(renderDbManifest(p, d, { password, rootPassword }), { secrets: [password, rootPassword].filter(Boolean) });
    } catch (err) {
      databases.remove(d);
      await kube.ensureTenant(p).catch(() => {});
      ctx.logger.error(`No se pudo crear la BD ${p.name}/${d.name}: ${err.message}`);
      return render(req, res, 502, { values: body, error: `No se pudo crear la base de datos: ${explainKubeError(err.message)}` });
    }

    projects.replaceEnv(p, { set: connectionEnv(p, d, password) });
    ctx.logger.info(`BD ${d.engine} ${p.name}/${d.name} creada por ${req.user.username}`);
    ctx.audit.record(req, 'db.create', { project: p, detail: `${d.name} ${d.engine} ${d.size_gi}Gi` });
    if (p.current_tag) {
      const id = queue.enqueue({ projectId: p.id, kind: 'restart', triggeredBy: req.user.username, userId: req.user.id, ip: req.ip, tag: p.current_tag });
      flash(req, 'success', `Base de datos ${d.name} creada. Reiniciando los pods para inyectar las variables.`);
      return res.redirect(`/deployments/${id}`);
    }
    flash(req, 'success', `Base de datos ${d.name} creada. Las variables se aplicarán en el primer despliegue.`);
    res.redirect(`/projects/${p.id}/databases`);
  });

  r.post('/projects/:id/databases/:dbId/reveal', load('db.manage'), (req, res) => {
    const d = databases.get(req.project, req.params.dbId);
    if (!d) return res.status(404).json({ error: 'No existe' });
    ctx.logger.info(`${req.user.username} reveló la contraseña de la BD ${req.project.name}/${d.name}`);
    ctx.audit.record(req, 'db.reveal', { project: req.project, detail: d.name });
    res.set('Cache-Control', 'no-store').json({ value: databases.password(req.project, d) });
  });

  r.post('/projects/:id/databases/:dbId/delete', load('db.manage'), async (req, res) => {
    const p = req.project;
    const d = databases.get(p, req.params.dbId);
    if (!d) return res.errorPage(404, 'Base de datos no encontrada');
    if ((req.body?.confirm_name || '') !== d.name) {
      flash(req, 'error', 'El nombre de confirmación no coincide; no se eliminó nada.');
      return res.redirect(`/projects/${p.id}/databases`);
    }
    try {
      await kube.deleteDatabase(p, d.name);
    } catch (err) {
      flash(req, 'error', `kubectl falló al borrar: ${err.message}`);
      return res.redirect(`/projects/${p.id}/databases`);
    }
    databases.remove(d);
    // Solo se quitan las variables si siguen apuntando a esta BD.
    let removedEnv = false;
    if (projects.envReveal(p, 'DB_HOST') === internalHost(p, d)) removedEnv = projects.replaceEnv(p, { remove: DB_ENV_KEYS.filter((k) => projects.envReveal(p, k) !== null) });
    await kube.ensureTenant(p).catch((err) => ctx.logger.warn(`No se pudo reducir la cuota de ${p.name}: ${err.message}`));
    ctx.logger.info(`BD ${p.name}/${d.name} eliminada por ${req.user.username}`);
    ctx.audit.record(req, 'db.delete', { project: p, detail: d.name });
    flash(req, 'success', `Base de datos ${d.name} eliminada.${removedEnv ? ' Se quitaron sus variables DB_* del proyecto (se aplicarán en el próximo reinicio o despliegue).' : ''}`);
    res.redirect(`/projects/${p.id}/databases`);
  });

  return r;
}
