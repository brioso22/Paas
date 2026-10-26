#!/usr/bin/env bash
# Lisec PaaS — configuración del sistema que requiere sudo. Idempotente: se puede
# ejecutar las veces que haga falta. Uso: bash ~/lisec-sudo.sh
#
#   1. DNS wildcard *.DOMAIN -> IP de Tailscale (dnsmasq propio, sin reenviar nada).
#   2. systemd-resolved del servidor pregunta *.DOMAIN a ese dnsmasq.
#   3. Proxy TCP IP_TAILSCALE:80/443 -> NodePorts http/https de ingress-nginx.
#   4. Verificaciones.
set -euo pipefail

DOMAIN="${DOMAIN:-lisec.test}"
TS_IP="${TS_IP:-$(tailscale ip -4 2>/dev/null | head -1)}"
[ -n "$TS_IP" ] || { echo "ERROR: no se pudo leer la IP de Tailscale (tailscale ip -4). Exporta TS_IP=..." >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
  KUSER="${SUDO_USER:-}"
else
  SUDO="sudo"
  KUSER=""
fi
kubectl_user() { if [ -n "$KUSER" ]; then sudo -u "$KUSER" -H kubectl "$@"; else kubectl "$@"; fi; }
ok() { printf '  \033[32mOK\033[0m %s\n' "$*"; }
bad() { printf '  \033[31mFALLO\033[0m %s\n' "$*"; FAILED=1; }
FAILED=0

echo "==> Leyendo del clúster la IP de Minikube y los NodePorts de ingress-nginx"
NODE_IP="$(kubectl_user get nodes -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
HTTP_NP="$(kubectl_user -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[?(@.name=="http")].nodePort}')"
HTTPS_NP="$(kubectl_user -n ingress-nginx get svc ingress-nginx-controller -o jsonpath='{.spec.ports[?(@.name=="https")].nodePort}')"
for v in NODE_IP HTTP_NP HTTPS_NP; do [ -n "${!v}" ] || { echo "ERROR: no se pudo leer $v del clúster" >&2; exit 1; }; done
echo "    dominio=$DOMAIN  tailscale=$TS_IP  minikube=$NODE_IP  http=$HTTP_NP  https=$HTTPS_NP"

DNSMASQ_BIN="$(command -v dnsmasq || true)"
if [ -z "$DNSMASQ_BIN" ]; then
  echo "==> Instalando dnsmasq-base (solo el binario, sin el servicio del paquete dnsmasq)"
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq dnsmasq-base
  DNSMASQ_BIN="$(command -v dnsmasq)"
fi

echo "==> 1/3 dnsmasq: *.$DOMAIN -> $TS_IP (solo 127.0.0.1 y $TS_IP, sin reenviar otros dominios)"
$SUDO install -d -m 755 /etc/lisec
$SUDO tee /etc/lisec/dnsmasq.conf >/dev/null <<EOF
# Generado por lisec-sudo.sh. DNS wildcard de Lisec PaaS.
port=53
listen-address=127.0.0.1
listen-address=$TS_IP
# bind-dynamic: escucha solo en esas direcciones (no choca con systemd-resolved en
# 127.0.0.53/54) y se engancha a la IP de Tailscale cuando aparezca tras el arranque.
bind-dynamic
# Sin servidores aguas arriba: lo que no sea $DOMAIN no se reenvía (REFUSED).
no-resolv
no-hosts
no-poll
domain-needed
bogus-priv
address=/$DOMAIN/$TS_IP
user=nobody
group=nogroup
pid-file=
EOF
$SUDO tee /etc/systemd/system/lisec-dns.service >/dev/null <<EOF
[Unit]
Description=Lisec PaaS - DNS wildcard *.$DOMAIN (dnsmasq)
After=network.target tailscaled.service
Wants=tailscaled.service

[Service]
ExecStartPre=$DNSMASQ_BIN --test --conf-file=/etc/lisec/dnsmasq.conf
ExecStart=$DNSMASQ_BIN --keep-in-foreground --conf-file=/etc/lisec/dnsmasq.conf
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> 2/3 systemd-resolved: consultas de *.$DOMAIN a 127.0.0.1"
$SUDO install -d -m 755 /etc/systemd/resolved.conf.d
$SUDO tee /etc/systemd/resolved.conf.d/lisec.conf >/dev/null <<EOF
# Generado por lisec-sudo.sh. Solo el dominio de enrutado ~$DOMAIN va a dnsmasq.
[Resolve]
DNS=127.0.0.1
Domains=~$DOMAIN
EOF

echo "==> 3/3 Proxy TCP $TS_IP:80 -> $NODE_IP:$HTTP_NP y $TS_IP:443 -> $NODE_IP:$HTTPS_NP"
# systemd-socket-proxyd viene con systemd. FreeBind permite escuchar en la IP de Tailscale
# aunque aún no exista; cada conexión abre una nueva hacia Minikube, así que si el bridge
# todavía no tiene IP solo fallan esas conexiones y el proxy sigue en pie.
PROXYD="$(ls /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd 2>/dev/null | head -1)"
[ -n "$PROXYD" ] || { echo "ERROR: no se encontró systemd-socket-proxyd" >&2; exit 1; }
for pair in "http:80:$HTTP_NP" "https:443:$HTTPS_NP"; do
  IFS=: read -r name port np <<<"$pair"
  $SUDO tee /etc/systemd/system/lisec-proxy-$name.socket >/dev/null <<EOF
[Unit]
Description=Lisec PaaS - escucha $TS_IP:$port ($name)

[Socket]
ListenStream=$TS_IP:$port
FreeBind=true
NoDelay=true
Backlog=256

[Install]
WantedBy=sockets.target
EOF
  $SUDO tee /etc/systemd/system/lisec-proxy-$name.service >/dev/null <<EOF
[Unit]
Description=Lisec PaaS - proxy TCP $TS_IP:$port -> $NODE_IP:$np (ingress-nginx $name)
Requires=lisec-proxy-$name.socket
After=lisec-proxy-$name.socket

[Service]
ExecStart=$PROXYD --connections-max=512 $NODE_IP:$np
Restart=always
RestartSec=2
DynamicUser=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
EOF
done

echo "==> Recargando y arrancando servicios"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now lisec-dns.service >/dev/null
$SUDO systemctl restart lisec-dns.service
$SUDO systemctl restart systemd-resolved.service
for name in http https; do
  $SUDO systemctl enable lisec-proxy-$name.socket >/dev/null
  # Reinicia el servicio si ya corría (p. ej. cambió el NodePort) y deja el socket escuchando.
  $SUDO systemctl stop lisec-proxy-$name.service 2>/dev/null || true
  $SUDO systemctl restart lisec-proxy-$name.socket
done
sleep 1

echo "==> Verificaciones"
systemctl is-active --quiet lisec-dns.service && ok "lisec-dns.service activo" || bad "lisec-dns.service no está activo (journalctl -u lisec-dns)"
for name in http https; do
  systemctl is-active --quiet lisec-proxy-$name.socket && ok "lisec-proxy-$name.socket escuchando" || bad "lisec-proxy-$name.socket inactivo"
done
systemctl is-active --quiet minikube-bridge-fix.timer && ok "minikube-bridge-fix.timer sigue activo" || bad "minikube-bridge-fix.timer no está activo"

if command -v dig >/dev/null; then
  a="$(dig +short @"$TS_IP" "python.$DOMAIN" A)"; [ "$a" = "$TS_IP" ] && ok "dig @$TS_IP python.$DOMAIN -> $a" || bad "dig @$TS_IP python.$DOMAIN devolvió '$a'"
  a="$(dig +short @127.0.0.1 "x.$DOMAIN" A)"; [ "$a" = "$TS_IP" ] && ok "dig @127.0.0.1 x.$DOMAIN -> $a" || bad "dig @127.0.0.1 x.$DOMAIN devolvió '$a'"
  st="$(dig @"$TS_IP" example.com A | sed -n 's/.*status: \([A-Z]*\).*/\1/p')"; [ "$st" != "NOERROR" ] && ok "otros dominios no se reenvían (example.com -> $st)" || bad "dnsmasq está reenviando example.com"
fi
a="$(getent hosts "python.$DOMAIN" | awk '{print $1}' | head -1)"; [ "$a" = "$TS_IP" ] && ok "getent hosts python.$DOMAIN -> $a" || bad "getent hosts python.$DOMAIN devolvió '$a'"
getent hosts github.com >/dev/null && ok "la resolución normal sigue funcionando (github.com)" || bad "github.com ya no resuelve: revisa /etc/systemd/resolved.conf.d/lisec.conf"
for port in 80 443; do
  ss -ltnH "sport = :$port" | grep -q "$TS_IP:$port" && ok "escuchando en $TS_IP:$port" || bad "nada escucha en $TS_IP:$port"
done
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$TS_IP/" -H "Host: nada.$DOMAIN" || true)"
[ "$code" = "404" ] && ok "HTTP llega al ingress (host desconocido -> 404 de ingress-nginx)" || bad "HTTP a $TS_IP:80 devolvió '$code' (¿bridge de minikube sin IP?)"
code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "nada.$DOMAIN:443:$TS_IP" "https://nada.$DOMAIN/" || true)"
[ "$code" = "404" ] && ok "HTTPS llega al ingress (TLS por SNI)" || bad "HTTPS a $TS_IP:443 devolvió '$code'"

echo
if [ "$FAILED" -eq 0 ]; then echo "Todo correcto."; else echo "Hay fallos: revisa los mensajes de arriba." >&2; exit 1; fi
