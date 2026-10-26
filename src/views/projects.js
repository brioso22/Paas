import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { RESOURCE_DEFAULTS } from '../services/projects.js';
import { icon } from './icons.js';

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

export const money = (n) => (n === null || n === undefined ? '—' : `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`);

export const STACK_LABELS = { node: 'Node.js', php: 'PHP', laravel: 'Laravel', static: 'Estático', python: 'Python', dockerfile: 'Dockerfile' };

function projectCard({ project: p, pods, url, stack, lastDeployment, costHour }) {
  return html`<article class="card project-card">
    <div class="row between">
      <h2><a href="/projects/${p.id}">${p.name}</a></h2>
      ${statusBadge(p.status)}
    </div>
    <a class="url mono" href="${url}" target="_blank" rel="noopener noreferrer">${icon('link')} ${url.replace(/^https?:\/\//, '')}</a>
    <dl class="facts">
      <div><dt>Stack</dt><dd>${stack ? STACK_LABELS[stack] || stack : html`<span class="muted">—</span>`}</dd></div>
      <div><dt>Réplicas</dt><dd>${desiredReplicas(p)} ${podsCell(pods)}</dd></div>
      <div><dt>Último despliegue</dt><dd>${lastDeployment
        ? html`<a href="/deployments/${lastDeployment.id}">#${lastDeployment.id}</a> <small>${lastDeployment.created_at.slice(5, 16)}</small>`
        : html`<span class="muted">nunca</span>`}</dd></div>
      <div><dt>Costo / hora</dt><dd class="mono">${money(costHour)}</dd></div>
    </dl>
    <div class="actions">
      <a class="btn btn-small" href="/projects/${p.id}/logs">${icon('logs')} Logs</a>
      <a class="btn btn-small" href="/projects/${p.id}/deployments">${icon('rocket')} Despliegues</a>
      ${p.member_role && p.member_role !== 'owner' ? html`<span class="badge" title="Tu rol en el proyecto">${p.member_role}</span>` : ''}
    </div>
  </article>`;
}

export function dashboardView({ rows, canCreate }) {
  return html`<div class="page-head">
      <h1>Proyectos</h1>
      ${canCreate && rows.length ? html`<a class="btn btn-primary" href="/projects/new">${icon('plus')} Nuevo proyecto</a>` : ''}
    </div>
    ${rows.length === 0
      ? html`<section class="card empty">
          ${icon('rocket')}
          <h2>Aún no tienes proyectos</h2>
          ${canCreate
            ? html`<p>Sube un .zip o conecta un repositorio git y lo publicamos en su propio subdominio, con HTTPS y bases de datos opcionales.</p>
              <a class="btn btn-primary" href="/projects/new">${icon('plus')} Crear mi primer proyecto</a>`
            : html`<p>Cuando alguien te invite a un proyecto aparecerá aquí.</p>`}
        </section>`
      : html`<div class="cards">${rows.map(projectCard)}</div>`}`;
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

export const PROJECT_PRESETS = [
  { label: 'Node.js', port: 3000, env: 'NODE_ENV=production' },
  { label: 'PHP / Laravel', port: 80, env: 'APP_ENV=production\nAPP_DEBUG=false\nAPP_KEY=\nLOG_CHANNEL=stderr' },
  { label: 'Python / Flask', port: 8000, env: 'FLASK_ENV=production\nPYTHONUNBUFFERED=1' },
];

export function newProjectView({ csrfToken, values = {}, error, domain }) {
  const src = values.source || 'zip';
  return html`<div class="page-head"><h1>Nuevo proyecto</h1></div>
  <div class="card row">
    <span class="muted">Plantilla:</span>
    ${PROJECT_PRESETS.map((t) => html`<button type="button" class="btn btn-small" data-preset-port="${t.port}" data-preset-env="${t.env}">${t.label}</button>`)}
    <span class="hint">Rellena el puerto y variables sugeridas; puedes cambiarlos.</span>
  </div>
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

    <label>Dominio personalizado (opcional)
      <input name="custom_domain" placeholder="app.midominio.com" value="${values.custom_domain || ''}" autocomplete="off">
      <span class="hint">Se añade como host extra del ingress y del certificado HTTPS. Debe apuntar (DNS) a este servidor.</span>
    </label>

    <input type="hidden" name="tls_form" value="1">
    <label class="check"><input type="checkbox" name="tls_enabled" ${values.tls_form === '1' && values.tls_enabled !== 'on' ? '' : 'checked'}> HTTPS (certificado de la CA de Lisec; HTTP redirige a HTTPS)</label>

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
  ['deployments', 'Despliegues'],
  ['env', 'Variables'],
  ['databases', 'Bases de datos'],
  ['domains', 'Dominios y HTTPS'],
  ['metrics', 'Métricas'],
  ['members', 'Miembros'],
  ['activity', 'Actividad', 'project.audit'],
  ['settings', 'Ajustes'],
];

