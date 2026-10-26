#!/usr/bin/env node
// CLI de administración de Lisec PaaS: hace desde el servidor lo mismo que la UI, con los
// mismos servicios (validación, cifrado, cuotas, auditoría). Nunca imprime secretos.
//
//   node scripts/lisec.js projects
//   node scripts/lisec.js create <nombre> --repo <url> --port <n> [--branch main] [--no-tls]
//   node scripts/lisec.js db <proyecto> <nombre> <postgres|mysql> [--size 1] [--cpu 150m] [--memory 512Mi]
//   node scripts/lisec.js set <proyecto> --port <n>
//   node scripts/lisec.js env <proyecto> CLAVE=valor [CLAVE2=valor ...]   (no imprime los valores)
//   node scripts/lisec.js deploy <proyecto> [--config]     (--config: sin reconstruir la imagen)
//   node scripts/lisec.js expose-panel                     (https://panel.DOMAIN)
//
// Los despliegues corren en este proceso, fuera de la cola del panel: no lances otro desde la UI a la vez.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { loadConfig, ConfigError } from '../src/config.js';
import { createContext } from '../src/context.js';
import { renderTemplate, loadTemplate } from '../src/services/templates.js';
import * as v from '../src/lib/validate.js';
import { parseDbForm, checkStorageQuota, generatePassword, renderDbManifest, connectionEnv, explainKubeError } from '../src/services/databases.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
// Rutas relativas del .env (DATA_DIR, …) respecto al repo, se lance desde donde se lance.
process.env.PAAS_BASE_DIR ||= root;

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
const args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2);
    flags[k] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true;
  } else args.push(rest[i]);
}

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  die(err instanceof ConfigError ? err.message : err.message);
}

// createContext marca como fallidos los despliegues a medias: solo si el panel está ocioso.
const dbFile = path.join(config.dataDir, 'paas.db');
if (fs.existsSync(dbFile)) {
  const probe = new Database(dbFile, { readonly: true });
  const busy = probe.prepare("SELECT COUNT(*) FROM deployments WHERE status NOT IN ('success', 'failed')").pluck().get();
  probe.close();
  if (busy) die('el panel tiene un despliegue en curso; espera a que termine');
}

const ctx = createContext(config, { logger: { info() {}, warn: console.warn, error: console.error } });
const admin = ctx.db.prepare("SELECT id, username FROM users WHERE role = 'admin' AND active = 1 ORDER BY id LIMIT 1").get();
if (!admin) die('no hay ningún administrador; crea uno desde /setup');
const actor = { user: { id: admin.id, username: admin.username }, ip: 'cli' };
const project = (name) => ctx.projects.getByName(name) || die(`no existe el proyecto "${name}"`);

