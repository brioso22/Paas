import assert from 'node:assert/strict';
import { createContext } from '../../src/context.js';
import { createApp } from '../../src/app.js';
import { testConfig, silentLogger, startServer, setupAdmin } from './setup.js';
import { buildZip } from './zip.js';

export const SECRET = 'valor-ultra-secreto-42';

export function clock(start = Date.parse('2026-01-02T03:04:05Z')) {
  let t = start;
  return () => new Date((t += 60_000));
}

export async function boot({ env = {}, exec } = {}) {
  const config = testConfig(env);
  const ctx = createContext(config, { logger: silentLogger, now: clock(), exec });
  const srv = await startServer(createApp(ctx));
  const c = srv.client();
  await setupAdmin(c);
  return { ctx, config, srv, c, close: async () => (await srv.close(), ctx.close()) };
}

export async function createProject(c, form) {
  await c.get('/projects/new');
  const r = await c.post('/projects', {
    form: {
      _csrf: c.csrf,
      port: '80',
      cpu_request: '100m',
      cpu_limit: '500m',
      memory_request: '128Mi',
      memory_limit: '256Mi',
      replicas: '2',
      env: `DB_PASS=${SECRET}\nAPP_ENV=produccion`,
      ...form,
    },
  });
  assert.equal(r.status, 302, r.text?.slice(0, 400));
  return Number(r.headers.get('location').split('/').pop());
}

export async function uploadZip(c, projectId, entries, filename = 'sitio.zip') {
  await c.get(`/projects/${projectId}/deployments`);
  const fd = new FormData();
  fd.append('archive', new Blob([buildZip(entries)], { type: 'application/zip' }), filename);
  return c.post(`/projects/${projectId}/deploy/zip?_csrf=${encodeURIComponent(c.csrf)}`, { body: fd });
}

export const cmdline = (h) => [h.cmd, ...h.args].join(' ');

export async function readSse(base, c, url, headers = {}) {
  const res = await fetch(base + url, { headers: { cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; '), ...headers } });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((b) => b.includes('event:'))
    .map((b) => {
      const ev = {};
      for (const line of b.split('\n')) {
        const i = line.indexOf(': ');
        if (i > 0) ev[line.slice(0, i)] = line.slice(i + 2);
      }
      return ev;
    });
  return { status: res.status, type: res.headers.get('content-type'), events };
}


/** Proyecto zip ya desplegado (para tests de gestión). */
export async function deployedZipProject(env = {}, opts = {}) {
  const app = await boot({ env, ...opts });
  const id = await createProject(app.c, { name: 'web', source: 'zip' });
  await uploadZip(app.c, id, [{ name: 'index.html', data: 'x' }]);
  await app.ctx.queue.idle();
  app.ctx.exec.clearHistory();
  return { ...app, id };
}
