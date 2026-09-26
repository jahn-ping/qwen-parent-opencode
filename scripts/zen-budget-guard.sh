
#!/bin/bash
# zen-budget-guard: keep the no-mistakes gate on the fastest remote model that
# is still inside its daily free quota.
#   Priority: nvidia-nim -> opencode zen (mimo) -> local ninfer/qwen fallback.
# Under budget on a tier -> atomic-flip agent_config to that tier's model.
# Over budget or 429-seen-today on a tier -> drop to next tier; first 429 also
# lowers that provider's ceiling to today's crossing usage (self-calibration).
# Active only while ~/.no-mistakes/zen-budget.armed exists.
set -u
CONF=~/.no-mistakes/config.yaml
LOG=~/.no-mistakes/zen-budget-guard.log
ARMED=~/.no-mistakes/zen-budget.armed
MIMO='opencode/mimo-v2.6-flash-free'
NIM='nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b'
QWEN='ninfer/qwen3.8-27b'

say() { echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
[ -f "$ARMED" ] || exit 0

eval "$(/home/boxy/scripts/zen-budget.sh --kv)"

current=$(grep -E '^[[:space:]]+model:' "$CONF" | tail -1 | awk '{print $2}')

lower_ceiling() { # $1=provider $2=used
    local f=~/.no-mistakes/$1-ceiling
    if [ ! -f "$f" ] || [ "$2" -lt "$(cat "$f")" ]; then
        echo "$2" > "$f.tmp" && mv "$f.tmp" "$f"
        if [ "$1" = nim ]; then
            say "429 on nim: burst cap lowered to $2 (learned brake until slowdown analysis)"
        else
            say "429 on zen: ceiling lowered to $2 (budget now $(( $2 * 75 / 100 )))"
        fi
    fi
}

desired="$QWEN"; reason="all remote tiers unavailable"
if [ "$nused" -lt "$nbudget" ] && [ "$ntrips" -eq 0 ]; then
    desired="$NIM"; reason="nim $nused/$nbudget"
elif [ "$ntrips" -gt 0 ]; then
    lower_ceiling nim "$nused"
fi
if [ "$desired" = "$QWEN" ]; then
    if [ "$zused" -lt "$zbudget" ] && [ "$ztrips" -eq 0 ]; then
        desired="$MIMO"; reason="mimo $zused/$zbudget (nim exhausted)"
    elif [ "$ztrips" -gt 0 ]; then
        lower_ceiling zen "$zused"
    fi
fi

if [ "$current" != "$desired" ]; then
    sed "s|^\([[:space:]]*model:\).*|\1 $desired|" "$CONF" > "$CONF.tmp" && mv "$CONF.tmp" "$CONF"
    say "FLIP model $current -> $desired ($reason)"
fi
exit 0
