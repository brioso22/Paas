import { Router } from 'express';
import { requireAuth, requireAdmin, flash } from '../middleware/security.js';
import { withProject } from './projects.js';
import * as v from '../lib/validate.js';
import { parseResources, parseScaling } from '../services/projects.js';
import { openSse } from '../lib/sse.js';
import { envView, logsView, settingsView } from '../views/manage.js';
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
  const load = withProject(ctx);
  let activeLogStreams = 0;

  const back = (req, res, tab) => res.redirect(`/projects/${req.project.id}/${tab}`);
  const onValidation = (req, res, tab, err) => {
    if (!(err instanceof v.ValidationError)) throw err;
    flash(req, 'error', err.message);
    back(req, res, tab);
  };
  const enqueue = (req, kind) =>
    queue.enqueue({ projectId: req.project.id, kind, triggeredBy: req.user.username, userId: req.user.id, tag: req.project.current_tag });

  // --- Variables ---------------------------------------------------------------

  r.get('/projects/:id/env', requireAuth, load, (req, res) => {
    res.page(
      `${req.project.name} · variables`,
      envView({ project: req.project, keys: projects.envKeys(req.project), csrfToken: res.locals.csrfToken, isAdmin: req.user.role === 'admin', deployed: Boolean(req.project.current_tag) }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/env', requireAdmin, load, (req, res) => {
    const p = req.project;
    let changed;
    try {
      changed = projects.replaceEnv(p, parseEnvForm(req.body || {}));
    } catch (err) {
      return onValidation(req, res, 'env', err);
    }
    const apply = ['restart', 'redeploy', 'none'].includes(req.body.apply) ? req.body.apply : 'none';
    if (!changed) {
      flash(req, 'info', 'No hubo cambios.');
      return back(req, res, 'env');
    }
    ctx.logger.info(`Variables de ${p.name} modificadas por ${req.user.username}`);
    if (apply === 'none' || !p.current_tag) {
      flash(req, 'success', 'Variables guardadas. Se aplicarán en el próximo despliegue.');
      return back(req, res, 'env');
    }
    const id = enqueue(req, apply === 'redeploy' ? 'config' : 'restart');
    flash(req, 'success', 'Variables guardadas; aplicando en el clúster.');
    res.redirect(`/deployments/${id}`);
  });

  r.post('/projects/:id/env/:key/reveal', requireAdmin, load, (req, res) => {
    if (!v.isEnvName(req.params.key)) return res.status(400).json({ error: 'Nombre inválido' });
    const value = projects.envReveal(req.project, req.params.key);
    if (value === null) return res.status(404).json({ error: 'No existe' });
    ctx.logger.info(`${req.user.username} reveló ${req.project.name}/${req.params.key}`);
    res.set('Cache-Control', 'no-store').json({ value });
  });

  // --- Logs de pods ------------------------------------------------------------

  r.get('/projects/:id/logs', requireAuth, load, (req, res) => {
    res.page(`${req.project.name} · logs`, logsView({ project: req.project }), { active: 'projects' });
  });

  r.get('/projects/:id/logs/stream', requireAuth, load, (req, res) => {
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

  r.get('/projects/:id/settings', requireAuth, load, (req, res) => {
    res.page(
      `${req.project.name} · ajustes`,
      settingsView({
        project: req.project,
        csrfToken: res.locals.csrfToken,
        isAdmin: req.user.role === 'admin',
        hasToken: Boolean(req.project.git_token_enc),
        https: { url: projects.httpsUrl(req.project), nodePort: ctx.config.ingressHttpsNodePort, ingressIp: ctx.config.ingressIp, host: projects.host(req.project) },
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/scale', requireAdmin, load, async (req, res) => {
    const p = req.project;
    if (p.autoscaling_enabled) {
      flash(req, 'error', 'El HPA está activo: desactívalo para escalar manualmente.');
      return back(req, res, 'settings');
    }
    let replicas;
    try {
      replicas = v.intInRange(req.body.replicas, 0, v.LIMITS.replicas, 'replicas', 'Réplicas');
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
    flash(req, 'success', `Réplicas: ${replicas}.${p.current_tag ? '' : ' Se aplicará en el primer despliegue.'}`);
    back(req, res, 'settings');
  });

  r.post('/projects/:id/autoscaling', requireAdmin, load, (req, res) => {
    const p = req.project;
    try {
      projects.update(p, parseScaling({ ...req.body, replicas: p.replicas }, p));
    } catch (err) {
      return onValidation(req, res, 'settings', err);
    }
    if (!p.current_tag) {
      flash(req, 'success', 'Autoescalado guardado. Se aplicará en el primer despliegue.');
      return back(req, res, 'settings');
    }
    res.redirect(`/deployments/${enqueue(req, 'config')}`);
  });

  r.post('/projects/:id/resources', requireAdmin, load, async (req, res) => {
    const p = req.project;
    let updated;
    try {
      updated = projects.update(p, parseResources(req.body || {}, p));
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

  r.post('/projects/:id/restart', requireAdmin, load, (req, res) => {
    if (!req.project.current_tag) {
      flash(req, 'error', 'El proyecto aún no está desplegado.');
      return back(req, res, 'settings');
    }
    res.redirect(`/deployments/${enqueue(req, 'restart')}`);
  });

  r.post('/projects/:id/git', requireAdmin, load, (req, res) => {
    const p = req.project;
    if (p.source !== 'git') return res.errorPage(400, 'El proyecto no usa git');
    try {
      const repo_url = v.gitUrl(String(req.body.repo_url || '').trim());
      const branch = v.branch(String(req.body.branch || '').trim());
      const token = v.gitToken(req.body.git_token);
      projects.update(p, { repo_url, branch });
      if (req.body.clear_token === 'on') projects.setGitToken(p, '');
      else if (token) projects.setGitToken(p, token);
    } catch (err) {
      return onValidation(req, res, 'settings', err);
    }
    flash(req, 'success', 'Repositorio actualizado.');
    back(req, res, 'settings');
  });

  // --- Webhook -----------------------------------------------------------------

  r.get('/projects/:id/webhook', requireAuth, load, (req, res) => {
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
        isAdmin: req.user.role === 'admin',
        recent,
        publicBaseUrl: ctx.config.publicBaseUrl,
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/webhook/reveal', requireAdmin, load, (req, res) => {
    ctx.logger.info(`${req.user.username} reveló el secreto del webhook de ${req.project.name}`);
    res.set('Cache-Control', 'no-store').json({ value: projects.webhookSecret(req.project) });
  });

  r.post('/projects/:id/webhook/rotate', requireAdmin, load, (req, res) => {
    projects.rotateWebhookSecret(req.project);
    ctx.logger.info(`${req.user.username} regeneró el secreto del webhook de ${req.project.name}`);
    flash(req, 'success', 'Secreto regenerado. Actualízalo en GitHub.');
    back(req, res, 'webhook');
  });

  return r;
}
