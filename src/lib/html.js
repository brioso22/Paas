// Plantillas con escape automático: todo valor interpolado se escapa salvo que
// ya sea HTML seguro (resultado de otra plantilla html``).

export class SafeHtml {
  constructor(value) {
    this.value = value;
  }
  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

export function escapeHtml(value) {
  return String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c]);
}

function renderValue(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(renderValue).join('');
  return escapeHtml(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += renderValue(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** Solo para cadenas constantes del propio código. Nunca con datos del usuario. */
export function unsafeRaw(s) {
  return new SafeHtml(String(s));
}
