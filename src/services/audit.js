const PER_PAGE = 50;

/**
 * Registro de auditoría. Nunca recibe valores secretos: para variables solo se anotan
 * los nombres. `who` es la petición (req.user + req.ip) o { user, ip } para tareas internas.
 */
export function createAudit({ db }) {
  const insert = db.prepare(
    'INSERT INTO audit_log (user_id, username, action, project_id, project_name, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );

  return {
    record(who, action, { project = null, detail = null, username } = {}) {
      const user = who?.user || null;
      insert.run(
        user?.id ?? null,
        (username ?? user?.username ?? null)?.slice(0, 64) ?? null,
        action,
        project?.id ?? null,
        project?.name ?? null,
        detail === null ? null : String(detail).slice(0, 500),
        who?.ip ? String(who.ip).slice(0, 64) : null,
      );
    },

    /** Filtros opcionales: username, action (prefijo), project (nombre), projectId. */
    query({ username = '', action = '', project = '', projectId = null, page = 1 } = {}) {
      const where = [];
      const args = {};
      if (username) (where.push('username = @username'), (args.username = username));
      if (action) (where.push("action LIKE @action ESCAPE '\\'"), (args.action = `${action.replace(/[\\%_]/g, '\\$&')}%`));
      if (project) (where.push('project_name = @project'), (args.project = project));
      if (projectId !== null) (where.push('project_id = @projectId'), (args.projectId = projectId));
      const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) FROM audit_log ${sql}`).pluck().get(args);
      const pages = Math.max(1, Math.ceil(total / PER_PAGE));
      const p = Math.min(Math.max(1, Number.parseInt(page, 10) || 1), pages);
      const rows = db.prepare(`SELECT * FROM audit_log ${sql} ORDER BY id DESC LIMIT ${PER_PAGE} OFFSET ${(p - 1) * PER_PAGE}`).all(args);
      return { rows, total, page: p, pages };
    },
  };
}
