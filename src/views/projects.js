import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { RESOURCE_DEFAULTS } from '../services/projects.js';

export const STATUS_LABELS = {
  created: 'creado',
  queued: 'en cola',
  building: 'construyendo',
  deploying: 'desplegando',
  live: 'activo',
  success: 'éxito',
  failed: 'fallido',
  error: 'error',
};

export function statusBadge(status) {
  return html`<span class="badge badge-${status}">${STATUS_LABELS[status] || status}</span>`;
}

export function podsCell(st) {
  if (!st) return html`<span class="muted">—</span>`;
  if (st.error) return html`<span class="badge badge-error" title="${st.error}">sin acceso</span>`;
  if (st.dryRun) return html`<span class="muted" title="DRY_RUN: no se consulta el clúster">n/d</span>`;
  return html`<span class="${st.ready === st.total && st.total > 0 ? 'badge badge-ok' : 'badge badge-warn'}">${st.ready}/${st.total} listos</span>`;
}

export function desiredReplicas(p) {
  return p.autoscaling_enabled ? `${p.autoscaling_min}–${p.autoscaling_max} (HPA)` : String(p.replicas);
}

export function dashboardView({ rows, isAdmin }) {
  return html`<div class="row between">
      <h1>Proyectos</h1>
      ${isAdmin ? html`<a class="btn btn-primary" href="/projects/new">+ Nuevo proyecto</a>` : ''}
    </div>
    ${rows.length === 0
      ? html`<div class="card"><p class="muted">Aún no hay proyectos.${isAdmin ? html` <a href="/projects/new">Crea el primero</a>.` : ''}</p></div>`
      : html`<div class="card table-wrap"><table>
          <thead><tr><th>Nombre</th><th>Estado</th><th>Pods</th><th>Réplicas</th><th>Origen</th><th>URL pública</th></tr></thead>
          <tbody>
          ${rows.map(
            ({ project: p, pods, url }) => html`<tr>
              <td><a href="/projects/${p.id}"><strong>${p.name}</strong></a><br><small class="mono">${p.namespace}</small></td>
              <td>${statusBadge(p.status)}${p.current_tag ? html`<br><small class="mono">${p.current_tag}</small>` : ''}</td>
              <td>${podsCell(pods)}</td>
              <td>${desiredReplicas(p)}</td>
              <td>${p.source === 'git' ? html`git <small class="mono">${p.branch}</small>` : 'zip'}</td>
              <td><a href="${url}" rel="noopener noreferrer" target="_blank" class="mono">${url}</a></td>
            </tr>`,
          )}
          </tbody></table></div>`}`;
}

function resourceFields(values) {
  const val = (k) => values[k] ?? RESOURCE_DEFAULTS[k];
  return html`<div class="grid">
    <label>CPU solicitada <input name="cpu_request" value="${val('cpu_request')}" required pattern="\\d+m|\\d+(\\.\\d+)?"><span class="hint">Ej.: 100m, 0.25</span></label>
    <label>Límite de CPU <input name="cpu_limit" value="${val('cpu_limit')}" required pattern="\\d+m|\\d+(\\.\\d+)?"></label>
    <label>Memoria solicitada <input name="memory_request" value="${val('memory_request')}" required pattern="\\d+(Mi|Gi)"><span class="hint">Ej.: 128Mi, 1Gi</span></label>
    <label>Límite de memoria <input name="memory_limit" value="${val('memory_limit')}" required pattern="\\d+(Mi|Gi)"></label>
  </div>`;
}

