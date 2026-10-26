import { randomToken } from '../crypto.js';
import * as v from '../lib/validate.js';

export const RESOURCE_DEFAULTS = Object.freeze({
  cpu_request: '100m',
  cpu_limit: '500m',
  memory_request: '128Mi',
  memory_limit: '256Mi',
});

const aad = {
  env: (project, key) => `env:${project.name}:${key}`,
  git: (project) => `git:${project.name}`,
  hook: (project) => `hook:${project.name}`,
};

/**
 * Valida y normaliza los campos de recursos/escalado. Comparte reglas entre el
 * formulario de creación y el de edición.
 */
export function parseResources(body, current = RESOURCE_DEFAULTS) {
  const out = {
    cpu_request: v.cpuQuantity(body.cpu_request ?? current.cpu_request, 'cpu_request'),
    cpu_limit: v.cpuQuantity(body.cpu_limit ?? current.cpu_limit, 'cpu_limit'),
    memory_request: v.memoryQuantity(body.memory_request ?? current.memory_request, 'memory_request'),
    memory_limit: v.memoryQuantity(body.memory_limit ?? current.memory_limit, 'memory_limit'),
  };
  if (v.toMillicores(out.cpu_request) > v.toMillicores(out.cpu_limit))
    throw new v.ValidationError('La CPU solicitada no puede superar el límite', 'cpu_request');
  if (v.toMebibytes(out.memory_request) > v.toMebibytes(out.memory_limit))
    throw new v.ValidationError('La memoria solicitada no puede superar el límite', 'memory_request');
  return out;
}

export function parseScaling(body, current = {}) {
  const enabled = body.autoscaling_enabled === 'on' || body.autoscaling_enabled === '1' || body.autoscaling_enabled === true;
  const out = {
    replicas: v.intInRange(body.replicas ?? current.replicas ?? 1, 0, v.LIMITS.replicas, 'replicas', 'Réplicas'),
    autoscaling_enabled: enabled ? 1 : 0,
    autoscaling_min: v.intInRange(body.autoscaling_min ?? current.autoscaling_min ?? 1, 1, v.LIMITS.replicas, 'autoscaling_min', 'Mínimo HPA'),
    autoscaling_max: v.intInRange(body.autoscaling_max ?? current.autoscaling_max ?? 3, 1, v.LIMITS.replicas, 'autoscaling_max', 'Máximo HPA'),
    autoscaling_cpu: v.intInRange(body.autoscaling_cpu ?? current.autoscaling_cpu ?? 80, 10, 100, 'autoscaling_cpu', 'Objetivo de CPU'),
  };
  if (out.autoscaling_min > out.autoscaling_max) throw new v.ValidationError('El mínimo del HPA no puede superar el máximo', 'autoscaling_min');
  return out;
}

