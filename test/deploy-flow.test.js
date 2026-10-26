import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createExec, ExecError } from '../src/lib/exec.js';
import { silentLogger } from './helpers/setup.js';
import { buildZip } from './helpers/zip.js';
import { SECRET, boot, createProject, uploadZip, cmdline, readSse } from './helpers/app.js';

test('flujo zip completo en DRY_RUN: secuencia exacta de comandos', async (t) => {
  const { ctx, config, srv, c, close } = await boot();
  t.after(close);
  const ws = path.join(config.workspacesDir, 'web');

  const id = await createProject(c, { name: 'web', source: 'zip', tls_form: '1' });
  ctx.exec.clearHistory();

  const r = await uploadZip(c, id, [{ name: 'index.html', data: '<h1>hola</h1>' }]);
  assert.equal(r.status, 302, r.text);
  const depId = Number(r.headers.get('location').split('/').pop());
  await ctx.queue.idle();

  const dep = ctx.db.prepare('SELECT * FROM deployments WHERE id = ?').get(depId);
  assert.equal(dep.status, 'success', dep.log);
  assert.equal(dep.kind, 'build');
  assert.equal(dep.stack, 'static');
  assert.equal(dep.tag, '20260102030505');
  assert.equal(dep.helm_revision, 1);
  assert.equal(dep.triggered_by, 'admin');
  assert.equal(dep.source_ref, 'sitio.zip');

  assert.deepEqual(ctx.exec.history.map(cmdline), [
    `minikube image build -t web:20260102030505 ${ws}/src`,
    'kubectl apply -f -',
    'kubectl apply -n tenant-web -f -',
    `helm upgrade --install web ${config.chartPath} --namespace tenant-web -f ${ws}/values.yaml --wait --timeout 5m --history-max 10`,
    'helm history web --namespace tenant-web --max 20 -o json',
  ]);
  // Las plantillas y el Secret van por stdin, nunca como argumentos.
  assert.ok(ctx.exec.history[1].stdinBytes > 500);
  assert.ok(ctx.exec.history[2].stdinBytes > 50);

  // Dockerfile generado en el workspace y values.yaml sin secretos.
  assert.match(fs.readFileSync(path.join(ws, 'src', 'Dockerfile'), 'utf8'), /FROM nginx:alpine/);
  const valuesText = fs.readFileSync(path.join(ws, 'values.yaml'), 'utf8');
  assert.ok(!valuesText.includes(SECRET));
  const values = JSON.parse(valuesText.split('\n').slice(1).join('\n'));
  assert.deepEqual(values.image, { repository: 'web', tag: '20260102030505', pullPolicy: 'Never' });
  assert.equal(values.replicaCount, 2);
  assert.equal(values.containerPort, 80);
  assert.deepEqual(values.ingress.hosts, [{ host: 'web.paas.local', paths: [{ path: '/', pathType: 'Prefix' }] }]);
  assert.equal(values.ingress.className, 'nginx');
  assert.deepEqual(values.envFrom, [{ secretRef: { name: 'web-env' } }]);
  assert.deepEqual(values.resources, { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '500m', memory: '256Mi' } });
  assert.equal(values.autoscaling.enabled, false);
  assert.equal((fs.statSync(path.join(ws, 'values.yaml')).mode & 0o777).toString(8), '600');

  // El zip queda como "último" y la subida temporal se limpia.
  assert.ok(fs.existsSync(path.join(ws, 'source.zip')));
  assert.deepEqual(fs.readdirSync(path.join(ws, 'uploads')), []);

  // Ningún secreto en el log ni en el historial de comandos.
  assert.ok(!dep.log.includes(SECRET));
  assert.ok(!JSON.stringify(ctx.exec.history).includes(SECRET));
  assert.match(dep.log, /Stack detectado: Sitio estático/);
  assert.match(dep.log, /\[DRY_RUN\] \$ helm upgrade --install web/);

  const p = ctx.projects.get(id);
  assert.equal(p.status, 'live');
  assert.equal(p.current_tag, '20260102030505');

  // SSE de un despliegue terminado: todas las líneas + status + end; reanuda con Last-Event-ID.
  const s = await readSse(srv.base, c, `/deployments/${depId}/stream`);
  assert.equal(s.status, 200);
  assert.match(s.type, /text\/event-stream/);
  const lines = s.events.filter((e) => e.event === 'line');
  assert.ok(lines.length > 5);
  assert.equal(s.events.at(-1).event, 'end');
  assert.equal(s.events.at(-1).data, 'success');
  const resumed = await readSse(srv.base, c, `/deployments/${depId}/stream`, { 'last-event-id': String(lines.length - 3) });
  assert.equal(resumed.events.filter((e) => e.event === 'line').length, 2);

  // Páginas de historial y detalle.
  const hist = await c.get(`/projects/${id}/deployments`);
  assert.match(hist.text, /20260102030505/);
  const det = await c.get(`/deployments/${depId}`);
  assert.match(det.text, /data-stream="\/deployments\/\d+\/stream"/);
});

