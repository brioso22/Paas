# Lisec PaaS

PaaS propio sobre Kubernetes (Minikube): cada proyecto se construye desde git o un .zip,
se despliega con Helm en su namespace `tenant-<proyecto>` (cuota, LimitRange,
NetworkPolicy), puede tener PostgreSQL/MySQL administrados y se publica en
`https://<proyecto>.lisec.test` para todos los equipos de la tailnet.

## Arquitectura de red (DNS + proxy + TLS)

```
 PC de la tailnet                          Servidor (100.88.5.32)
 ───────────────                           ─────────────────────────────────────────────
 python.lisec.test ?  ──split DNS──▶  lisec-dns (dnsmasq)  *.lisec.test → 100.88.5.32
                                       (solo 127.0.0.1 y 100.88.5.32, sin reenviar)
 https://python.lisec.test ──TCP──▶  lisec-proxy-https.socket :443 ─┐  systemd-socket-proxyd
 http://python.lisec.test  ──TCP──▶  lisec-proxy-http.socket  :80  ─┤  (TCP puro)
                                                                    ▼
                                      Minikube 192.168.49.2 · ingress-nginx (NodePorts)
                                      decide por Host/SNI → Service → pods del tenant
                                      TLS: Secret <proyecto>-tls = wildcard *.lisec.test
```

- **DNS**: `lisec-dns.service` (dnsmasq) responde `*.lisec.test` con la IP de Tailscale. El
  propio servidor lo consulta vía un drop-in de systemd-resolved (`Domains=~lisec.test`); los
  demás equipos, vía *split DNS* de Tailscale (nameserver 100.88.5.32 restringido a `lisec.test`).
- **Proxy**: `lisec-proxy-{http,https}.socket` escuchan en 100.88.5.32:80/443 (`FreeBind`, así
  arrancan aunque Tailscale o el bridge de Minikube aún no estén) y reenvían cada conexión a
  los NodePorts de ingress-nginx.
- **TLS**: el panel tiene una CA propia (`DATA_DIR/tls/ca.{crt,key}`, permisos 600) y emite con
  openssl un certificado wildcard `*.DOMAIN` + `DOMAIN` que usan todos los proyectos; los que
  tienen dominio personalizado reciben uno propio con todos sus SAN. HTTPS está activo por
  defecto y el ingress redirige HTTP → HTTPS (308). La CA pública se descarga en
  *Dominios y HTTPS* (`/tls/ca.crt`).
- **Panel**: además de `http://<servidor>:8080`, se publica como `https://panel.lisec.test`
  (namespace `lisec-system`: Service sin selector + EndpointSlice hacia el host).

Todo lo que necesita sudo está en `deploy/lisec-sudo.sh` (idempotente):
`bash deploy/lisec-sudo.sh`. Plan B sin DNS: `deploy/lisec-hosts.sh` genera las líneas de `/etc/hosts`.

## Operación

```bash
npm start                                   # o: systemctl --user restart paas-panel
node scripts/lisec.js projects              # CLI: mismos servicios que la UI
node scripts/lisec.js create web --repo https://github.com/u/web.git --port 3000
node scripts/lisec.js db web web postgres
node scripts/lisec.js deploy web            # --config: sin reconstruir la imagen
node scripts/lisec.js expose-panel
npm test
```

## Pasar a un dominio público real

1. En `.env`: `DOMAIN=midominio.com` y `PUBLIC_BASE_URL=https://panel.midominio.com`; reinicia el panel.
2. Redespliega cada proyecto (*Desplegar* o `node scripts/lisec.js deploy <p> --config`): los
   ingress pasan a `<proyecto>.midominio.com` y se emite el wildcard nuevo. `expose-panel` de nuevo.
3. Publica con **Cloudflare Tunnel** (no implementado aún, ver `docs/PUBLISHING.md`): un túnel
   `cloudflared` con la regla `*.midominio.com → https://192.168.49.2:<INGRESS_HTTPS_NODEPORT>`
   (`originServerName` = el host, `noTLSVerify` o la CA de Lisec como `caPool`) y un CNAME
   wildcard en Cloudflare. Cloudflare sirve su propio certificado público; dnsmasq y el proxy
   local siguen sirviendo a la tailnet.
