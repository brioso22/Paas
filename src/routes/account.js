import { Router } from 'express';
import bcrypt from 'bcryptjs';
import * as v from '../lib/validate.js';
import { requirePermission, flash } from '../middleware/security.js';
import { accountView } from '../views/account.js';

export function accountRoutes(ctx) {
  const { users } = ctx;
  const r = Router();
  const guard = requirePermission('account.use');

  const render = (req, res, status = 200, error = null) =>
    res.status(status).page(
      'Mi cuenta',
      accountView({ user: req.user, plan: users.plan(req.user), usage: users.usage(req.user.id), csrfToken: res.locals.csrfToken, error }),
      { active: 'account' },
    );

  r.get('/account', guard, (req, res) => render(req, res));

  r.post('/account/password', guard, async (req, res) => {
    const { current = '', password = '', password2 = '' } = req.body || {};
    const full = users.get(req.user.id);
    try {
      if (typeof current !== 'string' || !(await bcrypt.compare(current, full.password_hash))) throw new v.ValidationError('La contraseña actual no es correcta');
      v.password(password);
      if (password !== password2) throw new v.ValidationError('Las contraseñas nuevas no coinciden');
      if (password === current) throw new v.ValidationError('La contraseña nueva debe ser distinta de la actual');
    } catch (err) {
      if (!(err instanceof v.ValidationError)) throw err;
      return render(req, res, 400, err.message);
    }
    await users.setPassword(full, password);
    ctx.audit.record(req, 'account.password');
    // Cierra el resto de sesiones del usuario y renueva la actual.
    ctx.sessionStore?.destroyUser(full.id);
    req.session.regenerate((err) => {
      if (err) return res.errorPage(500, 'No se pudo renovar la sesión');
      req.session.userId = full.id;
      flash(req, 'success', 'Contraseña actualizada. Se cerraron tus otras sesiones.');
      res.redirect('/account');
    });
  });

  return r;
}
