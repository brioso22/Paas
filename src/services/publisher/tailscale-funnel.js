import { PublishProvider, NotImplementedError } from './provider.js';

/**
 * STUB — Tailscale Funnel. Plan de implementación (docs/PUBLISHING.md):
 *
 * - Funnel publica puertos del propio nodo (443, 8443 o 10000) bajo
 *   https://<host>.<tailnet>.ts.net; no admite subdominios por proyecto, así que
 *   cada proyecto se mapearía a una RUTA: https://<host>.ts.net/<proyecto>/.
 * - expose(): `tailscale funnel --bg --set-path=/<proyecto> http://<INGRESS_IP>:<NODEPORT>`
 *   (requiere que el ingress reescriba la ruta o que la app acepte el prefijo) y
 *   añadir el host del Funnel a ingress.hosts.
 * - unexpose(): `tailscale funnel --set-path=/<proyecto> off`.
 * - status(): parsear `tailscale funnel status --json`.
 * - "tailscale" debería añadirse a ALLOWED_COMMANDS de lib/exec.js y el operador
 *   necesita `tailscale set --operator=$USER` para no usar sudo.
 */
export class TailscaleFunnelProvider extends PublishProvider {
  get name() {
    return 'tailscale-funnel';
  }
  async expose() {
    throw new NotImplementedError(this.name, 'expose');
  }
  async unexpose() {
    throw new NotImplementedError(this.name, 'unexpose');
  }
  async status() {
    throw new NotImplementedError(this.name, 'status');
  }
}
