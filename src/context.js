import fs from 'node:fs';
import path from 'node:path';
import { openDb } from './db.js';
import { createCipher } from './crypto.js';
import { createExec } from './lib/exec.js';

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
    routes: [],
    rawRoutes: [],
    onClose: (fn) => closers.push(fn),
    close() {
      for (const fn of closers.splice(0).reverse()) fn();
      ctx.db.close();
    },
  };
  return ctx;
}
