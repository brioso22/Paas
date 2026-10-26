import { renderTenantManifests, renderEnvSecret } from './templates.js';

const REQUEST_TIMEOUT = '--request-timeout=15s';

// Datos de conexión que no son secretos. DB_NAME suele coincidir con el nombre del proyecto:
// redactarlo convertiría "tenant-python" en "tenant-***" en todos los logs.
const PUBLIC_ENV_KEYS = new Set(['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER', 'PORT']);

/**
 * Valores de variables a redactar en logs. Los cortos (p. ej. "app", "5432") se omiten:
 * redactarlos rompería palabras como "apply", y nunca viajan en argumentos de todos modos.
 */
export function redactableValues(envMap) {
  return [...envMap].filter(([k, x]) => !PUBLIC_ENV_KEYS.has(k) && x.length >= 6).map(([, x]) => x);
}

/** Selector de los pods de la release. Asume las etiquetas estándar de `helm create`. */
export function appSelector(project) {
  return `app.kubernetes.io/instance=${project.name}`;
}

export function summarizePods(json) {
  const items = json?.items || [];
  const pods = items.map((p) => {
    const statuses = p.status?.containerStatuses || [];
    const ready = (p.status?.conditions || []).some((c) => c.type === 'Ready' && c.status === 'True');
    const waiting = statuses.map((s) => s.state?.waiting?.reason).find(Boolean);
    return {
      name: p.metadata?.name,
      phase: p.status?.phase || 'Unknown',
      ready,
      restarts: statuses.reduce((n, s) => n + (s.restartCount || 0), 0),
      reason: waiting || p.status?.reason || null,
      image: p.spec?.containers?.[0]?.image || null,
      startedAt: p.status?.startTime || null,
      terminating: Boolean(p.metadata?.deletionTimestamp),
    };
  });
  const active = pods.filter((p) => !['Succeeded', 'Failed'].includes(p.phase));
  return { total: active.length, ready: active.filter((p) => p.ready).length, pods };
}

export function createKube({ exec, db }) {
  const kubectl = (args, opts) => exec.run('kubectl', args, opts);
  // La cuota del namespace depende también de las bases de datos del proyecto.
  const databasesOf = (project) =>
    db ? db.prepare('SELECT cpu_request, cpu_limit, memory_request, memory_limit FROM databases WHERE project_id = ?').all(project.id) : [];

  return {
    applyManifest(manifest, opts = {}) {
      return kubectl(['apply', '-f', '-'], { ...opts, stdin: manifest });
    },

    ensureTenant(project, opts = {}) {
      return this.applyManifest(renderTenantManifests(project, { databases: databasesOf(project) }), opts);
    },

    /** Crea o actualiza el Secret "<app>-env". Los valores viajan solo por stdin. */
    applyEnvSecret(project, envMap, opts = {}) {
      const manifest = renderEnvSecret(project, envMap);
      return kubectl(['apply', '-n', project.namespace, '-f', '-'], {
        ...opts,
        stdin: manifest,
        secrets: [...(opts.secrets || []), ...redactableValues(envMap)],
      });
    },

    async podStatus(project) {
      const r = await kubectl(['get', 'pods', '-n', project.namespace, '-l', appSelector(project), '-o', 'json', REQUEST_TIMEOUT], {
        timeoutMs: 20_000,
      });
      if (r.dryRun) return { total: 0, ready: 0, pods: [], dryRun: true };
      return summarizePods(JSON.parse(r.stdout || '{}'));
    },

    rolloutRestart(project, opts = {}) {
      return kubectl(['rollout', 'restart', 'deployment', '-n', project.namespace, '-l', appSelector(project)], opts);
    },

    scale(project, replicas, opts = {}) {
      return kubectl(['scale', 'deployment', '-n', project.namespace, '-l', appSelector(project), `--replicas=${Number(replicas)}`], opts);
    },

    /** Sigue los logs de todos los pods de la app hasta que `signal` se aborte. */
    streamLogs(project, { onLine, signal, tail = 200 }) {
      return kubectl(
        [
          'logs',
          '-n',
          project.namespace,
          '-l',
          appSelector(project),
          '--all-containers=true',
          '--prefix=true',
          '--follow=true',
          `--tail=${Number(tail)}`,
          '--max-log-requests=10',
        ],
        { onLine, signal, echo: false, timeoutMs: 60 * 60 * 1000, maxBuffer: 1024 * 1024 },
      );
    },

    /** Estado de las BDs del namespace en una sola llamada: { [nombre]: { exists, ready, pvc, capacity, reason, restarts } }. */
    async databaseStatus(project) {
      const r = await kubectl(['get', 'statefulsets,persistentvolumeclaims,pods', '-n', project.namespace, '-l', 'paas/db', '-o', 'json', REQUEST_TIMEOUT], {
        timeoutMs: 20_000,
      });
      if (r.dryRun) return { dryRun: true };
      const out = {};
      for (const it of JSON.parse(r.stdout || '{}').items || []) {
        const name = it.metadata?.labels?.['paas/db'];
        if (!name) continue;
        out[name] ||= { exists: false, ready: false, pvc: null, capacity: null, reason: null, restarts: 0 };
        // El StatefulSet crea el PVC y el pod unos segundos después: basta con que exista él.
        if (it.kind === 'StatefulSet') {
          out[name].exists = true;
          out[name].ready = (it.status?.readyReplicas || 0) >= 1;
        }
        if (it.kind === 'PersistentVolumeClaim') {
          out[name].pvc = it.status?.phase || 'Pending';
          out[name].capacity = it.status?.capacity?.storage || null;
        }
        if (it.kind === 'Pod') {
          const st = it.status?.containerStatuses?.[0];
          out[name].restarts = st?.restartCount || 0;
          out[name].reason = st?.state?.waiting?.reason || st?.lastState?.terminated?.reason || (it.status?.phase === 'Pending' ? 'Pending' : null);
        }
      }
      return out;
    },

    deleteDatabase(project, name, opts = {}) {
      return kubectl(
        ['delete', 'statefulset,service,secret,persistentvolumeclaim', '-n', project.namespace, '-l', `paas/db=${name}`, '--ignore-not-found=true', '--wait=false'],
        opts,
      );
    },

    deleteNamespace(namespace, opts = {}) {
      return kubectl(['delete', 'namespace', namespace, '--ignore-not-found=true', '--wait=false'], opts);
    },
  };
}
