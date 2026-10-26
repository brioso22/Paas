import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate, renderTenantManifests, tenantParams, renderEnvSecret } from '../src/services/templates.js';

const project = {
  name: 'demo',
  namespace: 'tenant-demo',
  replicas: 2,
  autoscaling_enabled: 0,
  autoscaling_max: 5,
  cpu_request: '100m',
  cpu_limit: '0.5',
  memory_request: '128Mi',
  memory_limit: '1Gi',
};

test('renderTemplate sustituye parámetros y falla si falta alguno', () => {
  assert.equal(renderTemplate('a: "{{ x }}" b: {{y}}', { x: '1', y: 'dos' }), 'a: "1" b: dos');
  assert.throws(() => renderTemplate('{{ falta }}', {}), /Falta el parámetro/);
});

test('renderTemplate rechaza valores que podrían inyectar YAML', () => {
  for (const evil of ['a"\nkind: Secret', 'x: y', 'a b', '{}', "a'", 'x'.repeat(64)])
    assert.throws(() => renderTemplate('v: "{{ v }}"', { v: evil }), /no permitido/, evil);
});

test('parámetros del tenant: cuota = (réplicas máx + 1) x límites', () => {
  const p = tenantParams(project);
  assert.equal(p.quotaRequestsCpu, '300m');
  assert.equal(p.quotaLimitsCpu, '1500m');
  assert.equal(p.quotaRequestsMemory, '384Mi');
  assert.equal(p.quotaLimitsMemory, '3072Mi');
  assert.equal(p.quotaPods, 4);
  const hpa = tenantParams({ ...project, autoscaling_enabled: 1 });
  assert.equal(hpa.quotaLimitsCpu, '3000m');
});

test('manifiestos del tenant: namespace etiquetado, quota, limitrange y networkpolicy', () => {
  const y = renderTenantManifests(project);
  const docs = y.split('\n---\n');
  assert.equal(docs.length, 4);
  assert.match(docs[0], /kind: Namespace/);
  assert.match(docs[0], /name: "tenant-demo"/);
  assert.match(docs[0], /paas\/tenant: "true"/);
  assert.match(docs[0], /paas\/project: "demo"/);

  assert.match(docs[1], /kind: ResourceQuota/);
  assert.match(docs[1], /limits\.cpu: "1500m"/);
  assert.match(docs[1], /persistentvolumeclaims: "4"/);
  assert.match(docs[1], /requests\.storage: "10Gi"/);

  assert.match(docs[2], /kind: LimitRange/);
  assert.match(docs[2], /max:\n\s+cpu: "0\.5"\n\s+memory: "1Gi"/);

  const np = docs[3];
  assert.match(np, /kind: NetworkPolicy/);
  assert.match(np, /namespace: "tenant-demo"/);
  assert.match(np, /podSelector: \{\}\n\s+policyTypes:\n\s+- Ingress/);
  assert.match(np, /kubernetes\.io\/metadata\.name: monitoring/);
  assert.match(np, /kubernetes\.io\/metadata\.name: ingress-nginx/);
  // Solo tres reglas "from": propio namespace, monitoring e ingress-nginx.
  assert.equal(np.match(/- from:/g).length, 3);
  assert.doesNotMatch(y, /\{\{/);
});

test('Secret de variables en JSON con base64', () => {
  const s = JSON.parse(renderEnvSecret(project, new Map([['DB_PASS', 'p"a\ns']])));
  assert.equal(s.kind, 'Secret');
  assert.equal(s.metadata.name, 'demo-env');
  assert.equal(s.metadata.namespace, 'tenant-demo');
  assert.equal(Buffer.from(s.data.DB_PASS, 'base64').toString(), 'p"a\ns');
});
