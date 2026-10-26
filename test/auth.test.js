import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { testConfig, silentLogger, startServer, setupAdmin } from './helpers/setup.js';

async function boot() {
  const ctx = createContext(testConfig(), { logger: silentLogger });
  const app = createApp(ctx);
  const srv = await startServer(app);
  return {
    ctx,
    srv,
    async close() {
      await srv.close();
      ctx.close();
    },
  };
}

test('flujo de /setup, login, CSRF, logout y limitador de intentos', async (t) => {
  const { ctx, srv, close } = await boot();
  t.after(close);
  const c = srv.client();

  // Sin usuarios, todo redirige a /setup.
  let r = await c.get('/login');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/setup');

  r = await c.get('/');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/login/);

  // POST sin token CSRF se rechaza.
  r = await c.post('/setup', { form: { username: 'admin', password: 'x'.repeat(12), password2: 'x'.repeat(12) } });
  assert.equal(r.status, 403);

  await c.get('/setup');
  r = await c.post('/setup', { form: { _csrf: c.csrf, username: 'admin', password: 'corta', password2: 'corta' } });
  assert.equal(r.status, 400);

  const { password } = await setupAdmin(c);
  const user = ctx.db.prepare('SELECT * FROM users').get();
  assert.equal(user.role, 'admin');
  assert.match(user.password_hash, /^\$2[aby]\$12\$/, 'bcrypt con cost 12');

  // /setup queda deshabilitado.
  r = await c.get('/setup');
  assert.equal(r.status, 404);
  const other = srv.client();
  await other.get('/login');
  r = await other.post('/setup', { form: { _csrf: other.csrf, username: 'x2y', password: 'y'.repeat(12), password2: 'y'.repeat(12) } });
  assert.equal(r.status, 404);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 1);

  // Dashboard autenticado.
  r = await c.get('/');
  assert.equal(r.status, 200);
  assert.match(r.text, /Proyectos/);

  // Cookie de sesión httpOnly + SameSite=Lax.
  const fresh = srv.client();
  await fresh.get('/login');
  r = await fresh.post('/login', { form: { _csrf: fresh.csrf, username: 'admin', password } });
  assert.equal(r.status, 302);
  const setCookie = r.headers.getSetCookie().join(';');
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(setCookie, /Secure/i);

  // Logout con CSRF.
  r = await c.post('/logout', { form: {} });
  assert.equal(r.status, 403);
  r = await c.post('/logout', { form: { _csrf: c.csrf } });
  assert.equal(r.status, 302);
  r = await c.get('/');
  assert.equal(r.status, 302);

  // Limitador: 5 fallos por usuario bloquean incluso con la contraseña correcta.
  const att = srv.client();
  await att.get('/login');
  for (let i = 0; i < 5; i++) {
    r = await att.post('/login', { form: { _csrf: att.csrf, username: 'admin', password: 'incorrecta-' + i } });
    assert.equal(r.status, 401);
  }
  r = await att.post('/login', { form: { _csrf: att.csrf, username: 'admin', password } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
});

test('open redirect: next externo se ignora', async (t) => {
  const { srv, close } = await boot();
  t.after(close);
  const c = srv.client();
  const { password } = await setupAdmin(c);
  for (const next of ['//evil.com', 'https://evil.com', '/\\evil.com']) {
    const d = srv.client();
    await d.get('/login');
    const r = await d.post('/login', { form: { _csrf: d.csrf, username: 'admin', password, next } });
    assert.equal(r.headers.get('location'), '/', next);
  }
});

test('cabeceras de seguridad y /health', async (t) => {
  const { srv, close } = await boot();
  t.after(close);
  const c = srv.client();
  const r = await c.get('/login');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');

  const h = await c.get('/health');
  assert.equal(h.status, 200);
  const body = JSON.parse(h.text);
  assert.equal(body.status, 'ok');
  assert.equal(body.dryRun, true);
});

test('cuerpo demasiado grande se rechaza', async (t) => {
  const { srv, close } = await boot();
  t.after(close);
  const c = srv.client();
  await c.get('/login');
  const r = await c.post('/login', { form: { _csrf: c.csrf, username: 'a', password: 'x'.repeat(300 * 1024) } });
  assert.equal(r.status, 413);
});
