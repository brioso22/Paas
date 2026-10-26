import { EventEmitter } from 'node:events';

export const FINAL_STATUSES = new Set(['success', 'failed']);
const META_LINE = /^(\$ |\[DRY_RUN\]|==> )/;

/**
 * Buffer de log con presupuesto de bytes: guarda la cabecera y una cola circular con el
 * final, que es donde suelen estar los errores. Cada línea lleva un `seq` creciente que
 * se usa como id de evento SSE para reanudar tras una reconexión.
 */
class LogBuffer {
  constructor(maxBytes) {
    this.headBudget = Math.floor(maxBytes / 2);
    this.tailBudget = maxBytes - this.headBudget;
    this.head = [];
    this.tail = [];
    this.headBytes = 0;
    this.tailBytes = 0;
    this.omitted = 0;
    this.seq = 0;
  }

  push(text, stream) {
    const line = { seq: this.seq++, text: String(text).slice(0, 8192), stream };
    const size = Buffer.byteLength(line.text) + 1;
    if (!this.omitted && !this.tail.length && this.headBytes + size <= this.headBudget) {
      this.head.push(line);
      this.headBytes += size;
      return line;
    }
    this.tail.push(line);
    this.tailBytes += size;
    while (this.tailBytes > this.tailBudget && this.tail.length > 1) {
      const dropped = this.tail.shift();
      this.tailBytes -= Buffer.byteLength(dropped.text) + 1;
      this.omitted++;
    }
    return line;
  }

  linesAfter(seq) {
    return [...this.head, ...this.tail].filter((l) => l.seq > seq);
  }

  toText() {
    const parts = this.head.map((l) => l.text);
    if (this.omitted) parts.push(`[… ${this.omitted} líneas omitidas: el log superó MAX_LOG_KB …]`);
    parts.push(...this.tail.map((l) => l.text));
    return parts.join('\n');
  }
}

/**
 * Cola en memoria que ejecuta UN trabajo a la vez (builds y helm --wait consumen mucha
 * RAM en un Minikube pequeño). El estado y el log se persisten en la tabla deployments,
 * así el historial sobrevive a reinicios aunque la cola no.
 */
