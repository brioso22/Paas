import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDbForm, checkStorageQuota, connectionEnv, renderDbManifest, explainKubeError } from '../src/services/databases.js';
import { tenantParams } from '../src/services/templates.js';

const project = { name: 'web', namespace: 'tenant-web', replicas: 1, autoscaling_enabled: 0, cpu_request: '100m', cpu_limit: '200m', memory_request: '128Mi', memory_limit: '256Mi' };

test('parseDbForm: valida nombre/motor/tamaño y aplica límites por defecto', () => {
  const pg = parseDbForm({ name: 'main-db', engine: 'postgres', size_gi: '2' });
  assert.deepEqual(pg, { name: 'main-db', engine: 'postgres', size_gi: 2, cpu_limit: '100m', memory_limit: '256Mi', cpu_request: '50m', memory_request: '128Mi' });
  assert.equal(parseDbForm({ name: 'm1', engine: 'mysql', size_gi: '1' }).memory_limit, '384Mi');
  for (const bad of [{ name: '1db' }, { name: 'A' }, { name: 'x'.repeat(22) }, { engine: 'mongo' }, { size_gi: '3' }])
    assert.throws(() => parseDbForm({ name: 'db', engine: 'postgres', size_gi: '1', ...bad }), JSON.stringify(bad));
});

test('cuota de PVC y almacenamiento con mensaje claro', () => {
  assert.doesNotThrow(() => checkStorageQuota([{ size_gi: 5 }], 5));
  assert.throws(() => checkStorageQuota([{ size_gi: 5 }, { size_gi: 2 }], 5), /almacenamiento es 10Gi/);
  assert.throws(() => checkStorageQuota([1, 1, 1, 1].map(() => ({ size_gi: 1 })), 1), /permite 4 volúmenes/);
  assert.match(explainKubeError('Error from server (Forbidden): exceeded quota: web-quota, requested: requests.storage=5Gi'), /no tiene cuota suficiente/);
});

test('variables de conexión para postgres y mysql', () => {
  const pg = connectionEnv(project, { name: 'main-db', engine: 'postgres' }, 'abc123');
  assert.equal(pg.get('DB_HOST'), 'db-main-db.tenant-web.svc.cluster.local');
  assert.equal(pg.get('DB_NAME'), 'main_db');
  assert.equal(pg.get('DATABASE_URL'), 'postgresql://app:abc123@db-main-db.tenant-web.svc.cluster.local:5432/main_db');
  const my = connectionEnv(project, { name: 'shop', engine: 'mysql' }, 'pw');
  assert.equal(my.get('DB_PORT'), '3306');
  assert.match(my.get('DATABASE_URL'), /^mysql:\/\/app:pw@db-shop\.tenant-web\.svc\.cluster\.local:3306\/shop$/);
});

test('manifiesto de BD: Secret, Service ClusterIP y StatefulSet con PVC y etiquetas', () => {
  const d = { name: 'main', engine: 'postgres', size_gi: 2, cpu_request: '50m', cpu_limit: '100m', memory_request: '128Mi', memory_limit: '256Mi' };
  const y = renderDbManifest(project, d, { password: 'f'.repeat(48) });
  const docs = y.split('\n---\n');
  assert.deepEqual(docs.map((x) => x.match(/^kind: (\w+)/m)[1]), ['Secret', 'Service', 'StatefulSet']);
  assert.match(docs[1], /type: ClusterIP/);
  assert.match(docs[2], /image: postgres:16-alpine/);
  assert.match(docs[2], /readinessProbe:/);
  assert.match(docs[2], /volumeClaimTemplates:[\s\S]*storage: "2Gi"/);
  assert.equal(y.match(/paas\/db: "main"/g).length >= 6, true);
  assert.equal(y.split('f'.repeat(48)).length - 1, 1, 'la contraseña aparece solo en el Secret');
  assert.match(renderDbManifest(project, { ...d, engine: 'mysql' }, { password: 'a1', rootPassword: 'b2' }), /image: mysql:8\.4[\s\S]*mountPath: \/var\/lib\/mysql/);
});

test('la cuota del tenant incluye las bases de datos', () => {
  const p = tenantParams(project, [{ cpu_request: '75m', cpu_limit: '150m', memory_request: '192Mi', memory_limit: '384Mi' }]);
  assert.equal(p.quotaLimitsCpu, '550m'); // 200m x 2 pods + 150m
  assert.equal(p.quotaLimitsMemory, '896Mi');
  assert.equal(p.maxMemory, '384Mi');
  assert.equal(p.quotaPods, 4);
});
