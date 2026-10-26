import { renderTenantManifests, renderEnvSecret } from './templates.js';

const REQUEST_TIMEOUT = '--request-timeout=15s';

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

export function createKube({ exec }) {
  const kubectl = (args, opts) => exec.run('kubectl', args, opts);

  return {
    applyManifest(manifest, opts = {}) {
      return kubectl(['apply', '-f', '-'], { ...opts, stdin: manifest });
    },

    ensureTenant(project, opts = {}) {
      return this.applyManifest(renderTenantManifests(project), opts);
    },

    /** Crea o actualiza el Secret "<app>-env". Los valores viajan solo por stdin. */
    applyEnvSecret(project, envMap, opts = {}) {
      const manifest = renderEnvSecret(project, envMap);
      return kubectl(['apply', '-n', project.namespace, '-f', '-'], {
        ...opts,
        stdin: manifest,
        secrets: [...(opts.secrets || []), ...envMap.values()],
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

    deleteNamespace(namespace, opts = {}) {
      return kubectl(['delete', 'namespace', namespace, '--ignore-not-found=true', '--wait=false'], opts);
    },
  };
}
