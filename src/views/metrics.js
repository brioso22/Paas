import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader } from './projects.js';

const money = (n) => (n === null || n === undefined ? '—' : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);
const num = (n, d = 3) => (n === null || n === undefined ? '—' : n.toFixed(d));

export function bytes(n, suffix = '') {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}${suffix}`;
}

export function metricsView({ project: p, data, prometheusUrl }) {
  const m = data.metrics;
  const c = data.costs;
  return html`${projectHeader(p, 'metrics')}
  ${!data.available
    ? html`<div class="alert alert-warn">No se pudo consultar Prometheus en <span class="mono">${prometheusUrl}</span> (${data.error}). Los valores se muestran vacíos.</div>`
    : data.error
      ? html`<div class="alert alert-info">Algunas consultas fallaron: ${data.error}</div>`
      : ''}
  <div class="grid">
    <section class="card"><h3>CPU</h3><div class="metric">${num(m.cpu)} <small>núcleos</small></div><small>Promedio 24 h: ${num(m.cpuAvg24)}</small></section>
    <section class="card"><h3>Memoria</h3><div class="metric">${bytes(m.mem)}</div><small>Promedio 24 h: ${bytes(m.memAvg24)}</small></section>
    <section class="card"><h3>Red entrante</h3><div class="metric">${bytes(m.rx, '/s')}</div><small>Últimas 24 h: ${bytes(m.rx24)}</small></section>
    <section class="card"><h3>Red saliente</h3><div class="metric">${bytes(m.tx, '/s')}</div><small>Últimas 24 h: ${bytes(m.tx24)}</small></section>
  </div>
  <section class="card">
    <h2>Costo estimado</h2>
    <div class="grid">
      <div><small>Por hora (actual)</small><div class="metric">${money(c.hour)}</div></div>
      <div><small>Acumulado 24 h</small><div class="metric">${money(c.last24h)}</div></div>
      <div><small>Proyección 30 días</small><div class="metric">${money(c.projection30d)}</div><small>según ${c.basis}</small></div>
    </div>
    <p class="hint">Precios: ${money(data.prices.cpuHour)} por núcleo·hora y ${money(data.prices.ramGbHour)} por GiB·hora de RAM, calculado sobre el uso real del namespace <span class="mono">${p.namespace}</span>.</p>
  </section>
  <p><a class="btn btn-small" href="/projects/${p.id}/metrics">Actualizar</a></p>`;
}

export function settingsPageView({ csrfToken, prices, info, allowRegistration }) {
  return html`<h1>Ajustes y precios</h1>
  <section class="card">
    <h2>Registro de clientes</h2>
    <form method="post" action="/settings/registration" class="form">
      ${csrfField(csrfToken)}
      <label class="check"><input type="checkbox" name="allow_registration" ${allowRegistration ? 'checked' : ''}> Permitir registro abierto en /register</label>
      <span class="hint">Las cuentas nuevas son de rol cliente con el plan free. Desactivado por defecto.</span>
      <div><button class="btn btn-primary" type="submit">Guardar</button></div>
    </form>
  </section>
  <section class="card">
    <h2>Precios para el cálculo de costos</h2>
    <form method="post" action="/settings/prices" class="form">
      ${csrfField(csrfToken)}
      <div class="grid">
        <label>USD por núcleo de CPU por hora <input name="cpu_hour" inputmode="decimal" value="${prices.cpuHour}" required></label>
        <label>USD por GiB de RAM por hora <input name="ram_gb_hour" inputmode="decimal" value="${prices.ramGbHour}" required></label>
      </div>
      <div><button class="btn btn-primary" type="submit">Guardar precios</button></div>
    </form>
  </section>
  <section class="card">
    <h2>Configuración del servidor</h2>
    <p class="muted">Se define en el archivo .env (requiere reiniciar el panel). Los secretos no se muestran.</p>
    <dl class="kv">${Object.entries(info).map(([k, v]) => html`<dt class="mono">${k}</dt><dd class="mono">${String(v)}</dd>`)}</dl>
  </section>`;
}
