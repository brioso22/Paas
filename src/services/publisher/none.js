import { PublishProvider } from './provider.js';

/** No publica nada: la app solo es accesible por el ingress local (o por Tailscale hasta el host). */
export class NoneProvider extends PublishProvider {
  get name() {
    return 'none';
  }

  localUrl(project) {
    return `http://${project.name}.${this.ctx.config.domain}`;
  }

  async expose(project) {
    return this.status(project);
  }

  async unexpose() {
    return { exposed: false, url: null, message: 'Nada que retirar (proveedor none)' };
  }

  async status(project) {
    return {
      exposed: false,
      url: this.localUrl(project),
      message: `Sin publicación externa: accesible solo vía ingress local (${this.ctx.config.ingressIp}:${this.ctx.config.ingressNodePort}) con Host ${project.name}.${this.ctx.config.domain}`,
    };
  }
}