test('rebuild, limpieza de imágenes (KEEP_IMAGES=2) y rollback por helm', async (t) => {
  const { ctx, c, close } = await boot({ env: { KEEP_IMAGES: '2' } });
  t.after(close);
  const id = await createProject(c, { name: 'web', source: 'zip' });
  const rebuild = async () => {
    await c.get(`/projects/${id}/deployments`);
    const r = await c.post(`/projects/${id}/deploy/rebuild`, { form: { _csrf: c.csrf } });
    assert.equal(r.status, 302);
    await ctx.queue.idle();
    return ctx.db.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC').get(id);
  };

  await uploadZip(c, id, [{ name: 'index.html', data: 'v1' }]);
  await ctx.queue.idle();
  const first = ctx.db.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY id').get(id);
  const second = await rebuild();
  assert.equal(second.status, 'success', second.log);
  assert.notEqual(second.tag, first.tag);
  assert.equal(second.helm_revision, 2);

  ctx.exec.clearHistory();
  const third = await rebuild();
  assert.equal(third.helm_revision, 3);
  // Con KEEP_IMAGES=2 el tercer build borra la imagen del primero.
  assert.equal(cmdline(ctx.exec.history.at(-1)), `minikube image rm web:${first.tag}`);
  assert.equal(ctx.db.prepare('SELECT image_pruned FROM deployments WHERE id = ?').pluck().get(first.id), 1);

  // Sin imagen, el primer despliegue ya no se acepta como destino de rollback.
  await c.get(`/projects/${id}/deployments`);
  let r = await c.post(`/projects/${id}/deployments/${first.id}/rollback`, { form: { _csrf: c.csrf } });
  assert.equal(r.headers.get('location'), `/projects/${id}/deployments`);
  assert.equal(ctx.queue.stats().queued, 0);

  // Rollback al segundo: helm rollback a su revisión.
  ctx.exec.clearHistory();
  await c.get(`/projects/${id}/deployments`);
  r = await c.post(`/projects/${id}/deployments/${second.id}/rollback`, { form: { _csrf: c.csrf } });
  assert.match(r.headers.get('location'), /^\/deployments\/\d+$/);
  await ctx.queue.idle();
  assert.deepEqual(ctx.exec.history.map(cmdline), [
    'helm rollback web 2 --namespace tenant-web --wait --timeout 5m',
    'helm history web --namespace tenant-web --max 20 -o json',
  ]);
  const rb = ctx.db.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY id DESC').get(id);
  assert.equal(rb.kind, 'rollback');
  assert.equal(rb.status, 'success', rb.log);
  assert.equal(rb.rollback_of, second.id);
  assert.equal(rb.helm_revision, 4);
  assert.equal(ctx.projects.get(id).current_tag, second.tag);
});

