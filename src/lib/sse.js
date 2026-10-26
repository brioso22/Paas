/**
 * Server-Sent Events mínimo. `retry` indica al navegador cuánto esperar antes de
 * reconectar; al reconectar envía Last-Event-ID y el servidor reanuda desde ahí.
 */
export function openSse(req, res, { heartbeatMs = 15_000 } = {}) {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');

  let closed = false;
  const onClose = [];
  const hb = setInterval(() => !closed && res.write(': ping\n\n'), heartbeatMs);
  req.on('close', () => {
    closed = true;
    clearInterval(hb);
    onClose.forEach((fn) => fn());
  });

  const lastHeader = req.get('last-event-id');
  const lastEventId = lastHeader !== undefined && /^\d+$/.test(lastHeader) ? Number(lastHeader) : -1;

  return {
    lastEventId,
    get closed() {
      return closed;
    },
    send(event, data, id) {
      if (closed) return;
      let out = '';
      if (id !== undefined) out += `id: ${id}\n`;
      out += `event: ${event}\n`;
      // JSON garantiza una sola línea de data aunque el texto tenga saltos.
      out += `data: ${typeof data === 'string' ? data.replace(/\n/g, ' ') : JSON.stringify(data)}\n\n`;
      res.write(out);
    },
    end() {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      res.end();
    },
    onClose(fn) {
      onClose.push(fn);
    },
  };
}
