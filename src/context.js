import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createCipher } from './crypto.js';
import { createExec } from './lib/exec.js';
import { createKube } from './services/kube.js';
import { createProjectStore } from './services/projects.js';
import { createLifecycle } from './services/lifecycle.js';
import { createHelm } from './services/helm.js';
import { createGit } from './services/git.js';
import { createBuilder } from './services/builder.js';
import { createDeployer } from './services/deployer.js';
import { createQueue } from './jobs/queue.js';
import { createMetrics } from './services/metrics.js';
import { createPublisher } from './services/publisher/index.js';
import { createDatabaseStore } from './services/databases.js';
import { createTls } from './services/tls.js';
import { createUserStore } from './services/users.js';
import { createAudit } from './services/audit.js';

export function createLogger(prefix = 'paas-panel') {
  const ts = () => new Date().toISOString();
  return {
    info: (...a) => console.log(ts(), `[${prefix}]`, ...a),
    warn: (...a) => console.warn(ts(), `[${prefix}] WARN`, ...a),
    error: (...a) => console.error(ts(), `[${prefix}] ERROR`, ...a),
  };
}

/**
 * Construye todas las dependencias del panel en un único objeto. Las rutas y los
 * servicios lo reciben por parámetro, lo que permite a los tests inyectar otro exec,
 * otro reloj u otra BD.
 */
export function createContext(config, { logger = createLogger(), exec, now = () => new Date(), dbFile } = {}) {
  for (const d of [config.dataDir, config.workspacesDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });

  const closers = [];
  const ctx = {
    config,
    logger,
    now,
    db: openDb(dbFile || path.join(config.dataDir, 'paas.db')),
    cipher: createCipher(config.secretsKey),
    exec: exec || createExec({ dryRun: config.dryRun, logger }),
    onClose: (fn) => closers.push(fn),
    close() {
      for (const fn of closers.splice(0).reverse()) fn();
      ctx.db.close();
    },
  };
  ctx.audit = createAudit(ctx);
  ctx.users = createUserStore(ctx);
  ctx.kube = createKube(ctx);
  ctx.projects = createProjectStore(ctx);
  ctx.databases = createDatabaseStore(ctx);
  ctx.tls = createTls(ctx);
  ctx.helm = createHelm(ctx);
  ctx.git = createGit(ctx);
  ctx.builder = createBuilder(ctx);
  ctx.metrics = createMetrics(ctx);
  ctx.publisher = createPublisher(ctx);
  ctx.lifecycle = createLifecycle(ctx);
  ctx.deployer = createDeployer(ctx);
  ctx.queue = createQueue({ db: ctx.db, logger, runner: (dep, io) => ctx.deployer(dep, io), maxLogBytes: config.maxLogBytes });
  ctx.queue.recover();
  // Todo despliegue encolado (UI o webhook) queda en la auditoría.
  const enqueue = ctx.queue.enqueue;
  ctx.queue.enqueue = (job) => {
    const id = enqueue(job);
    ctx.audit.record({ user: job.userId ? { id: job.userId } : null, ip: job.ip }, `deploy.${job.kind}`, {
      project: ctx.projects.get(job.projectId),
      username: job.triggeredBy,
      detail: `#${id}${job.sourceRef ? ` ${job.sourceRef}` : ''}`,
    });
    return id;
  };
  return ctx;
}
