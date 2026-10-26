import { html } from '../lib/html.js';
import { csrfField } from './layout.js';
import { projectHeader } from './projects.js';

export function envView({ project: p, keys, csrfToken, isAdmin, deployed }) {
  const ro = !isAdmin;
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
            ${isAdmin
              ? html`<button type="button" class="btn btn-small" data-reveal-url="/projects/${p.id}/env/${encodeURIComponent(k.key)}/reveal" data-reveal-target="#env-val-${i}">Revelar</button>
                <label class="check"><input type="checkbox" name="delete" value="${k.key}"> borrar</label>`
              : html`<span></span><span></span>`}
          </div>`,
        )}
      </div>
      ${isAdmin
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

export function settingsView({ project: p, csrfToken, isAdmin, hasToken, https }) {
  const dis = isAdmin ? '' : 'disabled';
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
            ${isAdmin ? html`<div><button class="btn btn-primary" type="submit">Escalar</button></div>` : ''}
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
        ${isAdmin ? html`<div><button class="btn btn-primary" type="submit">Guardar HPA</button></div>` : ''}
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
        ${isAdmin ? html`<div><button class="btn btn-primary" type="submit">Guardar recursos</button></div>` : ''}
      </form>
    </section>

    <section class="card">
      <h2>Dominio personalizado</h2>
      <form method="post" action="/projects/${p.id}/domain" class="form">
        ${csrfField(csrfToken)}
        <label>Dominio <input name="custom_domain" value="${p.custom_domain || ''}" placeholder="app.midominio.com" ${dis}></label>
        <span class="hint">Host adicional del ingress (y del certificado si HTTPS está activo). Vacío = quitarlo. Requiere redeploy con Helm.</span>
        ${isAdmin ? html`<div><button class="btn btn-primary" type="submit">Guardar dominio</button></div>` : ''}
      </form>
    </section>

    <section class="card">
      <h2>HTTPS autofirmado</h2>
      ${p.tls_enabled
        ? html`<p><span class="badge badge-ok">activo</span> <a class="mono" href="${https.url}" target="_blank" rel="noopener noreferrer">${https.url}</a></p>
            <p class="hint">Expira: ${p.tls_expires_at ? p.tls_expires_at.slice(0, 10) : '—'}. Prueba: <span class="mono">curl --cacert paas-ca.crt --resolve ${https.host}:${https.nodePort}:${https.ingressIp} https://${https.host}:${https.nodePort}/</span></p>`
        : html`<p class="muted">Emite un certificado para <span class="mono">${https.host}</span>${p.custom_domain ? html` y <span class="mono">${p.custom_domain}</span>` : ''} firmado por la CA del panel (365 días) y lo sirve el ingress.</p>`}
      ${isAdmin
        ? html`<div class="row">
            ${p.tls_enabled
              ? html`<form method="post" action="/projects/${p.id}/tls/renew" class="inline">${csrfField(csrfToken)}<button class="btn" type="submit">Renovar certificado</button></form>
                  <form method="post" action="/projects/${p.id}/tls/disable" class="inline" data-confirm="¿Desactivar HTTPS?">${csrfField(csrfToken)}<button class="btn btn-danger" type="submit">Desactivar</button></form>`
              : html`<form method="post" action="/projects/${p.id}/tls/enable" class="inline">${csrfField(csrfToken)}<button class="btn btn-primary" type="submit">Activar HTTPS autofirmado</button></form>`}
          </div>`
        : ''}
      <p class="hint"><a href="/tls/ca.crt">Descargar el certificado de la CA</a> (solo la parte pública). Para que el navegador no avise: Chrome/Edge → Configuración → Privacidad y seguridad → Seguridad → Gestionar certificados → Entidades de certificación → Importar; Firefox → Ajustes → Privacidad → Ver certificados → Autoridades → Importar y marcar "confiar para sitios web". En Linux: <span class="mono">sudo cp paas-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates</span>.</p>
    </section>

    <section class="card">
      <h2>Acciones</h2>
      ${isAdmin
        ? html`<form method="post" action="/projects/${p.id}/restart" class="form" data-confirm="¿Reiniciar todos los pods de ${p.name}?">
            ${csrfField(csrfToken)}
            <p class="muted">Rollout restart: crea pods nuevos y retira los viejos sin cortar el servicio (si hay más de una réplica).</p>
            <div><button class="btn" type="submit" ${p.current_tag ? '' : 'disabled'}>Reiniciar pods</button></div>
          </form>
          <p><a href="/projects/${p.id}/deployments">Redesplegar o hacer rollback →</a></p>`
        : html`<p class="muted">Solo el administrador puede ejecutar acciones.</p>`}
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
            ${hasToken && isAdmin ? html`<label class="check"><input type="checkbox" name="clear_token"> Eliminar el token guardado</label>` : ''}
            ${isAdmin ? html`<div><button class="btn btn-primary" type="submit">Guardar</button></div>` : ''}
          </form>
        </section>`
      : ''}
  </div>`;
}
