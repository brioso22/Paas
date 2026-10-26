import fs from 'node:fs';
import path from 'node:path';

/**
 * Values para el chart paas-app-chart. Se escriben como JSON (subconjunto válido de YAML)
 * para no depender de un serializador YAML ni arriesgar inyección. Nunca contiene secretos:
 * las variables llegan por envFrom desde el Secret "<app>-env".
 */
export function buildValues(project, { tag, host, hosts = [host], envKeys = [] }) {
  const env = envKeys.includes('PORT') ? [] : [{ name: 'PORT', value: String(project.port) }];
  // httpGet: null borra la sonda httpGet por defecto del chart; si no, Helm fusiona ambas
  // y Kubernetes rechaza el Deployment ("may not specify more than 1 handler type").
  const probe = (initialDelaySeconds, periodSeconds) => ({
    httpGet: null,
    tcpSocket: { port: project.port },
    initialDelaySeconds,
    periodSeconds,
    timeoutSeconds: 3,
    failureThreshold: 3,
  });
  return {
    replicaCount: project.replicas,
    image: { repository: project.name, tag, pullPolicy: 'Never' },
    containerPort: project.port,
    service: { port: 80 },
    ingress: {
      enabled: true,
      className: 'nginx',
      hosts: hosts.map((h) => ({ host: h, paths: [{ path: '/', pathType: 'Prefix' }] })),
      tls: project.tls_enabled ? [{ secretName: `${project.name}-tls`, hosts }] : [],
    },
    env,
    envFrom: [{ secretRef: { name: `${project.name}-env` } }],
    resources: {
      requests: { cpu: project.cpu_request, memory: project.memory_request },
      limits: { cpu: project.cpu_limit, memory: project.memory_limit },
    },
    autoscaling: {
      enabled: Boolean(project.autoscaling_enabled),
      minReplicas: project.autoscaling_min,
      maxReplicas: project.autoscaling_max,
      targetCPUUtilizationPercentage: project.autoscaling_cpu,
    },
    livenessProbe: probe(20, 20),
    readinessProbe: probe(5, 10),
  };
}

export function writeValuesFile(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const header = '# Generado por paas-panel. JSON es YAML válido. No contiene secretos.\n';
  fs.writeFileSync(file, header + JSON.stringify(values, null, 2) + '\n', { mode: 0o600 });
}

export function createHelm({ exec, config }) {
  const helm = (args, opts) => exec.run('helm', args, opts);
  const waitArgs = () => ['--wait', '--timeout', config.helmTimeout];

  return {
    upgradeInstall(project, valuesFile, opts = {}) {
      return helm(
        ['upgrade', '--install', project.name, config.chartPath, '--namespace', project.namespace, '-f', valuesFile, ...waitArgs(), '--history-max', '10'],
        { timeoutMs: 15 * 60 * 1000, ...opts },
      );
    },

    rollback(project, revision, opts = {}) {
      return helm(['rollback', project.name, String(Number(revision)), '--namespace', project.namespace, ...waitArgs()], {
        timeoutMs: 15 * 60 * 1000,
        ...opts,
      });
    },

    async history(project, opts = {}) {
      const r = await helm(['history', project.name, '--namespace', project.namespace, '--max', '20', '-o', 'json'], { timeoutMs: 30_000, ...opts });
      if (r.dryRun || !r.stdout.trim()) return [];
      return JSON.parse(r.stdout);
    },

    async latestRevision(project, opts = {}) {
      const h = await this.history(project, opts);
      return h.length ? Math.max(...h.map((x) => Number(x.revision))) : null;
    },

    uninstall(project, opts = {}) {
      return helm(['uninstall', project.name, '--namespace', project.namespace, '--wait', '--timeout', config.helmTimeout], opts);
    },
  };
}