export function newProjectView({ csrfToken, values = {}, error, domain }) {
  const src = values.source || 'zip';
  return html`<h1>Nuevo proyecto</h1>
  ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
  <form method="post" action="/projects" class="form card">
    ${csrfField(csrfToken)}
    <label>Nombre
      <input name="name" required minlength="3" maxlength="30" pattern="[a-z0-9][a-z0-9\\-]{1,28}[a-z0-9]" value="${values.name || ''}" autocomplete="off">
      <span class="hint">Minúsculas, dígitos y guiones. Será el subdominio: &lt;nombre&gt;.${domain}</span>
    </label>

    <fieldset>
      <legend>Origen del código</legend>
      <label class="check"><input type="radio" name="source" value="zip" ${src === 'zip' ? 'checked' : ''}> Subir un .zip (después de crear el proyecto)</label>
      <label class="check"><input type="radio" name="source" value="git" ${src === 'git' ? 'checked' : ''}> Repositorio git (https)</label>
      <div data-source="git" class="form">
        <label>URL del repositorio <input name="repo_url" type="url" placeholder="https://github.com/usuario/repo.git" value="${values.repo_url || ''}"></label>
        <label>Rama <input name="branch" value="${values.branch || 'main'}"></label>
        <label>Token de acceso (opcional, para repos privados)
          <input name="git_token" type="password" autocomplete="off">
          <span class="hint">Se guarda cifrado y nunca se incluye en la URL ni en los logs.</span>
        </label>
      </div>
    </fieldset>

    <label>Puerto del contenedor <input name="port" type="number" min="1" max="65535" required value="${values.port || '3000'}">
      <span class="hint">Puerto en el que escucha tu aplicación (Node suele ser 3000, PHP/nginx 80).</span></label>

    <fieldset>
      <legend>Recursos por contenedor</legend>
      ${resourceFields(values)}
      <label>Réplicas <input name="replicas" type="number" min="0" max="20" value="${values.replicas ?? 1}"></label>
    </fieldset>

    <label>Variables de entorno
      <textarea name="env" placeholder="CLAVE=valor&#10;OTRA_CLAVE=otro valor" spellcheck="false">${values.env || ''}</textarea>
      <span class="hint">Una por línea, formato CLAVE=valor. Se guardan cifradas y se inyectan como Secret.</span>
    </label>

    <div><button class="btn btn-primary" type="submit">Crear proyecto</button></div>
  </form>`;
}

export const PROJECT_TABS = [
  ['', 'Resumen'],
];

export function projectHeader(project, active, tabs = PROJECT_TABS) {
  return html`<div class="row between">
      <h1>${project.name} ${statusBadge(project.status)}</h1>
    </div>
    <nav class="tabs">
      ${tabs.map(([path, label]) => html`<a href="/projects/${project.id}${path ? '/' + path : ''}" class="${active === path ? 'active' : ''}">${label}</a>`)}
    </nav>`;
}

export function projectOverviewView({ project: p, pods, url, ingressTest, csrfToken, isAdmin, extra = '' }) {
  return html`${projectHeader(p, '')}
  <div class="grid">
    <section class="card">
      <h2>General</h2>
      <dl class="kv">
        <dt>URL pública</dt><dd><a href="${url}" target="_blank" rel="noopener noreferrer" class="mono">${url}</a></dd>
        <dt>Namespace</dt><dd class="mono">${p.namespace}</dd>
        <dt>Origen</dt><dd>${p.source === 'git' ? html`<span class="mono">${p.repo_url}</span> (rama <span class="mono">${p.branch}</span>)` : 'Archivo .zip'}</dd>
        <dt>Puerto</dt><dd>${p.port}</dd>
        <dt>Versión actual</dt><dd class="mono">${p.current_tag || '—'}</dd>
        <dt>Creado</dt><dd>${p.created_at} UTC</dd>
      </dl>
    </section>
    <section class="card">
      <h2>Estado</h2>
      <dl class="kv">
        <dt>Pods</dt><dd>${podsCell(pods)}</dd>
        <dt>Réplicas deseadas</dt><dd>${desiredReplicas(p)}</dd>
        <dt>CPU</dt><dd>${p.cpu_request} / ${p.cpu_limit}</dd>
        <dt>Memoria</dt><dd>${p.memory_request} / ${p.memory_limit}</dd>
      </dl>
      <h3>Probar el ingress</h3>
      <pre class="log">${ingressTest}</pre>
    </section>
  </div>
  ${pods && pods.pods && pods.pods.length
    ? html`<section class="card table-wrap"><h2>Pods</h2><table>
        <thead><tr><th>Nombre</th><th>Fase</th><th>Listo</th><th>Reinicios</th><th>Motivo</th></tr></thead>
        <tbody>${pods.pods.map(
          (x) => html`<tr><td class="mono">${x.name}</td><td>${x.terminating ? 'Terminating' : x.phase}</td><td>${x.ready ? 'sí' : 'no'}</td><td>${x.restarts}</td><td>${x.reason || ''}</td></tr>`,
        )}</tbody></table></section>`
    : ''}
  ${extra}
  ${isAdmin
    ? html`<section class="card">
        <h2>Zona de peligro</h2>
        <p class="muted">Elimina la release de Helm, el namespace <span class="mono">${p.namespace}</span> con todo su contenido, las imágenes y el historial.</p>
        <form method="post" action="/projects/${p.id}/delete" class="row" data-confirm="¿Eliminar ${p.name} definitivamente?">
          ${csrfField(csrfToken)}
          <input name="confirm_name" placeholder="Escribe ${p.name} para confirmar" required autocomplete="off">
          <button class="btn btn-danger" type="submit">Eliminar proyecto</button>
        </form>
      </section>`
    : ''}`;
}
