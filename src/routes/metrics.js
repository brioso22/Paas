import { Router } from 'express';
import { requireAuth, requireAdmin, flash } from '../middleware/security.js';
import { withProject } from './projects.js';
import { metricsView, settingsPageView } from '../views/metrics.js';

const MAX_PRICE = 1000;

function parsePrice(v, label) {
  const s = String(v ?? '').trim().replace(',', '.');
  if (!/^\d{1,4}(\.\d{1,6})?$/.test(s) || Number(s) > MAX_PRICE) throw new Error(`${label}: usa un número entre 0 y ${MAX_PRICE} (hasta 6 decimales)`);
  return Number(s);
}

export function metricsRoutes(ctx) {
  const { config, metrics } = ctx;
  const r = Router();
  const load = withProject(ctx);

  r.get('/projects/:id/metrics', requireAuth, load, async (req, res) => {
    const data = await metrics.forProject(req.project);
    res.page(`${req.project.name} · métricas`, metricsView({ project: req.project, data, prometheusUrl: config.prometheusUrl }), { active: 'projects' });
  });

  r.get('/projects/:id/metrics.json', requireAuth, load, async (req, res) => {
    res.json(await metrics.forProject(req.project));
  });

  r.get('/settings', requireAuth, (req, res) => {
    const info = {
      DOMAIN: config.domain,
      CHART_PATH: config.chartPath,
      WORKSPACES_DIR: config.workspacesDir,
      DATA_DIR: config.dataDir,
      INGRESS: `${config.ingressIp}:${config.ingressNodePort}`,
      PROMETHEUS_URL: config.prometheusUrl,
      PUBLIC_BASE_URL: config.publicBaseUrl,
      PUBLISH_PROVIDER: config.publishProvider,
      TENANT_PREFIX: config.tenantPrefix,
      KEEP_IMAGES: config.keepImages,
      MAX_UPLOAD_MB: config.maxUploadMb,
      HELM_TIMEOUT: config.helmTimeout,
      COOKIE_SECURE: config.cookieSecure,
      DRY_RUN: config.dryRun,
    };
    res.page('Ajustes', settingsPageView({ csrfToken: res.locals.csrfToken, isAdmin: req.user.role === 'admin', prices: metrics.prices(), info, user: req.user }), {
      active: 'settings',
    });
  });

  r.post('/settings/prices', requireAdmin, (req, res) => {
    try {
      const cpuHour = parsePrice(req.body.cpu_hour, 'Precio de CPU');
      const ramGbHour = parsePrice(req.body.ram_gb_hour, 'Precio de RAM');
      metrics.setPrices({ cpuHour, ramGbHour });
      ctx.logger.info(`Precios actualizados por ${req.user.username}: cpu=${cpuHour} ram=${ramGbHour}`);
      flash(req, 'success', 'Precios guardados.');
    } catch (err) {
      flash(req, 'error', err.message);
    }
    res.redirect('/settings');
  });

  return r;
}
