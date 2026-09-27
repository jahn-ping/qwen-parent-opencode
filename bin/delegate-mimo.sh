#!/usr/bin/env bash
# delegate-mimo.sh — run a task on FREE MiMo as a PRIMARY session model,
# fed through the local opencode server API (the harness itself).
#
# WHY THIS EXISTS: Zen's free tier rejects MiMo calls from task-spawned
# subagent contexts ("free tier can only be used from within OpenCode"),
# but SERVES primary-session model calls. Proven 2026-09-26.
#
# Usage (from the parent agent's bash):
#   bin/delegate-mimo.sh "task prompt" [timeout-seconds]
# Prints the MiMo reply to stdout. Exit 0 = got a reply.
set -uo pipefail

PROMPT="${1:?usage: delegate-mimo.sh \"task prompt\" [timeout-s]}"
TMO="${2:-170}"
PORT="${OC_PORT:-4096}"; HOST="${OC_HOST:-127.0.0.1}"
PW="${OPENCODE_SERVER_PASSWORD:-qwen-dash}"
ENV_FILE="$HOME/qwen-parent-opencode/dashboard/dashboard.env"
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
PW="${OPENCODE_SERVER_PASSWORD:-$PW}"
BASE="http://$HOST:$PORT"

SID=$(curl -s --max-time 10 -u "opencode:$PW" -X POST "$BASE/session" \
  -H 'content-type: application/json' -d '{"title":"mimo delegation"}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin).get("id",""))')
[ -n "$SID" ] || { echo "ERROR: could not create delegation session" >&2; exit 2; }

PROMPT="$PROMPT" timeout "$TMO" curl -s --max-time "$TMO" -u "opencode:$PW" \
  -X POST "$BASE/session/$SID/message" -H 'content-type: application/json' \
  -d "$(PROMPT="$PROMPT" python3 -c 'import json,os;print(json.dumps({
    "agent":"build",
    "model":{"providerID":"opencode","modelID":"mimo-v2.6-flash-free"},
    "parts":[{"type":"text","text":os.environ["PROMPT"]}]}))')" \
| python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
    for p in d.get("parts", []):
        if p.get("type") == "text":
            print(p["text"])
except Exception as e:
    print(f"ERROR: delegation failed ({e})", file=sys.stderr)
    sys.exit(3)'
