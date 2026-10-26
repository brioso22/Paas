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
  {
    version: 3,
    name: 'historial de despliegues',
    up: `
      CREATE TABLE deployments (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('build', 'config', 'restart', 'rollback')),
        status TEXT NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'building', 'deploying', 'success', 'failed')),
        tag TEXT,
        commit_sha TEXT,
        source_ref TEXT,
        stack TEXT,
        helm_revision INTEGER,
        rollback_of INTEGER REFERENCES deployments(id) ON DELETE SET NULL,
        image_pruned INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        log TEXT NOT NULL DEFAULT '',
        log_truncated INTEGER NOT NULL DEFAULT 0,
        triggered_by TEXT NOT NULL,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX deployments_project ON deployments(project_id, id DESC);
    `,
  },
  {
    version: 4,
    name: 'bases de datos administradas',
    up: `
      CREATE TABLE databases (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        engine TEXT NOT NULL CHECK (engine IN ('postgres', 'mysql')),
        size_gi INTEGER NOT NULL,
        cpu_request TEXT NOT NULL,
        cpu_limit TEXT NOT NULL,
        memory_request TEXT NOT NULL,
        memory_limit TEXT NOT NULL,
        password_enc TEXT NOT NULL,
        root_password_enc TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (project_id, name)
      );
    `,
  },
  {
    version: 5,
    name: 'https autofirmado y dominio personalizado',
    up: `
      ALTER TABLE projects ADD COLUMN tls_enabled INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE projects ADD COLUMN tls_expires_at TEXT;
      ALTER TABLE projects ADD COLUMN custom_domain TEXT;
    `,
  },
  {
    version: 6,
    name: 'multiusuario: roles, planes, membresías y auditoría',
    // Reconstruir users (cambia el CHECK de rol y quita el índice de admin único) exige
    // desactivar las claves foráneas: con ellas activas, DROP TABLE dispararía los SET NULL.
    foreignKeysOff: true,
    up: `
      CREATE TABLE plans (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        max_projects INTEGER,        -- NULL = sin límite
        max_cpu_millicores INTEGER,
        max_memory_mi INTEGER,
        max_db_gi INTEGER
      );
      INSERT INTO plans (name, max_projects, max_cpu_millicores, max_memory_mi, max_db_gi) VALUES
        ('free', 2, 1000, 1024, 2),
        ('pro', 10, 4000, 8192, 20),
        ('ilimitado', NULL, NULL, NULL, NULL);

      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        email TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'user', 'viewer')),
        active INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        plan_id INTEGER REFERENCES plans(id),
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login TEXT
      );
      INSERT INTO users_new (id, username, password_hash, role, plan_id, created_at, last_login)
        SELECT id, username, password_hash, role,
          (SELECT id FROM plans WHERE name = CASE users.role WHEN 'admin' THEN 'ilimitado' ELSE 'free' END),
          created_at, last_login_at
        FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;

      CREATE TABLE project_members (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'deployer', 'viewer')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (project_id, user_id)
      );
      CREATE INDEX project_members_user ON project_members(user_id);
      CREATE UNIQUE INDEX project_members_one_owner ON project_members(project_id) WHERE role = 'owner';
      INSERT INTO project_members (project_id, user_id, role)
        SELECT p.id, a.id, 'owner' FROM projects p
        JOIN (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1) a;

      -- Sin FK a projects: el historial sobrevive al borrado del proyecto.
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        username TEXT,
        action TEXT NOT NULL,
        project_id INTEGER,
        project_name TEXT,
        detail TEXT,
        ip TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX audit_created ON audit_log(created_at DESC);
      CREATE INDEX audit_project ON audit_log(project_id, id DESC);
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
    // PRAGMA foreign_keys no tiene efecto dentro de una transacción: se cambia antes.
    const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
    if (m.foreignKeysOff) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.up);
        if (m.foreignKeysOff && db.pragma('foreign_key_check').length) throw new Error(`La migración ${m.version} rompe claves foráneas`);
        db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
      })();
    } finally {
      if (m.foreignKeysOff && fkWasOn) db.pragma('foreign_keys = ON');
    }
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
