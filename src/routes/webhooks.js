import express, { Router } from 'express';
import { createRateLimiter } from '../lib/rateLimit.js';
import { verifyGithubSignature, parseGithubBody, decideGithubEvent } from '../services/webhooks.js';

/**
 * Se monta ANTES de los parsers y de la sesión: necesita el cuerpo crudo para el HMAC
 * y no usa cookies ni CSRF (la autenticación es la firma).
 */
export function webhookRoutes(ctx) {
  const r = Router();
  const failures = createRateLimiter({ max: 30, windowMs: 10 * 60 * 1000 });
  ctx.onClose?.(() => failures.stop());

  r.post('/hooks/github/:projectId', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    const ip = req.ip || 'desconocida';
    if (failures.isBlocked(ip)) return res.status(429).json({ error: 'Demasiadas firmas inválidas' });

    const project = ctx.projects.get(req.params.projectId);
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    // Mismo error para proyecto inexistente y firma inválida: no se revela qué ids existen.
    if (!project || !verifyGithubSignature(ctx.projects.webhookSecret(project), raw, req.get('x-hub-signature-256'))) {
      failures.fail(ip);
      ctx.logger.warn(`Webhook rechazado (firma inválida o proyecto inexistente) id=${String(req.params.projectId).slice(0, 12)} ip=${ip}`);
      return res.status(401).json({ error: 'Firma inválida' });
    }
    if (project.source !== 'git') return res.status(400).json({ error: 'El proyecto no usa git' });

    let payload;
    try {
      payload = parseGithubBody(raw, req.get('content-type') || '');
    } catch {
      return res.status(400).json({ error: 'Cuerpo inválido' });
    }

    const decision = decideGithubEvent(req.get('x-github-event') || '', payload, project);
    if (decision.action === 'pong') return res.json({ ok: true, message: 'pong' });
    if (decision.action === 'ignore') return res.status(202).json({ queued: false, reason: decision.reason });

    if (ctx.queue.hasQueued(project.id, 'build')) return res.status(202).json({ queued: false, reason: 'ya hay un build en cola' });
    const id = ctx.queue.enqueue({
      projectId: project.id,
      kind: 'build',
      triggeredBy: 'webhook:github',
      sourceRef: `${decision.branch}@${decision.commit ? decision.commit.slice(0, 7) : '?'}`,
      params: { commit: decision.commit },
    });
    ctx.logger.info(`Webhook de GitHub: build #${id} encolado para ${project.name}`);
    res.status(202).json({ queued: true, deploymentId: id });
  });

  return r;
}
