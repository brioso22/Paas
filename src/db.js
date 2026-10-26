import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Migraciones versionadas. Nunca edites una ya publicada: agrega una nueva.
 * Cada una corre dentro de una transacción junto con el registro de su versión.
 */
export const MIGRATIONS = [
  {
    version: 1,
    name: 'usuarios, sesiones y ajustes',
    up: `
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
      );
      -- Política actual: un único administrador.
      CREATE UNIQUE INDEX users_single_admin ON users(role) WHERE role = 'admin';

      CREATE TABLE sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX sessions_expires ON sessions(expires);

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 2,
    name: 'proyectos y variables de entorno',
    up: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        namespace TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL CHECK (source IN ('zip', 'git')),
        repo_url TEXT,
        branch TEXT,
        port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
        replicas INTEGER NOT NULL DEFAULT 1,
        autoscaling_enabled INTEGER NOT NULL DEFAULT 0,
        autoscaling_min INTEGER NOT NULL DEFAULT 1,
        autoscaling_max INTEGER NOT NULL DEFAULT 3,
        autoscaling_cpu INTEGER NOT NULL DEFAULT 80,
        cpu_request TEXT NOT NULL,
        cpu_limit TEXT NOT NULL,
        memory_request TEXT NOT NULL,
        memory_limit TEXT NOT NULL,
        git_token_enc TEXT,
        webhook_secret_enc TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'created',
        current_tag TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (source = 'zip' OR (repo_url IS NOT NULL AND branch IS NOT NULL))
      );

      CREATE TABLE env_vars (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value_enc TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, key)
      );
    `,
  },
];

export function openDb(file, migrations = MIGRATIONS) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, migrations);
  return db;
}

export function migrate(db, migrations = MIGRATIONS) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').pluck().all());
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => !applied.has(m.version));
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.up);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    })();
  }
  return pending.map((m) => m.version);
}

export function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, String(value));
}
