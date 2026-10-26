import { html } from '../lib/html.js';
import { can } from '../lib/authz.js';
import { icon } from './icons.js';

export function csrfField(token) {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

const ROLE_NAMES = { admin: 'Administrador', user: 'Cliente', viewer: 'Solo lectura' };

function navLink(href, label, iconName, key, active) {
  return html`<a href="${href}" class="nav-link ${active === key ? 'active' : ''}" ${active === key ? html`aria-current="page"` : ''}>${icon(iconName)}<span>${label}</span></a>`;
}

function sidebar(user, csrfToken, active, dryRun) {
  return html`<aside class="sidebar" id="sidebar">
    <div class="sidebar-head">
      <a class="brand" href="/">${icon('server')}<span>Lisec PaaS</span></a>
      ${dryRun ? html`<span class="badge badge-warn" title="Los comandos no se ejecutan, solo se registran">DRY_RUN</span>` : ''}
    </div>
    <nav class="nav" aria-label="Principal">
      ${navLink('/', 'Proyectos', 'projects', 'projects', active)}
      ${can(user, 'project.create') ? navLink('/projects/new', 'Nuevo', 'plus', 'new', active) : ''}
      ${navLink('/account', 'Mi cuenta', 'user', 'account', active)}
      ${can(user, 'admin.access')
        ? html`<div class="nav-section">Panel admin</div>
          ${navLink('/admin', 'Resumen del clúster', 'gauge', 'admin', active)}
          ${navLink('/admin/users', 'Usuarios', 'users', 'admin-users', active)}
          ${navLink('/admin/audit', 'Auditoría', 'audit', 'admin-audit', active)}
          ${navLink('/settings', 'Ajustes y precios', 'settings', 'settings', active)}`
        : ''}
    </nav>
    <div class="sidebar-foot">
      <div class="who"><strong>${user.username}</strong><small>${ROLE_NAMES[user.role] || user.role}</small></div>
      <div class="row">
        <button type="button" class="btn btn-icon" data-theme-toggle title="Cambiar tema" aria-label="Cambiar tema (sistema, claro, oscuro)">${icon('theme')}</button>
        <form method="post" action="/logout" class="inline">
          ${csrfField(csrfToken)}
          <button type="submit" class="btn btn-icon" title="Salir" aria-label="Cerrar sesión">${icon('logout')}</button>
        </form>
      </div>
    </div>
  </aside>`;
}

/** Los mensajes flash se muestran como toasts; sin JS siguen visibles arriba del contenido. */
function toasts(flash) {
  return html`<div class="toasts" aria-live="polite">
    ${flash.map(
      (f) => html`<div class="toast toast-${f.type}" role="${f.type === 'error' ? 'alert' : 'status'}" data-toast>
        <span>${f.message}</span>
        <button type="button" class="btn btn-icon" data-dismiss aria-label="Cerrar aviso">${icon('close')}</button>
      </div>`,
    )}
  </div>`;
}

export function layout({ title, user, csrfToken, flash = [], body, dryRun = false, active = '' }) {
  return html`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${csrfToken || ''}">
  <title>${title} · Lisec PaaS</title>
  <link rel="stylesheet" href="/static/css/style.css">
  <script src="/static/js/theme.js"></script>
  <script src="/static/js/app.js" defer></script>
</head>
<body class="${user ? 'has-sidebar' : 'no-sidebar'}">
  <a class="skip" href="#main">Saltar al contenido</a>
  ${user
    ? html`<header class="mobilebar">
        <button type="button" class="btn btn-icon" data-nav-toggle aria-controls="sidebar" aria-expanded="false" aria-label="Abrir menú">${icon('menu')}</button>
        <a class="brand" href="/">Lisec PaaS</a>
      </header>
      ${sidebar(user, csrfToken, active, dryRun)}`
    : html`<header class="topbar"><a class="brand" href="/">${icon('server')}<span>Lisec PaaS</span></a>
        ${dryRun ? html`<span class="badge badge-warn">DRY_RUN</span>` : ''}
        <button type="button" class="btn btn-icon" data-theme-toggle aria-label="Cambiar tema">${icon('theme')}</button></header>`}
  <main class="container" id="main" tabindex="-1">
    ${toasts(flash)}
    ${body}
  </main>
</body>
</html>`;
}

export function errorPage({ status, message }) {
  return html`<section class="card narrow empty">
    ${icon('alert')}
    <h1>Error ${status}</h1>
    <p>${message}</p>
    <p><a class="btn" href="/">Volver al inicio</a></p>
  </section>`;
}
