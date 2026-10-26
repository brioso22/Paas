export class NotImplementedError extends Error {
  constructor(provider, method) {
    super(`El proveedor de publicación "${provider}" aún no implementa ${method}() (ver docs/PUBLISHING.md)`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Contrato de un proveedor de publicación: hace accesible un proyecto fuera de la red
 * local (o deja de hacerlo). Se invoca tras cada despliegue exitoso y al borrar.
 *
 * Resultado de expose/status: { exposed: boolean, url: string|null, message: string }
 */
export class PublishProvider {
  /** @param {object} ctx contexto del panel (config, exec, logger, projects…) */
  constructor(ctx) {
    this.ctx = ctx;
  }

  get name() {
    throw new NotImplementedError('base', 'name');
  }

  /** Idempotente: llamarlo dos veces no debe duplicar rutas ni túneles. */
  async expose(project) {
    throw new NotImplementedError(this.name, 'expose');
  }

  /** Idempotente: no falla si el proyecto ya no estaba publicado. */
  async unexpose(project) {
    throw new NotImplementedError(this.name, 'unexpose');
  }

  async status(project) {
    throw new NotImplementedError(this.name, 'status');
  }
}
