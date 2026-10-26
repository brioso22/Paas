import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createQueue, storedLines } from '../src/jobs/queue.js';
import { silentLogger } from './helpers/setup.js';

function freshDb() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('a', 'x', 'admin')").run();
  for (const n of ['p1', 'p2'])
    db.prepare(
      `INSERT INTO projects (name, namespace, source, port, cpu_request, cpu_limit, memory_request, memory_limit, webhook_secret_enc)
       VALUES (?, ?, 'zip', 80, '100m', '100m', '64Mi', '64Mi', 'x')`,
    ).run(n, `tenant-${n}`);
  return db;
}

test('ejecuta un trabajo a la vez, en orden, y persiste estado y log', async () => {
  const db = freshDb();
  let concurrent = 0;
  let maxConcurrent = 0;
  const order = [];
  const runner = async (dep, { log, setStatus }) => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    setStatus('building');
    log(`inicio ${dep.id}`);
    await new Promise((r) => setTimeout(r, 30));
    order.push(dep.id);
    concurrent--;
    if (dep.project_id === 2) throw new Error('falla a propósito');
  };
  const q = createQueue({ db, logger: silentLogger, runner });
  const a = q.enqueue({ projectId: 1, kind: 'build', triggeredBy: 'test' });
  const b = q.enqueue({ projectId: 2, kind: 'build', triggeredBy: 'test' });
  const c = q.enqueue({ projectId: 1, kind: 'config', triggeredBy: 'test' });
  assert.ok(q.hasQueued(1, 'config'));
  assert.ok(q.isBusy(2));
  await q.idle();
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, [a, b, c]);
  const rows = db.prepare('SELECT id, status, error, log, started_at, finished_at FROM deployments ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.status), ['success', 'failed', 'success']);
  assert.equal(rows[1].error, 'falla a propósito');
  assert.match(rows[0].log, /inicio 1[\s\S]*Terminado con éxito/);
  assert.ok(rows.every((r) => r.started_at && r.finished_at));
});

test('eventos en vivo con seq creciente y reanudación desde un seq', async () => {
  const db = freshDb();
  let release;
  const gate = new Promise((r) => (release = r));
  const q = createQueue({
    db,
    logger: silentLogger,
    runner: async (dep, { log }) => {
      log('uno');
      log('dos\ntres');
      await gate;
      log('cuatro');
    },
  });
  const id = q.enqueue({ projectId: 1, kind: 'build', triggeredBy: 't' });
  const seen = [];
  const unsub = q.subscribe(id, (ev) => ev.type === 'line' && seen.push([ev.seq, ev.text]));
  await new Promise((r) => setTimeout(r, 20));
  const live = q.live(id);
  assert.ok(live);
  assert.deepEqual(live.buffer.linesAfter(0).map((l) => l.text), ['dos', 'tres']);
  release();
  await q.idle();
  unsub();
  assert.deepEqual(seen, [
    [0, 'uno'],
    [1, 'dos'],
    [2, 'tres'],
    [3, 'cuatro'],
    [4, '==> Terminado con éxito'],
  ]);
});

test('el log respeta MAX_LOG_KB conservando cabecera y final', async () => {
  const db = freshDb();
  const q = createQueue({
    db,
    logger: silentLogger,
    maxLogBytes: 2048,
    runner: async (dep, { log }) => {
      for (let i = 0; i < 1000; i++) log(`línea ${i} ${'x'.repeat(20)}`);
      log('ERROR FINAL IMPORTANTE');
    },
  });
  q.enqueue({ projectId: 1, kind: 'build', triggeredBy: 't' });
  await q.idle();
  const row = db.prepare('SELECT log, log_truncated FROM deployments').get();
  assert.equal(row.log_truncated, 1);
  assert.ok(Buffer.byteLength(row.log) < 2048 + 200);
  assert.match(row.log, /^línea 0 /);
  assert.match(row.log, /líneas omitidas/);
  assert.match(row.log, /ERROR FINAL IMPORTANTE/);
});

test('al arrancar marca como fallidos los despliegues interrumpidos', () => {
  const db = freshDb();
  db.prepare("INSERT INTO deployments (project_id, kind, status, triggered_by) VALUES (1, 'build', 'building', 't'), (1, 'build', 'success', 't')").run();
  const q = createQueue({ db, logger: silentLogger, runner: async () => {} });
  assert.equal(q.recover(), 1);
  const rows = db.prepare('SELECT status, error FROM deployments ORDER BY id').all();
  assert.equal(rows[0].status, 'failed');
  assert.match(rows[0].error, /reinicio/);
  assert.equal(rows[1].status, 'success');
});

test('storedLines marca líneas meta', () => {
  assert.deepEqual(storedLines('$ helm x\nhola\n==> fin'), [
    { seq: 0, text: '$ helm x', stream: 'meta' },
    { seq: 1, text: 'hola', stream: 'stdout' },
    { seq: 2, text: '==> fin', stream: 'meta' },
  ]);
});
