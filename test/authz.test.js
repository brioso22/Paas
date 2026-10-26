import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { can, GLOBAL_MATRIX, PROJECT_MATRIX } from '../src/lib/authz.js';
import { migrate, MIGRATIONS } from '../src/db.js';
import { checkPlanQuota } from '../src/services/users.js';
import { boot, createProject, uploadZip, readSse } from './helpers/app.js';

const user = (role, extra = {}) => ({ id: 1, role, active: 1, ...extra });
const proj = (member_role) => ({ id: 7, member_role });

test('matriz de permisos: cada acción para cada combinación de rol global y de proyecto', () => {
  // Expectativa escrita a mano (no derivada de la matriz) para que un cambio accidental falle.
  const expected = {
    'project.view': { owner: 1, deployer: 1, viewer: 1 },
    'project.deploy': { owner: 1, deployer: 1, viewer: 0 },
    'env.edit': { owner: 1, deployer: 1, viewer: 0 },
    'project.settings': { owner: 1, deployer: 0, viewer: 0 },
    'webhook.manage': { owner: 1, deployer: 0, viewer: 0 },
    'db.manage': { owner: 1, deployer: 0, viewer: 0 },
    'tls.manage': { owner: 1, deployer: 0, viewer: 0 },
    'members.manage': { owner: 1, deployer: 0, viewer: 0 },
    'project.audit': { owner: 1, deployer: 0, viewer: 0 },
    'project.delete': { owner: 1, deployer: 0, viewer: 0 },
  };
  assert.deepEqual(Object.keys(expected).sort(), Object.keys(PROJECT_MATRIX).sort());
  for (const [action, byRole] of Object.entries(expected)) {
    for (const [member, allowed] of Object.entries(byRole)) {
      assert.equal(can(user('user'), action, proj(member)), Boolean(allowed), `user/${member} ${action}`);
      // Un viewer global nunca supera el nivel viewer aunque su membresía diga otra cosa.
      assert.equal(can(user('viewer'), action, proj(member)), Boolean(expected[action].viewer), `viewer/${member} ${action}`);
    }
    assert.equal(can(user('user'), action, proj(null)), false, `sin membresía ${action}`);
    assert.equal(can(user('admin'), action, proj(null)), true, `admin ${action}`);
    assert.equal(can(user('admin', { active: 0 }), action, proj('owner')), false, `inactivo ${action}`);
    assert.equal(can(user('user'), action, null), false);
  }

  assert.deepEqual(GLOBAL_MATRIX['admin.access'], ['admin']);
  assert.equal(can(user('user'), 'project.create'), true);
  assert.equal(can(user('viewer'), 'project.create'), false);
  assert.equal(can(user('user'), 'admin.access'), false);
  assert.equal(can(user('admin'), 'admin.access'), true);
  assert.equal(can(null, 'project.view', proj('owner')), false);
  assert.throws(() => can(user('admin'), 'proyecto.borrar', proj('owner')), /desconocida/);
});

test('cuotas por plan: mensaje claro y NULL = sin límite', () => {
  const free = { name: 'free', max_projects: 2, max_cpu_millicores: 1000, max_memory_mi: 1024, max_db_gi: 2 };
  const used = { projects: 2, cpu: 600, mem: 512, dbGi: 1 };
  assert.throws(() => checkPlanQuota(free, used, { projects: 1, cpu: 0, mem: 0, dbGi: 0 }), /plan free: permite 2 proyectos y ya tienes 2/);
  assert.throws(() => checkPlanQuota(free, used, { projects: 0, cpu: 500, mem: 0, dbGi: 0 }), /1000m de CPU/);
  assert.throws(() => checkPlanQuota(free, used, { projects: 0, cpu: 0, mem: 0, dbGi: 2 }), /2 GiB de bases de datos/);
  checkPlanQuota(free, used, { projects: 0, cpu: -300, mem: 512, dbGi: 1 }); // reducir o llegar justo al límite está permitido
  checkPlanQuota({ name: 'ilimitado', max_projects: null, max_cpu_millicores: null, max_memory_mi: null, max_db_gi: null }, used, { projects: 99, cpu: 1e6, mem: 1e6, dbGi: 1e3 });
});

