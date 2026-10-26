import test from 'node:test';
import assert from 'node:assert/strict';
import * as v from '../src/lib/validate.js';

test('nombres de proyecto', () => {
  for (const ok of ['abc', 'mi-app', 'a1b', 'x'.repeat(30), 'app-2025']) assert.ok(v.isProjectName(ok), ok);
  for (const bad of ['ab', 'Ab1', '-abc', 'abc-', 'a_b', 'x'.repeat(31), 'a.b', 'abc\n', '', 'añb', '../x', null, 123])
    assert.ok(!v.isProjectName(bad), String(bad));
  assert.throws(() => v.projectName('MAL'), v.ValidationError);
});

test('nombres de variables de entorno', () => {
  for (const ok of ['A', 'DB_HOST', '_X', 'API_KEY_2']) assert.ok(v.isEnvName(ok), ok);
  for (const bad of ['a', '1A', 'DB-HOST', 'DB HOST', '', 'Ñ', 'A$']) assert.ok(!v.isEnvName(bad), bad);
});

test('puertos', () => {
  for (const ok of [1, '80', 8080, '65535']) assert.ok(v.isPort(ok), String(ok));
  for (const bad of [0, '0', 65536, '-1', '80a', '8.5', '', null, ' 80']) assert.ok(!v.isPort(bad), String(bad));
});

test('URLs de git: solo https sin credenciales', () => {
  for (const ok of ['https://github.com/user/repo.git', 'https://gitlab.com/g/sub/repo', 'https://git.example.org:8443/a/b'])
    assert.ok(v.isGitUrl(ok), ok);
  for (const bad of [
    'http://github.com/u/r',
    'git@github.com:u/r.git',
    'ssh://github.com/u/r',
    'file:///etc/passwd',
    'https://user:pass@github.com/u/r',
    'https://token@github.com/u/r',
    'https://github.com/u/r?x=1',
    'https://github.com/u/r#frag',
    'https://github.com/u/../r',
    '--upload-pack=evil',
    'https://github.com/u/r with space',
    'ext::sh -c touch',
    'https://',
  ])
    assert.ok(!v.isGitUrl(bad), bad);
});

test('ramas', () => {
  for (const ok of ['main', 'release/1.2', 'feature-x', 'v1.0']) assert.ok(v.isBranch(ok), ok);
  for (const bad of ['-main', '--upload-pack', 'a..b', 'a//b', '/a', 'a/', 'a.lock', 'a b', 'a~1', 'a^', 'a:b', '.hidden', 'a/.b', '@', ''])
    assert.ok(!v.isBranch(bad), bad);
});

test('cantidades de CPU y memoria', () => {
  assert.equal(v.cpuQuantity('250m'), '250m');
  assert.equal(v.cpuQuantity('0.5'), '0.5');
  assert.equal(v.toMillicores('1.5'), 1500);
  assert.equal(v.toMebibytes('2Gi'), 2048);
  for (const bad of ['5m', '250M', '1e3', 'abc', '-1', '1000']) assert.throws(() => v.cpuQuantity(bad), bad);
  for (const bad of ['256', '256MB', '1Ti', '8Mi', '1.5Gi']) assert.throws(() => v.memoryQuantity(bad), bad);
});

test('bloque de variables .env', () => {
  const m = v.parseEnvBlock('# comentario\nDB_HOST=localhost\n\nURL=postgres://u:p@h/db?x=1\nEMPTY=\n');
  assert.deepEqual([...m], [
    ['DB_HOST', 'localhost'],
    ['URL', 'postgres://u:p@h/db?x=1'],
    ['EMPTY', ''],
  ]);
  assert.throws(() => v.parseEnvBlock('sin-igual'), v.ValidationError);
  assert.throws(() => v.parseEnvBlock('lower=1'), v.ValidationError);
  assert.throws(() => v.parseEnvBlock(Array.from({ length: 101 }, (_, i) => `V${i}=1`).join('\n')), /Máximo/);
});

test('usuario, contraseña y token', () => {
  assert.throws(() => v.username('a'));
  assert.throws(() => v.password('corta'));
  assert.equal(v.gitToken(''), '');
  assert.throws(() => v.gitToken('con espacio'));
  assert.equal(v.gitToken('ghp_abcDEF123'), 'ghp_abcDEF123');
});
