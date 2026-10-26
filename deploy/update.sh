#!/usr/bin/env bash
# Actualiza paas-panel: git pull, dependencias, reinicio y comprobación de /health.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f .env ] || die "No existe .env; ejecuta primero deploy/install.sh"
PORT="$(grep -E '^PORT=' .env | tail -1 | cut -d= -f2-)"; PORT="${PORT:-8080}"

say "git pull"
git pull --ff-only

say "npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund

# Si alguien añadió claves nuevas obligatorias, init-env completa solo los secretos.
node scripts/init-env.js

say "Reiniciando el servicio"
systemctl --user restart paas-panel.service

say "Comprobando /health"
for _ in $(seq 1 20); do
  if body="$(node -e "fetch('http://127.0.0.1:$PORT/health').then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)}).catch(()=>process.exit(1))" 2>/dev/null)"; then
    say "OK: $body"
    exit 0
  fi
  sleep 1
done
die "El panel no responde en /health. Revisa: journalctl --user -u paas-panel -n 50"