const commands = {
  projects() {
    for (const p of ctx.db.prepare('SELECT * FROM projects ORDER BY name').all())
      console.log(`${p.id}\t${p.name}\t${p.status}\t${ctx.projects.publicUrl(p)}\t${p.current_tag || '-'}`);
  },

  async create([name]) {
    const data = ctx.projects.parseCreateForm({
      name,
      source: 'git',
      repo_url: flags.repo,
      branch: flags.branch || 'main',
      port: flags.port,
      ...(flags['no-tls'] ? { tls_form: '1' } : {}),
    });
    const p = ctx.projects.create(data, admin.id);
    try {
      await ctx.kube.ensureTenant(p);
    } catch (err) {
      ctx.projects.remove(p);
      die(`no se pudo crear el namespace: ${err.message}`);
    }
    ctx.audit.record(actor, 'project.create', { project: p, detail: 'git (cli)' });
    console.log(`Proyecto ${p.name} (id ${p.id}) creado en ${p.namespace}: ${ctx.projects.publicUrl(p)}`);
  },

  async db([projectName, name, engine]) {
    const p = project(projectName);
    const data = parseDbForm({ name, engine, size_gi: flags.size || '1', cpu_limit: flags.cpu, memory_limit: flags.memory });
    checkStorageQuota(ctx.databases.list(p), data.size_gi);
    const password = generatePassword();
    const rootPassword = data.engine === 'mysql' ? generatePassword() : null;
    const d = ctx.databases.create(p, data, { password, rootPassword });
    try {
      await ctx.kube.ensureTenant(p);
      await ctx.kube.applyManifest(renderDbManifest(p, d, { password, rootPassword }), { secrets: [password, rootPassword].filter(Boolean) });
    } catch (err) {
      ctx.databases.remove(d);
      await ctx.kube.ensureTenant(p).catch(() => {});
      die(`no se pudo crear la base de datos: ${explainKubeError(err.message)}`);
    }
    ctx.projects.replaceEnv(p, { set: connectionEnv(p, d, password) });
    ctx.audit.record(actor, 'db.create', { project: p, detail: `${d.name} ${d.engine} ${d.size_gi}Gi (cli)` });
    console.log(`BD ${d.engine} ${d.name} creada (${d.cpu_limit} / ${d.memory_limit}); variables DB_* añadidas a ${p.name}.`);
  },

  set([projectName]) {
    const p = project(projectName);
    if (flags.port === undefined) die('indica --port <n>');
    const updated = ctx.projects.update(p, { port: v.port(flags.port) });
    ctx.audit.record(actor, 'project.update', { project: updated, detail: `port ${updated.port} (cli)` });
    console.log(`${updated.name}: puerto ${updated.port}. Redespliega para aplicarlo.`);
  },

  env([projectName, ...pairs]) {
    const p = project(projectName);
    const set = new Map();
    for (const pair of pairs) {
      const i = pair.indexOf('=');
      if (i < 1) die(`formato CLAVE=valor: ${pair.split('=')[0]}`);
      set.set(pair.slice(0, i), pair.slice(i + 1));
    }
    if (!set.size) die('indica al menos una variable CLAVE=valor');
    ctx.projects.replaceEnv(p, { set });
    ctx.audit.record(actor, 'env.update', { project: p, detail: `${[...set.keys()].join(', ')} (cli)` });
    console.log(`${p.name}: ${[...set.keys()].join(', ')} guardadas. Redespliega para aplicarlas.`);
  },

  async deploy([projectName]) {
    const p = project(projectName);
    const kind = flags.config ? 'config' : 'build';
    const id = ctx.queue.enqueue({ projectId: p.id, kind, triggeredBy: `${admin.username} (cli)`, userId: admin.id, ip: 'cli', tag: p.current_tag });
    const off = ctx.queue.subscribe(id, (ev) => ev.type === 'line' && console.log(ev.text));
    await ctx.queue.idle();
    off();
    const dep = ctx.db.prepare('SELECT status, error FROM deployments WHERE id = ?').get(id);
    console.log(`Despliegue #${id}: ${dep.status}`);
    if (dep.status !== 'success') process.exitCode = 1;
  },

  async 'expose-panel'() {
    const host = `panel.${config.domain}`;
    const namespace = 'lisec-system';
    // Desde los pods, el host es el gateway de la red docker de Minikube (x.y.z.1).
    const upstreamIp = flags.upstream || config.ingressIp.replace(/\.\d+$/, '.1');
    const manifest = renderTemplate(loadTemplate('panel-ingress.yaml'), {
      namespace,
      host,
      port: config.port,
      upstreamIp,
      bodySize: `${config.maxUploadMb + 5}m`,
    });
    await ctx.kube.applyManifest(manifest, { onLine: (line) => console.log(line) });
    const expires = await ctx.tls.issue({ name: 'panel', namespace }, [host], { onLine: (line) => console.log(line) });
    console.log(`Panel publicado en https://${host} -> ${upstreamIp}:${config.port} (certificado hasta ${expires?.slice(0, 10)})`);
  },
};

if (!commands[cmd]) {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//   ')).map((l) => l.slice(5)).join('\n'));
  process.exit(cmd ? 1 : 0);
}
try {
  await commands[cmd](args);
} catch (err) {
  die(err.message);
} finally {
  ctx.close();
}