test('migración 6: conserva datos, admite varios admins y asigna los proyectos al primer admin', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS.filter((m) => m.version <= 5));
  db.prepare("INSERT INTO users (id, username, password_hash, role, last_login_at) VALUES (1, 'jefa', 'h1', 'admin', '2026-01-01 00:00:00'), (2, 'lector', 'h2', 'viewer', NULL)").run();
  db.prepare("INSERT INTO projects (id, name, namespace, source, port, cpu_request, cpu_limit, memory_request, memory_limit, webhook_secret_enc, created_by) VALUES (1, 'web', 'tenant-web', 'zip', 80, '1m', '1m', '1Mi', '1Mi', 'x', 1)").run();
  db.prepare("INSERT INTO deployments (project_id, kind, triggered_by, user_id) VALUES (1, 'build', 'jefa', 1)").run();

  assert.deepEqual(migrate(db), [6]);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1, 'las FK vuelven a quedar activas');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  // Las referencias a users sobreviven a la reconstrucción de la tabla (no se dispararon los SET NULL).
  assert.equal(db.prepare('SELECT created_by FROM projects').pluck().get(), 1);
  assert.equal(db.prepare('SELECT user_id FROM deployments').pluck().get(), 1);

  const users = db.prepare('SELECT u.username, u.role, u.active, u.must_change_password, u.last_login, p.name AS plan FROM users u JOIN plans p ON p.id = u.plan_id ORDER BY u.id').all();
  assert.deepEqual(users.map((u) => ({ ...u })), [
    { username: 'jefa', role: 'admin', active: 1, must_change_password: 0, last_login: '2026-01-01 00:00:00', plan: 'ilimitado' },
    { username: 'lector', role: 'viewer', active: 1, must_change_password: 0, last_login: null, plan: 'free' },
  ]);
  assert.deepEqual(db.prepare('SELECT name, max_projects FROM plans ORDER BY id').all().map((r) => ({ ...r })), [
    { name: 'free', max_projects: 2 },
    { name: 'pro', max_projects: 10 },
    { name: 'ilimitado', max_projects: null },
  ]);
  assert.deepEqual({ ...db.prepare('SELECT project_id, user_id, role FROM project_members').get() }, { project_id: 1, user_id: 1, role: 'owner' });

  // Ya no hay índice de admin único; el CHECK de roles admite 'user' y rechaza otros.
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('otro', 'h', 'admin'), ('cli', 'h', 'user')").run();
  assert.throws(() => db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('x', 'h', 'root')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO project_members (project_id, user_id, role) VALUES (1, 4, 'owner')").run(), /UNIQUE/, 'un solo owner');
  assert.deepEqual(migrate(db), [], 'idempotente');
  db.close();
});

async function login(app, username, role = 'user', plan = 'free') {
  await app.ctx.users.create({ username, role, planName: plan, password: `${username}-password-1`, mustChange: false });
  const c = app.srv.client();
  await c.get('/login');
  const r = await c.post('/login', { form: { _csrf: c.csrf, username, password: `${username}-password-1` } });
  assert.equal(r.status, 302);
  await c.get('/');
  return c;
}

