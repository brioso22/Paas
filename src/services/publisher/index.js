import { NoneProvider } from './none.js';
import { TailscaleFunnelProvider } from './tailscale-funnel.js';
import { CloudflareTunnelProvider } from './cloudflare-tunnel.js';

export const PROVIDERS = {
  none: NoneProvider,
  'tailscale-funnel': TailscaleFunnelProvider,
  'cloudflare-tunnel': CloudflareTunnelProvider,
};

export function createPublisher(ctx, name = ctx.config.publishProvider) {
  const Provider = PROVIDERS[name];
  if (!Provider) throw new Error(`Proveedor de publicación desconocido: ${name}`);
  return new Provider(ctx);
}