export function createQueue({ db, logger, runner, maxLogBytes = 512 * 1024, flushMs = 1000 }) {
  const events = new EventEmitter();
  events.setMaxListeners(200);
  const pending = [];
  const live = new Map(); // deploymentId -> { buffer, status }
  let running = null;
  let idleResolvers = [];

  const stmt = {
    insert: db.prepare(
      `INSERT INTO deployments (project_id, kind, status, tag, source_ref, rollback_of, triggered_by, user_id)
       VALUES (@project_id, @kind, 'queued', @tag, @source_ref, @rollback_of, @triggered_by, @user_id)`,
    ),
    status: db.prepare('UPDATE deployments SET status = ? WHERE id = ?'),
    start: db.prepare("UPDATE deployments SET started_at = datetime('now') WHERE id = ?"),
    log: db.prepare('UPDATE deployments SET log = ?, log_truncated = ? WHERE id = ?'),
    finish: db.prepare("UPDATE deployments SET status = ?, error = ?, finished_at = datetime('now') WHERE id = ?"),
    get: db.prepare('SELECT * FROM deployments WHERE id = ?'),
  };

  function emit(id, event) {
    events.emit(`d:${id}`, event);
  }

  function setStatus(id, status) {
    stmt.status.run(status, id);
    const l = live.get(id);
    if (l) l.status = status;
    emit(id, { type: 'status', status });
  }

  function flush(id) {
    const l = live.get(id);
    if (l) stmt.log.run(l.buffer.toText(), l.buffer.omitted ? 1 : 0, id);
  }

  async function runOne(job) {
    const { id } = job;
    const buffer = new LogBuffer(maxLogBytes);
    live.set(id, { buffer, status: 'queued' });
    running = job;
    stmt.start.run(id);
    const timer = setInterval(() => flush(id), flushMs);
    const log = (text, stream = 'stdout') => {
      for (const t of String(text).split('\n')) {
        const line = buffer.push(t, stream);
        emit(id, { type: 'line', ...line });
      }
    };
    let finalStatus = 'success';
    let error = null;
    try {
      await runner(stmt.get.get(id), { log, setStatus: (s) => setStatus(id, s), params: job.params || {} });
    } catch (err) {
      finalStatus = 'failed';
      error = String(err.message || err).slice(0, 2000);
      log(`==> ERROR: ${error}`, 'stderr');
    } finally {
      clearInterval(timer);
      log(finalStatus === 'success' ? '==> Terminado con éxito' : '==> El despliegue falló', 'meta');
      flush(id);
      stmt.finish.run(finalStatus, error, id);
      live.get(id).status = finalStatus;
      emit(id, { type: 'status', status: finalStatus });
      emit(id, { type: 'end', status: finalStatus });
      // Se conserva un rato en memoria para clientes SSE que reconectan justo al terminar.
      setTimeout(() => live.delete(id), 30_000).unref();
      running = null;
    }
  }

  async function tick() {
    if (running) return;
    const job = pending.shift();
    if (!job) {
      idleResolvers.forEach((r) => r());
      idleResolvers = [];
      return;
    }
    try {
      await runOne(job);
    } catch (err) {
      logger.error(`Error inesperado en la cola: ${err.stack || err}`);
    }
    setImmediate(tick);
  }

  return {
    /** Crea la fila del despliegue y la encola. Devuelve el id. */
    enqueue({ projectId, kind, triggeredBy, userId = null, tag = null, sourceRef = null, rollbackOf = null, params = {} }) {
      const id = Number(
        stmt.insert.run({
          project_id: projectId,
          kind,
          tag,
          source_ref: sourceRef,
          rollback_of: rollbackOf,
          triggered_by: triggeredBy,
          user_id: userId,
        }).lastInsertRowid,
      );
      pending.push({ id, projectId, kind, params });
      setImmediate(tick);
      return id;
    },

    /** ¿Hay un trabajo de este tipo ya esperando para el proyecto? (para no apilar webhooks). */
    hasQueued(projectId, kind) {
      return pending.some((j) => j.projectId === projectId && (!kind || j.kind === kind));
    },

    isBusy(projectId) {
      return running?.projectId === projectId || pending.some((j) => j.projectId === projectId);
    },

    stats() {
      return { running: running ? running.id : null, queued: pending.length };
    },

    position(id) {
      const i = pending.findIndex((j) => j.id === id);
      return i < 0 ? null : i + 1;
    },

    /** Estado vivo (si está en memoria) para el stream SSE. */
    live(id) {
      return live.get(id) || null;
    },

    subscribe(id, fn) {
      events.on(`d:${id}`, fn);
      return () => events.off(`d:${id}`, fn);
    },

    /** Al arrancar: lo que quedó a medias en un proceso anterior ya no se va a ejecutar. */
    recover() {
      const n = db
        .prepare(
          `UPDATE deployments SET status = 'failed', error = 'Interrumpido por un reinicio del panel', finished_at = datetime('now')
           WHERE status NOT IN ('success', 'failed')`,
        )
        .run().changes;
      if (n) logger.warn(`${n} despliegue(s) interrumpidos por reinicio marcados como fallidos`);
      return n;
    },

    /** Resuelve cuando la cola queda vacía (útil en tests y en el apagado). */
    idle() {
      if (!running && !pending.length) return Promise.resolve();
      return new Promise((r) => idleResolvers.push(r));
    },
  };
}

/** Reconstruye las líneas desde el log guardado, para despliegues ya terminados. */
export function storedLines(logText) {
  if (!logText) return [];
  return logText.split('\n').map((text, seq) => ({ seq, text, stream: META_LINE.test(text) ? 'meta' : 'stdout' }));
}
