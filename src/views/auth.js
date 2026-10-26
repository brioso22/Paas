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

export function loginView({ csrfToken, error, username = '', next = '', allowRegistration = false }) {
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
    ${allowRegistration ? html`<p class="hint">¿No tienes cuenta? <a href="/register">Regístrate</a></p>` : ''}
  </section>`;
}

export function registerView({ csrfToken, error, username = '', email = '' }) {
  return html`<section class="card narrow">
    <h1>Crear cuenta</h1>
    <p class="muted">Plan gratuito: hasta 2 proyectos. El administrador puede ampliarlo.</p>
    ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
    <form method="post" action="/register" class="form">
      ${csrfField(csrfToken)}
      <label>Usuario <input name="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_.\\-]{3,32}" value="${username}" autocomplete="username"></label>
      <label>Correo (opcional) <input type="email" name="email" maxlength="254" value="${email}" autocomplete="email"></label>
      <label>Contraseña <input type="password" name="password" required minlength="10" maxlength="128" autocomplete="new-password"></label>
      <label>Repite la contraseña <input type="password" name="password2" required minlength="10" maxlength="128" autocomplete="new-password"></label>
      <button class="btn btn-primary" type="submit">Crear cuenta</button>
    </form>
    <p class="hint"><a href="/login">Ya tengo cuenta</a></p>
  </section>`;
}
