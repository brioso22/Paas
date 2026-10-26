import { html } from '../lib/html.js';
import { csrfField } from './layout.js';

export function setupView({ csrfToken, error, username = '' }) {
  return html`<section class="card narrow">
    <h1>Configuración inicial</h1>
    <p class="muted">Crea la cuenta de administrador. Esta página se deshabilita en cuanto exista un usuario.</p>
    ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
    <form method="post" action="/setup" class="form">
      ${csrfField(csrfToken)}
      <label>Usuario <input name="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_.\\-]{3,32}" value="${username}" autocomplete="username"></label>
      <label>Contraseña <input type="password" name="password" required minlength="10" maxlength="128" autocomplete="new-password"></label>
      <label>Repite la contraseña <input type="password" name="password2" required minlength="10" maxlength="128" autocomplete="new-password"></label>
      <button class="btn btn-primary" type="submit">Crear administrador</button>
    </form>
  </section>`;
}

export function loginView({ csrfToken, error, username = '', next = '' }) {
  return html`<section class="card narrow">
    <h1>Iniciar sesión</h1>
    ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
    <form method="post" action="/login" class="form">
      ${csrfField(csrfToken)}
      <input type="hidden" name="next" value="${next}">
      <label>Usuario <input name="username" required maxlength="32" value="${username}" autocomplete="username" autofocus></label>
      <label>Contraseña <input type="password" name="password" required maxlength="128" autocomplete="current-password"></label>
      <button class="btn btn-primary" type="submit">Entrar</button>
    </form>
  </section>`;
}
