import crypto from 'node:crypto';
import * as v from '../lib/validate.js';
import { loadTemplate, renderTemplate, TENANT_DEFAULTS } from './templates.js';

export const DB_NAME_RE = /^[a-z][a-z0-9-]{1,20}$/;
export const DB_SIZES = [1, 2, 5];
export const DB_ENV_KEYS = ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'DB_PASSWORD', 'DATABASE_URL'];
const DB_USER = 'app';

export const DB_ENGINES = Object.freeze({
  postgres: { label: 'PostgreSQL 16', template: 'db-postgres.yaml', port: 5432, scheme: 'postgresql', cpu_limit: '100m', memory_limit: '256Mi' },
  mysql: { label: 'MySQL 8.4', template: 'db-mysql.yaml', port: 3306, scheme: 'mysql', cpu_limit: '150m', memory_limit: '384Mi' },
});

const half = (millis) => `${Math.max(10, Math.floor(millis / 2))}`;

export const resourceName = (db) => `db-${db.name}`;
export const internalHost = (project, db) => `${resourceName(db)}.${project.namespace}.svc.cluster.local`;
// Postgres y MySQL obligan a citar identificadores con guion: se usa guion bajo.
export const dbIdentifier = (name) => name.replace(/-/g, '_');

/** Contraseña aleatoria hexadecimal: segura en URLs y en YAML sin escapar. */
export function generatePassword() {
  return crypto.randomBytes(24).toString('hex');
}

export function parseDbForm(body) {
  const name = String(body.name || '').trim();
  if (!DB_NAME_RE.test(name)) throw new v.ValidationError('Nombre de base de datos inválido: 2-21 caracteres, empieza por letra, minúsculas, dígitos y guiones', 'name');
  const engine = DB_ENGINES[body.engine] ? body.engine : null;
  if (!engine) throw new v.ValidationError('Elige el motor: postgres o mysql', 'engine');
  const size = Number(body.size_gi);
  if (!DB_SIZES.includes(size)) throw new v.ValidationError(`Tamaño de disco inválido: ${DB_SIZES.join(', ')} Gi`, 'size_gi');
  const def = DB_ENGINES[engine];
  const cpu_limit = v.cpuQuantity(String(body.cpu_limit || '').trim() || def.cpu_limit, 'cpu_limit');
  const memory_limit = v.memoryQuantity(String(body.memory_limit || '').trim() || def.memory_limit, 'memory_limit');
  return {
    name,
    engine,
    size_gi: size,
    cpu_limit,
    memory_limit,
    // Request = mitad del límite: deja reservar poco en un Minikube pequeño.
    cpu_request: `${half(v.toMillicores(cpu_limit))}m`,
    memory_request: `${Math.max(16, Math.floor(v.toMebibytes(memory_limit) / 2))}Mi`,
  };
}

/** Comprueba la ResourceQuota de PVC/almacenamiento antes de llamar al clúster. */
export function checkStorageQuota(existing, sizeGi) {
  const maxPvc = TENANT_DEFAULTS.quotaPvcCount;
  const maxGi = v.toMebibytes(TENANT_DEFAULTS.quotaStorage) / 1024;
  const usedGi = existing.reduce((n, d) => n + d.size_gi, 0);
  if (existing.length + 1 > maxPvc)
    throw new v.ValidationError(`La cuota del namespace permite ${maxPvc} volúmenes (PVC) y ya hay ${existing.length}. Elimina una base de datos antes de crear otra.`, 'quota');
  if (usedGi + sizeGi > maxGi)
    throw new v.ValidationError(`La cuota de almacenamiento es ${maxGi}Gi: ya hay ${usedGi}Gi reservados y pides ${sizeGi}Gi más. Elige un tamaño menor.`, 'quota');
}

export function connectionEnv(project, db, password) {
  const e = DB_ENGINES[db.engine];
  const host = internalHost(project, db);
  const name = dbIdentifier(db.name);
  return new Map([
    ['DB_HOST', host],
    ['DB_PORT', String(e.port)],
    ['DB_NAME', name],
    ['DB_USER', DB_USER],
    ['DB_PASSWORD', password],
    ['DATABASE_URL', `${e.scheme}://${DB_USER}:${password}@${host}:${e.port}/${name}`],
  ]);
}

export function renderDbManifest(project, db, { password, rootPassword }) {
  return renderTemplate(loadTemplate(DB_ENGINES[db.engine].template), {
    project: project.name,
    namespace: project.namespace,
    db: db.name,
    resource: resourceName(db),
    dbName: dbIdentifier(db.name),
    dbUser: DB_USER,
    password,
    rootPassword: rootPassword || password,
    size: `${db.size_gi}Gi`,
    cpuRequest: db.cpu_request,
    cpuLimit: db.cpu_limit,
    memoryRequest: db.memory_request,
    memoryLimit: db.memory_limit,
  });
}

/** Mensaje entendible cuando el clúster rechaza por cuota. */
export function explainKubeError(message) {
  if (/exceeded quota/i.test(message)) return `El namespace no tiene cuota suficiente (PVC, almacenamiento, CPU o memoria): ${message.split('\n').pop()}`;
  if (/maximum (cpu|memory) usage per Container/i.test(message)) return `El LimitRange del namespace no permite esos límites: ${message.split('\n').pop()}`;
  return message;
}

export function createDatabaseStore({ db, cipher }) {
  const aad = (project, name, kind = 'db') => `${kind}:${project.name}:${name}`;
  return {
    list(project) {
      return db.prepare('SELECT * FROM databases WHERE project_id = ? ORDER BY name').all(project.id);
    },
    get(project, id) {
      if (!/^\d{1,10}$/.test(String(id))) return null;
      return db.prepare('SELECT * FROM databases WHERE project_id = ? AND id = ?').get(project.id, Number(id)) || null;
    },
    create(project, data, { password, rootPassword }) {
      if (db.prepare('SELECT 1 FROM databases WHERE project_id = ? AND name = ?').get(project.id, data.name))
        throw new v.ValidationError(`Ya existe una base de datos llamada ${data.name}`, 'name');
      const id = db
        .prepare(
          `INSERT INTO databases (project_id, name, engine, size_gi, cpu_request, cpu_limit, memory_request, memory_limit, password_enc, root_password_enc)
           VALUES (@project_id, @name, @engine, @size_gi, @cpu_request, @cpu_limit, @memory_request, @memory_limit, @password_enc, @root_password_enc)`,
        )
        .run({
          ...data,
          project_id: project.id,
          password_enc: cipher.encrypt(password, aad(project, data.name)),
          root_password_enc: rootPassword ? cipher.encrypt(rootPassword, aad(project, data.name, 'dbroot')) : null,
        }).lastInsertRowid;
      return this.get(project, id);
    },
    password(project, d) {
      return cipher.decrypt(d.password_enc, aad(project, d.name));
    },
    remove(d) {
      db.prepare('DELETE FROM databases WHERE id = ?').run(d.id);
    },
  };
}
