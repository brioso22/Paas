import { html } from '../lib/html.js';

export function csrfField(token) {
  return html`<input type="hidden" name="_csrf" value="${token}">`;
}

export function layout({ title, user, csrfToken, flash = [], body, dryRun = false, active = '' }) {
  return html`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="csrf-token" content="${csrfToken || ''}">
  <title>${title} · PaaS Panel</title>
  <link rel="stylesheet" href="/static/css/style.css">
  <script src="/static/js/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">PaaS Panel</a>
    ${dryRun ? html`<span class="badge badge-warn" title="Los comandos no se ejecutan, solo se registran">DRY_RUN</span>` : ''}
    ${user
      ? html`<nav class="nav">
          <a href="/" class="${active === 'projects' ? 'active' : ''}">Proyectos</a>
          <a href="/projects/new" class="${active === 'new' ? 'active' : ''}">Nuevo</a>
          <a href="/settings" class="${active === 'settings' ? 'active' : ''}">Ajustes</a>
          <span class="nav-user">${user.username} <small>(${user.role})</small></span>
          <form method="post" action="/logout" class="inline">
            ${csrfField(csrfToken)}
            <button type="submit" class="btn btn-link">Salir</button>
          </form>
        </nav>`
      : ''}
  </header>
  <main class="container">
    ${flash.map((f) => html`<div class="alert alert-${f.type}" role="status">${f.message}</div>`)}
    ${body}
  </main>
</body>
</html>`;
}

export function errorPage({ status, message }) {
  return html`<section class="card narrow">
    <h1>Error ${status}</h1>
    <p>${message}</p>
    <p><a href="/">Volver al inicio</a></p>
  </section>`;
}
