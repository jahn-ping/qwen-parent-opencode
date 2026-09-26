#!/usr/bin/env bash
# install-service.sh — run the dashboard as a systemd user service:
# starts at login, auto-restarts on crash. Idempotent; safe to re-run.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
NODE_BIN="$(command -v node)"
PW="${OPENCODE_SERVER_PASSWORD:-qwen-dash}"
ENV_FILE="$SRC/dashboard.env"

# secret file (gitignored) — regenerated only if absent
if [[ ! -f "$ENV_FILE" ]]; then
  printf 'OPENCODE_SERVER_PASSWORD=%s\n' "$PW" > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "  wrote $ENV_FILE"
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/qwen-dash.service" << EOF
[Unit]
Description=qwen-parent live dashboard (auto-discovering)
After=network-online.target

[Service]
WorkingDirectory=$SRC
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $SRC/dashboard.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

# stop any manual instance holding the port, then hand over to systemd
PORT="${DASH_PORT:-8787}"
OLD=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP "pid=\\K[0-9]+" | head -1 || true)
if [[ -n "$OLD" ]]; then
  kill "$OLD" 2>/dev/null || true; sleep 1
  ss -tlnp 2>/dev/null | grep -q ":$PORT " && kill -9 "$OLD" 2>/dev/null || true
fi

systemctl --user daemon-reload
systemctl --user enable --now qwen-dash.service
sleep 2
systemctl --user is-active qwen-dash.service >/dev/null \
  && echo "  qwen-dash.service: active (starts at login, auto-restarts)" \
  || { echo "  FAILED — check: journalctl --user -u qwen-dash -n 20"; exit 1; }
