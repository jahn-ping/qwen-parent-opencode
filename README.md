# Qwen Parent Hierarchy — OpenCode kit

Local Qwen3.8-27B (ninfer, V100 box) is **always the parent**. The free remote
tiers — MiMo (OpenCode Zen) and NVIDIA NIM — exist **only** as read-only scout
subagents that augment throughput while quota lasts. They can never be promoted
to parent: the config pins `model`, `build`, and `plan` to the local model, and
the remotes appear nowhere as a primary.

```
                    you (TUI — /thinking on, watch the ▸ lines)
                                     │
                    ┌────────────────▼─────────────────┐
                    │  PARENT (always): Qwen3.8-27B    │
                    │  ninfer :8080 · 2 slots · 96k    │
                    │  plans · decides · writes · bash │
                    └──────┬──────────┬──────────┬─────┘
                           │ task tool (parallel fan-out)
          ┌────────────────▼──┐ ┌────▼──────────┐ ┌──▼──────────────┐
          │ scout-mimo       │ │ scout-nim     │ │ scout-local     │
          │ opencode/        │ │ nvidia-nim/   │ │ local Qwen      │
          │ mimo-v2.6-       │ │ nemotron-3-   │ │ LAST resort,    │
          │ flash-free       │ │ ultra-550b    │ │ max 1 at a time │
          │ stop at 375/500  │ │ until 429     │ │ (shares slots   │
          │ (≥25% reserved)  │ │ → dead today  │ │  with parent)   │
          └──────────────────┘ └───────────────┘ └─────────────────┘
                 read-only workers: facts-only briefs, ≤15 bullets, file:line
```

## Files

| file          | what it is                                                  |
|---------------|-------------------------------------------------------------|
| `opencode.json` | providers, the parent lock, the three scout subagents     |
| `AGENTS.md`   | the parent's operating law: hierarchy, quota ledger, narration, plugin rules |
| `install.sh`  | one-shot installer (backs up anything it replaces)          |
| `dashboard/`  | live observability window (LM Studio-style) — see below     |

## Get it onto the other box

On this box (repo root = this folder):

```bash
# create an EMPTY private repo on GitHub first (no secrets in here, but it
# describes your GPU box and model stack — keep it private), then:
git remote add origin git@github.com:<you>/qwen-parent-opencode.git
git push -u origin main
```

On the V100 box:

```bash
git clone git@github.com:<you>/qwen-parent-opencode.git
cd qwen-parent-opencode
./install.sh            # in a project dir, or  ./install.sh --global
```

## First-run checklist (V100 box)

1. **NVIDIA NIM key** (free): sign in at https://build.nvidia.com, open any
   model, "Get API Key" → run `opencode`, then `/connect` → NVIDIA NIM.
   The key lands in `~/.local/share/opencode/auth.json` — never in this repo.
2. **MiMo free models**: run `opencode`, then `/connect` → OpenCode Zen
   (paste the Zen API key). `opencode/mimo-v2.6-flash-free` is $0.
3. **Verify model ids** (both already calibrated — just confirm):
   ```bash
   curl -s http://127.0.0.1:8080/v1/models
   # → id must be "qwen3.8-27b" (ninfer serves it under the short id,
   #    NOT the file name "qwen3_8_27b_nvfp4"). If different, fix
   #    opencode.json (provider "ninfer" + every "ninfer/..." ref).

   opencode models
   # → expect exactly 4-ish: ninfer/qwen3.8-27b,
   #   nvidia-nim/nvidia/nemotron-3-ultra-550b-a55b,
   #   nvidia-nim/qwen/qwen3-coder-480b-a35b-instruct,
   #   opencode/mimo-v2.6-flash-free
   #   (enabled_providers + the opencode whitelist hide everything else —
   #    openrouter's 385 catalog entries etc.)
   ```
4. **See the hierarchy**: start `opencode` in your project → `/agents` should
   list `scout-mimo`, `scout-nim`, `scout-local`.

## First test drive + the live view

Ask something read-heavy, e.g. *"find every place we handle auth errors"*.
You should see (this is the "live update window" — thinking plus flow):

```
/thinking                     ← toggle ON once; ninfer preserves thinking,
                                so the parent's reasoning streams live
[QUOTA] mimo 0/375 · nim ok | dead: none
▸ FANOUT: map auth-error call sites → scout-mimo ×2 + scout-nim ×1 (mimo under cap)
▸ MERGE: 3 briefs in · 41 hits across 9 files · patching retry logic in auth.py
```

Scout internals are hidden inside task calls — the ▸ narration lines are what
give you the whole-project flow. They are mandatory in `AGENTS.md` §6.

Live-visibility cheatsheet:

| want                          | how                                        |
|-------------------------------|--------------------------------------------|
| **everything at once**        | **the live dashboard** (next section)      |
| parent's thinking streamed    | `/thinking` in the TUI                     |
| headless run with thinking    | `opencode run --thinking "..."`            |
| raw event stream (scripts)    | `opencode run --format json "..."`         |
| what each model actually spent| `opencode stats --models`                  |
| replay a whole session as web | `/share` (public link — off by default)    |

## Live dashboard — the "watch everything" window

A zero-dependency observability page (LM Studio server-view style): the
agent tree with live thinking tails, pp/tg throughput charts with the
verified V100 reference bands, lane/queue gauges, the quota-guard bars,
and a scrolling ticker of every event plus the parent's ▸ narration.

Start the TUI with the server port pinned, then run the dashboard:

```bash
opencode --hostname 127.0.0.1 --port 4096     # your normal TUI, port pinned
node dashboard/dashboard.js                    # from this repo, any terminal
# → open http://127.0.0.1:8787
```

What you see:

