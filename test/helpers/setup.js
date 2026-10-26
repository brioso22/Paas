import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config.js';

export const silentLogger = { info() {}, warn() {}, error() {} };

export function tmpDir(prefix = 'paas-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function testEnv(overrides = {}) {
  const base = tmpDir();
  return {
    NODE_ENV: 'test',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    SECRETS_KEY: crypto.randomBytes(32).toString('base64'),
    DATA_DIR: path.join(base, 'data'),
    WORKSPACES_DIR: path.join(base, 'workspaces'),
    CHART_PATH: path.join(base, 'chart'),
    DRY_RUN: 'true',
    PROMETHEUS_URL: 'http://127.0.0.1:9',
    PUBLIC_BASE_URL: 'https://panel.example.test',
    ...overrides,
  };
}

export function testConfig(overrides = {}) {
  return loadConfig(testEnv(overrides));
}

/** Levanta la app en un puerto efímero y devuelve un cliente con cookie jar. */
export async function startServer(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    client: () => createClient(base),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export function createClient(base) {
  const jar = new Map();
  let csrf = '';

  async function request(method, url, { form, json, body, headers = {}, raw = false } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload = body;
    if (form) {
      h['content-type'] = 'application/x-www-form-urlencoded';
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, x));
        else p.append(k, v);
      }
      payload = p.toString();
    }
    if (json) {
      h['content-type'] = 'application/json';
      payload = JSON.stringify(json);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const text = raw ? null : await res.text();
    if (text) {
      const m = text.match(/<meta name="csrf-token" content="([^"]*)"/);
      if (m && m[1]) csrf = m[1];
    }
    return { status: res.status, headers: res.headers, text, res };
  }

  return {
    get: (url, o) => request('GET', url, o),
    post: (url, o) => request('POST', url, o),
    request,
    get csrf() {
      return csrf;
    },
    jar,
  };
}

/** Crea el admin vía /setup y deja el cliente logueado. */
export async function setupAdmin(client, { username = 'admin', password = 'contraseña-segura-123' } = {}) {
  await client.get('/setup');
  const r = await client.post('/setup', { form: { _csrf: client.csrf, username, password, password2: password } });
  if (r.status !== 302) throw new Error(`setup falló: ${r.status} ${r.text?.slice(0, 300)}`);
  await client.get('/');
  return { username, password };
}
