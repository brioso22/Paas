import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublisher, PROVIDERS } from '../src/services/publisher/index.js';
import { PublishProvider, NotImplementedError } from '../src/services/publisher/provider.js';
import { testConfig } from './helpers/setup.js';
import { deployedZipProject } from './helpers/app.js';

const ctx = { config: testConfig() };
const project = { name: 'web', namespace: 'tenant-web' };

test('todos los proveedores implementan la interfaz PublishProvider', () => {
  for (const [name, P] of Object.entries(PROVIDERS)) {
    const p = new P(ctx);
    assert.ok(p instanceof PublishProvider, name);
    assert.equal(p.name, name);
    for (const m of ['expose', 'unexpose', 'status']) assert.equal(typeof p[m], 'function', `${name}.${m}`);
  }
});

test('provider none: no expone y describe el acceso local', async () => {
  const p = createPublisher(ctx, 'none');
  const s = await p.status(project);
  assert.deepEqual(Object.keys(s).sort(), ['exposed', 'message', 'url']);
  assert.equal(s.exposed, false);
  assert.equal(s.url, 'http://web.paas.local');
  assert.match(s.message, /192\.168\.49\.2:32134/);
  assert.deepEqual(await p.expose(project), s);
  assert.equal((await p.unexpose(project)).exposed, false);
});

test('los stubs fallan explícitamente con NotImplementedError', async () => {
  for (const name of ['tailscale-funnel', 'cloudflare-tunnel']) {
    const p = createPublisher(ctx, name);
    for (const m of ['expose', 'unexpose', 'status']) await assert.rejects(p[m](project), NotImplementedError, `${name}.${m}`);
  }
  assert.throws(() => createPublisher(ctx, 'ngrok'), /desconocido/);
});

test('el despliegue registra el resultado de la publicación', async (t) => {
  const { ctx: app, id, close } = await deployedZipProject();
  t.after(close);
  const dep = app.db.prepare('SELECT log FROM deployments WHERE project_id = ?').get(id);
  assert.match(dep.log, /Publicación \(none\): Sin publicación externa/);
});

test('un fallo del proveedor no marca el despliegue como fallido', async (t) => {
  const { ctx: app, c, id, close } = await deployedZipProject();
  t.after(close);
  app.publisher.expose = async () => {
    throw new Error('túnel caído');
  };
  await c.get(`/projects/${id}/deployments`);
  await c.post(`/projects/${id}/deploy/apply`, { form: { _csrf: c.csrf } });
  await app.queue.idle();
  const dep = app.db.prepare('SELECT status, log FROM deployments ORDER BY id DESC').get();
  assert.equal(dep.status, 'success');
  assert.match(dep.log, /la publicación externa falló: túnel caído/);
});
