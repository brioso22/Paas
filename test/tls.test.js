import test from 'node:test';
import assert from 'node:assert/strict';
import { certExtensions, renderTlsSecret } from '../src/services/tls.js';
import { buildValues } from '../src/services/helm.js';

const project = { name: 'web', namespace: 'tenant-web', port: 80, replicas: 1, autoscaling_enabled: 0, autoscaling_min: 1, autoscaling_max: 3, autoscaling_cpu: 80, cpu_request: '100m', cpu_limit: '200m', memory_request: '64Mi', memory_limit: '128Mi' };

test('extensiones del certificado: SAN con todos los hosts, no CA, serverAuth', () => {
  const e = certExtensions(['web.paas.local', 'www.ejemplo.com']);
  assert.match(e, /^subjectAltName=DNS:web\.paas\.local,DNS:www\.ejemplo\.com$/m);
  assert.match(e, /basicConstraints=CA:FALSE/);
  assert.match(e, /extendedKeyUsage=serverAuth/);
});

test('Secret TLS tipo kubernetes.io/tls con PEM en base64', () => {
  const s = JSON.parse(renderTlsSecret(project, 'CERT', 'KEY'));
  assert.equal(s.type, 'kubernetes.io/tls');
  assert.equal(s.metadata.name, 'web-tls');
  assert.equal(Buffer.from(s.data['tls.key'], 'base64').toString(), 'KEY');
});

test('values: ingress.tls solo con HTTPS activo y con todos los hosts', () => {
  const hosts = ['web.paas.local', 'www.ejemplo.com'];
  assert.deepEqual(buildValues(project, { tag: 't', hosts }).ingress.tls, []);
  const v = buildValues({ ...project, tls_enabled: 1 }, { tag: 't', hosts });
  assert.deepEqual(v.ingress.tls, [{ secretName: 'web-tls', hosts }]);
  assert.deepEqual(v.ingress.hosts.map((h) => h.host), hosts);
});
