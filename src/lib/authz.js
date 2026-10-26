// Autorización: ÚNICA fuente de verdad sobre quién puede hacer qué.
// Rutas, vistas y streams preguntan siempre a can(); nunca comparan roles a mano.

export const GLOBAL_ROLES = ['admin', 'user', 'viewer'];
export const MEMBER_ROLES = ['owner', 'deployer', 'viewer'];

/** Acciones sin proyecto: qué roles globales las tienen. */
export const GLOBAL_MATRIX = Object.freeze({
  'project.create': ['admin', 'user'],
  'account.use': ['admin', 'user', 'viewer'],
  'tls.ca': ['admin', 'user', 'viewer'],
  'admin.access': ['admin'], // usuarios, ajustes, precios, clúster, auditoría
});

/** Acciones sobre un proyecto: qué roles de membresía las tienen (el admin global las tiene todas). */
export const PROJECT_MATRIX = Object.freeze({
  'project.view': ['owner', 'deployer', 'viewer'], // resumen, despliegues, logs, métricas, BD (sin secretos)
  'project.deploy': ['owner', 'deployer'], // desplegar, redesplegar, rollback, reiniciar
  'env.edit': ['owner', 'deployer'], // editar y revelar variables
  'project.settings': ['owner'], // escalado, HPA, recursos, repositorio
  'webhook.manage': ['owner'],
  'db.manage': ['owner'],
  'tls.manage': ['owner'], // HTTPS y dominio
  'members.manage': ['owner'],
  'project.audit': ['owner'],
  'project.delete': ['owner'],
});

/**
 * ¿Puede `user` hacer `action` sobre `project`? `project.member_role` es el rol del usuario
 * en ese proyecto (lo carga projects.getFor). Un viewer global nunca pasa de viewer aunque
 * su membresía diga otra cosa. Acción desconocida = error de programación.
 */
export function can(user, action, project = null) {
  if (!user || !user.active) return false;
  if (action in GLOBAL_MATRIX) return GLOBAL_MATRIX[action].includes(user.role);
  if (!(action in PROJECT_MATRIX)) throw new Error(`Acción de autorización desconocida: ${action}`);
  if (!project) return false;
  if (user.role === 'admin') return true;
  const role = user.role === 'viewer' && project.member_role ? 'viewer' : project.member_role;
  return Boolean(role) && PROJECT_MATRIX[action].includes(role);
}

/** Atajo para vistas: perms('env.edit') con el usuario y proyecto ya fijados. */
export const permsFor = (user, project) => (action) => can(user, action, project);
