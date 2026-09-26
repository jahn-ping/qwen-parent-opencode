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
| `AGENTS.md`   | the parent's operating law: hierarchy, quota ledger, narration |
| `install.sh`  | one-shot installer (backs up anything it replaces)          |

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
| parent's thinking streamed    | `/thinking` in the TUI                     |
| headless run with thinking    | `opencode run --thinking "..."`            |
| raw event stream (scripts)    | `opencode run --format json "..."`         |
| what each model actually spent| `opencode stats --models`                  |
| replay a whole session as web | `/share` (public link — off by default)    |

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
