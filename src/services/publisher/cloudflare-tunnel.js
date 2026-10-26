import { PublishProvider, NotImplementedError } from './provider.js';

/**
 * STUB — Cloudflare Tunnel con wildcard. Plan de implementación (docs/PUBLISHING.md):
 *
 * - Un único túnel (cloudflared corriendo como servicio en el host o como Deployment)
 *   con una regla de ingress `*.<DOMINIO> -> http://<INGRESS_IP>:<NODEPORT>` y un
 *   registro DNS CNAME `*.<DOMINIO> -> <TUNNEL_ID>.cfargotunnel.com`.
 * - Con el wildcard, expose() no necesita tocar Cloudflare: solo comprobar que el
 *   host <proyecto>.<DOMINIO> responde a través del túnel. status() haría esa prueba.
 * - Si se quisiera un host por proyecto sin wildcard, expose() crearía el registro DNS
 *   con la API de Cloudflare (token con permiso DNS:Edit, guardado cifrado o en .env).
 * - TLS lo termina Cloudflare; dentro del clúster puede seguir siendo HTTP.
 */
export class CloudflareTunnelProvider extends PublishProvider {
  get name() {
    return 'cloudflare-tunnel';
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