- **Agents panel** — the parent session and every scout the task tool
  spawns, with status chips (waiting/running), the model each one runs on,
  and a live tail of its current reasoning (purple), text, or tool call.
  This is the "what is it thinking on / what's waiting" view.
- **Throughput panel** — ninfer prefill (pp) and decode (tg) tok/s over the
  last 15 minutes, drawn from `/metrics` counter deltas (works even though
  the rate gauges decay to zero when idle), with the verified 205–614 pp /
  27–59 tg bands as dashed guide zones. Lane pips show the 2 slots
  (green = decoding, yellow = prefilling); queue depth from
  `requests_deferred`.
- **Quota panel** — MiMo used vs the 375 stop line (the 25% reserve stays
  visibly untouched) and NIM used until its first 429 marks it DEAD; reads
  `~/scripts/zen-budget.sh --kv` every 30s. Panel hides if the script is
  absent.
- **Flow ticker** — every opencode bus event, with the parent's
  `▸ FANOUT / ▸ MERGE / ▸ THROTTLED` narration lines highlighted green.

Notes: if `OPENCODE_SERVER_PASSWORD` is set, export it before starting the
dashboard (it forwards basic auth). If ninfer runs without `--metrics`, the
charts automatically fall back to rates derived from `/slots` lane deltas
(accurate while lanes are processing; add `--metrics` to the ninfer serve
flags and restart the container for exact server-wide counters — note that
restart briefly interrupts the local model). Only sessions running through
the pinned 4096 server appear in the Agents panel — the desktop app's own
server (random port) is a separate instance and won't show. All three
sources degrade independently — the page never goes blank because one is
down.

## Plugins under the hierarchy

The box runs: **openspec** (`/opsx:*`), **no-mistakes**, **opencode-goal**,
**opencode-agent-memory**. The law is `AGENTS.md` §8 — summary:

- Every plugin flow runs with local Qwen as parent; plugin prompts never
  override the protocol. Research/delta/verification phases fan out to the
  scouts under the normal quota rules; the parent writes everything.
- **no-mistakes is explicit-only**: it never runs automatically after edits
  or sessions — only when you invoke it.
- **opencode-goal**: parent decomposes the goal first, delegates scouting,
  judges completion. One session per goal (keeps agent-memory consistent);
  the parent is the sole memory writer.
- Scheduler: free remote lanes fill first (MiMo while under budget, NIM
  until 429), up to 3–4 parallel remote scouts; scout-local is solo and
  last; total local concurrency caps at 2 (parent + one scout = both ninfer
  lanes). If both free tiers trip, everything collapses to the parent.

If a plugin registers its own agent carrying a remote model, discover and
pin it (same-name override in `opencode.json`, or disable it outright):

```bash
curl -s 127.0.0.1:4096/agent | jq '.[] | {name, model, mode}'   # list ALL agents incl. plugin ones
```

```jsonc
// in opencode.json → "agent" block (example — use the real name found above):
"some-plugin-agent": { "model": "ninfer/qwen3.8-27b" }        // pin to parent's model
// or: "some-plugin-agent": { "disable": true }                // remove it entirely
```

## Benchmark / bug report

One command exercises the whole deployment and writes a report you can hand
back for diagnosis:

```bash
node bench/benchmark.js            # ~1 minute
node bench/benchmark.js --scouts   # also pings each scout live
                                  # (costs ~1 MiMo + ~1 NIM call — the local scout is free)
```

It checks: host/GPU/docker environment · ninfer `/health` `/v1/models`
`/slots` `/metrics` · **real inference benchmarks** (short decode, ~3.5K-token
prefill, 2-lane concurrent — the pp/tg numbers against the verified bands) ·
the opencode server (auth, the **hierarchy check** — any primary agent on a
non-local model is flagged as a FAILURE — config provider allowlist, an 8s
SSE event sample) · the dashboard (did its charts actually move during the
bench) · the quota guard (values + 25%-reserve math) · optional live scout
pings.

Output lands in `reports/` (gitignored):

- `bug-report-<timestamp>.md` — human-readable verdict, failures first
- `bug-report-<timestamp>.json` — same data plus redacted raw samples

For the cleanest read: have the TUI (pinned `:4096`) and the dashboard
running before you benchmark. Bring back BOTH files — the `.json` carries
the shapes and samples the `.md` summarizes. No secrets ever land in a
report (auth/key/token fields are redacted).

## Tuning knobs

| knob                          | where                              | default |
|-------------------------------|------------------------------------|---------|
| MiMo daily cap / stop         | `AGENTS.md` §2 table + §5 rules    | 500 / 375 |
| which NIM model scouts use    | `opencode.json` → scout-nim.model  | nvidia/nemotron-3-ultra-550b-a55b |
| more/fewer parallel scouts    | `AGENTS.md` §3                     | 3–4 remote, 1 local |
| brief size (context pressure) | scout prompts in `opencode.json`   | 15 bullets |
| housekeeping model            | `small_model` in `opencode.json`   | mimo-v2.6-flash-free |

Calibrate the MiMo cap with `opencode stats --models` after a few days: set
the cap to ~75% of what you actually got on an unlimited day, and the stop
line keeps the last 25% untouched.

## How the quota rules actually enforce (honest note)

Neither free gateway exposes a live "percent quota remaining" API, so the
25%-reserve on MiMo is enforced by the ledger protocol in `AGENTS.md` §5 —
the parent reads its own ledger (`~/scripts/zen-budget.sh --kv` on this box)
and stops itself at 375/500. NIM needs
no emulation: it throttles with a real 429, which the protocol turns into
"dead for today". If you ever want a **hard** gate instead of prompt-level
discipline, put a LiteLLM proxy in front of both providers with per-key
daily request caps, and point the two `baseURL`s at the proxy — the config
otherwise unchanged.
