import session from 'express-session';

/** Store de express-session sobre la tabla `sessions` de SQLite (evita otra dependencia). */
export class SqliteSessionStore extends session.Store {
  constructor(db, { ttlMs, pruneIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.stmts = {
      get: db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'),
      set: db.prepare(
        'INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires',
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      prune: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
      destroyUser: db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?"),
    };
    this.timer = setInterval(() => this.prune(), pruneIntervalMs);
    this.timer.unref();
  }

  expiresFor(sess) {
    const exp = sess?.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttlMs;
    return exp;
  }

  get(sid, cb) {
    try {
      const row = this.stmts.get.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmts.set.run(sid, JSON.stringify(sess), this.expiresFor(sess));
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmts.destroy.run(sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmts.touch.run(this.expiresFor(sess), sid);
      cb?.(null);
    } catch (err) {
      cb?.(err);
    }
  }

  /** Cierra todas las sesiones de un usuario (desactivación, cambio de rol, contraseña). */
  destroyUser(userId) {
    return this.stmts.destroyUser.run(userId).changes;
  }

  prune() {
    return this.stmts.prune.run(Date.now()).changes;
  }

  close() {
    clearInterval(this.timer);
  }
}
