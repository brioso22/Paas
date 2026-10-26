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
    /** Proyectos visibles para `user`: todos si es admin, si no solo aquellos de los que es miembro. */
    list(user) {
      const cols = `p.*, (SELECT COUNT(*) FROM env_vars e WHERE e.project_id = p.id) AS env_count,
        (SELECT u.username FROM project_members o JOIN users u ON u.id = o.user_id WHERE o.project_id = p.id AND o.role = 'owner') AS owner_name`;
      if (user?.role === 'admin')
        return db.prepare(`SELECT ${cols}, (SELECT role FROM project_members m WHERE m.project_id = p.id AND m.user_id = ?) AS member_role FROM projects p ORDER BY p.name`).all(user.id);
      if (!user) return [];
      return db
        .prepare(`SELECT ${cols}, m.role AS member_role FROM projects p JOIN project_members m ON m.project_id = p.id WHERE m.user_id = ? ORDER BY p.name`)
        .all(user.id);
    },

    get(id) {
      if (!/^\d{1,10}$/.test(String(id))) return null;
      return db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)) || null;
    },

    /** El proyecto con `member_role` del usuario, o null si no lo puede ver (evita IDOR). */
    getFor(id, user) {
      const p = store.get(id);
      if (!p || !user) return null;
      p.member_role = db.prepare('SELECT role FROM project_members WHERE project_id = ? AND user_id = ?').pluck().get(p.id, user.id) || null;
      return p.member_role || user.role === 'admin' ? p : null;
    },

    // --- Miembros ------------------------------------------------------------------

    members(project) {
      return db
        .prepare(
          `SELECT m.role, m.created_at, u.id AS user_id, u.username, u.role AS global_role, u.active
           FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = ?
           ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'deployer' THEN 1 ELSE 2 END, u.username`,
        )
        .all(project.id);
    },

    setMember(project, userId, role) {
      db.prepare(
        `INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`,
      ).run(project.id, userId, role);
    },

    removeMember(project, userId) {
      return db.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'").run(project.id, userId).changes > 0;
    },

    getByName(name) {
      return db.prepare('SELECT * FROM projects WHERE name = ?').get(name) || null;
    },

    /** URL con la que se muestra el proyecto: https:// si tiene HTTPS activo, http:// si no. */
    publicUrl(project) {
      return `${project.tls_enabled ? 'https' : 'http'}://${store.host(project)}`;
    },

    host(project) {
      return `${project.name}.${config.domain}`;
    },

    /** Todos los hosts del ingress (y SAN del certificado): el interno y el dominio propio. */
    hosts(project) {
      return [store.host(project), ...(project.custom_domain ? [project.custom_domain] : [])];
    },

    /** Valida el dominio propio: único y fuera de *.DOMAIN (esos hosts son de otros proyectos). */
    checkCustomDomain(value, projectId = null) {
      const d = v.customDomain(value);
      if (!d) return null;
      if (d === config.domain || d.endsWith(`.${config.domain}`))
        throw new v.ValidationError(`El dominio personalizado no puede ser ${config.domain} ni un subdominio suyo`, 'custom_domain');
      const other = db.prepare('SELECT id FROM projects WHERE custom_domain = ?').get(d);
      if (other && other.id !== projectId) throw new v.ValidationError(`El dominio ${d} ya lo usa otro proyecto`, 'custom_domain');
      return d;
    },

    httpsUrl(project) {
      return `https://${project.name}.${config.domain}`;
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
        custom_domain: store.checkCustomDomain(body.custom_domain),
        // HTTPS por defecto. El formulario manda tls_form=1 para distinguir "casilla desmarcada".
        tls_enabled: body.tls_form === '1' ? (body.tls_enabled === 'on' ? 1 : 0) : 1,
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
              cpu_request, cpu_limit, memory_request, memory_limit, git_token_enc, webhook_secret_enc, created_by, custom_domain, tls_enabled)
             VALUES (@name, @namespace, @source, @repo_url, @branch, @port, @replicas,
              @autoscaling_enabled, @autoscaling_min, @autoscaling_max, @autoscaling_cpu,
              @cpu_request, @cpu_limit, @memory_request, @memory_limit, @git_token_enc, @webhook_secret_enc, @created_by, @custom_domain, @tls_enabled)`,
          )
          .run({
            ...data,
            git_token_enc: data.git_token ? cipher.encrypt(data.git_token, aad.git(p)) : null,
            webhook_secret_enc: cipher.encrypt(randomToken(32), aad.hook(p)),
            created_by: userId ?? null,
            custom_domain: data.custom_domain ?? null,
            tls_enabled: data.tls_enabled ?? 0,
          }).lastInsertRowid;
        const project = store.get(id);
        if (userId) store.setMember(project, userId, 'owner');
        store.replaceEnv(project, { set: data.env || new Map() });
        return project;
      })();
    },

    update(project, fields) {
      const allowed = [
        'repo_url', 'branch', 'port', 'replicas', 'autoscaling_enabled', 'autoscaling_min', 'autoscaling_max',
        'autoscaling_cpu', 'cpu_request', 'cpu_limit', 'memory_request', 'memory_limit', 'status', 'current_tag',
        'tls_enabled', 'tls_expires_at', 'custom_domain',
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