export function projectHeader(project, active, tabs = PROJECT_TABS) {
  return html`<div class="page-head">
      <h1>${project.name} ${statusBadge(project.status)}</h1>
      <div class="row">
        <a class="btn btn-small" href="/projects/${project.id}/logs">${icon('logs')} Logs</a>
      </div>
    </div>
    <nav class="tabs" aria-label="Secciones del proyecto">
      ${tabs
        .filter(([, , action]) => !action || project.can?.(action))
        .map(([path, label]) => html`<a href="/projects/${project.id}${path ? '/' + path : ''}" class="${active === path ? 'active' : ''}" ${active === path ? html`aria-current="page"` : ''}>${label}</a>`)}
    </nav>`;
}

export function projectOverviewView({ project: p, pods, url, ingressTest, csrfToken, can, lastDeployment, publication, summary, extra = '' }) {
  return html`${projectHeader(p, '')}
  ${summary
    ? html`<section class="card">
        <h2>Resumen</h2>
        <div class="grid">
          <div><small>URL(s)</small>${summary.urls.map((u) => html`<div><a class="mono" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a></div>`)}</div>
          <div><small>Estado</small><div>${statusBadge(p.status)} ${podsCell(pods)}</div><small>Réplicas: ${desiredReplicas(p)}</small></div>
          <div><small>Base de datos</small><div>${summary.databases.length
            ? summary.databases.map((d) => html`<div><a href="/projects/${p.id}/databases">${d.name}</a> <small>${d.engine}, ${d.size_gi} Gi</small></div>`)
            : html`<span class="muted">ninguna</span>`}</div></div>
          <div><small>Último despliegue</small><div>${lastDeployment
            ? html`<a href="/deployments/${lastDeployment.id}">#${lastDeployment.id}</a> ${statusBadge(lastDeployment.status)}`
            : html`<span class="muted">nunca</span>`}</div></div>
          <div><small>Costo estimado / hora</small><div class="metric">${summary.costHour === null ? '—' : `$${summary.costHour.toFixed(4)}`}</div>
            ${summary.metricsAvailable ? '' : html`<small>Prometheus no disponible</small>`}</div>
        </div>
      </section>`
    : ''}
  <div class="grid">
    <section class="card">
      <h2>General</h2>
      <dl class="kv">
        <dt>URL pública</dt><dd><a href="${url}" target="_blank" rel="noopener noreferrer" class="mono">${url}</a></dd>
        <dt>Namespace</dt><dd class="mono">${p.namespace}</dd>
        ${publication ? html`<dt>Publicación</dt><dd>${publication.exposed ? html`<a href="${publication.url}" class="mono" target="_blank" rel="noopener noreferrer">${publication.url}</a>` : html`<small>${publication.message}</small>`}</dd>` : ''}
        <dt>Origen</dt><dd>${p.source === 'git' ? html`<span class="mono">${p.repo_url}</span> (rama <span class="mono">${p.branch}</span>)` : 'Archivo .zip'}</dd>
        <dt>Puerto</dt><dd>${p.port}</dd>
        <dt>Versión actual</dt><dd class="mono">${p.current_tag || '—'}</dd>
        <dt>Último despliegue</dt><dd>${lastDeployment
          ? html`<a href="/deployments/${lastDeployment.id}">#${lastDeployment.id}</a> ${statusBadge(lastDeployment.status)} <small>${lastDeployment.created_at} UTC</small>`
          : html`<a href="/projects/${p.id}/deployments">Aún no desplegado</a>`}</dd>
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
      <h3>Probar en local</h3>
      ${ingressTest.map(
        (t, i) => html`<div class="copy-cmd"><small>${t.label}</small>
          <div class="row"><input id="test-cmd-${i}" class="mono" value="${t.cmd}" readonly><button class="btn" type="button" data-copy="#test-cmd-${i}">Copiar</button></div></div>`,
      )}
      ${p.tls_enabled ? html`<p class="hint"><a href="/tls/ca.crt">Descargar lisec-ca.crt</a> · instrucciones en <a href="/projects/${p.id}/domains">Dominios y HTTPS</a>.</p>` : ''}
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
  ${can('project.delete')
    ? html`<section class="card">
        <h2>Zona de peligro</h2>
        <p class="muted">Elimina la release de Helm, el namespace <span class="mono">${p.namespace}</span> con todo su contenido (incluidas las bases de datos), las imágenes y el historial.</p>
        <form method="post" action="/projects/${p.id}/delete" class="row" data-confirm="¿Eliminar ${p.name} definitivamente?">
          ${csrfField(csrfToken)}
          <input name="confirm_name" placeholder="Escribe ${p.name} para confirmar" required autocomplete="off">
          <button class="btn btn-danger" type="submit">Eliminar proyecto</button>
        </form>
      </section>`
    : ''}`;
}
