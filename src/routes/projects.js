import { Router } from 'express';
import { requireAuth, requireAdmin, flash } from '../middleware/security.js';
import { ValidationError } from '../lib/validate.js';
import { dashboardView, newProjectView, projectOverviewView } from '../views/projects.js';

/** Carga :id como proyecto o responde 404. */
export function withProject(ctx) {
  return (req, res, next) => {
    const project = ctx.projects.get(req.params.id);
    if (!project) return res.errorPage(404, 'Proyecto no encontrado');
    req.project = project;
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

export function ingressTestCommand(ctx, project) {
  const { ingressIp, ingressNodePort } = ctx.config;
  return `curl -H 'Host: ${ctx.projects.host(project)}' http://${ingressIp}:${ingressNodePort}/`;
}

export function projectRoutes(ctx) {
  const r = Router();
  const load = withProject(ctx);

  r.get('/', requireAuth, async (req, res) => {
    const projects = ctx.projects.list();
    const rows = await Promise.all(
      projects.map(async (project) => ({ project, pods: await safePodStatus(ctx, project), url: ctx.projects.publicUrl(project) })),
    );
    res.page('Proyectos', dashboardView({ rows, isAdmin: req.user.role === 'admin' }), { active: 'projects' });
  });

  r.get('/projects/new', requireAdmin, (req, res) => {
    res.page('Nuevo proyecto', newProjectView({ csrfToken: res.locals.csrfToken, domain: ctx.config.domain }), { active: 'new' });
  });

  r.post('/projects', requireAdmin, async (req, res) => {
    const body = req.body || {};
    let data;
    try {
      data = ctx.projects.parseCreateForm(body);
      if (ctx.projects.getByName(data.name)) throw new ValidationError(`Ya existe un proyecto llamado "${data.name}"`, 'name');
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
    flash(req, 'success', `Proyecto ${project.name} creado. Namespace ${project.namespace} listo.`);
    res.redirect(`/projects/${project.id}`);
  });

  r.get('/projects/:id', requireAuth, load, async (req, res) => {
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
        isAdmin: req.user.role === 'admin',
        publication,
        summary: { urls, databases: ctx.databases.list(p), costHour: metrics.costs.hour, metricsAvailable: metrics.available },
        lastDeployment: ctx.db.prepare('SELECT id, status, created_at FROM deployments WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(p.id),
      }),
      { active: 'projects' },
    );
  });

  r.post('/projects/:id/delete', requireAdmin, load, async (req, res) => {
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
    flash(req, warnings.length ? 'warn' : 'success', `Proyecto ${p.name} eliminado.${warnings.length ? ' Avisos: ' + warnings.join(' | ') : ''}`);
    res.redirect('/');
  });

  return r;
}
