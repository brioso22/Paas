import { Router } from 'express';

/** Endpoint público y deliberadamente parco: no expone versiones ni rutas. */
export function healthRoutes(ctx) {
  const r = Router();
  r.get('/health', (req, res) => {
    let db = 'ok';
    try {
      ctx.db.prepare('SELECT 1').get();
    } catch {
      db = 'error';
    }
    const status = db === 'ok' ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
      status,
      db,
      dryRun: ctx.config.dryRun,
      queue: ctx.queue ? ctx.queue.stats() : undefined,
      uptimeSec: Math.round(process.uptime()),
    });
  });
  return r;
}
