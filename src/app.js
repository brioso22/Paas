import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { SqliteSessionStore } from './lib/sessionStore.js';
import { csrfProtection, loadUser, takeFlash } from './middleware/security.js';
import { layout, errorPage } from './views/layout.js';
import { authRoutes } from './routes/auth.js';
import { healthRoutes } from './routes/health.js';
import { projectRoutes } from './routes/projects.js';
import { deploymentRoutes } from './routes/deployments.js';
import { manageRoutes } from './routes/manage.js';
import { webhookRoutes } from './routes/webhooks.js';
import { metricsRoutes } from './routes/metrics.js';
import { databaseRoutes } from './routes/databases.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SESSION_COOKIE = 'paas.sid';

export function createApp(ctx) {
  const { config, db } = ctx;
  const app = express();
  ctx.sessionCookieName = SESSION_COOKIE;

  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          objectSrc: ["'none'"],
          // Sin HTTPS, upgrade-insecure-requests rompería la carga de CSS/JS por la IP de Tailscale.
          ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      strictTransportSecurity: config.cookieSecure ? { maxAge: 15552000 } : false,
      referrerPolicy: { policy: 'no-referrer' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: false }));

  app.use(healthRoutes(ctx));
  // Los webhooks necesitan el cuerpo crudo para verificar la firma HMAC: van antes de los parsers.
  app.use(webhookRoutes(ctx));

  app.use(express.urlencoded({ extended: false, limit: '256kb', parameterLimit: 1000 }));
  app.use(express.json({ limit: '256kb' }));

  const store = new SqliteSessionStore(db, { ttlMs: config.sessionMaxAgeMs });
  ctx.onClose?.(() => store.close());
  ctx.sessionStore = store;
  app.use(
    session({
      name: SESSION_COOKIE,
      secret: config.sessionSecret,
      store,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.cookieSecure,
        maxAge: config.sessionMaxAgeMs,
      },
    }),
  );

  app.use(loadUser(db));
  app.use(takeFlash);

  // Helpers de render: todas las páginas pasan por el layout con el usuario y el token CSRF.
  app.use((req, res, next) => {
    res.page = (title, body, opts = {}) =>
      res.type('html').send(
        String(
          layout({
            title,
            body,
            user: req.user,
            csrfToken: res.locals.csrfToken,
            flash: res.locals.flash,
            dryRun: config.dryRun,
            active: opts.active,
          }),
        ),
      );
    res.errorPage = (status, message) => res.status(status).page(`Error ${status}`, errorPage({ status, message }));
    next();
  });

  app.use(csrfProtection());

  app.use(authRoutes(ctx));
  app.use(projectRoutes(ctx));
  app.use(deploymentRoutes(ctx));
  app.use(manageRoutes(ctx));
  app.use(metricsRoutes(ctx));
  app.use(databaseRoutes(ctx));

  app.use((req, res) => {
    if ((req.get('accept') || '').includes('application/json')) return res.status(404).json({ error: 'No encontrado' });
    res.errorPage(404, 'Página no encontrada');
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) ctx.logger.error(err);
    const message = status >= 500 && !config.isDev ? 'Error interno del servidor' : err.message;
    if (res.headersSent) return res.end();
    if (typeof res.page !== 'function' || (req.get('accept') || '').includes('application/json') || req.path.endsWith('.json'))
      return res.status(status).json({ error: message });
    if (!res.locals.csrfToken && req.session) res.locals.csrfToken = req.session.csrfToken;
    res.errorPage(status, message);
  });

  return app;
}
