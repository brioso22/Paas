import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';
import { testEnv } from './helpers/setup.js';

test('configuración válida con valores por defecto', () => {
  const c = loadConfig(testEnv());
  assert.equal(c.port, 8080);
  assert.equal(c.domain, 'paas.local');
  assert.equal(c.ingressIp, '192.168.49.2');
  assert.equal(c.ingressNodePort, 32134);
  assert.equal(c.tenantPrefix, 'tenant-');
  assert.equal(c.keepImages, 3);
  assert.equal(c.priceCpuHour, 0.05);
  assert.equal(c.secretsKey.length, 32);
});

test('errores claros y acumulados', () => {
  const env = testEnv({ SESSION_SECRET: 'corto', SECRETS_KEY: 'bm8=', PORT: 'abc', INGRESS_IP: 'x', PUBLISH_PROVIDER: 'cloudflare-tunnel', DRY_RUN: 'quizá' });
  try {
    loadConfig(env);
    assert.fail('debía fallar');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    const msg = err.message;
    for (const k of ['SESSION_SECRET', 'SECRETS_KEY', 'PORT', 'INGRESS_IP', 'PUBLISH_PROVIDER', 'DRY_RUN']) assert.match(msg, new RegExp(k));
  }
});

test('rechaza los valores de ejemplo fuera de test', () => {
  const env = testEnv({ NODE_ENV: 'production', SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' });
  assert.throws(() => loadConfig(env), /valor de ejemplo/);
});

test('SESSION_SECRET y SECRETS_KEY son obligatorios', () => {
  const env = testEnv();
  delete env.SESSION_SECRET;
  delete env.SECRETS_KEY;
  assert.throws(() => loadConfig(env), /SESSION_SECRET es obligatorio[\s\S]*SECRETS_KEY es obligatorio/);
});
