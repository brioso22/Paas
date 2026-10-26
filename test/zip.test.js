import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safeExtractZip, inspectZip, projectRoot, entryParts, ZipError } from '../src/lib/zip.js';
import { buildZip } from './helpers/zip.js';
import { tmpDir } from './helpers/setup.js';

function writeZip(entries) {
  const dir = tmpDir('zip-');
  const file = path.join(dir, 'in.zip');
  fs.writeFileSync(file, buildZip(entries));
  return { file, dest: path.join(dir, 'out'), dir };
}

test('extrae un zip normal con carpetas', () => {
  const { file, dest } = writeZip([
    { name: 'app/', data: '' },
    { name: 'app/index.html', data: '<h1>hola</h1>' },
    { name: 'app/js/main.js', data: 'console.log(1)'.repeat(100) },
    { name: '__MACOSX/app/._index.html', data: 'basura' },
  ]);
  const r = safeExtractZip(file, dest);
  assert.equal(r.files, 2);
  assert.equal(fs.readFileSync(path.join(dest, 'app/index.html'), 'utf8'), '<h1>hola</h1>');
  assert.ok(!fs.existsSync(path.join(dest, '__MACOSX')));
  assert.equal(projectRoot(dest), path.join(dest, 'app'));
});

test('zip-slip: rechaza "..", rutas absolutas y barras invertidas', () => {
  for (const name of ['../evil.txt', 'a/../../evil.txt', '/etc/evil', 'C:/evil', '..\\evil.txt', 'a\\..\\..\\evil']) {
    const { file, dest, dir } = writeZip([{ name, data: 'x' }]);
    assert.throws(() => safeExtractZip(file, dest), ZipError, name);
    assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')), name);
  }
  assert.deepEqual(entryParts('./a//b/./c'), ['a', 'b', 'c']);
});

test('rechaza enlaces simbólicos y archivos especiales', () => {
  const { file, dest } = writeZip([{ name: 'link', data: '/etc/passwd', mode: 0o120777, method: 0 }]);
  assert.throws(() => safeExtractZip(file, dest), /simbólicos/);
  const fifo = writeZip([{ name: 'fifo', data: '', mode: 0o010644 }]);
  assert.throws(() => safeExtractZip(fifo.file, fifo.dest), /especiales/);
});

test('no conserva SUID/SGID; sí el bit de ejecución', () => {
  const { file, dest } = writeZip([
    { name: 'run.sh', data: '#!/bin/sh', mode: 0o104755 },
    { name: 'plain.txt', data: 'x', mode: 0o102644 },
  ]);
  safeExtractZip(file, dest);
  assert.equal(fs.statSync(path.join(dest, 'run.sh')).mode & 0o7777, 0o755);
  assert.equal(fs.statSync(path.join(dest, 'plain.txt')).mode & 0o7777, 0o644);
});

test('zip bomb: el límite se aplica a los bytes reales inflados, no al tamaño declarado', () => {
  const zeros = Buffer.alloc(5 * 1024 * 1024);
  const limits = { maxFiles: 100, maxTotalBytes: 1024 * 1024, maxEntryBytes: 1024 * 1024 };
  // Tamaño declarado honesto: se rechaza al inspeccionar.
  const honest = writeZip([{ name: 'bomb.bin', data: zeros }]);
  assert.throws(() => safeExtractZip(honest.file, honest.dest, limits), /límite/);
  // Tamaño declarado mentiroso (0): se rechaza al inflar gracias a maxOutputLength.
  const liar = writeZip([{ name: 'bomb.bin', data: zeros, declaredSize: 0 }]);
  assert.throws(() => safeExtractZip(liar.file, liar.dest, limits), /zip bomb/);
  // Suma de varias entradas que superan el total.
  const many = writeZip(Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(300 * 1024), declaredSize: 1 })));
  assert.throws(() => safeExtractZip(many.file, many.dest, limits), /límite|inconsistente/);
});

test('tamaño declarado inconsistente se considera manipulación', () => {
  const { file, dest } = writeZip([{ name: 'a.txt', data: 'hola mundo', declaredSize: 4 }]);
  assert.throws(() => safeExtractZip(file, dest), /inconsistente/);
});

test('límite de cantidad de archivos, duplicados, cifrados y zip vacío', () => {
  const lots = writeZip(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, data: 'x' })));
  assert.throws(() => inspectZip(lots.file, { maxFiles: 10, maxTotalBytes: 1e9, maxEntryBytes: 1e9 }), /demasiados/);
  const dup = writeZip([
    { name: 'a.txt', data: 'uno' },
    { name: 'A.txt', data: 'dos' },
  ]);
  assert.throws(() => inspectZip(dup.file), /duplicada/);
  const enc = writeZip([{ name: 'a.txt', data: 'x', flags: 1 }]);
  assert.throws(() => inspectZip(enc.file), /cifrados/);
  const empty = writeZip([]);
  assert.throws(() => inspectZip(empty.file), /vacío|válido/);
  const notZip = path.join(tmpDir(), 'x.zip');
  fs.writeFileSync(notZip, 'no soy un zip');
  assert.throws(() => inspectZip(notZip), ZipError);
});

test('el destino debe estar vacío', () => {
  const { file, dest } = writeZip([{ name: 'a.txt', data: 'x' }]);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'previo'), '');
  assert.throws(() => safeExtractZip(file, dest), /no está vacío/);
});
