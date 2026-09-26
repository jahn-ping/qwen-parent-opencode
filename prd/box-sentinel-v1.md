# PRD: Box Sentinel v1

Status: DRAFT for /opsx:propose
Owner: jahn
Target box: V100 inference server (ninfer :8080, opencode harness, zen-budget quota guard)

## 1. Problem

The box runs a hand-built inference stack (ninfer NVFP4 server, OpenCode
harness with quota-gated remote scouts, a live dashboard) but has **no
memory**. Every signal that matters — throughput, MTP draft-acceptance,
GPU thermals, free-tier quota burn — exists only in the moment: log lines
scroll away, the dashboard shows the last 15 minutes, benchmark reports
pile up unread. When decode speed drops or Zen trips a 429, there is no
history to say *when it started* or *what changed*.

## 2. Product

**Box Sentinel** — a single lightweight always-on service (Node.js, zero
npm dependencies, same constraint as the dashboard) that:

1. **Samples** every 60s: ninfer throughput (parsed from
   `docker logs --since 60s ninfer` — the fork has no /metrics or /slots),
   GPU temp/power/utilization (`nvidia-smi --query-gpu`), and quota state
   (`~/scripts/zen-budget.sh --kv`).
2. **Stores** samples in a local SQLite database (via `node:sqlite` — no
   dependencies), retaining 30 days.
3. **Serves** a compact JSON API on `127.0.0.1:8790`:
   - `GET /health` → `{ok:true}`
   - `GET /stats?hours=N` → per-minute aggregates: pp/tg tok/s (avg, max),
     gpu temp (max), quota used/budget
   - `GET /alerts?active=1` → currently firing alerts
4. **Alerts** (evaluated on every sample, deduplicated — one alert per
   condition per hour, written to the alerts table):
   - **thermal**: GPU temp ≥ 84°C for 5 consecutive samples
   - **mtp-drift**: MTP acceptance < 30% across ≥ 10 requests in a 15-min
     window (spec nominal: 36–82%)
   - **throughput-drop**: decode avg < 20 tok/s for 10 min while a request
     is running (verified band: 27–36 single-lane)
   - **quota**: MiMo trips 429 OR NIM trips 429 (surface which)
5. **Optional webhook**: if `SENTINEL_WEBHOOK_URL` env is set, POST alert
   JSON to it (Telegram/Discord-compatible payload shape), max 1/hour per
   condition. Never required for core function.

## 3. Non-goals (v1)

- No frontend UI (the existing qwen-parent dashboard remains the view;
  Sentinel is data + alerts only)
- No multi-box support
- No auth/TLS (loopback-only binding)
- No historical backfill — history starts when Sentinel starts

## 4. Users & stories

- **jahn (owner, at the box)**: "I want to ask *was my box slow this
  afternoon, and since when?* and get a minutes-accurate answer."
  → `GET /stats?hours=6` shows the drop and the temp curve alongside it.
- **jahn (away from the box)**: "I want to know the moment quota or
  thermals break my session." → webhook message arrives on his phone.
- **the qwen parent (agent)**: "When the user asks why decode is slow, I
  want facts to delegate for." → scouts read `/stats` output as data.

## 5. Functional requirements

- FR1 Sample loop runs every 60s ± 5s; a failed sample is logged and
  skipped, never crashes the loop.
- FR2 SQLite DB at `~/sentinel/sentinel.db`; WAL mode; auto-created.
- FR3 `GET /stats` returns 200 within 200ms for 30 days of data.
- FR4 Alerts include: condition id, first-seen timestamp, last-seen,
  evidence (the actual sample values), and acknowledged flag.
- FR5 `POST /alerts/:id/ack` silences a condition for 12h.
- FR6 Service runs as a systemd user unit (`sentinel.service`), starts at
  login, restarts on crash, logs to journald.
- FR7 All config via env vars with the defaults above; no config files.

## 6. Acceptance criteria

- AC1: Given the service has been up 10 minutes, `GET /stats?hours=1`
  returns ≥ 9 samples with pp/tg values (zeros when idle, not gaps).
- AC2: Given MTP acceptance from ninfer logs drops below 30% for 10
  requests, `GET /alerts?active=1` shows an `mtp-drift` alert with the
  failing values as evidence.
- AC3: Given `zen-budget.sh` reports ztrips ≥ 1, a `quota` alert fires
  within 60s and the hourly dedup prevents repeats for 1 hour.
- AC4: Given the service is killed with SIGKILL, systemd restarts it
  within 10s and the sample loop resumes without manual action.
- AC5: `node sentinel.js --selftest` runs one full sample + one alert
  evaluation offline and exits 0 — no docker, no GPU required.

## 7. Architecture sketch (non-binding)

    sentinel.js        entry, env config, systemd-friendly (SIGTERM clean)
    lib/sample.js      docker logs / nvidia-smi / zen-budget parsers
    lib/store.js       node:sqlite schema + queries (samples, alerts)
    lib/alerts.js      condition evaluation + dedup + optional webhook
    lib/api.js         http server on 127.0.0.1:8790

Tests: `node --test` with fixture log lines (throughput/req-done samples
captured from real ninfer output) — parsers must be pure functions.

## 8. Process requirements (for the opsx run — this is the test)

- Research phases SHOULD fan out read-heavy investigation to the scout
  subagents (scout-nim first; scout-mimo is provider-blocked on this box
  and will fall back — that fallback is part of what v1 of the process is
  validating).
- The parent writes all specs and code; scouts return facts-only briefs.
- The quota ledger ([QUOTA] lines) must be narrated per AGENTS.md §5-§6.
- Implementation MUST NOT modify anything outside the sentinel project
  directory.

## 9. Milestones

- M1: sampling + storage + /health (walking skeleton)
- M2: /stats + /alerts with all four conditions
- M3: systemd unit + webhook + selftest
- M4: 48h soak on the box, then review history for real drift events