test('flujo git en DRY_RUN: clone con token por GIT_CONFIG_* y nunca en argumentos', async (t) => {
  const { ctx, config, c, close } = await boot();
  t.after(close);
  const token = 'ghp_TokenSuperSecreto987';
  const id = await createProject(c, { name: 'api', source: 'git', repo_url: 'https://github.com/acme/api.git', branch: 'develop', git_token: token, port: '3000', tls_form: '1' });
  ctx.exec.clearHistory();

  await c.get(`/projects/${id}/deployments`);
  const r = await c.post(`/projects/${id}/deploy/git`, { form: { _csrf: c.csrf } });
  assert.equal(r.status, 302);
  await ctx.queue.idle();
  const ws = path.join(config.workspacesDir, 'api');
  const dep = ctx.db.prepare('SELECT * FROM deployments WHERE project_id = ?').get(id);
  assert.equal(dep.status, 'success', dep.log);

  assert.deepEqual(ctx.exec.history.map(cmdline), [
    `git clone --depth 1 --branch develop --single-branch --no-tags -- https://github.com/acme/api.git ${ws}/src`,
    `git -C ${ws}/src rev-parse --short=7 HEAD`,
    `minikube image build -t api:${dep.tag} ${ws}/src`,
    'kubectl apply -f -',
    'kubectl apply -n tenant-api -f -',
    `helm upgrade --install api ${config.chartPath} --namespace tenant-api -f ${ws}/values.yaml --wait --timeout 5m --history-max 10`,
    'helm history api --namespace tenant-api --max 20 -o json',
  ]);
  assert.deepEqual(ctx.exec.history[0].envKeys.sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_TERMINAL_PROMPT']);
  const dump = JSON.stringify(ctx.exec.history) + dep.log;
  assert.ok(!dump.includes(token));
  assert.ok(!dump.includes(Buffer.from(`x-access-token:${token}`).toString('base64')));
  assert.match(dep.log, /DRY_RUN\] No hay código clonado/);
});

test('el header de auth de git queda limitado al origen del repo', async () => {
  const { gitAuthEnv } = await import('../src/services/git.js');
  const env = gitAuthEnv('https://gitlab.example.com:8443/g/r.git', 'tok123');
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://gitlab.example.com:8443/.extraheader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Basic ${Buffer.from('x-access-token:tok123').toString('base64')}`);
  assert.deepEqual(gitAuthEnv('https://github.com/a/b', ''), { GIT_TERMINAL_PROMPT: '0' });
});

test('si helm falla: despliegue fallido, error guardado, estado del proyecto y zip limpiado', async (t) => {
  const base = createExec({ dryRun: true, logger: silentLogger });
  const exec = {
    ...base,
    run: async (cmd, args, opts) => {
      if (cmd === 'helm' && args[0] === 'upgrade') throw new ExecError(`helm terminó con código 1: Error: timed out waiting for the condition (${SECRET})`);
      return base.run(cmd, args, opts);
    },
  };
  const { ctx, config, c, close } = await boot({ exec });
  t.after(close);
  const id = await createProject(c, { name: 'web', source: 'zip' });
  await uploadZip(c, id, [{ name: 'index.html', data: 'x' }]);
  await ctx.queue.idle();
  const dep = ctx.db.prepare('SELECT * FROM deployments WHERE project_id = ?').get(id);
  assert.equal(dep.status, 'failed');
  assert.match(dep.error, /timed out/);
  assert.match(dep.log, /==> ERROR/);
  assert.equal(ctx.projects.get(id).status, 'failed');
  assert.equal(ctx.projects.get(id).current_tag, null);
  assert.deepEqual(fs.readdirSync(path.join(config.workspacesDir, 'web', 'uploads')), []);
  assert.ok(!fs.existsSync(path.join(config.workspacesDir, 'web', 'source.zip')));
});

