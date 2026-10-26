#!/usr/bin/env bash
# Plan B si un equipo no resuelve *.lisec.test por DNS: genera las líneas de /etc/hosts
# de los hosts que existen ahora mismo en los ingress del clúster. Se ejecuta en el servidor.
#
#   bash ~/lisec-hosts.sh                    # muestra el bloque
#   Desde otro equipo (p. ej. el PC), reemplazando el bloque anterior si lo había:
#   ssh osint@100.88.5.32 'bash ~/lisec-hosts.sh' > /tmp/lisec-hosts \
#     && sudo sed -i '/# BEGIN lisec/,/# END lisec/d' /etc/hosts \
#     && cat /tmp/lisec-hosts | sudo tee -a /etc/hosts
set -euo pipefail
DOMAIN="${DOMAIN:-lisec.test}"
TS_IP="${TS_IP:-$(tailscale ip -4 2>/dev/null | head -1)}"
[ -n "$TS_IP" ] || { echo "No se pudo leer la IP de Tailscale; exporta TS_IP=..." >&2; exit 1; }

echo "# BEGIN lisec (generado por lisec-hosts.sh $(date -u +%F))"
{ echo "panel.$DOMAIN"
  kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}'
} | grep -E "(^|\.)${DOMAIN//./\\.}\$" | sort -u | while read -r h; do echo "$TS_IP $h"; done
echo "# END lisec"
