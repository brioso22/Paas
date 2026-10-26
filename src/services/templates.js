import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMillicores, toMebibytes } from '../lib/validate.js';

const TEMPLATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'k8s');
export const TENANT_TEMPLATES = ['namespace.yaml', 'resourcequota.yaml', 'limitrange.yaml', 'networkpolicy.yaml'];

// Solo se interpolan valores ya validados (nombres DNS y cantidades k8s). Este filtro
// es la segunda barrera contra inyección de YAML si algún día llega otro tipo de dato.
const SAFE_VALUE = /^[A-Za-z0-9._\-]{1,63}$/;

export const TENANT_DEFAULTS = Object.freeze({
  quotaPvcCount: 4,
  quotaStorage: '10Gi',
  maxPvcSize: '5Gi',
});

export function renderTemplate(text, params) {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g, (_, key) => {
    if (!(key in params)) throw new Error(`Falta el parámetro "${key}" en la plantilla`);
    const value = String(params[key]);
    if (!SAFE_VALUE.test(value)) throw new Error(`Valor no permitido para "${key}": ${JSON.stringify(value)}`);
    return value;
  });
}

export function loadTemplate(name, dir = TEMPLATE_DIR) {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

/** Réplicas máximas que puede llegar a tener el proyecto (HPA incluido). */
export function maxReplicas(project) {
  return project.autoscaling_enabled ? project.autoscaling_max : project.replicas;
}

export function tenantParams(project, databases = []) {
  // +1 para el pod extra que crea el rolling update (maxSurge) mientras conviven versiones.
  const pods = maxReplicas(project) + 1;
  // Las bases de datos administradas (1 pod cada una) también consumen cuota.
  const sum = (field, conv) => databases.reduce((n, d) => n + conv(d[field]), 0);
  const cpu = (field) => `${toMillicores(project[field]) * pods + sum(field, toMillicores)}m`;
  const mem = (field) => `${toMebibytes(project[field]) * pods + sum(field, toMebibytes)}Mi`;
  const maxOf = (field, conv, unit) => `${Math.max(conv(project[field]), ...databases.map((d) => conv(d[field])))}${unit}`;
  return {
    project: project.name,
    namespace: project.namespace,
    cpuRequest: project.cpu_request,
    cpuLimit: project.cpu_limit,
    memoryRequest: project.memory_request,
    memoryLimit: project.memory_limit,
    maxCpu: databases.length ? maxOf('cpu_limit', toMillicores, 'm') : project.cpu_limit,
    maxMemory: databases.length ? maxOf('memory_limit', toMebibytes, 'Mi') : project.memory_limit,
    quotaRequestsCpu: cpu('cpu_request'),
    quotaLimitsCpu: cpu('cpu_limit'),
    quotaRequestsMemory: mem('memory_request'),
    quotaLimitsMemory: mem('memory_limit'),
    quotaPods: pods + 1 + databases.length,
    ...TENANT_DEFAULTS,
  };
}

/** Manifiestos multi-documento listos para `kubectl apply -f -`. */
export function renderTenantManifests(project, { dir = TEMPLATE_DIR, databases = [] } = {}) {
  const params = tenantParams(project, databases);
  return TENANT_TEMPLATES.map((t) => renderTemplate(loadTemplate(t, dir), params).trim()).join('\n---\n') + '\n';
}

/**
 * Secret con las variables del proyecto. Se genera como JSON (válido para kubectl) para no
 * tener que escapar YAML. Nunca se escribe a disco ni se pasa por argumentos.
 */
export function renderEnvSecret(project, envMap) {
  const data = {};
  for (const [k, val] of envMap) data[k] = Buffer.from(val, 'utf8').toString('base64');
  return JSON.stringify({
    apiVersion: 'v1',
    kind: 'Secret',
    type: 'Opaque',
    metadata: {
      name: `${project.name}-env`,
      namespace: project.namespace,
      labels: { 'paas/project': project.name, 'app.kubernetes.io/managed-by': 'paas-panel' },
    },
    data,
  });
}
