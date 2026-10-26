import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as v from '../lib/validate.js';
import { createRateLimiter } from '../lib/rateLimit.js';
import { getSetting } from '../db.js';
import { BCRYPT_COST } from '../services/users.js';
import { setupView, loginView, registerView } from '../views/auth.js';

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
  const registrationOpen = () => getSetting(db, 'allow_registration', '0') === '1';
  const byIpRegister = createRateLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
  ctx.onClose?.(() => byIpRegister.stop());

  // Registro abierto (desactivado por defecto; se activa en Ajustes): role=user, plan free.
  r.get('/register', (req, res) => {
    if (!registrationOpen() || userCount() === 0) return res.errorPage(404, 'Página no encontrada');
    if (req.user) return res.redirect('/');
    res.page('Crear cuenta', registerView({ csrfToken: res.locals.csrfToken }));
  });

  r.post('/register', async (req, res) => {
    if (!registrationOpen() || userCount() === 0) return res.errorPage(404, 'Página no encontrada');
    const { username = '', email = '', password = '', password2 = '' } = req.body || {};
    const ip = req.ip || 'desconocida';
    const render = (status, error) => res.status(status).page('Crear cuenta', registerView({ csrfToken: res.locals.csrfToken, error, username: String(username).slice(0, 32), email: String(email).slice(0, 254) }));
    if (byIpRegister.isBlocked(ip)) return render(429, 'Demasiados registros desde tu red. Inténtalo más tarde.');
    let user;
    try {
      v.password(password);
      if (password !== password2) throw new v.ValidationError('Las contraseñas no coinciden');
      ({ user } = await ctx.users.create({ username, email, role: 'user', planName: 'free', password, mustChange: false }));
    } catch (err) {
      if (!(err instanceof v.ValidationError)) throw err;
      return render(400, err.message);
    }
    byIpRegister.fail(ip);
    ctx.audit.record({ user, ip }, 'user.register');
    req.session.regenerate((err) => {
      if (err) return render(500, 'No se pudo iniciar la sesión');
      req.session.userId = user.id;
      res.redirect('/');
    });
  });

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
      return db
        .prepare("INSERT INTO users (username, password_hash, role, plan_id) VALUES (?, ?, 'admin', (SELECT id FROM plans WHERE name = 'ilimitado'))")
        .run(username, hash).lastInsertRowid;
    })();
    if (!created) return res.errorPage(404, 'Página no encontrada');
    ctx.logger.info(`Administrador "${username}" creado desde /setup`);
    ctx.audit.record({ user: { id: Number(created), username }, ip: req.ip }, 'user.create', { detail: 'admin inicial (/setup)' });
    req.session.regenerate((err) => {
      if (err) return res.errorPage(500, 'No se pudo iniciar la sesión');
      req.session.userId = Number(created);
      res.redirect('/');
    });
  });

  r.get('/login', (req, res) => {
    if (userCount() === 0) return res.redirect('/setup');
    if (req.user) return res.redirect('/');
    res.page('Iniciar sesión', loginView({ csrfToken: res.locals.csrfToken, next: safeNext(req.query.next), allowRegistration: registrationOpen() }));
  });

  r.post('/login', async (req, res) => {
    const { username = '', password = '', next = '/' } = req.body || {};
    const ipKey = req.ip || 'desconocida';
    const userKey = String(username).toLowerCase().slice(0, 64);
    const render = (status, error) =>
      res.status(status).page('Iniciar sesión', loginView({ csrfToken: res.locals.csrfToken, error, username: String(username).slice(0, 32), next: safeNext(next), allowRegistration: registrationOpen() }));

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
      ctx.audit.record({ ip: ipKey }, 'auth.login_failed', { username: userKey.replace(/[^\w.\-]/g, '?') });
      return render(401, 'Usuario o contraseña incorrectos');
    }
    if (!user.active) {
      ctx.audit.record({ user, ip: ipKey }, 'auth.login_failed', { detail: 'cuenta desactivada' });
      return render(403, 'Tu cuenta está desactivada. Contacta con el administrador.');
    }
    byUser.reset(userKey);
    // Regenerar evita fijación de sesión.
    req.session.regenerate((err) => {
      if (err) return render(500, 'No se pudo iniciar la sesión');
      req.session.userId = user.id;
      ctx.users.touchLogin(user);
      ctx.audit.record({ user, ip: ipKey }, 'auth.login');
      res.redirect(user.must_change_password ? '/account' : safeNext(next));
    });
  });

  r.post('/logout', (req, res) => {
    if (req.user) ctx.audit.record(req, 'auth.logout');
    req.session.destroy(() => {
      res.clearCookie(ctx.sessionCookieName);
      res.redirect('/login');
    });
  });

  return r;
}