export function createProjectStore({ db, cipher, config }) {
  const touch = db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?");

  const store = {
    list() {
      return db
        .prepare(
          `SELECT p.*, (SELECT COUNT(*) FROM env_vars e WHERE e.project_id = p.id) AS env_count
           FROM projects p ORDER BY p.name`,
        )
        .all();
    },

    get(id) {
      if (!/^\d{1,10}$/.test(String(id))) return null;
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)) || null;
    },

    getByName(name) {
      return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) || null;
    },

    publicUrl(project) {
      return `http://${project.name}.${config.domain}`;
    },

    host(project) {
      return `${project.name}.${config.domain}`;
    },

    /** Valida el formulario completo de creación. Devuelve los datos listos para `create`. */
    parseCreateForm(body) {
      const name = v.projectName(String(body.name || '').trim());
      const source = body.source === 'git' ? 'git' : body.source === 'zip' ? 'zip' : null;
      if (!source) throw new v.ValidationError('Elige el origen: zip o git', 'source');
      const data = {
        name,
        namespace: `${config.tenantPrefix}${name}`,
        source,
        repo_url: null,
        branch: null,
        git_token: '',
        port: v.port(body.port || '3000'),
        ...parseResources(body),
        ...parseScaling(body),
        env: v.parseEnvBlock(body.env || ''),
      };
      if (source === 'git') {
        data.repo_url = v.gitUrl(String(body.repo_url || '').trim());
        data.branch = v.branch(String(body.branch || 'main').trim());
        data.git_token = v.gitToken(body.git_token);
      }
      return data;
    },

    create(data, userId) {
      if (store.getByName(data.name)) throw new v.ValidationError(`Ya existe un proyecto llamado "${data.name}"`, 'name');
      return db.transaction(() => {
        const p = { name: data.name };
        const id = db
          .prepare(
            `INSERT INTO projects (name, namespace, source, repo_url, branch, port, replicas,
              autoscaling_enabled, autoscaling_min, autoscaling_max, autoscaling_cpu,
              cpu_request, cpu_limit, memory_request, memory_limit, git_token_enc, webhook_secret_enc, created_by)
             VALUES (@name, @namespace, @source, @repo_url, @branch, @port, @replicas,
              @autoscaling_enabled, @autoscaling_min, @autoscaling_max, @autoscaling_cpu,
              @cpu_request, @cpu_limit, @memory_request, @memory_limit, @git_token_enc, @webhook_secret_enc, @created_by)`,
          )
          .run({
            ...data,
            git_token_enc: data.git_token ? cipher.encrypt(data.git_token, aad.git(p)) : null,
            webhook_secret_enc: cipher.encrypt(randomToken(32), aad.hook(p)),
            created_by: userId ?? null,
          }).lastInsertRowid;
        const project = store.get(id);
        store.replaceEnv(project, { set: data.env || new Map() });
        return project;
      })();
    },

    update(project, fields) {
      const allowed = [
        'repo_url', 'branch', 'port', 'replicas', 'autoscaling_enabled', 'autoscaling_min', 'autoscaling_max',
        'autoscaling_cpu', 'cpu_request', 'cpu_limit', 'memory_request', 'memory_limit', 'status', 'current_tag',
      ];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      if (!keys.length) return project;
      db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = @${k}`).join(', ')}, updated_at = datetime('now') WHERE id = @id`).run({
        ...Object.fromEntries(keys.map((k) => [k, fields[k]])),
        id: project.id,
      });
      return store.get(project.id);
    },

    setStatus(projectId, status) {
      db.prepare("UPDATE projects SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, projectId);
    },

    remove(project) {
      db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
    },

    // --- Variables de entorno ---------------------------------------------------

    envKeys(project) {
      return db.prepare('SELECT key, updated_at FROM env_vars WHERE project_id = ? ORDER BY key').all(project.id);
    },

    envMap(project) {
      const rows = db.prepare('SELECT key, value_enc FROM env_vars WHERE project_id = ? ORDER BY key').all(project.id);
      return new Map(rows.map((r) => [r.key, cipher.decrypt(r.value_enc, aad.env(project, r.key))]));
    },

    envReveal(project, key) {
      const row = db.prepare('SELECT value_enc FROM env_vars WHERE project_id = ? AND key = ?').get(project.id, key);
      return row ? cipher.decrypt(row.value_enc, aad.env(project, key)) : null;
    },

    /**
     * Aplica cambios: `set` (Map clave→valor) inserta/actualiza, `remove` (array) borra.
     * Devuelve true si algo cambió.
     */
    replaceEnv(project, { set = new Map(), remove = [] }) {
      const upsert = db.prepare(
        `INSERT INTO env_vars (project_id, key, value_enc) VALUES (?, ?, ?)
         ON CONFLICT(project_id, key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = datetime('now')`,
      );
      const del = db.prepare('DELETE FROM env_vars WHERE project_id = ? AND key = ?');
      let changed = false;
      db.transaction(() => {
        for (const key of remove) changed = del.run(project.id, v.envName(key)).changes > 0 || changed;
        for (const [key, value] of set) {
          upsert.run(project.id, v.envName(key), cipher.encrypt(v.envValue(value, key), aad.env(project, key)));
          changed = true;
        }
        const count = db.prepare('SELECT COUNT(*) FROM env_vars WHERE project_id = ?').pluck().get(project.id);
        if (count > v.LIMITS.envVars) throw new v.ValidationError(`Máximo ${v.LIMITS.envVars} variables por proyecto`, 'env');
        if (changed) touch.run(project.id);
      })();
      return changed;
    },

    // --- Secretos del proyecto ---------------------------------------------------

    gitToken(project) {
      return project.git_token_enc ? cipher.decrypt(project.git_token_enc, aad.git(project)) : '';
    },

    setGitToken(project, token) {
      const enc = token ? cipher.encrypt(token, aad.git(project)) : null;
      db.prepare("UPDATE projects SET git_token_enc = ?, updated_at = datetime('now') WHERE id = ?").run(enc, project.id);
    },

    webhookSecret(project) {
      return cipher.decrypt(project.webhook_secret_enc, aad.hook(project));
    },

    rotateWebhookSecret(project) {
      const secret = randomToken(32);
      db.prepare("UPDATE projects SET webhook_secret_enc = ?, updated_at = datetime('now') WHERE id = ?").run(
        cipher.encrypt(secret, aad.hook(project)),
        project.id,
      );
      return secret;
    },
  };
  return store;
}
