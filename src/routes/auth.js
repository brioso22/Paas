import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as v from '../lib/validate.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { setupView, loginView } from '../views/auth.js';

const BCRYPT_COST = 12;
// Hash fijo para comparar cuando el usuario no existe y no revelar su existencia por timing.
const DUMMY_HASH = bcrypt.hashSync('usuario-inexistente', BCRYPT_COST);

function safeNext(next) {
  return typeof next === 'string' && /^\/(?![\/\\])[\w\-\/.?=&%]*$/.test(next) ? next : '/';
}

export function authRoutes(ctx) {
  const { db } = ctx;
  const r = Router();
  const byIp = createRateLimiter({ max: 20, windowMs: 15 * 60 * 1000 });
  const byUser = createRateLimiter({ max: 5, windowMs: 15 * 60 * 1000 });
  ctx.onClose?.(() => (byIp.stop(), byUser.stop()));

  const userCount = () => db.prepare('SELECT COUNT(*) FROM users').pluck().get();

  r.get('/setup', (req, res) => {
    if (userCount() > 0) return res.errorPage(404, 'Página no encontrada');
    res.page('Configuración inicial', setupView({ csrfToken: res.locals.csrfToken }));
  });

  r.post('/setup', async (req, res) => {
    if (userCount() > 0) return res.errorPage(404, 'Página no encontrada');
    const { username = '', password = '', password2 = '' } = req.body || {};
    try {
      v.username(username);
      v.password(password);
      if (password !== password2) throw new v.ValidationError('Las contraseñas no coinciden');
    } catch (err) {
      return res.status(400).page('Configuración inicial', setupView({ csrfToken: res.locals.csrfToken, error: err.message, username }));
    }
    const hash = await bcrypt.hash(password, BCRYPT_COST);
    // Se vuelve a comprobar dentro de la transacción: dos peticiones simultáneas no pueden crear dos admins.
    const created = db.transaction(() => {
      if (userCount() > 0) return null;
      return db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(username, hash).lastInsertRowid;
    })();
    if (!created) return res.errorPage(404, 'Página no encontrada');
    ctx.logger.info(`Administrador "${username}" creado desde /setup`);
    req.session.regenerate((err) => {
      if (err) return res.errorPage(500, 'No se pudo iniciar la sesión');
      req.session.userId = Number(created);
      res.redirect('/');
    });
  });

  r.get('/login', (req, res) => {
    if (userCount() === 0) return res.redirect('/setup');
    if (req.user) return res.redirect('/');
    res.page('Iniciar sesión', loginView({ csrfToken: res.locals.csrfToken, next: safeNext(req.query.next) }));
  });

  r.post('/login', async (req, res) => {
    const { username = '', password = '', next = '/' } = req.body || {};
    const ipKey = req.ip || 'desconocida';
    const userKey = String(username).toLowerCase().slice(0, 64);
    const render = (status, error) =>
      res.status(status).page('Iniciar sesión', loginView({ csrfToken: res.locals.csrfToken, error, username: String(username).slice(0, 32), next: safeNext(next) }));

    if (byIp.isBlocked(ipKey) || byUser.isBlocked(userKey)) {
      const wait = Math.max(byIp.retryAfterSec(ipKey), byUser.retryAfterSec(userKey));
      res.set('Retry-After', String(wait));
      return render(429, `Demasiados intentos. Espera ${Math.ceil(wait / 60)} min.`);
    }

    const user = typeof username === 'string' ? db.prepare('SELECT * FROM users WHERE username = ?').get(username) : null;
    const ok = await bcrypt.compare(typeof password === 'string' ? password : '', user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) {
      byIp.fail(ipKey);
      byUser.fail(userKey);
      ctx.logger.warn(`Login fallido para "${userKey}" desde ${ipKey}`);
      return render(401, 'Usuario o contraseña incorrectos');
    }
    byUser.reset(userKey);
    // Regenerar evita fijación de sesión.
    req.session.regenerate((err) => {
      if (err) return render(500, 'No se pudo iniciar la sesión');
      req.session.userId = user.id;
      db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(user.id);
      res.redirect(safeNext(next));
    });
  });

  r.post('/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie(ctx.sessionCookieName);
      res.redirect('/login');
    });
  });

  return r;
}
