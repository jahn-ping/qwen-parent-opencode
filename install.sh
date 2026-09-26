#!/usr/bin/env bash
# install.sh — wire the Qwen-parent OpenCode kit into a project (or globally).
#
# Usage (on the box where ninfer serves Qwen3.8-27B on :8080):
#   ./install.sh             install into the CURRENT directory (project scope)
#   ./install.sh --global    install into ~/.config/opencode (all projects)
#
# Existing opencode.json / AGENTS.md are backed up with a timestamp, never lost.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCOPE="project"
if [[ "${1:-}" == "--global" ]]; then
  SCOPE="global"
fi

if [[ "$SCOPE" == "global" ]]; then
  DEST="$HOME/.config/opencode"
else
  DEST="$PWD"
fi
mkdir -p "$DEST"

for f in opencode.json AGENTS.md; do
  target="$DEST/$f"
  if [[ -f "$target" ]]; then
    backup="$target.backup.$(date +%Y%m%d-%H%M%S)"
    cp "$target" "$backup"
    echo "  backed up existing -> $(basename "$backup")"
  fi
  cp "$SRC/$f" "$target"
  echo "  installed -> $target"
done

echo
echo "Done ($SCOPE scope). Next steps:"
echo "  1. NVIDIA key (free tier):  export NVIDIA_API_KEY=nvapi-xxxx   # add to ~/.bashrc"
echo "     (get one at https://build.nvidia.com — sign in, any model, 'Get API Key')"
echo "  2. MiMo free models:        run 'opencode', then /connect -> OpenCode Zen"
echo "  3. Sanity checks:"
echo "       curl -s http://127.0.0.1:8080/v1/models   # model id must match opencode.json"
echo "       opencode models                           # ninfer/nvidia-nim/opencode all listed"
echo "  4. Start: 'opencode' in your project, then /agents to see the scouts."
