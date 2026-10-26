import test from 'node:test';
import assert from 'node:assert/strict';
import { createContext } from '../src/context.js';
import { createApp } from '../src/app.js';
import { testConfig, silentLogger, startServer, setupAdmin } from './helpers/setup.js';

async function boot(overrides) {
  const ctx = createContext(testConfig(overrides), { logger: silentLogger });
  const srv = await startServer(createApp(ctx));
  const c = srv.client();
  await setupAdmin(c);
  return { ctx, srv, c, close: async () => (await srv.close(), ctx.close()) };
}

const baseForm = {
  name: 'demo',
  source: 'zip',
  port: '8080',
  cpu_request: '100m',
  cpu_limit: '500m',
  memory_request: '128Mi',
  memory_limit: '256Mi',
  replicas: '1',
  env: 'DB_PASS=super-secreto-1\nAPI_URL=https://api.example.test',
};

test('crear proyecto zip: BD, cifrado y namespace + plantillas por stdin', async (t) => {
  const { ctx, c, close } = await boot();
  t.after(close);
  ctx.exec.clearHistory();

  await c.get('/projects/new');
  const r = await c.post('/projects', { form: { _csrf: c.csrf, ...baseForm } });
  assert.equal(r.status, 302);
  const p = ctx.projects.getByName('demo');
  assert.equal(r.headers.get('location'), `/projects/${p.id}`);
  assert.equal(p.namespace, 'tenant-demo');
  assert.equal(p.status, 'created');

  // Valores cifrados en la BD.
  const raw = ctx.db.prepare('SELECT value_enc FROM env_vars WHERE project_id = ?').pluck().all(p.id);
  assert.equal(raw.length, 2);
  assert.ok(raw.every((x) => x.startsWith('v1:') && !x.includes('super-secreto')));
  assert.equal(ctx.projects.envMap(p).get('DB_PASS'), 'super-secreto-1');

  // Exactamente un kubectl apply -f - con stdin.
  assert.equal(ctx.exec.history.length, 1);
  const cmd = ctx.exec.history[0];
  assert.deepEqual([cmd.cmd, ...cmd.args], ['kubectl', 'apply', '-f', '-']);
  assert.ok(cmd.stdinBytes > 500);

  // Listado y detalle.
  let page = await c.get('/');
  assert.match(page.text, /tenant-demo/);
  assert.match(page.text, /http:\/\/demo\.paas\.local/);
  page = await c.get(`/projects/${p.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /curl -H &#39;Host: demo\.paas\.local&#39; http:\/\/192\.168\.49\.2:32134\//);
  assert.doesNotMatch(page.text, /super-secreto/);

  // Nombre duplicado.
  const dup = await c.post('/projects', { form: { _csrf: c.csrf, ...baseForm } });
  assert.equal(dup.status, 400);
  assert.match(dup.text, /Ya existe/);
});

test('validación del formulario y escape de HTML (XSS)', async (t) => {
  const { ctx, c, close } = await boot();
  t.after(close);
  await c.get('/projects/new');
  const cases = [
    [{ name: 'MAL' }, /nombre debe tener/],
    [{ port: '70000' }, /puerto/],
    [{ cpu_request: '2', cpu_limit: '1' }, /CPU solicitada/],
    [{ source: 'git', repo_url: 'http://github.com/u/r' }, /https/],
    [{ source: 'git', repo_url: 'https://github.com/u/r', branch: '--upload-pack=x' }, /rama/i],
    [{ env: '<script>alert(1)</script>=x' }, /Nombre de variable inválido/],
  ];
  for (const [over, re] of cases) {
    const r = await c.post('/projects', { form: { _csrf: c.csrf, ...baseForm, ...over } });
    assert.equal(r.status, 400, JSON.stringify(over));
    assert.match(r.text, re);
    assert.doesNotMatch(r.text, /<script>alert/);
  }
  const r = await c.post('/projects', { form: { _csrf: c.csrf, ...baseForm, name: '"><img src=x onerror=alert(1)>' } });
  assert.doesNotMatch(r.text, /<img src=x/);
  assert.match(r.text, /&quot;&gt;&lt;img/);
  // El token de git nunca se devuelve en el formulario con errores.
  const t2 = await c.post('/projects', { form: { _csrf: c.csrf, ...baseForm, source: 'git', repo_url: 'mal', git_token: 'ghp_NO_DEVOLVER' } });
  assert.doesNotMatch(t2.text, /ghp_NO_DEVOLVER/);
  assert.equal(ctx.projects.list().length, 0);
});

test('proyecto git guarda el token cifrado; borrar exige confirmar el nombre', async (t) => {
  const { ctx, c, close } = await boot();
  t.after(close);
  await c.get('/projects/new');
  const r = await c.post('/projects', {
    form: { _csrf: c.csrf, ...baseForm, name: 'api', source: 'git', repo_url: 'https://github.com/u/api.git', branch: 'main', git_token: 'ghp_tokenSecreto123' },
  });
  assert.equal(r.status, 302);
  const p = ctx.projects.getByName('api');
  assert.equal(p.source, 'git');
  assert.ok(!p.git_token_enc.includes('ghp_'));
  assert.equal(ctx.projects.gitToken(p), 'ghp_tokenSecreto123');

  await c.get(`/projects/${p.id}`);
  let d = await c.post(`/projects/${p.id}/delete`, { form: { _csrf: c.csrf, confirm_name: 'otro' } });
  assert.equal(d.status, 302);
  assert.ok(ctx.projects.get(p.id));

  ctx.exec.clearHistory();
  d = await c.post(`/projects/${p.id}/delete`, { form: { _csrf: c.csrf, confirm_name: 'api' } });
  assert.equal(d.status, 302);
  assert.equal(ctx.projects.get(p.id), null);
  assert.ok(ctx.exec.history.some((h) => h.cmd === 'kubectl' && h.args.join(' ') === 'delete namespace tenant-api --ignore-not-found=true --wait=false'));
});

test('un viewer no puede crear proyectos', async (t) => {
  const { ctx, srv, close } = await boot();
  t.after(close);
  const bcrypt = (await import('bcryptjs')).default;
  ctx.db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('lector', ?, 'viewer')").run(bcrypt.hashSync('lector-password-1', 4));
  const v = srv.client();
  await v.get('/login');
  await v.post('/login', { form: { _csrf: v.csrf, username: 'lector', password: 'lector-password-1' } });
  const page = await v.get('/');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Nuevo proyecto/);
  const r = await v.post('/projects', { form: { _csrf: v.csrf, ...baseForm } });
  assert.equal(r.status, 403);
});

test('si el clúster falla al crear el namespace, el proyecto se revierte', async (t) => {
  const { ctx, c, close } = await boot();
  t.after(close);
  ctx.kube.ensureTenant = async () => {
    throw new Error('connection refused');
  };
  await c.get('/projects/new');
  const r = await c.post('/projects', { form: { _csrf: c.csrf, ...baseForm } });
  assert.equal(r.status, 502);
  assert.match(r.text, /connection refused/);
  assert.equal(ctx.projects.getByName('demo'), null);
});
