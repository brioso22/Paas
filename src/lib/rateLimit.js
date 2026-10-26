/**
 * Limitador en memoria por clave con ventana fija. Suficiente para un panel con un
 * único proceso; si algún día hay varias réplicas habría que moverlo a la BD.
 */
export function createRateLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();

  function prune() {
    const t = now();
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
  }
  const timer = setInterval(prune, Math.min(windowMs, 60_000));
  timer.unref();

  return {
    /** true si la clave está bloqueada. */
    isBlocked(key) {
      const v = hits.get(key);
      return Boolean(v && v.resetAt > now() && v.count >= max);
    },
    retryAfterSec(key) {
      const v = hits.get(key);
      return v ? Math.max(1, Math.ceil((v.resetAt - now()) / 1000)) : 0;
    },
    fail(key) {
      const t = now();
      const v = hits.get(key);
      if (!v || v.resetAt <= t) hits.set(key, { count: 1, resetAt: t + windowMs });
      else v.count++;
    },
    reset(key) {
      hits.delete(key);
    },
    stop() {
      clearInterval(timer);
    },
  };
}
