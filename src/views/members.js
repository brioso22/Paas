import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader } from './projects.js';
import { ROLE_LABELS } from './account.js';

const ROLE_HELP = { owner: 'todo, incluido borrar', deployer: 'despliega, variables, reinicia', viewer: 'solo estado y logs' };

export function membersView({ project: p, members, csrfToken, can }) {
  const manage = can('members.manage');
  return html`${projectHeader(p, 'members')}
  <section class="card table-wrap">
    <h2>Miembros</h2>
    <table>
      <thead><tr><th>Usuario</th><th>Rol</th><th>Desde</th>${manage ? html`<th></th>` : ''}</tr></thead>
      <tbody>${members.map(
        (m) => html`<tr>
          <td><strong>${m.username}</strong>${m.active ? '' : html` <span class="badge badge-error">desactivado</span>`}</td>
          <td>${manage && m.role !== 'owner'
            ? html`<form method="post" action="/projects/${p.id}/members/${m.user_id}/role" class="row">
                ${csrfField(csrfToken)}
                <select name="role" aria-label="Rol de ${m.username}">
                  ${['deployer', 'viewer'].map((r) => html`<option value="${r}" ${m.role === r ? 'selected' : ''} ${m.global_role === 'viewer' && r !== 'viewer' ? 'disabled' : ''}>${ROLE_LABELS[r]}</option>`)}
                </select>
                <button class="btn btn-small" type="submit">Cambiar</button>
              </form>`
            : html`<span class="badge">${ROLE_LABELS[m.role]}</span> <small>${ROLE_HELP[m.role]}</small>`}</td>
          <td><small>${m.created_at} UTC</small></td>
          ${manage
            ? html`<td>${m.role === 'owner'
                ? ''
                : html`<form method="post" action="/projects/${p.id}/members/${m.user_id}/remove" data-confirm="¿Quitar el acceso de ${m.username} a ${p.name}?">
                    ${csrfField(csrfToken)}<button class="btn btn-danger btn-small" type="submit">Quitar</button></form>`}</td>`
            : ''}
        </tr>`,
      )}</tbody>
    </table>
  </section>
  ${manage
    ? html`<section class="card">
        <h2>Invitar a un usuario</h2>
        <form method="post" action="/projects/${p.id}/members" class="form">
          ${csrfField(csrfToken)}
          <div class="grid">
            <label>Usuario existente <input name="username" required maxlength="32" autocomplete="off"></label>
            <label>Rol
              <select name="role"><option value="deployer">Deployer — ${ROLE_HELP.deployer}</option><option value="viewer">Viewer — ${ROLE_HELP.viewer}</option></select>
            </label>
          </div>
          <div><button class="btn btn-primary" type="submit">Añadir miembro</button></div>
        </form>
      </section>`
    : ''}`;
}

export function pager(result, baseQuery = '') {
  if (result.pages <= 1) return '';
  const link = (n, label) => html`<a class="btn btn-small" href="?${baseQuery}${baseQuery ? '&' : ''}page=${n}">${label}</a>`;
  return html`<nav class="row pager" aria-label="Paginación">
    ${result.page > 1 ? link(result.page - 1, '← Anterior') : ''}
    <span class="muted">Página ${result.page} de ${result.pages} · ${result.total} eventos</span>
    ${result.page < result.pages ? link(result.page + 1, 'Siguiente →') : ''}
  </nav>`;
}

export function auditTable(rows, { showProject = true } = {}) {
  if (!rows.length) return html`<p class="muted">Sin eventos.</p>`;
  return html`<div class="table-wrap"><table>
    <thead><tr><th>Fecha (UTC)</th><th>Usuario</th><th>Acción</th>${showProject ? html`<th>Proyecto</th>` : ''}<th>Detalle</th><th>IP</th></tr></thead>
    <tbody>${rows.map(
      (e) => html`<tr>
        <td><small>${e.created_at}</small></td>
        <td>${e.username || html`<span class="muted">—</span>`}</td>
        <td><span class="badge ${/failed|delete|deactivate|remove/.test(e.action) ? 'badge-error' : ''}">${e.action}</span></td>
        ${showProject ? html`<td>${e.project_name || ''}</td>` : ''}
        <td class="mono"><small>${e.detail || ''}</small></td>
        <td class="mono"><small>${e.ip || ''}</small></td>
      </tr>`,
    )}</tbody>
  </table></div>`;
}

export function activityView({ project: p, result }) {
  return html`${projectHeader(p, 'activity')}
  <section class="card">
    <h2>Actividad del proyecto</h2>
    ${auditTable(result.rows, { showProject: false })}
    ${pager(result)}
  </section>`;
}
