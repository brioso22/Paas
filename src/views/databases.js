import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader } from './projects.js';
import { DB_ENGINES, DB_SIZES, internalHost } from '../services/databases.js';

function statusCell(st) {
  if (!st || st.dryRun) return html`<span class="muted" title="DRY_RUN: no se consulta el clúster">n/d</span>`;
  if (st.error) return html`<span class="badge badge-error" title="${st.error}">sin acceso</span>`;
  if (!st.exists && !st.pvc) return html`<span class="badge badge-warn">sin recursos</span>`;
  const failing = !st.ready && /CrashLoopBackOff|OOMKilled|Error|ImagePull/.test(st.reason || '');
  const label = st.ready ? 'lista' : failing ? 'con errores' : 'iniciando';
  return html`<span class="badge ${st.ready ? 'badge-ok' : failing ? 'badge-error' : 'badge-warn'}">${label}</span>
    <br><small>PVC: ${st.pvc || '—'}${st.capacity ? ` (${st.capacity})` : ''}${!st.ready && st.reason ? ` · ${st.reason}` : ''}${st.restarts ? ` · ${st.restarts} reinicio(s)` : ''}</small>`;
}

export function databasesView({ project: p, databases, statuses, csrfToken, can, values = {}, error, conflicts = [] }) {
  const manage = can('db.manage');
  const engine = values.engine || 'postgres';
  return html`${projectHeader(p, 'databases')}
  <section class="card table-wrap">
    <h2>Bases de datos</h2>
    ${databases.length === 0
      ? html`<p class="muted">Este proyecto no tiene bases de datos.</p>`
      : html`<table>
        <thead><tr><th>Nombre</th><th>Motor</th><th>Disco</th><th>Estado</th><th>Host interno</th>${manage ? html`<th>Contraseña</th><th></th>` : ''}</tr></thead>
        <tbody>${databases.map(
          (d) => html`<tr>
            <td><strong>${d.name}</strong><br><small>${d.cpu_limit} / ${d.memory_limit}</small></td>
            <td>${DB_ENGINES[d.engine].label}</td>
            <td>${d.size_gi} Gi</td>
            <td>${statusCell(statuses[d.name] || (statuses.dryRun ? statuses : statuses.error ? statuses : null))}</td>
            <td class="mono"><small>${internalHost(p, d)}:${DB_ENGINES[d.engine].port}</small></td>
            ${manage ? html`<td><span class="copy-row">
              <input id="db-pw-${d.id}" class="mono" type="password" readonly placeholder="••••••">
              <button type="button" class="btn btn-small" data-reveal-url="/projects/${p.id}/databases/${d.id}/reveal" data-reveal-target="#db-pw-${d.id}">Revelar</button>
              <button type="button" class="btn btn-small" data-copy="#db-pw-${d.id}">Copiar</button>
            </span></td>
            <td><form method="post" action="/projects/${p.id}/databases/${d.id}/delete" class="row" data-confirm="Se borrarán el StatefulSet, el Service, el Secret y el volumen con TODOS los datos de ${d.name}. ¿Continuar?">
              ${csrfField(csrfToken)}
              <input name="confirm_name" placeholder="${d.name}" required autocomplete="off" aria-label="Escribe ${d.name} para confirmar">
              <button class="btn btn-danger btn-small" type="submit">Eliminar</button>
            </form></td>` : ''}
          </tr>`,
        )}</tbody></table>`}
  </section>
  ${manage ? html`<section class="card">
    <h2>Nueva base de datos</h2>
    ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
    <form method="post" action="/projects/${p.id}/databases" class="form">
      ${csrfField(csrfToken)}
      <div class="grid">
        <label>Nombre <input name="name" required pattern="[a-z][a-z0-9\\-]{1,20}" maxlength="21" value="${values.name || ''}" autocomplete="off"></label>
        <label>Motor
          <select name="engine">
            ${Object.entries(DB_ENGINES).map(([k, e]) => html`<option value="${k}" ${engine === k ? 'selected' : ''}>${e.label} (por defecto ${e.cpu_limit} / ${e.memory_limit})</option>`)}
          </select>
        </label>
        <label>Disco
          <select name="size_gi">${DB_SIZES.map((s) => html`<option value="${s}" ${String(values.size_gi || 1) === String(s) ? 'selected' : ''}>${s} Gi</option>`)}</select>
        </label>
        <label>Límite de CPU <input name="cpu_limit" placeholder="por defecto del motor" value="${values.cpu_limit || ''}"></label>
        <label>Límite de memoria <input name="memory_limit" placeholder="por defecto del motor" value="${values.memory_limit || ''}"></label>
      </div>
      <p class="hint">La contraseña se genera en el servidor. Se añadirán al proyecto (cifradas) DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD y DATABASE_URL, y si ya está desplegado se reiniciarán sus pods.</p>
      ${conflicts.length
        ? html`<div class="alert alert-warn">
            Ya existen estas variables y se sobrescribirán: <span class="mono">${conflicts.join(', ')}</span>
            <label class="check"><input type="checkbox" name="confirm_overwrite" value="on"> Sí, sobrescribirlas</label>
          </div>`
        : ''}
      <div><button class="btn btn-primary" type="submit">Crear base de datos</button></div>
    </form>
  </section>` : ''}`;
}
