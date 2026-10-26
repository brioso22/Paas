import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { computeCosts, queriesFor, createMetrics } from '../src/services/metrics.js';
import { openDb } from '../src/db.js';
import { boot, createProject } from './helpers/app.js';

const GIB = 1024 ** 3;

function fakePrometheus(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      const q = new URL(req.url, 'http://x').searchParams.get('query');
      seen.push(q);
      const value = handler(q);
      if (value === 'hang') return; // no responde nunca
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({ status: 'success', data: { resultType: 'vector', result: value === null ? [] : [{ metric: {}, value: [1700000000, String(value)] }] } }),
      );
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, seen, close: () => (srv.closeAllConnections(), srv.close()) }));
  });
}

test('consultas PromQL filtradas por namespace', () => {
  const q = queriesFor('tenant-web');
  assert.match(q.cpu, /container_cpu_usage_seconds_total\{namespace="tenant-web",container!="",container!="POD"\}\[5m\]/);
  assert.match(q.mem, /container_memory_working_set_bytes\{namespace="tenant-web"/);
  assert.match(q.rx, /container_network_receive_bytes_total\{namespace="tenant-web"\}/);
  assert.match(q.tx, /container_network_transmit_bytes_total/);
  assert.match(q.cpuAvg24, /avg_over_time\(\(sum\(rate\(.*\)\)\)\[24h:5m\]\)/);
  assert.match(q.rx24, /increase\(.*\[24h\]\)/);
  assert.match(queriesFor('a"b').cpu, /namespace="a\\"b"/);
});

test('cálculo de costos: por hora, 24 h y proyección a 30 días', () => {
  const prices = { cpuHour: 0.05, ramGbHour: 0.01 };
  const c = computeCosts({ cpu: 0.5, mem: 2 * GIB, cpuAvg24: 0.2, memAvg24: 1 * GIB }, prices);
  assert.equal(c.hour.toFixed(6), (0.5 * 0.05 + 2 * 0.01).toFixed(6));
  const avgHour = 0.2 * 0.05 + 1 * 0.01;
  assert.equal(c.last24h.toFixed(6), (avgHour * 24).toFixed(6));
  assert.equal(c.projection30d.toFixed(6), (avgHour * 720).toFixed(6));
  assert.match(c.basis, /24 h/);
  // Sin datos de 24 h se proyecta con el consumo actual.
  const now = computeCosts({ cpu: 1, mem: 0, cpuAvg24: null, memAvg24: null }, prices);
  assert.equal(now.last24h, null);
  assert.equal(now.projection30d.toFixed(4), (0.05 * 720).toFixed(4));
  // Sin nada: todo nulo.
  assert.deepEqual(computeCosts({ cpu: null, mem: null, cpuAvg24: null, memAvg24: null }, prices), { hour: null, last24h: null, projection30d: null, basis: 'consumo actual' });
});

test('consulta Prometheus real (servidor falso) y usa precios de la BD si existen', async (t) => {
  const prom = await fakePrometheus((q) => (q.startsWith('avg_over_time((sum(rate') ? 0.25 : q.includes('cpu_usage') ? 0.5 : q.includes('memory') ? GIB : q.includes('receive') ? 1000 : null));
  t.after(prom.close);
  const db = openDb(':memory:');
  const m = createMetrics({ config: { prometheusUrl: prom.url, priceCpuHour: 0.05, priceRamGbHour: 0.01 }, db });
  m.setPrices({ cpuHour: 0.1, ramGbHour: 0.02 });
  const r = await m.forProject({ namespace: 'tenant-web' });
  assert.equal(r.available, true);
  assert.equal(r.error, null);
  assert.equal(r.metrics.cpu, 0.5);
  assert.equal(r.metrics.mem, GIB);
  assert.equal(r.metrics.rx, 1000);
  assert.equal(r.metrics.tx, null);
  assert.deepEqual(r.prices, { cpuHour: 0.1, ramGbHour: 0.02 });
  assert.equal(r.costs.hour.toFixed(4), (0.5 * 0.1 + 1 * 0.02).toFixed(4));
  assert.equal(prom.seen.length, 8);
  assert.ok(prom.seen.every((q) => q.includes('namespace="tenant-web"')));
});

test('Prometheus caído o colgado: no lanza, available=false', async (t) => {
  const db = openDb(':memory:');
  const down = createMetrics({ config: { prometheusUrl: 'http://127.0.0.1:9', priceCpuHour: 0.05, priceRamGbHour: 0.01 }, db });
  const r = await down.forProject({ namespace: 'tenant-x' });
  assert.equal(r.available, false);
  assert.match(r.error, /ECONNREFUSED|fetch failed/);
  assert.equal(r.costs.hour, null);

  const prom = await fakePrometheus(() => 'hang');
  t.after(prom.close);
  const slow = createMetrics({ config: { prometheusUrl: prom.url, priceCpuHour: 0.05, priceRamGbHour: 0.01 }, db, timeoutMs: 200 });
  const t0 = Date.now();
  const r2 = await slow.forProject({ namespace: 'tenant-x' });
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(r2.available, false);
  assert.match(r2.error, /tiempo de espera/);
});

test('página de métricas con Prometheus caído y precios editables solo por admin', async (t) => {
  const { ctx, srv, c, close } = await boot();
  t.after(close);
  const id = await createProject(c, { name: 'web', source: 'zip' });
  const page = await c.get(`/projects/${id}/metrics`);
  assert.equal(page.status, 200);
  assert.match(page.text, /No se pudo consultar Prometheus/);
  assert.match(page.text, /Proyección 30 días/);

  await c.get('/settings');
  let r = await c.post('/settings/prices', { form: { _csrf: c.csrf, cpu_hour: '0,07', ram_gb_hour: '0.015' } });
  assert.equal(r.status, 302);
  assert.deepEqual(ctx.metrics.prices(), { cpuHour: 0.07, ramGbHour: 0.015 });
  await c.get('/settings');
  await c.post('/settings/prices', { form: { _csrf: c.csrf, cpu_hour: '-1', ram_gb_hour: 'abc' } });
  const s = await c.get('/settings');
  assert.match(s.text, /Precio de CPU: usa un número/);
  assert.deepEqual(ctx.metrics.prices(), { cpuHour: 0.07, ramGbHour: 0.015 });
  assert.doesNotMatch(s.text, /SECRETS_KEY|SESSION_SECRET/);

  const bcrypt = (await import('bcryptjs')).default;
  ctx.db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('lector', ?, 'viewer')").run(bcrypt.hashSync('lector-password-1', 4));
  const v = srv.client();
  await v.get('/login');
  await v.post('/login', { form: { _csrf: v.csrf, username: 'lector', password: 'lector-password-1' } });
  // Las páginas de administración no existen para quien no es admin.
  assert.equal((await v.get('/settings')).status, 404);
  r = await v.post('/settings/prices', { form: { _csrf: v.csrf, cpu_hour: '9', ram_gb_hour: '9' } });
  assert.equal(r.status, 404);
  assert.deepEqual(ctx.metrics.prices(), { cpuHour: 0.07, ramGbHour: 0.015 });
});
