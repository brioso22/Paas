#!/usr/bin/env node
// Crea .env a partir de .env.example generando SESSION_SECRET y SECRETS_KEY aleatorios.
// Idempotente: si .env existe, solo completa esas dos claves cuando faltan o tienen el valor de ejemplo.
// Uso: node scripts/init-env.js [--dry-run]   (--dry-run escribe DRY_RUN=true en un .env nuevo)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const envPath = path.join(root, '.env');
const examplePath = path.join(root, '.env.example');
const dryRun = process.argv.includes('--dry-run');

const PLACEHOLDERS = {
  SESSION_SECRET: 'cambia-esto-por-un-valor-aleatorio-de-al-menos-32-caracteres',
  SECRETS_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};
const generators = {
  SESSION_SECRET: () => crypto.randomBytes(48).toString('base64url'),
  SECRETS_KEY: () => crypto.randomBytes(32).toString('base64'),
};

const isNew = !fs.existsSync(envPath);
let text = fs.readFileSync(isNew ? examplePath : envPath, 'utf8');
const changed = [];

for (const key of Object.keys(generators)) {
  const re = new RegExp(`^${key}=(.*)$`, 'm');
  const m = text.match(re);
  if (!m) {
    text += `\n${key}=${generators[key]()}\n`;
    changed.push(key);
  } else if (!m[1].trim() || m[1].trim() === PLACEHOLDERS[key]) {
    text = text.replace(re, `${key}=${generators[key]()}`);
    changed.push(key);
  }
}
if (isNew && dryRun) {
  text = text.replace(/^DRY_RUN=.*$/m, 'DRY_RUN=true').replace(/^NODE_ENV=.*$/m, 'NODE_ENV=development');
}

if (isNew || changed.length) {
  fs.writeFileSync(envPath, text, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);
}
console.log(isNew ? `.env creado (${changed.join(', ')} generados)` : changed.length ? `.env actualizado: ${changed.join(', ')}` : '.env ya estaba completo; sin cambios');