test('aislamiento entre clientes: proyectos ajenos responden 404 en páginas, acciones y streams', async (t) => {
  const app = await boot();
  t.after(app.close);
  const ana = await login(app, 'ana');
  const beto = await login(app, 'beto');

  const id = await createProject(ana, { name: 'tienda', source: 'zip', replicas: '1' });
  await uploadZip(ana, id, [{ name: 'index.html', data: 'x' }]);
  await app.ctx.queue.idle();
  const depId = app.ctx.db.prepare('SELECT id FROM deployments WHERE project_id = ?').pluck().get(id);
  assert.equal(app.ctx.users.ownerOf(id).username, 'ana');

  // El dashboard de beto no la lista; el del admin sí.
  assert.doesNotMatch((await beto.get('/')).text, /tienda/);
  assert.match((await app.c.get('/')).text, /tienda/);

  for (const url of [`/projects/${id}`, `/projects/${id}/env`, `/projects/${id}/deployments`, `/projects/${id}/metrics.json`, `/projects/${id}/members`, `/deployments/${depId}`])
    assert.equal((await beto.get(url)).status, 404, url);
  for (const url of [`/projects/${id}/logs/stream`, `/deployments/${depId}/stream`])
    assert.equal((await readSse(app.srv.base, beto, url)).status, 404, url);
  const h = { headers: { 'x-csrf-token': beto.csrf, accept: 'application/json' } };
  for (const url of [`/projects/${id}/env/DB_PASS/reveal`, `/projects/${id}/deploy/apply`, `/projects/${id}/delete`, `/projects/${id}/tls/enable`, `/projects/${id}/members`])
    assert.equal((await beto.request('POST', url, h)).status, 404, url);
  for (const url of ['/admin/users', '/admin/audit', '/settings']) assert.equal((await beto.get(url)).status, 404, url);

  // Invitado como viewer: ve y lee logs, pero no despliega ni revela (403, ya sabe que existe).
  await ana.get(`/projects/${id}/members`);
  let r = await ana.post(`/projects/${id}/members`, { form: { _csrf: ana.csrf, username: 'beto', role: 'viewer' } });
  assert.equal(r.status, 302);
  assert.equal((await beto.get(`/projects/${id}`)).status, 200);
  assert.equal((await readSse(app.srv.base, beto, `/deployments/${depId}/stream`)).status, 200);
  assert.equal((await beto.request('POST', `/projects/${id}/env/DB_PASS/reveal`, h)).status, 403);
  assert.equal((await beto.request('POST', `/projects/${id}/deploy/apply`, h)).status, 403);
  assert.equal((await beto.get(`/projects/${id}/activity`)).status, 403);

  // Como deployer ya puede desplegar y revelar, pero no borrar ni gestionar BD/HTTPS/miembros.
  const betoId = app.ctx.users.getByUsername('beto').id;
  await ana.get(`/projects/${id}/members`);
  await ana.post(`/projects/${id}/members/${betoId}/role`, { form: { _csrf: ana.csrf, role: 'deployer' } });
  assert.equal((await beto.request('POST', `/projects/${id}/env/DB_PASS/reveal`, h)).status, 200);
  assert.equal((await beto.request('POST', `/projects/${id}/deploy/apply`, h)).status, 302);
  for (const url of [`/projects/${id}/delete`, `/projects/${id}/databases`, `/projects/${id}/tls/enable`, `/projects/${id}/members`])
    assert.equal((await beto.request('POST', url, h)).status, 403, url);
  await app.ctx.queue.idle();

  // Plan free: 2 proyectos. El tercero se rechaza con un mensaje claro.
  await createProject(ana, { name: 'blog', source: 'zip', replicas: '1' });
  await ana.get('/projects/new');
  r = await ana.post('/projects', { form: { _csrf: ana.csrf, name: 'extra', source: 'zip', port: '80', replicas: '1' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /Límite del plan free: permite 2 proyectos y ya tienes 2/);

  // La auditoría guarda nombres de variables, nunca valores; el owner ve la actividad.
  const audit = app.ctx.db.prepare('SELECT action, detail FROM audit_log').all();
  for (const a of ['auth.login', 'project.create', 'deploy.build', 'member.add', 'member.role', 'env.reveal']) assert.ok(audit.some((e) => e.action === a), a);
  assert.ok(!JSON.stringify(audit).includes('valor-ultra-secreto-42'));
  assert.match((await ana.get(`/projects/${id}/activity`)).text, /member\.role/);
});

test('administración de usuarios: contraseña temporal, último admin y sesiones invalidadas', async (t) => {
  const app = await boot();
  t.after(app.close);
  const { c, ctx } = app;

  await c.get('/admin/users');
  let r = await c.post('/admin/users', { form: { _csrf: c.csrf, username: 'cliente', email: 'c@ejemplo.com', role: 'user', plan: 'pro' } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const temp = r.text.match(/id="temp-pw" class="mono" value="([^"]+)"/)[1];
  assert.ok(!JSON.stringify(ctx.db.prepare('SELECT * FROM audit_log').all()).includes(temp), 'la contraseña temporal no se audita');

  // Con contraseña temporal solo puede ir a Mi cuenta.
  const u = app.srv.client();
  await u.get('/login');
  r = await u.post('/login', { form: { _csrf: u.csrf, username: 'cliente', password: temp } });
  assert.equal(r.headers.get('location'), '/account');
  assert.equal((await u.get('/')).headers.get('location'), '/account');
  await u.get('/account');
  r = await u.post('/account/password', { form: { _csrf: u.csrf, current: temp, password: 'nueva-clave-segura', password2: 'nueva-clave-segura' } });
  assert.equal(r.status, 302);
  assert.equal((await u.get('/')).status, 200);

  // Último admin: ni desactivarlo ni degradarlo.
  const admin = ctx.users.getByUsername('admin');
  await c.get('/admin/users');
  await c.post(`/admin/users/${admin.id}/role`, { form: { _csrf: c.csrf, role: 'user' } });
  await c.post(`/admin/users/${admin.id}/active`, { form: { _csrf: c.csrf, active: '0' } });
  assert.equal(ctx.users.get(admin.id).role, 'admin');
  assert.equal(ctx.users.get(admin.id).active, 1);
  assert.match((await c.get('/admin/users')).text, /último administrador/);

  // Desactivar cierra sus sesiones al momento; reactivar no las resucita.
  const cliente = ctx.users.getByUsername('cliente');
  await c.post(`/admin/users/${cliente.id}/active`, { form: { _csrf: c.csrf, active: '0' } });
  assert.equal((await u.get('/')).status, 302);
  await c.get('/admin/users');
  await c.post(`/admin/users/${cliente.id}/active`, { form: { _csrf: c.csrf, active: '1' } });
  assert.equal((await u.get('/')).status, 302);

  // Registro abierto: desactivado por defecto.
  assert.equal((await app.srv.client().get('/register')).status, 404);
  await c.get('/settings');
  await c.post('/settings/registration', { form: { _csrf: c.csrf, allow_registration: 'on' } });
  const nuevo = app.srv.client();
  await nuevo.get('/register');
  r = await nuevo.post('/register', { form: { _csrf: nuevo.csrf, username: 'nuevo', password: 'clave-del-nuevo-1', password2: 'clave-del-nuevo-1' } });
  assert.equal(r.status, 302);
  const n = ctx.users.getByUsername('nuevo');
  assert.equal(n.role, 'user');
  assert.equal(ctx.users.plan(n).name, 'free');
});
