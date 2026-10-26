import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth, requireAdmin, flash } from '../middleware/security.js';
import { withProject } from './projects.js';

export function tlsRoutes(ctx) {
  const { tls, projects, queue } = ctx;
  const r = Router();
  const load = withProject(ctx);
  const back = (req, res) => res.redirect(`/projects/${req.project.id}/settings`);
  const redeploy = (req) => queue.enqueue({ projectId: req.project.id, kind: 'config', triggeredBy: req.user.username, userId: req.user.id, tag: req.project.current_tag });

  async function issue(req, res) {
    try {
      const expires = await tls.issue(req.project, projects.hosts(req.project));
      return projects.update(req.project, { tls_expires_at: expires });
    } catch (err) {
      ctx.logger.error(`TLS de ${req.project.name}: ${err.message}`);
      flash(req, 'error', `No se pudo emitir el certificado: ${err.message}`);
      back(req, res);
      return null;
    }
  }

  r.post('/projects/:id/tls/enable', requireAdmin, load, async (req, res) => {
    if (!(await issue(req, res))) return;
    projects.update(req.project, { tls_enabled: 1 });
    ctx.logger.info(`HTTPS activado en ${req.project.name} por ${req.user.username}`);
    if (!req.project.current_tag) {
      flash(req, 'success', 'Certificado emitido. HTTPS se activará en el primer despliegue.');
      return back(req, res);
    }
    res.redirect(`/deployments/${redeploy(req)}`);
  });

  r.post('/projects/:id/tls/renew', requireAdmin, load, async (req, res) => {
    if (!(await issue(req, res))) return;
    // ingress-nginx recarga el Secret por su cuenta: no hace falta redesplegar.
    flash(req, 'success', 'Certificado renovado.');
    back(req, res);
  });

  r.post('/projects/:id/tls/disable', requireAdmin, load, (req, res) => {
    projects.update(req.project, { tls_enabled: 0 });
    if (!req.project.current_tag) {
      flash(req, 'success', 'HTTPS desactivado.');
      return back(req, res);
    }
    res.redirect(`/deployments/${redeploy(req)}`);
  });

  // Solo el certificado público de la CA; la clave nunca sale de DATA_DIR.
  r.get('/tls/ca.crt', requireAuth, (req, res) => {
    if (!tls.caExists()) return res.errorPage(404, 'Aún no se ha generado la CA (activa HTTPS en algún proyecto).');
    res.set({ 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="paas-ca.crt"' });
    res.send(fs.readFileSync(tls.paths.caCert));
  });

  return r;
}
