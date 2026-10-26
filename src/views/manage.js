import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader } from './projects.js';

export function envView({ project: p, keys, csrfToken, can, deployed }) {
  const canEdit = can('env.edit');
  const ro = !canEdit;
  return html`${projectHeader(p, 'env')}
  <section class="card">
    <h2>Variables de entorno</h2>
    <p class="muted">Se guardan cifradas (AES-256-GCM) y se inyectan en los pods mediante el Secret <span class="mono">${p.name}-env</span>.
      Los valores no se muestran; deja el campo vacío para conservar el valor actual.</p>
    <form method="post" action="/projects/${p.id}/env" class="form">
      ${csrfField(csrfToken)}
      <div id="env-list" class="stack">
        ${keys.length === 0 ? html`<p class="muted">Sin variables.</p>` : ''}
        ${keys.map(
          (k, i) => html`<div class="env-row">
            <input class="mono" value="${k.key}" readonly aria-label="Nombre">
            <input type="hidden" name="existing_key" value="${k.key}">
            <input id="env-val-${i}" class="mono" type="password" name="existing_value" placeholder="•••••• (sin cambios)" autocomplete="off" ${ro ? 'disabled' : ''} aria-label="Nuevo valor de ${k.key}">
            ${canEdit
              ? html`<button type="button" class="btn btn-small" data-reveal-url="/projects/${p.id}/env/${encodeURIComponent(k.key)}/reveal" data-reveal-target="#env-val-${i}">Revelar</button>
                <label class="check"><input type="checkbox" name="delete" value="${k.key}"> borrar</label>`
              : html`<span></span><span></span>`}
          </div>`,
        )}
      </div>
      ${canEdit
        ? html`<template id="env-new-row"><div class="env-row">
            <input class="mono" name="new_key" placeholder="NUEVA_VARIABLE" pattern="[A-Z_][A-Z0-9_]*" autocomplete="off">
            <input class="mono" name="new_value" placeholder="valor" autocomplete="off">
            <button type="button" class="btn btn-small" data-remove-row>Quitar</button><span></span>
          </div></template>
          <div><button type="button" class="btn btn-small" data-add-row="env-new-row" data-into="#env-list">+ Añadir variable</button></div>
          <label>Al guardar
            <select name="apply">
              <option value="restart" ${deployed ? 'selected' : ''}>Actualizar el Secret y reiniciar los pods (rollout restart)</option>
              <option value="redeploy">Actualizar y redesplegar con Helm (sin reconstruir)</option>
              <option value="none" ${deployed ? '' : 'selected'}>Solo guardar (se aplicará en el próximo despliegue)</option>
            </select>
          </label>
          <div><button class="btn btn-primary" type="submit">Guardar variables</button></div>`
        : ''}
    </form>
  </section>`;
}

export function logsView({ project: p }) {
  return html`${projectHeader(p, 'logs')}
  <section class="card">
    <div class="row between">
      <h2>Logs de los pods</h2>
      <a class="btn btn-small" href="/projects/${p.id}/logs">Reconectar</a>
    </div>
    <p class="muted">Últimas 200 líneas de cada contenedor y, a continuación, en vivo (<span class="mono">kubectl logs -f</span>).</p>
    <pre class="log" data-stream="/projects/${p.id}/logs/stream"></pre>
  </section>`;
}

