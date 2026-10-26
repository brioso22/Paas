import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCipher, safeEqual } from '../src/crypto.js';

const key = crypto.randomBytes(32);

test('cifra y descifra con AES-256-GCM', () => {
  const c = createCipher(key);
  const secret = 'contraseña súper secreta 🔑';
  const enc = c.encrypt(secret, 'env:app:DB_PASS');
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes(secret));
  assert.equal(c.decrypt(enc, 'env:app:DB_PASS'), secret);
});

test('IV aleatorio: mismo texto produce cifrados distintos', () => {
  const c = createCipher(key);
  assert.notEqual(c.encrypt('x'), c.encrypt('x'));
});

test('rechaza contexto (AAD) distinto, clave distinta o datos manipulados', () => {
  const c = createCipher(key);
  const enc = c.encrypt('valor', 'env:a:K');
  assert.throws(() => c.decrypt(enc, 'env:b:K'));
  assert.throws(() => createCipher(crypto.randomBytes(32)).decrypt(enc, 'env:a:K'));
  const parts = enc.split(':');
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 1;
  parts[3] = ct.toString('base64');
  assert.throws(() => c.decrypt(parts.join(':'), 'env:a:K'));
  assert.throws(() => c.decrypt('basura', ''));
});

test('exige clave de 32 bytes', () => {
  assert.throws(() => createCipher(Buffer.alloc(16)));
});

test('safeEqual', () => {
  assert.ok(safeEqual('abc', 'abc'));
  assert.ok(!safeEqual('abc', 'abd'));
  assert.ok(!safeEqual('abc', 'abcd'));
});
