// Validadores del lado del servidor. Todo lo que no encaja se rechaza.

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.status = 400;
  }
}

export const PROJECT_NAME_RE = /^[a-z0-9]([a-z0-9-]{1,28})[a-z0-9]$/;
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const CPU_RE = /^(\d{1,5}m|\d{1,3}(\.\d{1,3})?)$/;
const MEMORY_RE = /^\d{1,6}(Mi|Gi)$/;

export const LIMITS = Object.freeze({
  envVars: 100,
  envValueBytes: 32 * 1024,
  envNameLength: 128,
  replicas: 20,
  passwordMin: 10,
  passwordMax: 128,
  gitUrlLength: 300,
  gitTokenLength: 512,
});

export function isProjectName(v) {
  return typeof v === 'string' && PROJECT_NAME_RE.test(v);
}

export function projectName(v) {
  if (!isProjectName(v))
    throw new ValidationError(
      'El nombre debe tener 3-30 caracteres: minúsculas, dígitos y guiones, sin empezar ni terminar en guion',
      'name',
    );
  return v;
}

export function isEnvName(v) {
  return typeof v === 'string' && v.length <= LIMITS.envNameLength && ENV_NAME_RE.test(v);
}

export function envName(v) {
  if (!isEnvName(v))
    throw new ValidationError(`Nombre de variable inválido: "${String(v).slice(0, 40)}" (usa MAYÚSCULAS, dígitos y _)`, 'env');
  return v;
}

export function envValue(v, name = '') {
  if (typeof v !== 'string') throw new ValidationError(`Valor inválido para ${name}`, 'env');
  if (Buffer.byteLength(v) > LIMITS.envValueBytes) throw new ValidationError(`El valor de ${name} supera 32 KB`, 'env');
  if (v.includes('\0')) throw new ValidationError(`El valor de ${name} contiene caracteres no permitidos`, 'env');
  return v;
}

export function isPort(v) {
  const s = String(v ?? '');
  if (!/^\d{1,5}$/.test(s)) return false;
  const n = Number(s);
  return n >= 1 && n <= 65535;
}

export function port(v, field = 'port') {
  if (!isPort(v)) throw new ValidationError('El puerto debe ser un entero entre 1 y 65535', field);
  return Number(v);
}

export function intInRange(v, min, max, field, label = field) {
  const s = String(v ?? '');
  if (!/^\d{1,6}$/.test(s) || Number(s) < min || Number(s) > max)
    throw new ValidationError(`${label} debe ser un entero entre ${min} y ${max}`, field);
  return Number(s);
}

/** Solo https, sin credenciales embebidas: los tokens van por un campo aparte y cifrado. */
export function isGitUrl(v) {
  if (typeof v !== 'string' || v.length > LIMITS.gitUrlLength || /\s/.test(v) || v.startsWith('-')) return false;
  // new URL() normaliza "/a/../b"; se rechaza sobre el texto original.
  if (/\/\.\.?(\/|$)/.test(v) || v.includes('\\')) return false;
  let u;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (!u.hostname || !/^[a-z0-9.-]+$/i.test(u.hostname)) return false;
  if (u.search || u.hash) return false;
  if (!/^\/[A-Za-z0-9._~\/-]+$/.test(u.pathname) || u.pathname.includes('..')) return false;
  return true;
}

export function gitUrl(v) {
  if (!isGitUrl(v))
    throw new ValidationError('La URL del repositorio debe ser https://host/ruta, sin usuario/contraseña ni parámetros', 'repoUrl');
  return v;
}

/** Subconjunto conservador de `git check-ref-format`. */
export function isBranch(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 100) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(v)) return false;
  if (v.startsWith('-') || v.startsWith('.') || v.startsWith('/') || v.endsWith('/') || v.endsWith('.')) return false;
  if (v.includes('..') || v.includes('//') || v.endsWith('.lock') || v.includes('/.') || v === '@') return false;
  return true;
}

export function branch(v) {
  if (!isBranch(v)) throw new ValidationError('Nombre de rama inválido', 'branch');
  return v;
}

export function cpuQuantity(v, field = 'cpu') {
  if (typeof v !== 'string' || !CPU_RE.test(v) || toMillicores(v) < 10 || toMillicores(v) > 64000)
    throw new ValidationError('CPU inválida: usa milicores (250m) o núcleos (0.5, 1), entre 10m y 64', field);
  return v;
}

export function memoryQuantity(v, field = 'memory') {
  if (typeof v !== 'string' || !MEMORY_RE.test(v) || toMebibytes(v) < 16 || toMebibytes(v) > 262144)
    throw new ValidationError('Memoria inválida: usa Mi o Gi (256Mi, 1Gi), entre 16Mi y 256Gi', field);
  return v;
}

export function toMillicores(v) {
  return v.endsWith('m') ? Number(v.slice(0, -1)) : Math.round(Number(v) * 1000);
}

export function toMebibytes(v) {
  return v.endsWith('Gi') ? Number(v.slice(0, -2)) * 1024 : Number(v.slice(0, -2));
}

export function username(v) {
  if (typeof v !== 'string' || !USERNAME_RE.test(v))
    throw new ValidationError('El usuario debe tener 3-32 caracteres: letras, dígitos, punto, guion o _', 'username');
  return v;
}

export function password(v) {
  if (typeof v !== 'string' || v.length < LIMITS.passwordMin || v.length > LIMITS.passwordMax)
    throw new ValidationError(`La contraseña debe tener entre ${LIMITS.passwordMin} y ${LIMITS.passwordMax} caracteres`, 'password');
  return v;
}

export function gitToken(v) {
  if (v === undefined || v === null || v === '') return '';
  if (typeof v !== 'string' || v.length > LIMITS.gitTokenLength || !/^[\x21-\x7e]+$/.test(v))
    throw new ValidationError('Token de git inválido', 'gitToken');
  return v;
}

/**
 * Parsea un bloque estilo .env (KEY=valor por línea). Ignora líneas vacías y comentarios.
 * No interpreta comillas ni escapes: el valor es literal tras el primer "=".
 */
export function parseEnvBlock(text) {
  const out = new Map();
  if (!text) return out;
  if (typeof text !== 'string') throw new ValidationError('Bloque de variables inválido', 'env');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = raw.indexOf('=');
    if (eq < 1) throw new ValidationError(`Línea inválida en variables: "${line.slice(0, 40)}" (formato CLAVE=valor)`, 'env');
    const key = envName(raw.slice(0, eq).trim());
    out.set(key, envValue(raw.slice(eq + 1), key));
    if (out.size > LIMITS.envVars) throw new ValidationError(`Máximo ${LIMITS.envVars} variables`, 'env');
  }
  return out;
}
