/**
 * Operaciones que tocan varias piezas a la vez (BD + clúster + disco).
 * Las rutas llaman aquí para no repetir el orden ni el manejo de errores parciales.
 */
export function createLifecycle(ctx) {
  return {
    /** Borra todo lo del proyecto. Los fallos del clúster se devuelven como avisos, no abortan. */
    async destroy(project) {
      const warnings = [];
      const attempt = async (label, fn) => {
        try {
          await fn();
        } catch (err) {
          warnings.push(`${label}: ${err.message.slice(0, 160)}`);
        }
      };
      await attempt('namespace', () => ctx.kube.deleteNamespace(project.namespace));
      ctx.projects.remove(project);
      return warnings;
    },
  };
}
