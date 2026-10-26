import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { SECRET, boot, createProject, deployedZipProject, cmdline, readSse } from './helpers/app.js';
import { parseEnvForm } from '../src/routes/manage.js';

test('parseEnvForm: vacío conserva, borrar, añadir y validar', () => {
  const r = parseEnvForm({
    existing_key: ['A', 'B', 'C'],
    existing_value: ['', 'nuevo', 'x'],
    delete: 'C',
    new_key: ['D', ''],
    new_value: ['d', 'ignorado'],
  });
  assert.deepEqual([...r.set], [
    ['B', 'nuevo'],
    ['D', 'd'],
  ]);
  assert.deepEqual(r.remove, ['C']);
  assert.throws(() => parseEnvForm({ new_key: 'mal-nombre', new_value: 'x' }), /inválido/);
  assert.throws(() => parseEnvForm({ existing_key: 'A', existing_value: '', new_key: 'A', new_value: 'x' }), /ya existe/);
});

test('editar variables: enmascaradas, revelado con CSRF y rollout restart', async (t) => {
  const { ctx, c, id, close } = await deployedZipProject();
  t.after(close);

  let page = await c.get(`/projects/${id}/env`);
  assert.equal(page.status, 200);
  assert.match(page.text, /DB_PASS/);
  assert.ok(!page.text.includes(SECRET), 'el valor nunca va en el HTML');

  // Revelar exige POST + CSRF.
  let r = await c.request('POST', `/projects/${id}/env/DB_PASS/reveal`, { headers: { accept: 'application/json' } });
  assert.equal(r.status, 403);
  r = await c.request('POST', `/projects/${id}/env/DB_PASS/reveal`, { headers: { 'x-csrf-token': c.csrf, accept: 'application/json' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.text).value, SECRET);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  r = await c.get(`/projects/${id}/env/DB_PASS/reveal`);
  assert.equal(r.status, 404);

  // Guardar: DB_PASS se conserva (vacío), APP_ENV cambia, se añade NUEVA y se reinician los pods.
  page = await c.get(`/projects/${id}/env`);
  r = await c.post(`/projects/${id}/env`, {
    form: { _csrf: c.csrf, existing_key: ['APP_ENV', 'DB_PASS'], existing_value: ['staging', ''], new_key: 'NUEVA', new_value: 'n', apply: 'restart' },
  });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/deployments\/\d+$/);
  await ctx.queue.idle();
  const p = ctx.projects.get(id);
  assert.deepEqual(Object.fromEntries(ctx.projects.envMap(p)), { APP_ENV: 'staging', DB_PASS: SECRET, NUEVA: 'n' });
  assert.deepEqual(ctx.exec.history.map(cmdline), [
    'kubectl apply -n tenant-web -f -',
    'kubectl rollout restart deployment -n tenant-web -l app.kubernetes.io/instance=web',
  ]);
  const dep = ctx.db.prepare('SELECT * FROM deployments ORDER BY id DESC').get();
  assert.equal(dep.kind, 'restart');
  assert.equal(dep.status, 'success', dep.log);
  assert.ok(!dep.log.includes(SECRET) && !dep.log.includes('staging'));

  // Borrar con apply=none no toca el clúster.
  ctx.exec.clearHistory();
  await c.get(`/projects/${id}/env`);
  r = await c.post(`/projects/${id}/env`, { form: { _csrf: c.csrf, existing_key: ['NUEVA'], existing_value: [''], delete: 'NUEVA', apply: 'none' } });
  assert.equal(r.status, 302);
  assert.equal(ctx.exec.history.length, 0);
  assert.equal(ctx.projects.envMap(p).has('NUEVA'), false);

  // Nombre inválido: error y nada cambia.
  await c.get(`/projects/${id}/env`);
  r = await c.post(`/projects/${id}/env`, { form: { _csrf: c.csrf, new_key: 'x y', new_value: '1', apply: 'none' } });
  page = await c.get(`/projects/${id}/env`);
  assert.match(page.text, /Nombre de variable inválido/);
});

