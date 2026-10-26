import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createExec, createRedactor, formatCommand, ExecError } from '../src/lib/exec.js';
import { silentLogger } from './helpers/setup.js';

test('redacta secretos, su base64 y su forma URL-encoded', () => {
  const redact = createRedactor(['s3cr3t-valor', 'p@ss word', 'ab']);
  const b64 = Buffer.from('s3cr3t-valor').toString('base64');
  const out = redact(`token=s3cr3t-valor data=${b64} url=p%40ss%20word plain=p@ss word corto=ab`);
  assert.equal(out, 'token=*** data=*** url=*** plain=*** corto=ab');
});

test('el redactor escapa metacaracteres de regex', () => {
  const redact = createRedactor(['a.b*c(d)']);
  assert.equal(redact('x a.b*c(d) y aXbbc(d)'), 'x *** y aXbbc(d)');
});

test('formatCommand cita argumentos con espacios o comillas', () => {
  assert.equal(formatCommand('git', ['clone', '--', 'https://h/r', "a b'c"]), "git clone -- https://h/r 'a b'\\''c'");
});

test('DRY_RUN no ejecuta, registra el comando y redacta', async () => {
  const lines = [];
  const exec = createExec({ dryRun: true, logger: silentLogger });
  const r = await exec.run('kubectl', ['get', 'secret', 'tok-XYZ123'], {
    stdin: 'apiVersion: v1',
    secrets: ['tok-XYZ123'],
    env: { GIT_CONFIG_VALUE_0: 'Authorization: Basic zzz' },
    onLine: (l) => lines.push(l),
  });
  assert.equal(r.code, 0);
  assert.equal(r.dryRun, true);
  assert.deepEqual(exec.history[0], {
    cmd: 'kubectl',
    args: ['get', 'secret', '***'],
    cwd: null,
    stdinBytes: 14,
    envKeys: ['GIT_CONFIG_VALUE_0'],
  });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('tok-XYZ123'));
  assert.ok(!JSON.stringify(exec.history).includes('Basic zzz'));
});

test('rechaza comandos fuera de la lista blanca y argumentos no string', async () => {
  const exec = createExec({ dryRun: true, logger: silentLogger });
  await assert.rejects(exec.run('bash', ['-c', 'id']), ExecError);
  await assert.rejects(exec.run('rm', ['-rf', '/']), /no permitido/);
  await assert.rejects(exec.run('git', [1]), /arreglo de strings/);
});

test('ejecución real: stdin, salida línea a línea, código de error y redacción (usa git)', async () => {
  const exec = createExec({ dryRun: false, logger: silentLogger });
  const lines = [];
  const r = await exec.run('git', ['hash-object', '--stdin'], { stdin: 'hola\n', onLine: (l, s) => lines.push([s, l]) });
  const expected = crypto.createHash('sha1').update('blob 5\0hola\n').digest('hex');
  assert.equal(r.stdout.trim(), expected);
  assert.equal(lines[0][0], 'meta');
  assert.equal(lines[1][0], 'stdout');

  const err = await exec.run('git', ['rev-parse', '--verify', 'rama-SECRETA-123'], { cwd: '/', secrets: ['SECRETA-123'] }).catch((e) => e);
  assert.ok(err instanceof ExecError);
  assert.notEqual(err.code, 0);
  assert.ok(!err.message.includes('SECRETA-123'));
  assert.ok(!err.cmd.includes('SECRETA-123'));
});

test('timeout mata el proceso y no deja la promesa colgada', async () => {
  const node = process.execPath;
  const exec = createExec({ dryRun: false, logger: silentLogger, allowed: [node] });
  const t0 = Date.now();
  const err = await exec.run(node, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 200 }).catch((e) => e);
  assert.ok(err instanceof ExecError);
  assert.equal(err.timedOut, true);
  assert.ok(Date.now() - t0 < 5000);
});

test('AbortSignal cancela el proceso (usado al cerrar un stream de logs)', async () => {
  const node = process.execPath;
  const exec = createExec({ dryRun: false, logger: silentLogger, allowed: [node] });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const err = await exec.run(node, ['-e', 'setTimeout(() => {}, 20000)'], { signal: ac.signal }).catch((e) => e);
  assert.ok(err instanceof ExecError);
  assert.equal(err.aborted, true);
});

test('los procesos hijos no heredan SESSION_SECRET ni SECRETS_KEY', async () => {
  const node = process.execPath;
  const exec = createExec({ dryRun: false, logger: silentLogger, allowed: [node] });
  process.env.SESSION_SECRET = 'no-debe-filtrarse';
  try {
    const r = await exec.run(node, ['-e', 'process.stdout.write(String(process.env.SESSION_SECRET))']);
    assert.equal(r.stdout, 'undefined');
  } finally {
    delete process.env.SESSION_SECRET;
  }
});
