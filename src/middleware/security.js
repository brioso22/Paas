import { randomToken, safeEqual } from '../crypto.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Token sincronizado guardado en la sesión. */
export function ensureCsrfToken(req) {
  if (!req.session.csrfToken) req.session.csrfToken = randomToken(24);
  return req.session.csrfToken;
}

/**
 * Protección CSRF para toda petición que modifica estado. El token se acepta en la
 * cabecera x-csrf-token (fetch), en el campo _csrf (formularios) o en ?_csrf= (solo
 * formularios multipart, porque multer no ha parseado el cuerpo todavía).
 */
export function csrfProtection({ exempt = [] } = {}) {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      res.locals.csrfToken = ensureCsrfToken(req);
      return next();
    }
    if (exempt.some((prefix) => req.path.startsWith(prefix))) return next();
    const expected = req.session?.csrfToken;
    const sent = req.get('x-csrf-token') || req.body?._csrf || req.query?._csrf;
    if (!expected || typeof sent !== 'string' || !safeEqual(sent, expected)) {
      const err = new Error('Token CSRF inválido o ausente. Recarga la página e inténtalo de nuevo.');
      err.status = 403;
      return next(err);
    }
    res.locals.csrfToken = expected;
    next();
  };
}

export function loadUser(db) {
  const stmt = db.prepare('SELECT id, username, role FROM users WHERE id = ?');
  return (req, res, next) => {
    const id = req.session?.userId;
    req.user = id ? stmt.get(id) || null : null;
    if (id && !req.user) delete req.session.userId;
    res.locals.user = req.user;
    next();
  };
}

function wantsJson(req) {
  return req.xhr || (req.get('accept') || '').includes('application/json') || req.path.endsWith('.json');
}

export function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return res.status(401).json({ error: 'No autenticado' });
  const back = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/login${back}`);
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (req.user.role === role || req.user.role === 'admin') return next();
    const err = new Error('No tienes permisos para esta acción');
    err.status = 403;
    next(err);
  };
}

export const requireAdmin = requireRole('admin');

export function flash(req, type, message) {
  req.session.flash = [...(req.session.flash || []), { type, message }];
}

export function takeFlash(req, res, next) {
  res.locals.flash = req.session?.flash || [];
  if (req.session?.flash) delete req.session.flash;
  next();
}
