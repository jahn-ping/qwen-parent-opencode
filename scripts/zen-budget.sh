#!/bin/bash
# model-budget: meter daily usage of each paid/free remote model provider so
# the no-mistakes gate can stay inside free quotas.
#   zen     = opencode zen free models (mimo), counted via providerID=opencode
#   nim     = nvidia-nim, counted via providerID=nvidia-nim
# Both share the same log sources.
#   zen (mimo): budget = 75% of ceiling (>=25% always free) - hard reserve.
#   nim:        budget = 100% of ceiling (default 2000) - BURST mode, no fixed
#               reserve; brakes come from real 429s (ceiling learns) until we
#               analyze slowdown thresholds.
# Ceilings: ~/.no-mistakes/zen-ceiling (default 500), ~/.no-mistakes/nim-ceiling
# (default 2000). On first 429 for a provider the guard lowers its ceiling to that
# day's crossing usage. All days are UTC.
set -u
ZEN_CEIL=${ZEN_CEILING:-500}
NIM_CEIL=${NIM_CEILING:-2000}
[ -f ~/.no-mistakes/zen-ceiling ] && ZEN_CEIL=$(cat ~/.no-mistakes/zen-ceiling)
[ -f ~/.no-mistakes/nim-ceiling ] && NIM_CEIL=$(cat ~/.no-mistakes/nim-ceiling)
ZEN_BUDGET=$(( ZEN_CEIL * 75 / 100 ))
NIM_BUDGET=$NIM_CEIL

DAY=$(date -u +%F)
[ "${1:-}" = "--kv" ] || DAY=${1:-$DAY}
LOGS="$HOME/.local/share/opencode/log/opencode.log $HOME/.no-mistakes/logs/managed-server.log"
Z_USED=0; Z_TRIPS=0; N_USED=0; N_TRIPS=0
for f in $LOGS; do
    [ -f "$f" ] || continue
    for prov in opencode nvidia-nim; do
        u=$(grep 'message=stream' "$f" 2>/dev/null | grep "providerID=$prov" | grep -c "timestamp=$DAY")
        t=$(grep -E 'FreeUsageLimitError|Free usage exceeded|429' "$f" 2>/dev/null | grep "providerID=$prov" | grep -c "timestamp=$DAY")
        if [ "$prov" = opencode ]; then Z_USED=$((Z_USED+u)); Z_TRIPS=$((Z_TRIPS+t))
        else N_USED=$((N_USED+u)); N_TRIPS=$((N_TRIPS+t)); fi
    done
done
# 429s often log without providerID; attribute same-day bare 429 lines to zen
BARE=$(grep -E 'status=429|HTTP 429' "$LOGS" 2>/dev/null | grep -c "timestamp=$DAY" || true)
Z_TRIPS=$(( Z_TRIPS + BARE ))

Z_REMAIN=$(( ZEN_BUDGET - Z_USED )); [ $Z_REMAIN -lt 0 ] && Z_REMAIN=0
N_REMAIN=$(( NIM_BUDGET - N_USED )); [ $N_REMAIN -lt 0 ] && N_REMAIN=0

if [ "${1:-}" = "--kv" ]; then
    printf 'zused=%d\nzbudget=%d\nztrips=%d\nzceil=%d\nnused=%d\nnbudget=%d\nntrips=%d\nnceil=%d\n' \
        "$Z_USED" "$ZEN_BUDGET" "$Z_TRIPS" "$ZEN_CEIL" "$N_USED" "$NIM_BUDGET" "$N_TRIPS" "$NIM_CEIL"
else
    echo "zen ($DAY UTC): $Z_USED/$ZEN_BUDGET used, $Z_REMAIN left, 429: $Z_TRIPS | nim: $N_USED/$NIM_BUDGET used, $N_REMAIN left, 429: $N_TRIPS"
fi
