#!/usr/bin/env bash
# Instalación idempotente de paas-panel como servicio systemd de usuario.
# No ejecuta nada con sudo: al final imprime los comandos que debes correr tú.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="paas-panel.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
cd "$APP_DIR"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mAVISO:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "No ejecutes este script como root: el panel corre como servicio de tu usuario."
command -v node >/dev/null || die "No se encontró node (se requiere Node 22)."
command -v npm >/dev/null || die "No se encontró npm."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Se requiere Node >= 22 (tienes $(node -v))."
for c in kubectl helm minikube git; do
  command -v "$c" >/dev/null || warn "No se encontró '$c' en el PATH: los despliegues fallarán hasta instalarlo."
done

say "Instalando dependencias (npm ci --omit=dev)"
npm ci --omit=dev --no-audit --no-fund

say "Preparando .env"
node scripts/init-env.js
chmod 600 .env

env_get() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
PORT="$(env_get PORT)"; PORT="${PORT:-8080}"
CHART_PATH="$(env_get CHART_PATH)"; CHART_PATH="${CHART_PATH:-~/paas-app-chart}"
CHART_PATH="${CHART_PATH/#\~/$HOME}"
[ -f "$CHART_PATH/Chart.yaml" ] || warn "No se encontró el chart en $CHART_PATH (CHART_PATH en .env)."
[ "$(env_get DRY_RUN)" = "true" ] && warn "DRY_RUN=true en .env: el panel no ejecutará comandos reales."

mkdir -p data workspaces
chmod 700 data workspaces

# PATH de la unidad: directorios reales de las herramientas + los del sistema.
UNIT_PATH="/usr/local/bin:/usr/bin:/bin"
for c in node kubectl helm minikube git docker; do
  if p="$(command -v "$c" 2>/dev/null)"; then
    d="$(dirname "$(readlink -f "$p")")"
    case ":$UNIT_PATH:" in *":$d:"*) ;; *) UNIT_PATH="$d:$UNIT_PATH" ;; esac
  fi
done

say "Instalando la unidad en $UNIT_DIR/$UNIT_NAME"
mkdir -p "$UNIT_DIR"
sed -e "s|%h/paas-panel|$APP_DIR|g" \
    -e "s|^ExecStart=/usr/bin/node |ExecStart=$(command -v node) |" \
    -e "s|^Environment=PATH=.*|Environment=PATH=$UNIT_PATH|" \
    deploy/paas-panel.service > "$UNIT_DIR/$UNIT_NAME"

systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME" >/dev/null
systemctl --user restart "$UNIT_NAME"

say "Esperando a /health"
ok=0
for _ in $(seq 1 20); do
  if node -e "fetch('http://127.0.0.1:$PORT/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
if [ "$ok" -eq 1 ]; then
  say "paas-panel está corriendo en el puerto $PORT."
else
  warn "El servicio no respondió en 20 s. Revisa: journalctl --user -u paas-panel -n 50"
fi

cat <<MSG

Pasos que debes ejecutar TÚ (requieren sudo; este script no los corre):

  # Permitir el panel solo desde la interfaz de Tailscale:
  sudo ufw allow in on tailscale0 to any port $PORT proto tcp

  # Mantener el servicio de usuario activo sin sesión abierta (y tras reiniciar):
  sudo loginctl enable-linger $USER

Después abre http://<IP-tailscale-del-servidor>:$PORT/setup para crear el administrador.
MSG
