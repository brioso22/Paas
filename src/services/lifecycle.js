import fs from 'node:fs';
import { workspacePaths } from './deployer.js';

/**
 * Operaciones que tocan varias piezas a la vez (BD + clúster + disco).
 * Las rutas llaman aquí para no repetir el orden ni el manejo de errores parciales.
 */
export function createLifecycle(ctx) {
  return {
    /** Borra todo lo del proyecto. Los fallos del clúster se devuelven como avisos, no abortan. */
    async destroy(project) {
      if (ctx.queue?.isBusy(project.id)) throw Object.assign(new Error('Hay un despliegue en curso o en cola para este proyecto; espera a que termine.'), { status: 409 });
      const warnings = [];
      const attempt = async (label, fn) => {
        try {
          await fn();
        } catch (err) {
          warnings.push(`${label}: ${err.message.slice(0, 160)}`);
        }
      };
      if (ctx.publisher) await attempt('publicación', () => ctx.publisher.unexpose(project));
      await attempt('helm uninstall', () => ctx.helm.uninstall(project));
      await attempt('namespace', () => ctx.kube.deleteNamespace(project.namespace));
      const tags = ctx.db
        .prepare("SELECT DISTINCT tag FROM deployments WHERE project_id = ? AND kind = 'build' AND tag IS NOT NULL AND image_pruned = 0")
        .pluck()
        .all(project.id);
      for (const tag of tags) await attempt(`imagen ${tag}`, () => ctx.builder.removeImage(project, tag));
      fs.rmSync(workspacePaths(ctx.config, project).root, { recursive: true, force: true });
      ctx.tls?.remove(project);
      ctx.projects.remove(project);
      return warnings;
    },
  };
}
