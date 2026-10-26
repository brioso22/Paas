import { html } from '../lib/html.js';
import { csrfField } from './layout.js';

export const ROLE_LABELS = { admin: 'Administrador', user: 'Cliente', viewer: 'Solo lectura', owner: 'Owner', deployer: 'Deployer' };

function meter(label, used, max, unit = '') {
  const pct = max === null ? 0 : Math.min(100, Math.round((used / Math.max(max, 1)) * 100));
  return html`<div class="meter-row">
    <div class="row between"><span>${label}</span><span class="mono">${used}${unit} / ${max === null ? '∞' : `${max}${unit}`}</span></div>
    <progress class="meter ${pct >= 90 ? 'meter-danger' : pct >= 70 ? 'meter-warn' : ''}" max="100" value="${pct}" aria-label="${label}">${pct}%</progress>
  </div>`;
}

export function planUsage(plan, usage) {
  return html`<div class="stack">
    ${meter('Proyectos', usage.projects, plan.max_projects)}
    ${meter('CPU (límite × réplicas)', usage.cpu, plan.max_cpu_millicores, 'm')}
    ${meter('Memoria (límite × réplicas)', usage.mem, plan.max_memory_mi, 'Mi')}
    ${meter('Bases de datos', usage.dbGi, plan.max_db_gi, ' GiB')}
  </div>`;
}

export function accountView({ user, plan, usage, csrfToken, error }) {
  return html`<h1>Mi cuenta</h1>
  ${user.must_change_password ? html`<div class="alert alert-warn">Tu contraseña es temporal: cámbiala para continuar.</div>` : ''}
  <div class="grid">
    <section class="card">
      <h2>Perfil</h2>
      <dl class="kv">
        <dt>Usuario</dt><dd>${user.username}</dd>
        <dt>Correo</dt><dd>${user.email || '—'}</dd>
        <dt>Rol</dt><dd>${ROLE_LABELS[user.role] || user.role}</dd>
        <dt>Plan</dt><dd><span class="badge">${plan.name}</span></dd>
      </dl>
    </section>
    <section class="card">
      <h2>Uso del plan</h2>
      ${planUsage(plan, usage)}
    </section>
  </div>
  <section class="card">
    <h2>Cambiar contraseña</h2>
    ${error ? html`<div class="alert alert-error">${error}</div>` : ''}
    <form method="post" action="/account/password" class="form narrow-form">
      ${csrfField(csrfToken)}
      <label>Contraseña actual <input type="password" name="current" required maxlength="128" autocomplete="current-password"></label>
      <label>Nueva contraseña <input type="password" name="password" required minlength="10" maxlength="128" autocomplete="new-password"></label>
      <label>Repite la nueva <input type="password" name="password2" required minlength="10" maxlength="128" autocomplete="new-password"></label>
      <div><button class="btn btn-primary" type="submit">Guardar contraseña</button></div>
    </form>
  </section>`;
}
