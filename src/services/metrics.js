import { getSetting, setSetting } from '../db.js';

const GIB = 1024 ** 3;
const HOURS_MONTH = 24 * 30;

function promString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Consultas PromQL por namespace. Usan las métricas de cAdvisor que expone el kubelet. */
export function queriesFor(namespace) {
  const ns = promString(namespace);
  const containers = `namespace=${ns},container!="",container!="POD"`;
  const cpu = `sum(rate(container_cpu_usage_seconds_total{${containers}}[5m]))`;
  const mem = `sum(container_memory_working_set_bytes{${containers}})`;
  return {
    cpu,
    mem,
    rx: `sum(rate(container_network_receive_bytes_total{namespace=${ns}}[5m]))`,
    tx: `sum(rate(container_network_transmit_bytes_total{namespace=${ns}}[5m]))`,
    cpuAvg24: `avg_over_time((${cpu})[24h:5m])`,
    memAvg24: `avg_over_time((${mem})[24h:5m])`,
    rx24: `sum(increase(container_network_receive_bytes_total{namespace=${ns}}[24h]))`,
    tx24: `sum(increase(container_network_transmit_bytes_total{namespace=${ns}}[24h]))`,
  };
}

/**
 * Costo según uso real (no según requests). Si no hay datos de 24 h se proyecta con el
 * consumo actual.
 */
export function computeCosts(m, prices) {
  const perHour = (cpu, memBytes) => (cpu ?? 0) * prices.cpuHour + ((memBytes ?? 0) / GIB) * prices.ramGbHour;
  const hour = m.cpu === null && m.mem === null ? null : perHour(m.cpu, m.mem);
  const has24 = m.cpuAvg24 !== null || m.memAvg24 !== null;
  const avgHour = has24 ? perHour(m.cpuAvg24, m.memAvg24) : hour;
  return {
    hour,
    last24h: has24 ? avgHour * 24 : null,
    projection30d: avgHour === null ? null : avgHour * HOURS_MONTH,
    basis: has24 ? 'promedio de las últimas 24 h' : 'consumo actual',
  };
}

export function createMetrics({ config, db, fetchImpl = (...a) => fetch(...a), timeoutMs = 4000 }) {
  async function query(promql) {
    const url = `${config.prometheusUrl}/api/v1/query?query=${encodeURIComponent(promql)}`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Prometheus respondió HTTP ${res.status}`);
    const body = await res.json();
    if (body.status !== 'success') throw new Error(body.error || 'consulta fallida');
    const r = body.data?.result?.[0];
    if (!r) return null; // sin series: el namespace aún no tiene pods
    const n = Number(r.value?.[1]);
    return Number.isFinite(n) ? n : null;
  }

  return {
    prices() {
      return {
        cpuHour: Number(getSetting(db, 'price_cpu_hour', config.priceCpuHour)),
        ramGbHour: Number(getSetting(db, 'price_ram_gb_hour', config.priceRamGbHour)),
      };
    },

    setPrices({ cpuHour, ramGbHour }) {
      setSetting(db, 'price_cpu_hour', cpuHour);
      setSetting(db, 'price_ram_gb_hour', ramGbHour);
    },

    /**
     * Consumo del nodo con métricas de cAdvisor (id="/" = la máquina entera). Nunca lanza:
     * cada valor queda en null si su consulta falla.
     */
    async cluster() {
      const qs = {
        cpuUsed: 'sum(rate(container_cpu_usage_seconds_total{id="/"}[5m]))',
        cpuTotal: 'sum(machine_cpu_cores)',
        memUsed: 'sum(container_memory_working_set_bytes{id="/"})',
        memTotal: 'sum(machine_memory_bytes)',
      };
      const keys = Object.keys(qs);
      const results = await Promise.allSettled(keys.map((k) => query(qs[k])));
      const out = { available: results.some((r) => r.status === 'fulfilled') };
      results.forEach((r, i) => (out[keys[i]] = r.status === 'fulfilled' ? r.value : null));
      return out;
    },

    /** Nunca lanza: si Prometheus no responde devuelve available=false y el error. */
    async forProject(project) {
      const qs = queriesFor(project.namespace);
      const keys = Object.keys(qs);
      const results = await Promise.allSettled(keys.map((k) => query(qs[k])));
      const m = {};
      const errors = [];
      results.forEach((r, i) => {
        m[keys[i]] = r.status === 'fulfilled' ? r.value : null;
        if (r.status === 'rejected') errors.push(r.reason?.name === 'TimeoutError' ? 'tiempo de espera agotado' : r.reason?.cause?.code || r.reason?.message);
      });
      const prices = this.prices();
      return {
        available: errors.length < keys.length,
        error: errors.length ? [...new Set(errors)].join('; ') : null,
        metrics: m,
        prices,
        costs: computeCosts(m, prices),
      };
    },
  };
}
