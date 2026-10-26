import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { ROLE_LABELS } from './account.js';
import { auditTable, pager } from './members.js';
import { icon } from './icons.js';
import { money, statusBadge, podsCell } from './projects.js';
import { bytes } from './metrics.js';

function stat(label, value, iconName, cls = '') {
  return html`<section class="card stat ${cls}"><span class="label">${icon(iconName)} ${label}</span><span class="value">${value ?? '—'}</span></section>`;
}

function usage(used, total, fmt) {
  if (used === null || total === null) return html`<span class="muted">sin datos</span>`;
  const pct = Math.min(100, Math.round((used / Math.max(total, 1e-9)) * 100));
  return html`<div class="meter-row">
    <div class="row between"><span class="mono">${fmt(used)} / ${fmt(total)}</span><strong>${pct}%</strong></div>
    <progress class="meter ${pct >= 90 ? 'meter-danger' : pct >= 70 ? 'meter-warn' : ''}" max="100" value="${pct}">${pct}%</progress>
  </div>`;
}

export function adminDashboardView({ counts, cluster, rows, billing, prices }) {
  return html`<div class="page-head"><h1>Panel admin</h1></div>
  <div class="stats">
    ${stat('Usuarios activos', counts.users, 'users')}
    ${stat('Proyectos', counts.projects, 'projects')}
    ${stat('Pods', counts.pods, 'server')}
    ${stat('Despliegues fallidos (24 h)', counts.failed24h, 'alert', counts.failed24h ? 'danger' : '')}
  </div>
  <section class="card">
    <h2>Consumo del clúster</h2>
    ${cluster.available
      ? html`<div class="grid">
          <div><small>CPU del nodo</small>${usage(cluster.cpuUsed, cluster.cpuTotal, (n) => `${n.toFixed(2)} núcleos`)}</div>
          <div><small>RAM del nodo</small>${usage(cluster.memUsed, cluster.memTotal, (n) => bytes(n))}</div>
        </div>`
      : html`<p class="muted">Prometheus no responde: no hay datos de consumo del nodo.</p>`}
  </section>
  <section class="card">
    <h2>Todos los proyectos</h2>
    ${rows.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>Proyecto</th><th>Dueño</th><th>Estado</th><th>Pods</th><th class="num">Costo / hora</th><th class="num">Proyección 30 d</th></tr></thead>
          <tbody>${rows.map(
            (r) => html`<tr>
              <td><a href="/projects/${r.project.id}"><strong>${r.project.name}</strong></a></td>
              <td>${r.project.owner_name || html`<span class="muted">—</span>`}</td>
              <td>${statusBadge(r.project.status)}</td>
              <td>${podsCell(r.pods)}</td>
              <td class="num mono">${money(r.costs.hour)}</td>
              <td class="num mono">${money(r.costs.projection30d)}</td>
            </tr>`,
          )}</tbody></table></div>`
      : html`<p class="muted">No hay proyectos.</p>`}
  </section>
  <section class="card">
    <h2>${icon('money')} Facturación por usuario</h2>
    ${billing.length
      ? html`<div class="table-wrap"><table>
          <thead><tr><th>Usuario</th><th class="num">Proyectos</th><th class="num">Costo / hora</th><th class="num">Últimas 24 h</th><th class="num">Proyección 30 d</th></tr></thead>
          <tbody>${billing.map(
            (b) => html`<tr><td>${b.owner}</td><td class="num">${b.projects}</td><td class="num mono">${money(b.hour)}</td><td class="num mono">${money(b.last24h)}</td><td class="num mono"><strong>${money(b.projection30d)}</strong></td></tr>`,
          )}</tbody></table></div>`
      : html`<p class="muted">Sin datos.</p>`}
    <p class="hint">Según uso real medido por Prometheus y los precios de <a href="/settings">Ajustes</a>: ${money(prices.cpuHour)} por núcleo·hora y ${money(prices.ramGbHour)} por GiB·hora.</p>
  </section>`;
}

export function usersView({ users, plans, me, csrfToken, error, values = {} }) {
  return html`<div class="page-head"><h1>Usuarios</h1></div>
  <section class="card table-wrap">
    <table>
      <thead><tr><th>Usuario</th><th>Rol</th><th>Plan</th><th>Proyectos</th><th>Último acceso (UTC)</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>${users.map(
        (u) => html`<tr>
          <td><strong>${u.username}</strong>${u.id === me.id ? html` <small>(tú)</small>` : ''}${u.email ? html`<br><small>${u.email}</small>` : ''}
            ${u.must_change_password ? html`<br><span class="badge badge-warn">contraseña temporal</span>` : ''}</td>
          <td><form method="post" action="/admin/users/${u.id}/role" class="row">
            ${csrfField(csrfToken)}
            <select name="role" aria-label="Rol de ${u.username}">${['admin', 'user', 'viewer'].map((r) => html`<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)}</select>
            <button class="btn btn-small" type="submit">Cambiar</button>
          </form></td>
          <td><form method="post" action="/admin/users/${u.id}/plan" class="row">
            ${csrfField(csrfToken)}
            <select name="plan" aria-label="Plan de ${u.username}">${plans.map((p) => html`<option value="${p.name}" ${u.plan_id === p.id ? 'selected' : ''}>${p.name}</option>`)}</select>
            <button class="btn btn-small" type="submit">Cambiar</button>
          </form></td>
          <td>${u.owned_projects}</td>
          <td><small>${u.last_login || 'nunca'}</small></td>
          <td>${u.active ? html`<span class="badge badge-ok">activo</span>` : html`<span class="badge badge-error">desactivado</span>`}</td>
          <td class="row">
            <form method="post" action="/admin/users/${u.id}/active" data-confirm="${u.active ? `¿Desactivar a ${u.username}? Se cerrarán sus sesiones.` : `¿Reactivar a ${u.username}?`}">
              ${csrfField(csrfToken)}<input type="hidden" name="active" value="${u.active ? '0' : '1'}">
              <button class="btn btn-small ${u.active ? 'btn-danger' : ''}" type="submit">${u.active ? 'Desactivar' : 'Activar'}</button>
            </form>
            <form method="post" action="/admin/users/${u.id}/reset" data-confirm="¿Generar una contraseña temporal para ${u.username}? La actual dejará de valer.">
              ${csrfField(csrfToken)}<button class="btn btn-small" type="submit">Restablecer contraseña</button>
            </form>
          </td>
        </tr>`,
      )}</tbody>
    </table>
  </section>
  <section class="card">
    <h2>Nuevo usuario</h2>
    ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
    <form method="post" action="/admin/users" class="form">
      ${csrfField(csrfToken)}
      <div class="grid">
        <label>Usuario <input name="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_.\\-]{3,32}" value="${values.username || ''}" autocomplete="off"></label>
        <label>Correo (opcional) <input type="email" name="email" maxlength="254" value="${values.email || ''}" autocomplete="off"></label>
        <label>Rol <select name="role">${['user', 'viewer', 'admin'].map((r) => html`<option value="${r}" ${values.role === r ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`)}</select></label>
        <label>Plan <select name="plan">${plans.map((p) => html`<option value="${p.name}" ${(values.plan || 'free') === p.name ? 'selected' : ''}>${p.name}${p.max_projects === null ? ' (sin límites)' : ` (${p.max_projects} proyectos)`}</option>`)}</select></label>
      </div>
      <p class="hint">Se genera una contraseña temporal que se muestra una sola vez; el usuario deberá cambiarla al entrar.</p>
      <div><button class="btn btn-primary" type="submit">Crear usuario</button></div>
    </form>
  </section>`;
}

