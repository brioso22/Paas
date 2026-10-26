import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader, statusBadge } from './projects.js';

export function webhookView({ project: p, url, csrfToken, can, recent, publicBaseUrl }) {
  const canManage = can('webhook.manage');
  return html`${projectHeader(p, 'settings')}
  <section class="card">
    <h2>Auto-deploy con GitHub</h2>
    ${p.source !== 'git'
      ? html`<p class="muted">Este proyecto se despliega con .zip; el webhook solo aplica a proyectos con repositorio git.</p>`
      : html`<p>En GitHub: <em>Settings → Webhooks → Add webhook</em> y completa:</p>
        <div class="form">
          <label>Payload URL
            <span class="copy-row"><input id="hook-url" class="mono" value="${url}" readonly>
            <button type="button" class="btn btn-small" data-copy="#hook-url">Copiar</button></span>
          </label>
          <label>Content type <input class="mono" value="application/json" readonly></label>
          <label>Secret
            <span class="copy-row"><input id="hook-secret" class="mono" type="password" value="" placeholder="••••••••••••" readonly>
            ${canManage
              ? html`<button type="button" class="btn btn-small" data-reveal-url="/projects/${p.id}/webhook/reveal" data-reveal-target="#hook-secret">Revelar</button>
                <button type="button" class="btn btn-small" data-copy="#hook-secret">Copiar</button>`
              : ''}</span>
          </label>
          <p class="hint">Eventos: <strong>Just the push event</strong>. Solo se despliegan los push a la rama <span class="mono">${p.branch}</span>; el evento ping responde "pong".</p>
          ${/^https?:\/\/(localhost|127\.)/.test(publicBaseUrl)
            ? html`<div class="alert alert-warn">PUBLIC_BASE_URL apunta a localhost: GitHub no podrá alcanzar esa URL. Configura una dirección pública (ver docs/PUBLISHING.md).</div>`
            : ''}
        </div>
        ${canManage
          ? html`<form method="post" action="/projects/${p.id}/webhook/rotate" data-confirm="El secreto actual dejará de funcionar. ¿Continuar?">
              ${csrfField(csrfToken)}<button class="btn btn-danger btn-small" type="submit">Regenerar secreto</button></form>`
          : ''}`}
  </section>
  ${recent.length
    ? html`<section class="card table-wrap"><h2>Últimos despliegues por webhook</h2><table>
        <thead><tr><th>#</th><th>Estado</th><th>Origen</th><th>Fecha (UTC)</th></tr></thead>
        <tbody>${recent.map((d) => html`<tr><td><a href="/deployments/${d.id}">#${d.id}</a></td><td>${statusBadge(d.status)}</td><td class="mono">${d.source_ref || ''}</td><td>${d.created_at}</td></tr>`)}</tbody>
      </table></section>`
    : ''}`;
}
