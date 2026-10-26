import { Router } from 'express';
import { requireAuth, requirePermission, flash, httpError } from '../middleware/security.js';
import { can, permsFor } from '../lib/authz.js';
import { projectFootprint } from '../services/users.js';
import { ValidationError } from '../lib/validate.js';
import { dashboardView, newProjectView, projectOverviewView } from '../views/projects.js';

/**
 * Carga :id para el usuario actual y exige `action`. Un proyecto que el usuario no puede
 * ver responde 404 (igual que uno inexistente): así no se filtra qué ids existen.
 */
export function withProject(ctx, action = 'project.view') {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    const project = ctx.projects.getFor(req.params.id, req.user);
    if (!project || !can(req.user, 'project.view', project)) return next(httpError(404, 'Proyecto no encontrado'));
    if (!can(req.user, action, project)) return next(httpError(403, 'No tienes permisos para esta acción en este proyecto'));
    req.can = permsFor(req.user, project);
    // Las vistas (pestañas, botones) preguntan a project.can; no se serializa.
    Object.defineProperty(project, 'can', { value: req.can, enumerable: false });
    req.project = project;
    res.locals.can = req.can;
    next();
  };
}

export async function safePodStatus(ctx, project) {
  try {
    return await ctx.kube.podStatus(project);
  } catch (err) {
    return { error: err.message.slice(0, 200), total: 0, ready: 0, pods: [] };
  }
}

/** Datos de una tarjeta/fila de proyecto (dashboards de cliente y de admin). Nunca lanza. */
export async function projectRow(ctx, project) {
  const [pods, metrics] = await Promise.all([safePodStatus(ctx, project), ctx.metrics.forProject(project)]);
  return {
    project,
    pods,
    url: ctx.projects.publicUrl(project),
    stack: ctx.db.prepare('SELECT stack FROM deployments WHERE project_id = ? AND stack IS NOT NULL ORDER BY id DESC LIMIT 1').pluck().get(project.id) || null,
    lastDeployment: ctx.db.prepare('SELECT id, status, created_at FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(project.id) || null,
    costHour: metrics.costs.hour,
    costs: metrics.costs,
  };
}

export function ingressTestCommand(ctx, project) {
  const { ingressIp, ingressNodePort } = ctx.config;
  return `curl -H 'Host: ${ctx.projects.host(project)}' http://${ingressIp}:${ingressNodePort}/`;
}

export function projectRoutes(ctx) {
  const r = Router();
  const load = (action) => withProject(ctx, action);

  r.get('/', requireAuth, async (req, res) => {
    const projects = ctx.projects.list(req.user);
    const rows = await Promise.all(projects.map((project) => projectRow(ctx, project)));
    res.page('Proyectos', dashboardView({ rows, canCreate: can(req.user, 'project.create') }), { active: 'projects' });
  });

  r.get('/projects/new', requirePermission('project.create'), (req, res) => {
    res.page('Nuevo proyecto', newProjectView({ csrfToken: res.locals.csrfToken, domain: ctx.config.domain }), { active: 'new' });
  });

  r.post('/projects', requirePermission('project.create'), async (req, res) => {
    const body = req.body || {};
    let data;
    try {
      data = ctx.projects.parseCreateForm(body);
      if (ctx.projects.getByName(data.name)) throw new ValidationError(`Ya existe un proyecto llamado "${data.name}"`, 'name');
      ctx.users.checkQuota(req.user, { projects: 1, ...projectFootprint(data) });
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const { git_token, ...values } = body; // nunca se re-renderiza el token
      return res
        .status(400)
        .page('Nuevo proyecto', newProjectView({ csrfToken: res.locals.csrfToken, values, error: err.message, domain: ctx.config.domain }), { active: 'new' });
    }

    const project = ctx.projects.create(data, req.user.id);
    try {
      await ctx.kube.ensureTenant(project);
    } catch (err) {
      // Sin namespace el proyecto no sirve: se revierte para que el usuario pueda reintentar.
      ctx.projects.remove(project);
      ctx.logger.error(`No se pudo crear el namespace de ${project.name}: ${err.message}`);
      return res.status(502).page(
        'Nuevo proyecto',
        newProjectView({
          csrfToken: res.locals.csrfToken,
          values: { ...body, git_token: undefined },
          error: `No se pudo crear el namespace en el clúster: ${err.message}`,
          domain: ctx.config.domain,
        }),
        { active: 'new' },
      );
    }
    ctx.logger.info(`Proyecto ${project.name} creado por ${req.user.username}`);
    ctx.audit.record(req, 'project.create', { project, detail: project.source });
    flash(req, 'success', `Proyecto ${project.name} creado. Namespace ${project.namespace} listo.`);
    res.redirect(`/projects/${project.id}`);
  });

  r.get('/projects/:id', load('project.view'), async (req, res) => {
    const p = req.project;
    const pods = await safePodStatus(ctx, p);
    const [publication, metrics] = await Promise.all([
      ctx.publisher.status(p).catch((err) => ({ exposed: false, url: null, message: err.message })),
      ctx.metrics.forProject(p),
    ]);
    const urls = [
      ctx.projects.publicUrl(p),
      ...(p.tls_enabled ? [ctx.projects.httpsUrl(p)] : []),
      ...(p.custom_domain ? [`${p.tls_enabled ? 'https' : 'http'}://${p.custom_domain}`] : []),
    ];
    res.page(
      p.name,
      projectOverviewView({
        project: p,
        pods,
        url: ctx.projects.publicUrl(p),
        ingressTest: ingressTestCommand(ctx, p),
        csrfToken: res.locals.csrfToken,
        can: req.can,
        publication,
        summary: { urls, databases: ctx.databases.list(p), costHour: metrics.costs.hour, metricsAvailable: metrics.available },
        lastDeployment: ctx.db.prepare('SELECT id, status, created_at FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(p.id),
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/delete', load('project.delete'), async (req, res) => {
    const p = req.project;
    if ((req.body?.confirm_name || '') !== p.name) {
      flash(req, 'error', 'El nombre de confirmación no coincide; no se eliminó nada.');
      return res.redirect(`/projects/${p.id}`);
    }
    let warnings;
    try {
      warnings = await ctx.lifecycle.destroy(p);
    } catch (err) {
      if (err.status !== 409) throw err;
      flash(req, 'error', err.message);
      return res.redirect(`/projects/${p.id}`);
    }
    ctx.logger.info(`Proyecto ${p.name} eliminado por ${req.user.username}`);
    ctx.audit.record(req, 'project.delete', { project: p, detail: warnings.length ? `con ${warnings.length} aviso(s)` : null });
    flash(req, warnings.length ? 'warn' : 'success', `Proyecto ${p.name} eliminado.${warnings.length ? ' Avisos: ' + warnings.join(' | ') : ''}`);
    res.redirect('/');
  });

  return r;
}