export function tempPasswordView({ user, password }) {
  return html`<section class="card narrow">
    <h1>Contraseña temporal de ${user.username}</h1>
    <p>Cópiala y entrégala por un canal seguro. <strong>No se volverá a mostrar.</strong></p>
    <span class="copy-row"><input id="temp-pw" class="mono" value="${password}" readonly aria-label="Contraseña temporal">
      <button type="button" class="btn btn-small" data-copy="#temp-pw">Copiar</button></span>
    <p class="hint">Al iniciar sesión deberá elegir una nueva.</p>
    <p><a class="btn" href="/admin/users">← Volver a usuarios</a></p>
  </section>`;
}

export function auditView({ result, filters }) {
  const q = new URLSearchParams(Object.entries({ user: filters.username, action: filters.action, project: filters.project }).filter(([, v]) => v)).toString();
  return html`<div class="page-head"><h1>Auditoría</h1></div>
  <section class="card">
    <form method="get" action="/admin/audit" class="row">
      <label>Usuario <input name="user" value="${filters.username}" maxlength="64"></label>
      <label>Acción (prefijo) <input name="action" value="${filters.action}" placeholder="auth., deploy., user." maxlength="64"></label>
      <label>Proyecto <input name="project" value="${filters.project}" maxlength="64"></label>
      <button class="btn" type="submit">Filtrar</button>
      ${q ? html`<a href="/admin/audit">Limpiar</a>` : ''}
    </form>
  </section>
  <section class="card">
    ${auditTable(result.rows)}
    ${pager(result, q)}
  </section>`;
}