test('un viewer ve la página de variables pero no puede revelar ni guardar', async (t) => {
  const { ctx, srv, id, close } = await deployedZipProject();
  t.after(close);
  ctx.db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('lector', ?, 'viewer')").run(bcrypt.hashSync('lector-password-1', 4));
  const v = srv.client();
  await v.get('/login');
  await v.post('/login', { form: { _csrf: v.csrf, username: 'lector', password: 'lector-password-1' } });
  const page = await v.get(`/projects/${id}/env`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /data-reveal-url/);
  const r = await v.request('POST', `/projects/${id}/env/DB_PASS/reveal`, { headers: { 'x-csrf-token': v.csrf, accept: 'application/json' } });
  assert.equal(r.status, 403);
});

test('escalar manualmente: amplía la cuota y luego kubectl scale; queda guardado', async (t) => {
  const { ctx, config, c, id, close } = await deployedZipProject();
  t.after(close);
  await c.get(`/projects/${id}/settings`);
  let r = await c.post(`/projects/${id}/scale`, { form: { _csrf: c.csrf, replicas: '5' } });
  assert.equal(r.status, 302);
  assert.deepEqual(ctx.exec.history.map(cmdline), [
    'kubectl apply -f -',
    'kubectl scale deployment -n tenant-web -l app.kubernetes.io/instance=web --replicas=5',
  ]);
  assert.equal(ctx.projects.get(id).replicas, 5);

  r = await c.post(`/projects/${id}/scale`, { form: { _csrf: c.csrf, replicas: '99' } });
  const page = await c.get(`/projects/${id}/settings`);
  assert.match(page.text, /Réplicas debe ser un entero entre 0 y 20/);

  // El siguiente despliegue usa las réplicas guardadas.
  await c.post(`/projects/${id}/deploy/apply`, { form: { _csrf: c.csrf } });
  await ctx.queue.idle();
  const values = JSON.parse(fs.readFileSync(path.join(config.workspacesDir, 'web', 'values.yaml'), 'utf8').split('\n').slice(1).join('\n'));
  assert.equal(values.replicaCount, 5);
});

test('HPA y recursos se aplican con helm upgrade sin reconstruir', async (t) => {
  const { ctx, config, c, id, close } = await deployedZipProject();
  t.after(close);
  const tag = ctx.projects.get(id).current_tag;
  await c.get(`/projects/${id}/settings`);
  let r = await c.post(`/projects/${id}/autoscaling`, {
    form: { _csrf: c.csrf, autoscaling_enabled: 'on', autoscaling_min: '2', autoscaling_max: '6', autoscaling_cpu: '70' },
  });
  assert.match(r.headers.get('location'), /^\/deployments\/\d+$/);
  await ctx.queue.idle();
  const cmds = ctx.exec.history.map(cmdline);
  assert.ok(!cmds.some((x) => x.startsWith('minikube image build')), 'no reconstruye');
  assert.ok(cmds.some((x) => x.startsWith('helm upgrade --install web')));
  const values = JSON.parse(fs.readFileSync(path.join(config.workspacesDir, 'web', 'values.yaml'), 'utf8').split('\n').slice(1).join('\n'));
  assert.deepEqual(values.autoscaling, { enabled: true, minReplicas: 2, maxReplicas: 6, targetCPUUtilizationPercentage: 70 });
  assert.equal(values.image.tag, tag);

  // Con HPA activo no se permite escalar a mano.
  ctx.exec.clearHistory();
  await c.get(`/projects/${id}/settings`);
  await c.post(`/projects/${id}/scale`, { form: { _csrf: c.csrf, replicas: '3' } });
  assert.equal(ctx.exec.history.length, 0);

  // Mínimo > máximo se rechaza.
  r = await c.post(`/projects/${id}/autoscaling`, { form: { _csrf: c.csrf, autoscaling_enabled: 'on', autoscaling_min: '5', autoscaling_max: '2', autoscaling_cpu: '70' } });
  let page = await c.get(`/projects/${id}/settings`);
  assert.match(page.text, /mínimo del HPA no puede superar/);

  // Recursos: inválidos se rechazan; válidos redespliegan.
  r = await c.post(`/projects/${id}/resources`, { form: { _csrf: c.csrf, cpu_request: '1', cpu_limit: '500m', memory_request: '128Mi', memory_limit: '256Mi' } });
  page = await c.get(`/projects/${id}/settings`);
  assert.match(page.text, /CPU solicitada no puede superar/);
  r = await c.post(`/projects/${id}/resources`, { form: { _csrf: c.csrf, cpu_request: '200m', cpu_limit: '1', memory_request: '256Mi', memory_limit: '512Mi' } });
  assert.match(r.headers.get('location'), /^\/deployments\/\d+$/);
  await ctx.queue.idle();
  const v2 = JSON.parse(fs.readFileSync(path.join(config.workspacesDir, 'web', 'values.yaml'), 'utf8').split('\n').slice(1).join('\n'));
  assert.deepEqual(v2.resources, { requests: { cpu: '200m', memory: '256Mi' }, limits: { cpu: '1', memory: '512Mi' } });
});

