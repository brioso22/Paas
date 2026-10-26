import fs from 'node:fs';
import { Router } from 'express';
import { requirePermission, flash } from '../middleware/security.js';
import { withProject } from './projects.js';
import { ValidationError } from '../lib/validate.js';

export function tlsRoutes(ctx) {
  const { tls, projects, queue } = ctx;
  const r = Router();
  const load = (action) => withProject(ctx, action);
  const back = (req, res) => res.redirect(`/projects/${req.project.id}/domains`);
  const redeploy = (req) => queue.enqueue({ projectId: req.project.id, kind: 'config', triggeredBy: req.user.username, userId: req.user.id, ip: req.ip, tag: req.project.current_tag });

  async function issue(req, res, { force = false } = {}) {
    try {
      const expires = await tls.issue(req.project, projects.hosts(req.project), { force });
      return projects.update(req.project, { tls_expires_at: expires });
    } catch (err) {
      ctx.logger.error(`TLS de ${req.project.name}: ${err.message}`);
      flash(req, 'error', `No se pudo emitir el certificado: ${err.message}`);
      back(req, res);
      return null;
    }
  }

  r.post('/projects/:id/tls/enable', load('tls.manage'), async (req, res) => {
    if (!(await issue(req, res))) return;
    projects.update(req.project, { tls_enabled: 1 });
    ctx.logger.info(`HTTPS activado en ${req.project.name} por ${req.user.username}`);
    ctx.audit.record(req, 'tls.enable', { project: req.project });
    if (!req.project.current_tag) {
      flash(req, 'success', 'Certificado emitido. HTTPS se activará en el primer despliegue.');
      return back(req, res);
    }
    res.redirect(`/deployments/${redeploy(req)}`);
  });

  r.post('/projects/:id/tls/renew', load('tls.manage'), async (req, res) => {
    if (!(await issue(req, res, { force: true }))) return;
    ctx.audit.record(req, 'tls.renew', { project: req.project });
    // ingress-nginx recarga el Secret por su cuenta: no hace falta redesplegar.
    flash(req, 'success', 'Certificado renovado.');
    back(req, res);
  });

  r.post('/projects/:id/tls/disable', load('tls.manage'), (req, res) => {
    projects.update(req.project, { tls_enabled: 0 });
    ctx.audit.record(req, 'tls.disable', { project: req.project });
    if (!req.project.current_tag) {
      flash(req, 'success', 'HTTPS desactivado.');
      return back(req, res);
    }
    res.redirect(`/deployments/${redeploy(req)}`);
  });

  r.post('/projects/:id/domain', load('tls.manage'), async (req, res) => {
    let domain;
    try {
      domain = projects.checkCustomDomain(req.body?.custom_domain, req.project.id);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      flash(req, 'error', err.message);
      return back(req, res);
    }
    if (domain === (req.project.custom_domain || null)) {
      flash(req, 'info', 'Sin cambios.');
      return back(req, res);
    }
    req.project = projects.update(req.project, { custom_domain: domain });
    // El certificado debe cubrir el host nuevo.
    if (req.project.tls_enabled && !(await issue(req, res))) return;
    ctx.logger.info(`Dominio de ${req.project.name} cambiado a ${domain || '(ninguno)'} por ${req.user.username}`);
    ctx.audit.record(req, 'domain.update', { project: req.project, detail: domain || '(ninguno)' });
    if (!req.project.current_tag) {
      flash(req, 'success', 'Dominio guardado. Se aplicará en el primer despliegue.');
      return back(req, res);
    }
    res.redirect(`/deployments/${redeploy(req)}`);
  });

  // Solo el certificado público de la CA; la clave nunca sale de DATA_DIR.
  r.get('/tls/ca.crt', requirePermission('tls.ca'), (req, res) => {
    if (!tls.caExists()) return res.errorPage(404, 'Aún no se ha generado la CA (activa HTTPS en algún proyecto).');
    res.set({ 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="lisec-ca.crt"' });
    res.send(fs.readFileSync(tls.paths.caCert));
  });

  return r;
}
