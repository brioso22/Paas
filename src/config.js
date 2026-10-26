import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

export class ConfigError extends Error {
  constructor(errors) {
    super('Configuración inválida:\n' + errors.map((e) => `  - ${e}`).join('\n'));
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

// Valores de .env.example: si llegan a producción, el cifrado no protege nada.
const PLACEHOLDER_SESSION = 'cambia-esto-por-un-valor-aleatorio-de-al-menos-32-caracteres';
const PLACEHOLDER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export const PUBLISH_PROVIDERS = ['none', 'tailscale-funnel', 'cloudflare-tunnel'];
export const IMPLEMENTED_PROVIDERS = ['none'];

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Construye la configuración a partir de un objeto de entorno.
 * Recibe `env` explícito para que los tests no dependan de process.env.
 */
export function loadConfig(env = process.env) {
  const errors = [];
  const str = (name, def) => {
    const v = env[name];
    return v === undefined || v === '' ? def : String(v).trim();
  };
  const int = (name, def, min, max) => {
    const raw = str(name, String(def));
    if (!/^\d+$/.test(raw)) {
      errors.push(`${name} debe ser un entero (valor: "${raw}")`);
      return def;
    }
    const n = Number(raw);
    if (n < min || n > max) errors.push(`${name} debe estar entre ${min} y ${max} (valor: ${n})`);
    return n;
  };
  const num = (name, def) => {
    const raw = str(name, String(def));
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${name} debe ser un número >= 0 (valor: "${raw}")`);
      return def;
    }
    return n;
  };
  const bool = (name, def) => {
    const raw = str(name, def ? 'true' : 'false').toLowerCase();
    if (['true', '1', 'yes', 'si', 'sí'].includes(raw)) return true;
    if (['false', '0', 'no'].includes(raw)) return false;
    errors.push(`${name} debe ser true o false (valor: "${raw}")`);
    return def;
  };
  const url = (name, def, { optional = false } = {}) => {
    const raw = str(name, def);
    if (!raw) {
      if (!optional) errors.push(`${name} es obligatorio`);
      return raw;
    }
    try {
      const u = new URL(raw);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      return raw.replace(/\/+$/, '');
    } catch {
      errors.push(`${name} debe ser una URL http(s) válida (valor: "${raw}")`);
      return raw;
    }
  };

  const nodeEnv = str('NODE_ENV', 'production');
  const port = int('PORT', 8080, 1, 65535);
  const dryRun = bool('DRY_RUN', false);

  const sessionSecret = str('SESSION_SECRET', '');
  if (!sessionSecret) errors.push('SESSION_SECRET es obligatorio');
  else if (sessionSecret.length < 32) errors.push('SESSION_SECRET debe tener al menos 32 caracteres');
  else if (sessionSecret === PLACEHOLDER_SESSION && nodeEnv !== 'test')
    errors.push('SESSION_SECRET tiene el valor de ejemplo; genera uno con "node scripts/init-env.js"');

  const secretsKeyRaw = str('SECRETS_KEY', '');
  let secretsKey = null;
  if (!secretsKeyRaw) errors.push('SECRETS_KEY es obligatorio (32 bytes en base64)');
  else {
    const buf = Buffer.from(secretsKeyRaw, 'base64');
    if (buf.length !== 32 || buf.toString('base64') !== secretsKeyRaw)
      errors.push(`SECRETS_KEY debe ser exactamente 32 bytes codificados en base64 (se decodificaron ${buf.length})`);
    else if (secretsKeyRaw === PLACEHOLDER_KEY && nodeEnv !== 'test')
      errors.push('SECRETS_KEY tiene el valor de ejemplo; genera una con "node scripts/init-env.js"');
    else secretsKey = buf;
  }

  const host = str('HOST', '0.0.0.0');
  if (!net.isIP(host) && !/^[a-z0-9.-]+$/i.test(host)) errors.push(`HOST inválido: "${host}"`);

  const domain = str('DOMAIN', 'paas.local').toLowerCase();
  if (!/^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(domain))
    errors.push(`DOMAIN inválido: "${domain}"`);

  const ingressIp = str('INGRESS_IP', '192.168.49.2');
  if (net.isIP(ingressIp) !== 4) errors.push(`INGRESS_IP debe ser una IPv4 (valor: "${ingressIp}")`);

  const tenantPrefix = str('TENANT_PREFIX', 'tenant-');
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(tenantPrefix))
    errors.push('TENANT_PREFIX debe ser minúsculas, dígitos o guiones (máx. 20) y empezar por letra');

  const helmTimeout = str('HELM_TIMEOUT', '5m');
  if (!/^\d+(s|m)$/.test(helmTimeout)) errors.push('HELM_TIMEOUT debe tener el formato 300s o 5m');

  const publishProvider = str('PUBLISH_PROVIDER', 'none');
  if (!PUBLISH_PROVIDERS.includes(publishProvider))
    errors.push(`PUBLISH_PROVIDER debe ser uno de: ${PUBLISH_PROVIDERS.join(', ')}`);
  else if (!IMPLEMENTED_PROVIDERS.includes(publishProvider))
    errors.push(`PUBLISH_PROVIDER "${publishProvider}" aún no está implementado (ver docs/PUBLISHING.md)`);

  const cwd = env.PAAS_BASE_DIR || process.cwd();
  const dir = (name, def) => path.resolve(cwd, expandHome(str(name, def)));

  const config = {
    nodeEnv,
    isDev: nodeEnv === 'development',
    port,
    host,
    sessionSecret,
    secretsKey,
    cookieSecure: bool('COOKIE_SECURE', false),
    sessionMaxAgeMs: int('SESSION_MAX_AGE_HOURS', 12, 1, 24 * 30) * 3600 * 1000,
    trustProxy: bool('TRUST_PROXY', false),
    domain,
    dataDir: dir('DATA_DIR', './data'),
    workspacesDir: dir('WORKSPACES_DIR', './workspaces'),
    chartPath: dir('CHART_PATH', '~/paas-app-chart'),
    ingressIp,
    ingressNodePort: int('INGRESS_NODEPORT', 32134, 1, 65535),
    ingressHttpsNodePort: int('INGRESS_HTTPS_NODEPORT', 31703, 1, 65535),
    prometheusUrl: url('PROMETHEUS_URL', 'http://localhost:9090'),
    priceCpuHour: num('PRICE_CPU_HOUR', 0.05),
    priceRamGbHour: num('PRICE_RAM_GB_HOUR', 0.01),
    maxUploadMb: int('MAX_UPLOAD_MB', 50, 1, 1024),
    maxLogBytes: int('MAX_LOG_KB', 512, 16, 16384) * 1024,
    tenantPrefix,
    publicBaseUrl: url('PUBLIC_BASE_URL', `http://localhost:${port}`),
    publishProvider,
    dryRun,
    keepImages: int('KEEP_IMAGES', 3, 1, 50),
    helmTimeout,
  };

  if (errors.length) throw new ConfigError(errors);
  return Object.freeze(config);
}