export function settingsView({ project: p, csrfToken, can, hasToken }) {
  const canSettings = can('project.settings');
  const dis = canSettings ? '' : 'disabled';
  const canDeploy = can('project.deploy');
  return html`${projectHeader(p, 'settings')}
  <div class="grid">
    <section class="card">
      <h2>Escalado manual</h2>
      ${p.autoscaling_enabled
        ? html`<p class="muted">El HPA está activo (${p.autoscaling_min}–${p.autoscaling_max} réplicas). Desactívalo para escalar a mano.</p>`
        : html`<form method="post" action="/projects/${p.id}/scale" class="form">
            ${csrfField(csrfToken)}
            <label>Réplicas <input type="number" name="replicas" min="0" max="20" value="${p.replicas}" ${dis}></label>
            <span class="hint">Se aplica al momento con kubectl scale y se guarda para próximos despliegues. 0 = apagar.</span>
            ${canSettings ? html`<div><button class="btn btn-primary" type="submit">Escalar</button></div>` : ''}
          </form>`}
    </section>

    <section class="card">
      <h2>Autoescalado (HPA)</h2>
      <form method="post" action="/projects/${p.id}/autoscaling" class="form">
        ${csrfField(csrfToken)}
        <label class="check"><input type="checkbox" name="autoscaling_enabled" ${p.autoscaling_enabled ? 'checked' : ''} ${dis}> Activar HPA</label>
        <div class="grid">
          <label>Mínimo <input type="number" name="autoscaling_min" min="1" max="20" value="${p.autoscaling_min}" ${dis}></label>
          <label>Máximo <input type="number" name="autoscaling_max" min="1" max="20" value="${p.autoscaling_max}" ${dis}></label>
          <label>% CPU objetivo <input type="number" name="autoscaling_cpu" min="10" max="100" value="${p.autoscaling_cpu}" ${dis}></label>
        </div>
        <span class="hint">Requiere metrics-server en el clúster. Se aplica con helm upgrade (sin reconstruir).</span>
        ${canSettings ? html`<div><button class="btn btn-primary" type="submit">Guardar HPA</button></div>` : ''}
      </form>
    </section>

    <section class="card">
      <h2>Recursos por contenedor</h2>
      <form method="post" action="/projects/${p.id}/resources" class="form">
        ${csrfField(csrfToken)}
        <div class="grid">
          <label>CPU solicitada <input name="cpu_request" value="${p.cpu_request}" ${dis}></label>
          <label>Límite de CPU <input name="cpu_limit" value="${p.cpu_limit}" ${dis}></label>
          <label>Memoria solicitada <input name="memory_request" value="${p.memory_request}" ${dis}></label>
          <label>Límite de memoria <input name="memory_limit" value="${p.memory_limit}" ${dis}></label>
        </div>
        <span class="hint">Recalcula la ResourceQuota y el LimitRange del namespace y redespliega con Helm.</span>
        ${canSettings ? html`<div><button class="btn btn-primary" type="submit">Guardar recursos</button></div>` : ''}
      </form>
    </section>

    <section class="card">
      <h2>Acciones</h2>
      ${canDeploy
        ? html`<form method="post" action="/projects/${p.id}/restart" class="form" data-confirm="¿Reiniciar todos los pods de ${p.name}?">
            ${csrfField(csrfToken)}
            <p class="muted">Rollout restart: crea pods nuevos y retira los viejos sin cortar el servicio (si hay más de una réplica).</p>
            <div><button class="btn" type="submit" ${p.current_tag ? '' : 'disabled'}>Reiniciar pods</button></div>
          </form>
          <p><a href="/projects/${p.id}/deployments">Redesplegar o hacer rollback →</a></p>
          ${p.source === 'git' ? html`<p><a href="/projects/${p.id}/webhook">Auto-deploy con webhook de GitHub →</a></p>` : ''}`
        : html`<p class="muted">Tu rol en este proyecto es de solo lectura.</p>`}
    </section>

    ${p.source === 'git'
      ? html`<section class="card">
          <h2>Repositorio</h2>
          <form method="post" action="/projects/${p.id}/git" class="form">
            ${csrfField(csrfToken)}
            <label>URL <input name="repo_url" value="${p.repo_url}" ${dis}></label>
            <label>Rama <input name="branch" value="${p.branch}" ${dis}></label>
            <label>Token de acceso
              <input type="password" name="git_token" placeholder="${hasToken ? '•••••• (guardado; vacío = sin cambios)' : 'sin token'}" autocomplete="off" ${dis}>
            </label>
            ${hasToken && canSettings ? html`<label class="check"><input type="checkbox" name="clear_token"> Eliminar el token guardado</label>` : ''}
            ${canSettings ? html`<div><button class="btn btn-primary" type="submit">Guardar</button></div>` : ''}
          </form>
        </section>`
      : ''}
  </div>`;
}

