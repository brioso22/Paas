import { Router } from 'express';
import { requireAdmin, flash } from '../middleware/security.js';
import * as v from '../lib/validate.js';
import { GLOBAL_ROLES } from '../lib/authz.js';
import { setSetting } from '../db.js';
import { temporaryPassword } from '../services/users.js';
import { usersView, tempPasswordView, auditView, adminDashboardView } from '../views/admin.js';
import { projectRow } from './projects.js';

/** Agrupa el costo de los proyectos por dueño. Los nulos (sin Prometheus) no suman. */
export function billingByOwner(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.project.owner_name || '(sin dueño)';
    const b = by.get(key) || { owner: key, projects: 0, hour: null, last24h: null, projection30d: null };
    b.projects++;
    for (const k of ['hour', 'last24h', 'projection30d']) if (r.costs[k] !== null) b[k] = (b[k] ?? 0) + r.costs[k];
    by.set(key, b);
  }
  return [...by.values()].sort((a, b) => (b.projection30d ?? -1) - (a.projection30d ?? -1));
}

/** Páginas del proveedor. Todas exigen admin.access (404 para el resto). */
export function adminRoutes(ctx) {
  const { users } = ctx;
  const r = Router();
  r.use(['/admin', '/settings'], requireAdmin);

  const listPage = (req, res, status = 200, extra = {}) =>
    res.status(status).page('Usuarios', usersView({ users: users.list(), plans: users.plans(), me: req.user, csrfToken: res.locals.csrfToken, ...extra }), { active: 'admin-users' });

  // La contraseña temporal se muestra una sola vez en la respuesta: nunca va a flash, logs ni auditoría.
  const showTemp = (res, user, password, title) => {
    res.set('Cache-Control', 'no-store');
    res.page(title, tempPasswordView({ user, password }), { active: 'admin-users' });
  };

  const loadUser = (req, res, next) => {
    req.target = users.get(req.params.userId);
    if (!req.target) return res.errorPage(404, 'Usuario no encontrado');
    next();
  };

  // Cerrar sesiones tras desactivar o cambiar el rol: el cambio aplica en la siguiente petición.
  const kick = (user) => ctx.sessionStore?.destroyUser(user.id);

  r.get('/admin', async (req, res) => {
    const projects = ctx.projects.list(req.user);
    const [rows, cluster] = await Promise.all([Promise.all(projects.map((p) => projectRow(ctx, p))), ctx.metrics.cluster()]);
    const podsKnown = rows.filter((r) => !r.pods.error && !r.pods.dryRun);
    const counts = {
      users: ctx.db.prepare('SELECT COUNT(*) FROM users WHERE active = 1').pluck().get(),
      projects: projects.length,
      pods: podsKnown.length ? podsKnown.reduce((n, r) => n + r.pods.total, 0) : null,
      failed24h: ctx.db.prepare("SELECT COUNT(*) FROM deployments WHERE status = 'failed' AND created_at >= datetime('now', '-1 day')").pluck().get(),
    };
    res.page('Panel admin', adminDashboardView({ counts, cluster, rows, billing: billingByOwner(rows), prices: ctx.metrics.prices() }), { active: 'admin' });
  });

  r.get('/admin/users', (req, res) => listPage(req, res));

  r.post('/admin/users', async (req, res) => {
    const { username = '', email = '', role = 'user', plan = 'free' } = req.body || {};
    let created;
    try {
      created = await users.create({ username: String(username).trim(), email, role, planName: plan, createdBy: req.user.id });
    } catch (err) {
      if (!(err instanceof v.ValidationError)) throw err;
      return listPage(req, res, 400, { error: err.message, values: req.body });
    }
    ctx.audit.record(req, 'user.create', { detail: `${created.user.username} rol=${role} plan=${plan}` });
    showTemp(res, created.user, created.password, 'Usuario creado');
  });

  r.post('/admin/users/:userId/active', loadUser, (req, res) => {
    const active = req.body?.active === '1' ? 1 : 0;
    try {
      users.assertKeepsAdmin(req.target, { active });
    } catch (err) {
      flash(req, 'error', err.message);
      return res.redirect('/admin/users');
    }
    users.update(req.target, { active });
    if (!active) kick(req.target);
    ctx.audit.record(req, active ? 'user.activate' : 'user.deactivate', { detail: req.target.username });
    flash(req, 'success', `${req.target.username} ${active ? 'activado' : 'desactivado; sus sesiones se cerraron'}.`);
    res.redirect('/admin/users');
  });

  r.post('/admin/users/:userId/reset', loadUser, async (req, res) => {
    const password = temporaryPassword();
    await users.setPassword(req.target, password, { mustChange: true });
    kick(req.target);
    ctx.audit.record(req, 'user.reset_password', { detail: req.target.username });
    showTemp(res, req.target, password, 'Contraseña restablecida');
  });

  r.post('/admin/users/:userId/role', loadUser, (req, res) => {
    const role = String(req.body?.role || '');
    try {
      if (!GLOBAL_ROLES.includes(role)) throw new v.ValidationError('Rol inválido');
      users.assertKeepsAdmin(req.target, { role });
    } catch (err) {
      flash(req, 'error', err.message);
      return res.redirect('/admin/users');
    }
    if (role !== req.target.role) {
      users.update(req.target, { role });
      kick(req.target);
      ctx.audit.record(req, 'user.role', { detail: `${req.target.username}: ${req.target.role} → ${role}` });
      flash(req, 'success', `${req.target.username} ahora es ${role}; sus sesiones se cerraron.`);
    }
    res.redirect('/admin/users');
  });

  r.post('/admin/users/:userId/plan', loadUser, (req, res) => {
    const plan = users.planByName(String(req.body?.plan || ''));
    if (!plan) {
      flash(req, 'error', 'Plan inválido');
      return res.redirect('/admin/users');
    }
    users.update(req.target, { plan_id: plan.id });
    ctx.audit.record(req, 'user.plan', { detail: `${req.target.username}: ${plan.name}` });
    flash(req, 'success', `${req.target.username} pasa al plan ${plan.name}.`);
    res.redirect('/admin/users');
  });

  r.get('/admin/audit', (req, res) => {
    const filters = {
      username: String(req.query.user || '').slice(0, 64),
      action: String(req.query.action || '').slice(0, 64),
      project: String(req.query.project || '').slice(0, 64),
    };
    res.page('Auditoría', auditView({ result: ctx.audit.query({ ...filters, page: req.query.page }), filters }), { active: 'admin-audit' });
  });

  r.post('/settings/registration', (req, res) => {
    const on = req.body?.allow_registration === 'on';
    setSetting(ctx.db, 'allow_registration', on ? '1' : '0');
    ctx.audit.record(req, 'settings.registration', { detail: on ? 'abierto' : 'cerrado' });
    flash(req, 'success', on ? 'Registro abierto activado (role user, plan free).' : 'Registro abierto desactivado.');
    res.redirect('/settings');
  });

  return r;
}
