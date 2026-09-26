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

if [[ "$SCOPE" == "global" ]]; then
  # opencode.json "instructions" points at this exact path
  cp "$SRC/AGENTS.md" "$DEST/qwen-parent-AGENTS.md"
  echo "  installed -> $DEST/qwen-parent-AGENTS.md (instructions path)"
fi

# Quota-guard scripts -> ~/scripts (NO-CLOBBER: a box with a working guard and
# learned ceilings keeps its own; the repo copy is for fresh setups).
if [[ -d "$SRC/scripts" ]] && [[ ! -f "$HOME/scripts/zen-budget.sh" ]]; then
  mkdir -p "$HOME/scripts"
  for f in "$SRC"/scripts/*.sh; do
    cp "$f" "$HOME/scripts/"
    chmod +x "$HOME/scripts/$(basename "$f")"
    echo "  installed -> $HOME/scripts/$(basename "$f")"
  done
  echo "  note: enable the guard loop with:"
  echo "    systemctl --user enable --now zen-budget-guard  (unit not included — see README)"
elif [[ -f "$HOME/scripts/zen-budget.sh" ]]; then
  echo "  kept existing ~/scripts/zen-budget.sh (no-clobber)"
fi

echo
echo "Done ($SCOPE scope). Next steps:"
echo "  1. NVIDIA NIM key (free): run 'opencode' -> /connect -> NVIDIA NIM"
echo "     (key is stored in ~/.local/share/opencode/auth.json, never in this repo)"
echo "  2. MiMo free models:        run 'opencode', then /connect -> OpenCode Zen"
echo "  3. Sanity checks:"
echo "       curl -s http://127.0.0.1:8080/v1/models   # served id must be qwen3.8-27b"
echo "       opencode models                           # ninfer/nvidia-nim/opencode only"
echo "  4. Start: 'opencode' in your project, then /agents to see the scouts."
