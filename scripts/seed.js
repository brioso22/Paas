#!/usr/bin/env node
// Datos de ejemplo para desarrollo: admin, dos proyectos y zips de ejemplo en examples/dist/.
// Solo corre con NODE_ENV=development. Uso: npm run dev:seed
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import AdmZip from 'adm-zip';
import { loadConfig, ConfigError } from '../src/config.js';
import { createContext } from '../src/context.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

if (process.env.NODE_ENV !== 'development') {
  console.error('dev:seed solo se ejecuta con NODE_ENV=development (revisa tu .env).');
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const quiet = { info() {}, warn: console.warn, error: console.error };
const ctx = createContext(config, { logger: quiet });

// Zips de ejemplo listos para subir desde la UI.
const dist = path.join(root, 'examples', 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const name of ['static-site', 'node-app', 'php-app']) {
  const zip = new AdmZip();
  zip.addLocalFolder(path.join(root, 'examples', name));
  zip.writeZip(path.join(dist, `${name}.zip`));
}
console.log(`Zips de ejemplo en ${path.relative(root, dist)}/`);

if (ctx.db.prepare('SELECT COUNT(*) FROM users').pluck().get() === 0) {
  const password = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  ctx.db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('admin', ?, 'admin')").run(bcrypt.hashSync(password, 12));
  console.log(`Usuario admin creado. Contraseña: ${password}`);
} else {
  console.log('Ya existen usuarios; no se crea el admin.');
}

const admin = ctx.db.prepare("SELECT id FROM users WHERE role = 'admin'").get();
const samples = [
  {
    name: 'demo-static',
    source: 'zip',
    port: '8080',
    env: 'MENSAJE=hola',
  },
  {
    name: 'demo-node',
    source: 'git',
    repo_url: 'https://github.com/heroku/node-js-getting-started.git',
    branch: 'main',
    port: '5006',
    env: 'DB_PASS=cambia-me\nNODE_ENV=production',
  },
];

for (const s of samples) {
  if (ctx.projects.getByName(s.name)) {
    console.log(`Proyecto ${s.name} ya existe.`);
    continue;
  }
  const project = ctx.projects.create(ctx.projects.parseCreateForm(s), admin?.id);
  if (config.dryRun) await ctx.kube.ensureTenant(project);
  console.log(`Proyecto ${s.name} creado${config.dryRun ? ' (namespace simulado por DRY_RUN)' : ' (sin namespace: ejecuta un despliegue para crearlo)'}.`);
}

ctx.close();
