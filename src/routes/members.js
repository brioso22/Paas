import { Router } from 'express';
import { flash } from '../middleware/security.js';
import { withProject } from './projects.js';
import { membersView, activityView } from '../views/members.js';

const INVITE_ROLES = ['deployer', 'viewer'];

export function memberRoutes(ctx) {
  const { projects, users } = ctx;
  const r = Router();
  const load = (action) => withProject(ctx, action);
  const back = (req, res) => res.redirect(`/projects/${req.project.id}/members`);

  r.get('/projects/:id/members', load('project.view'), (req, res) => {
    res.page(`${req.project.name} · miembros`, membersView({ project: req.project, members: projects.members(req.project), csrfToken: res.locals.csrfToken, can: req.can }), {
      active: 'projects',
    });
  });

  r.post('/projects/:id/members', load('members.manage'), (req, res) => {
    const p = req.project;
    const role = String(req.body?.role || '');
    const target = users.getByUsername(String(req.body?.username || '').trim());
    if (!INVITE_ROLES.includes(role)) flash(req, 'error', 'Rol inválido: deployer o viewer.');
    else if (!target || !target.active) flash(req, 'error', 'No existe ningún usuario activo con ese nombre.');
    else if (projects.members(p).some((m) => m.user_id === target.id)) flash(req, 'error', `${target.username} ya es miembro; cambia su rol en la tabla.`);
    else if (target.role === 'viewer' && role !== 'viewer') flash(req, 'error', `${target.username} es un usuario de solo lectura: solo puede ser viewer.`);
    else {
      projects.setMember(p, target.id, role);
      ctx.audit.record(req, 'member.add', { project: p, detail: `${target.username} como ${role}` });
      flash(req, 'success', `${target.username} añadido como ${role}.`);
    }
    back(req, res);
  });

  const loadMember = (req, res, next) => {
    req.member = projects.members(req.project).find((m) => String(m.user_id) === String(req.params.userId));
    if (!req.member) return res.errorPage(404, 'Miembro no encontrado');
    if (req.member.role === 'owner') {
      flash(req, 'error', 'El owner no se puede quitar ni cambiar de rol.');
      return back(req, res);
    }
    next();
  };

  r.post('/projects/:id/members/:userId/role', load('members.manage'), loadMember, (req, res) => {
    const role = String(req.body?.role || '');
    if (!INVITE_ROLES.includes(role) || (req.member.global_role === 'viewer' && role !== 'viewer')) {
      flash(req, 'error', 'Rol no permitido para este usuario.');
      return back(req, res);
    }
    projects.setMember(req.project, req.member.user_id, role);
    ctx.audit.record(req, 'member.role', { project: req.project, detail: `${req.member.username}: ${req.member.role} → ${role}` });
    flash(req, 'success', `${req.member.username} ahora es ${role}.`);
    back(req, res);
  });

  r.post('/projects/:id/members/:userId/remove', load('members.manage'), loadMember, (req, res) => {
    projects.removeMember(req.project, req.member.user_id);
    ctx.audit.record(req, 'member.remove', { project: req.project, detail: req.member.username });
    flash(req, 'success', `${req.member.username} ya no tiene acceso a ${req.project.name}.`);
    back(req, res);
  });

  r.get('/projects/:id/activity', load('project.audit'), (req, res) => {
    const result = ctx.audit.query({ projectId: req.project.id, page: req.query.page });
    res.page(`${req.project.name} · actividad`, activityView({ project: req.project, result }), { active: 'projects' });
  });

  return r;
}
