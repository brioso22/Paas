import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader, statusBadge } from './projects.js';

const KIND_LABELS = { build: 'Build + deploy', config: 'Configuración', restart: 'Reinicio', rollback: 'Rollback' };

function duration(d) {
  if (!d.started_at || !d.finished_at) return '';
  const s = Math.round((Date.parse(d.finished_at + 'Z') - Date.parse(d.started_at + 'Z')) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

export function deploymentsView({ project: p, deployments, csrfToken, isAdmin, maxUploadMb, rollbackable, hasLastZip, webhookUrl }) {
  const deployForms = !isAdmin
    ? ''
    : html`<section class="card">
        <h2>Nuevo despliegue</h2>
        <div class="grid">
          ${p.source === 'zip'
            ? html`<form method="post" action="/projects/${p.id}/deploy/zip?_csrf=${encodeURIComponent(csrfToken)}" enctype="multipart/form-data" class="form">
                <label>Archivo .zip (máx. ${maxUploadMb} MB)
                  <input type="file" name="archive" accept=".zip,application/zip" required>
                  <span class="hint">Con Dockerfile en la raíz se usa tal cual; si no, se detecta Node, PHP/Laravel o sitio estático.</span>
                </label>
                <div><button class="btn btn-primary" type="submit">Subir y desplegar</button></div>
              </form>`
            : html`<form method="post" action="/projects/${p.id}/deploy/git" class="form">
                ${csrfField(csrfToken)}
                <p>Clona <span class="mono">${p.repo_url}</span> en la rama <span class="mono">${p.branch}</span> y despliega el último commit.</p>
                ${webhookUrl ? html`<p class="hint">También se dispara automáticamente con cada push (pestaña Webhook).</p>` : ''}
                <div><button class="btn btn-primary" type="submit">Desplegar ahora</button></div>
              </form>`}
          <div class="form">
            ${p.source === 'zip' && hasLastZip
              ? html`<form method="post" action="/projects/${p.id}/deploy/rebuild" class="inline">
                  ${csrfField(csrfToken)}
                  <button class="btn" type="submit">Reconstruir con el último zip</button>
                </form>`
              : ''}
            ${p.current_tag
              ? html`<form method="post" action="/projects/${p.id}/deploy/apply" class="inline">
                  ${csrfField(csrfToken)}
                  <button class="btn" type="submit" title="helm upgrade con la imagen actual, sin reconstruir">Redesplegar sin reconstruir</button>
                </form>`
              : ''}
          </div>
        </div>
      </section>`;

  return html`${projectHeader(p, 'deployments')}
    ${deployForms}
    <section class="card table-wrap">
      <h2>Historial</h2>
      ${deployments.length === 0
        ? html`<p class="muted">Todavía no hay despliegues.</p>`
        : html`<table>
          <thead><tr><th>#</th><th>Tipo</th><th>Estado</th><th>Tag</th><th>Disparado por</th><th>Inicio (UTC)</th><th>Duración</th><th></th></tr></thead>
          <tbody>${deployments.map(
            (d) => html`<tr>
              <td><a href="/deployments/${d.id}">#${d.id}</a></td>
              <td>${KIND_LABELS[d.kind] || d.kind}${d.stack ? html`<br><small>${d.stack}</small>` : ''}</td>
              <td>${statusBadge(d.status)}</td>
              <td class="mono">${d.tag || '—'}${d.tag && d.tag === p.current_tag ? html` <span class="badge badge-ok">actual</span>` : ''}${d.helm_revision ? html`<br><small>rev. ${d.helm_revision}</small>` : ''}</td>
              <td>${d.triggered_by}</td>
              <td><small>${d.started_at || d.created_at}</small></td>
              <td><small>${duration(d)}</small></td>
              <td>${isAdmin && rollbackable.has(d.id)
                ? html`<form method="post" action="/projects/${p.id}/deployments/${d.id}/rollback" class="inline" data-confirm="¿Volver a la revisión ${d.helm_revision} (${d.tag})?">
                    ${csrfField(csrfToken)}<button class="btn btn-small" type="submit">Rollback</button></form>`
                : ''}</td>
            </tr>`,
          )}</tbody></table>`}
    </section>`;
}

export function deploymentDetailView({ project: p, d, queuePosition }) {
  return html`${projectHeader(p, 'deployments')}
    <section class="card">
      <div class="row between">
        <h2>Despliegue #${d.id} · ${KIND_LABELS[d.kind] || d.kind}</h2>
        <span id="dep-status" class="badge badge-${d.status}">${d.status}</span>
      </div>
      <dl class="kv">
        <dt>Tag</dt><dd class="mono">${d.tag || '—'}</dd>
        ${d.commit_sha ? html`<dt>Commit</dt><dd class="mono">${d.commit_sha}</dd>` : ''}
        ${d.source_ref ? html`<dt>Origen</dt><dd class="mono">${d.source_ref}</dd>` : ''}
        <dt>Disparado por</dt><dd>${d.triggered_by}</dd>
        <dt>Creado</dt><dd>${d.created_at} UTC</dd>
        ${queuePosition ? html`<dt>Posición en cola</dt><dd>${queuePosition}</dd>` : ''}
        ${d.error ? html`<dt>Error</dt><dd class="alert-error">${d.error}</dd>` : ''}
      </dl>
    </section>
    <section class="card">
      <h2>Log</h2>
      <pre class="log" data-stream="/deployments/${d.id}/stream" data-status-target="#dep-status" ${['success', 'failed'].includes(d.status) ? '' : 'data-reload-on-end'}></pre>
      ${d.log_truncated ? html`<p class="hint">El log se recortó por superar MAX_LOG_KB.</p>` : ''}
    </section>
    <p><a href="/projects/${p.id}/deployments">← Volver al historial</a></p>`;
}