export function domainsView({ project: p, csrfToken, can, https }) {
  const canTls = can('tls.manage');
  const disTls = canTls ? '' : 'disabled';
  return html`${projectHeader(p, 'domains')}
  <div class="grid">
    <section class="card">
      <h2>Dominio personalizado</h2>
      <form method="post" action="/projects/${p.id}/domain" class="form">
        ${csrfField(csrfToken)}
        <label>Dominio <input name="custom_domain" value="${p.custom_domain || ''}" placeholder="app.midominio.com" ${disTls}></label>
        <span class="hint">Host adicional del ingress (y del certificado si HTTPS está activo). Vacío = quitarlo. Requiere redeploy con Helm.</span>
        ${canTls ? html`<div><button class="btn btn-primary" type="submit">Guardar dominio</button></div>` : ''}
      </form>
    </section>

    <section class="card">
      <h2>HTTPS (CA de Lisec)</h2>
      ${p.tls_enabled
        ? html`<p><span class="badge badge-ok">activo</span> <a class="mono" href="${https.url}" target="_blank" rel="noopener noreferrer">${https.url}</a></p>
            <p class="hint">Certificado ${https.wildcard ? html`wildcard <span class="mono">*.${https.domain}</span>` : 'propio del proyecto'}, expira ${p.tls_expires_at ? p.tls_expires_at.slice(0, 10) : '—'}. HTTP redirige a HTTPS (308).</p>
            <div class="copy-cmd"><small>Prueba</small><div class="row"><input id="tls-curl" class="mono" value="curl --cacert lisec-ca.crt ${https.url}/" readonly><button class="btn" type="button" data-copy="#tls-curl">Copiar</button></div></div>`
        : html`<p class="muted">Sirve <span class="mono">${https.host}</span>${p.custom_domain ? html` y <span class="mono">${p.custom_domain}</span>` : ''} por HTTPS con un certificado firmado por la CA de Lisec (365 días).</p>`}
      ${canTls
        ? html`<div class="row">
            ${p.tls_enabled
              ? html`<form method="post" action="/projects/${p.id}/tls/renew" class="inline">${csrfField(csrfToken)}<button class="btn" type="submit">Renovar certificado</button></form>
                  <form method="post" action="/projects/${p.id}/tls/disable" class="inline" data-confirm="¿Desactivar HTTPS?">${csrfField(csrfToken)}<button class="btn btn-danger" type="submit">Desactivar</button></form>`
              : html`<form method="post" action="/projects/${p.id}/tls/enable" class="inline">${csrfField(csrfToken)}<button class="btn btn-primary" type="submit">Activar HTTPS</button></form>`}
          </div>`
        : ''}
    </section>

    <section class="card">
      <h2>Certificado de la CA</h2>
      <p><a class="btn btn-primary" href="/tls/ca.crt" download>Descargar lisec-ca.crt</a> <small class="muted">Solo la parte pública; la clave nunca sale del servidor.</small></p>
      <p class="hint">Instálalo una vez en cada equipo para que los navegadores confíen en <span class="mono">https://*.${https.domain}</span>:</p>
      <ul class="ca-steps hint">
        <li><strong>Brave / Chrome (Linux)</strong>: <span class="mono">brave://settings/certificates</span> o <span class="mono">chrome://settings/certificates</span> → Autoridades → Importar → <span class="mono">lisec-ca.crt</span> → marcar «Confiar en este certificado para identificar sitios web».</li>
        <li><strong>Firefox</strong>: Ajustes → Privacidad y seguridad → Certificados → Ver certificados → Autoridades → Importar → marcar «Confiar en esta CA para identificar sitios web».</li>
        <li><strong>Sistema (curl, wget, apps)</strong>:
          <div class="copy-cmd"><div class="row"><input id="ca-system" class="mono" value="sudo cp lisec-ca.crt /usr/local/share/ca-certificates/lisec-ca.crt &amp;&amp; sudo update-ca-certificates" readonly><button class="btn" type="button" data-copy="#ca-system">Copiar</button></div></div>
        </li>
      </ul>
      <p class="hint">Reinicia el navegador después de importar. Sin instalarla: <span class="mono">curl --cacert lisec-ca.crt …</span></p>
    </section>

  </div>`;
}