test('reinicio manual y redeploy manual', async (t) => {
  const { ctx, c, id, close } = await deployedZipProject();
  t.after(close);
  await c.get(`/projects/${id}/settings`);
  await c.post(`/projects/${id}/restart`, { form: { _csrf: c.csrf } });
  await ctx.queue.idle();
  assert.equal(cmdline(ctx.exec.history.at(-1)), 'kubectl rollout restart deployment -n tenant-web -l app.kubernetes.io/instance=web');
});

test('logs de pods por SSE (DRY_RUN): kubectl logs -f con selector', async (t) => {
  const { ctx, srv, c, id, close } = await deployedZipProject();
  t.after(close);
  const page = await c.get(`/projects/${id}/logs`);
  assert.match(page.text, /data-stream="\/projects\/\d+\/logs\/stream"/);
  const s = await readSse(srv.base, c, `/projects/${id}/logs/stream`);
  assert.deepEqual(s.events.map((e) => e.event), ['reset', 'end']);
  assert.match(s.events[1].data, /DRY_RUN/);
  assert.equal(
    cmdline(ctx.exec.history.at(-1)),
    'kubectl logs -n tenant-web -l app.kubernetes.io/instance=web --all-containers=true --prefix=true --follow=true --tail=200 --max-log-requests=10',
  );
});

test('ajustes de git: cambiar rama y token; borrar token', async (t) => {
  const { ctx, c, close } = await boot();
  t.after(close);
  const id = await createProject(c, { name: 'api', source: 'git', repo_url: 'https://github.com/a/b.git', branch: 'main', git_token: 'tok-viejo' });
  await c.get(`/projects/${id}/settings`);
  await c.post(`/projects/${id}/git`, { form: { _csrf: c.csrf, repo_url: 'https://github.com/a/b.git', branch: 'release/2', git_token: 'tok-nuevo' } });
  let p = ctx.projects.get(id);
  assert.equal(p.branch, 'release/2');
  assert.equal(ctx.projects.gitToken(p), 'tok-nuevo');
  const page = await c.get(`/projects/${id}/settings`);
  assert.ok(!page.text.includes('tok-nuevo'));
  await c.post(`/projects/${id}/git`, { form: { _csrf: c.csrf, repo_url: 'https://github.com/a/b.git', branch: 'release/2', clear_token: 'on' } });
  p = ctx.projects.get(id);
  assert.equal(ctx.projects.gitToken(p), '');
  await c.post(`/projects/${id}/git`, { form: { _csrf: c.csrf, repo_url: 'git@github.com:a/b.git', branch: 'main' } });
  assert.equal(ctx.projects.get(id).repo_url, 'https://github.com/a/b.git');
});