test('subidas inválidas: no-zip, zip-slip y tamaño máximo', async (t) => {
  const { ctx, c, close } = await boot({ env: { MAX_UPLOAD_MB: '1' } });
  t.after(close);
  const id = await createProject(c, { name: 'web', source: 'zip' });

  let r = await uploadZip(c, id, [{ name: '../../etc/evil', data: 'x' }]);
  assert.equal(r.status, 302);
  let page = await c.get(`/projects/${id}/deployments`);
  assert.match(page.text, /no permitida en el zip/);

  const fd = new FormData();
  fd.append('archive', new Blob(['hola'], { type: 'text/plain' }), 'nota.txt');
  r = await c.post(`/projects/${id}/deploy/zip?_csrf=${encodeURIComponent(c.csrf)}`, { body: fd });
  page = await c.get(`/projects/${id}/deployments`);
  assert.match(page.text, /Solo se aceptan archivos \.zip/);

  const big = new FormData();
  big.append('archive', new Blob([Buffer.alloc(2 * 1024 * 1024)], { type: 'application/zip' }), 'grande.zip');
  r = await c.post(`/projects/${id}/deploy/zip?_csrf=${encodeURIComponent(c.csrf)}`, { body: big });
  page = await c.get(`/projects/${id}/deployments`);
  assert.match(page.text, /supera el máximo de 1 MB/);

  // Sin token CSRF la subida se rechaza antes de procesar el archivo.
  const fd2 = new FormData();
  fd2.append('archive', new Blob([buildZip([{ name: 'index.html', data: 'x' }])], { type: 'application/zip' }), 'ok.zip');
  r = await c.post(`/projects/${id}/deploy/zip`, { body: fd2 });
  assert.equal(r.status, 403);

  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM deployments').pluck().get(), 0);
});

test('borrar un proyecto desplegado: helm uninstall, namespace, imágenes y workspace', async (t) => {
  const { ctx, config, c, close } = await boot();
  t.after(close);
  const id = await createProject(c, { name: 'web', source: 'zip' });
  await uploadZip(c, id, [{ name: 'index.html', data: 'x' }]);
  await ctx.queue.idle();
  const tag = ctx.projects.get(id).current_tag;
  await c.get(`/projects/${id}`);
  ctx.exec.clearHistory();
  const r = await c.post(`/projects/${id}/delete`, { form: { _csrf: c.csrf, confirm_name: 'web' } });
  assert.equal(r.status, 302);
  assert.deepEqual(ctx.exec.history.map(cmdline), [
    'helm uninstall web --namespace tenant-web --wait --timeout 5m',
    'kubectl delete namespace tenant-web --ignore-not-found=true --wait=false',
    `minikube image rm web:${tag}`,
  ]);
  assert.ok(!fs.existsSync(path.join(config.workspacesDir, 'web')));
  assert.equal(ctx.db.prepare('SELECT COUNT(*) FROM deployments').pluck().get(), 0);
});

test('SSE en vivo durante el build y reconexión con Last-Event-ID', async (t) => {
  const base = createExec({ dryRun: true, logger: silentLogger });
  let release;
  const gate = new Promise((r) => (release = r));
  const exec = {
    ...base,
    run: async (cmd, args, opts) => {
      if (cmd === 'minikube' && args[1] === 'build') {
        opts.onLine?.('Step 1/3 : FROM nginx:alpine', 'stdout');
        await gate;
        opts.onLine?.('Successfully built', 'stdout');
      }
      return base.run(cmd, args, opts);
    },
  };
  const { ctx, srv, c, close } = await boot({ exec });
  t.after(close);
  const id = await createProject(c, { name: 'web', source: 'zip' });
  const r = await uploadZip(c, id, [{ name: 'index.html', data: 'x' }]);
  const depId = Number(r.headers.get('location').split('/').pop());
  while (ctx.queue.stats().running !== depId) await new Promise((x) => setTimeout(x, 10));
  await new Promise((x) => setTimeout(x, 30));

  const cookie = [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${srv.base}/deployments/${depId}/stream`, { headers: { cookie } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (!buf.includes('Step 1/3')) buf += dec.decode((await reader.read()).value);
  assert.match(buf, /event: status\ndata: building/);
  const ids = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  const lastId = ids.at(-1);
  await reader.cancel(); // simula una desconexión

  // Reconecta pidiendo solo lo posterior a lastId y deja terminar el build.
  const res2 = fetch(`${srv.base}/deployments/${depId}/stream`, { headers: { cookie, 'last-event-id': String(lastId) } });
  release();
  const text = await (await res2).text();
  const ids2 = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
  assert.ok(ids2.length > 0);
  assert.ok(ids2.every((x) => x > lastId), 'no repite líneas ya recibidas');
  assert.doesNotMatch(text, /Step 1\/3/);
  assert.match(text, /Successfully built/);
  assert.match(text, /event: end\ndata: success/);
});
