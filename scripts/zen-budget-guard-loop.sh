
#!/bin/bash
# zen-budget-guard-loop: run the guard every 60s
while true; do
    /home/boxy/scripts/zen-budget-guard.sh || true
    sleep 60
done
