#!/usr/bin/env node
// benchmark.js — deployment benchmark + bug report generator.
//
// Exercises every layer of the qwen-parent deployment on this box and writes
// a timestamped bug report you can hand back for diagnosis:
//
//   reports/bug-report-<timestamp>.md   human-readable
//   reports/bug-report-<timestamp>.json machine-readable (same data, raw samples)
//
// Sections:
//   1 environment        host, GPU, docker, node
//   2 ninfer endpoints   /health /v1/models /slots /metrics
//   3 inference bench    real requests: short decode, long-prefill, 2-lane
//                        concurrent — the pp/tg numbers
//   4 opencode server    auth, agents (hierarchy check!), config, SSE events
//   5 dashboard          live snapshot, did charts actually move during §3
//   6 quota guard        zen-budget.sh --kv values + stop-line math
//   7 live scout ping    OPTIONAL: one tiny task per scout (--scouts)
//                        — costs ~1 MiMo + ~1 NIM call, local is free
//
// Usage:  node bench/benchmark.js [--scouts]
// Zero npm dependencies. Node >= 18. Never writes secrets into reports.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const CFG = {
  ocBase: `http://${process.env.OC_HOST || "127.0.0.1"}:${process.env.OC_PORT || "4096"}`,
  nBase: `http://${process.env.NINFER_HOST || "127.0.0.1"}:${process.env.NINFER_PORT || "8080"}`,
  dashBase: `http://127.0.0.1:${process.env.DASH_PORT || "8787"}`,
  zenBudget: process.env.ZEN_BUDGET || path.join(os.homedir(), "scripts", "zen-budget.sh"),
  scouts: process.argv.includes("--scouts"),
  parentModel: "ninfer/qwen3.8-27b",       // the law — anything else is a violation
  allowedProviders: ["ninfer", "nvidia-nim", "opencode"],
};

const ocHeaders = {};
if (process.env.OPENCODE_SERVER_PASSWORD) {
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  ocHeaders.Authorization = "Basic " +
    Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
}

const results = []; // {section, name, status, expected, got, note, ms}
const raw = {};     // redacted raw samples per section

async function check(section, name, fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    results.push({ section, name, status: r.status || "info", expected: r.expected,
      got: r.got, note: r.note, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ section, name, status: "fail", expected: "no throw",
      got: String(e && e.message || e), ms: Date.now() - t0 });
  }
}

async function jget(url, headers, ms = 8000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}
async function tget(url, ms = 8000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return { ok: r.ok, status: r.status, text: await r.text().catch(() => "") };
}
function sh(cmd, args, ms = 8000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ms }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || "").trim(), err: String(stderr || err || "").trim() }));
  });
}
function redact(v, depth = 0) {
  if (depth > 6) return "[deep]";
  if (typeof v === "string") return v.length > 300 ? v.slice(0, 300) + "…[truncated]" : v;
  if (Array.isArray(v)) return v.slice(0, 8).map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const o = {};
    for (const k of Object.keys(v).slice(0, 30)) {
      if (/pass|key|token|secret|authorization/i.test(k)) o[k] = "[redacted]";
      else o[k] = redact(v[k], depth + 1);
    }
    return o;
  }
  return v;
}

// ------------------------------------------------------------- sections ----

async function sectionEnv() {
  const e = raw.env = {};
  e.date = new Date().toISOString();
  e.node = process.version;
  e.uname = (await sh("uname", ["-a"])).out;
  const gpu = await sh("nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used,power.limit", "--format=csv,noheader"]);
  e.gpu = gpu.ok ? gpu.out : "nvidia-smi unavailable";
  const dk = await sh("docker", ["ps", "--format", "{{.Names}} {{.Image}} {{.Status}}", "--no-trunc"], 10000);
  e.docker = dk.ok ? dk.out.split("\n").filter((l) => /ninfer|opencode/i.test(l)) : "docker unavailable";
  await check("env", "host environment", () => ({ status: "info", got: `${e.gpu} | node ${e.node}` }));
}

let lanesBusyBefore = 0;

async function sectionNinfer() {
  const n = raw.ninfer = {};
  await check("ninfer", "GET /health", async () => {
    const h = await tget(`${CFG.nBase}/health`);
    n.health = h;
    return { status: h.ok ? "pass" : "fail", expected: "200 ok", got: h.status };
  });
  await check("ninfer", "GET /v1/models — served id", async () => {
    const m = await jget(`${CFG.nBase}/v1/models`);
    n.models = redact(m);
    const id = m && m.data && m.data[0] && m.data[0].id;
    return { status: id === "qwen3.8-27b" ? "pass" : "warn",
      expected: "qwen3.8-27b", got: id, note: "config must match this id" };
  });
  await check("ninfer", "GET /slots — 2 lanes", async () => {
    let s;
    try { s = await jget(`${CFG.nBase}/slots`); }
    catch (e) {
      return { status: "warn", expected: "200 JSON array", got: String(e.message || e),
        note: "fork appears to disable /slots — lane view + slot-rate fallback unavailable; add --metrics to serve flags for exact counters" };
    }
    n.slotsSample = redact(Array.isArray(s) ? s[0] : s);
    const lanes = Array.isArray(s) ? s.length : 0;
    lanesBusyBefore = Array.isArray(s) ? s.filter((x) => x.is_processing).length : 0;
    const hasFields = Array.isArray(s) && s[0] && "n_prompt_tokens_processed" in s[0];
    return { status: lanes === 2 && hasFields ? "pass" : "warn",
      expected: "2 lanes with token fields", got: `${lanes} lanes, fields=${!!hasFields}` };
  });
  await check("ninfer", "GET /metrics — prefix detect", async () => {
    const m = await tget(`${CFG.nBase}/metrics`);
    n.metricsHead = m.text.slice(0, 400);
    if (!m.ok) return { status: "warn", expected: "200", got: m.status,
      note: "add --metrics to serve flags for exact counters (slots fallback works without it)" };
    const pfx = /llamacpp:/.test(m.text) ? "llamacpp:" : /llama_/.test(m.text) ? "llama_" : null;
    n.metricsPrefix = pfx;
    return { status: pfx ? "pass" : "warn", expected: "llamacpp: or llama_ prefix",
      got: pfx || "unknown" };
  });
}

// One streamed chat completion; returns timing + token counts.
async function streamChat(prompt, maxTokens) {
  const t0 = Date.now();
  let ttft = null, chunks = 0, usage = null;
  const r = await fetch(`${CFG.nBase}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: "qwen3.8-27b", stream: true, max_tokens: maxTokens,
      stream_options: { include_usage: true }, // final chunk carries usage (llama.cpp-family)
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok || !r.body) throw new Error(`completions ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      if (j.usage) usage = j.usage;
      const delta = j.choices && j.choices[0] && j.choices[0].delta;
      if (delta && (delta.content || delta.reasoning_content)) {
        chunks++;
        if (ttft === null) ttft = Date.now() - t0;
      }
    }
  }
  const total = Date.now() - t0;
  const outTok = usage && (usage.completion_tokens ?? usage.computed_completion_tokens) || chunks;
  // Some forks ignore stream_options — fall back to a chars/4 token estimate.
  const inTok = usage && usage.prompt_tokens || null;
  const inTokEst = Math.round(prompt.length / 4);
  return { ttft, totalMs: total, outTok, inTok, inTokEst,
    inTokEstimated: !inTok, usage: usage || null };
}

async function sectionBench() {
  const b = raw.bench = {};
  if (lanesBusyBefore >= 2) {
    await check("bench", "lanes free?", () => ({ status: "warn", got: `${lanesBusyBefore}/2 busy`,
      note: "live traffic on the box — numbers below will be skewed" }));
  }
  await check("bench", "decode short (30 tok)", async () => {
    const r = await streamChat("Count from 1 to 30, one number per line. Nothing else.", 40);
    const tps = r.outTok && r.totalMs ? (r.outTok / ((r.totalMs - (r.ttft || 0)) / 1000)) : 0;
    b.decodeShort = { ...r, tokPerSec: +tps.toFixed(1) };
    return { status: tps >= 20 ? "pass" : "warn", expected: "≥20 tok/s (verified band 27–36)",
      got: `${tps.toFixed(1)} tok/s, ttft ${r.ttft}ms` };
  });
  await check("bench", "prefill long (~3.5K tok, cache-proof)", async () => {
    // ninfer reuses compatible prefixes — a repeated prompt would come from
    // cache and fake a huge tok/s. Salt every run with a unique tag.
    const filler = ("The quick brown fox jumps over the lazy dog while the turbine spins. ").repeat(290);
    const salt = `\nrun-salt ${Date.now()}-${Math.random().toString(36).slice(2, 10)} — ignore.\n`;
    const r = await streamChat(`${salt}${filler}\nReply with the single word: ok`, 8);
    const inTok = r.inTok || r.inTokEst;
    const pp = inTok && r.ttft ? (inTok / (r.ttft / 1000)) : 0;
    b.prefillLong = { ...r, ppTokPerSec: +pp.toFixed(0) };
    const cached = r.ttft < 800 && inTok > 2000; // too fast for this many tokens
    return { status: pp >= 100 && !cached ? "pass" : "warn",
      expected: "≥100 tok/s (verified band 205–614), not prefix-cache-served",
      got: `${pp.toFixed(0)} tok/s over ${inTok} prompt tok (${r.inTokEstimated ? "estimated" : "usage-reported"}), ttft ${r.ttft}ms`,
      note: cached ? "TTFT implausibly low — prompt likely prefix-cache-served despite salt" : "" };
  });
  await check("bench", "2-lane concurrent decode", async () => {
    const [a, c] = await Promise.all([
      streamChat("List ten colors, one per line.", 40),
      streamChat("List ten countries, one per line.", 40),
    ]);
    const toks = (a.outTok || 0) + (c.outTok || 0);
    const span = Math.max(a.totalMs, c.totalMs) / 1000;
    const agg = span > 0 ? toks / span : 0;
    b.concurrent2 = { a: { outTok: a.outTok, totalMs: a.totalMs },
      c: { outTok: c.outTok, totalMs: c.totalMs }, aggregateTokPerSec: +agg.toFixed(1) };
    return { status: agg >= 35 ? "pass" : "warn",
      expected: "≥35 tok/s aggregate (verified 45–59 @2 streams)", got: `${agg.toFixed(1)} tok/s` };
  });
}

async function sectionOpencode() {
  const o = raw.opencode = {};
  await check("opencode", "server reachable + auth", async () => {
    const noAuth = await tget(`${CFG.ocBase}/session`);
    const withAuth = await fetch(`${CFG.ocBase}/session`, { headers: ocHeaders,
      signal: AbortSignal.timeout(5000) });
    o.authNoCreds = noAuth.status; o.authWithCreds = withAuth.status;
    if (withAuth.ok) return { status: "pass", got: `with-creds ${withAuth.status} (no-creds ${noAuth.status})`,
      note: noAuth.status === 401 ? "password set — export OPENCODE_SERVER_PASSWORD before the dashboard" : "no auth" };
    return { status: "fail", expected: "200 with credentials", got: withAuth.status,
      note: "is the TUI running with --port 4096?" };
  });
  await check("opencode", "agents — hierarchy check", async () => {
    const agents = await jget(`${CFG.ocBase}/agent`, ocHeaders);
    o.agents = redact(agents);
    const list = Array.isArray(agents) ? agents : Object.values(agents || {});
    const byName = {};
    for (const a of list) byName[a.name] = a;
    const offenders = list.filter((a) =>
      a.mode !== "subagent" && a.model && a.model.providerID !== undefined
        ? `${a.model.providerID}/${a.model.modelID}` !== CFG.parentModel &&
          !`${a.model.providerID}/${a.model.modelID}`.startsWith("ninfer/")
        : a.model && typeof a.model === "string" && !a.model.startsWith("ninfer/"));
    const scouts = ["scout-mimo", "scout-nim", "scout-local"]
      .filter((s) => !byName[s]);
    let status = "pass", note = "";
    if (offenders.length) { status = "fail";
      note = "PRIMARY agent on a non-local model: " +
        offenders.map((a) => `${a.name} → ${JSON.stringify(a.model)}`).join("; "); }
    else if (scouts.length) { status = "warn"; note = `missing scouts: ${scouts.join(", ")}`; }
    else note = "build/plan on local Qwen, all scouts present, no remote primaries";
    return { status, expected: `all primaries = ${CFG.parentModel}, 3 scouts`, got: `${list.length} agents`, note };
  });
  await check("opencode", "config — provider allowlist", async () => {
    const c = await jget(`${CFG.ocBase}/config`, ocHeaders);
    o.configKeys = Object.keys(c || {});
    const model = c && c.model;
    const en = (c && c.enabled_providers) || null;
    o.model = model; o.enabledProviders = en;
    const extra = Array.isArray(en) ? en.filter((p) => !CFG.allowedProviders.includes(p)) : [];
    const okModel = model === CFG.parentModel;
    return { status: okModel && !extra.length ? "pass" : "fail",
      expected: `model=${CFG.parentModel}, providers ⊆ ${CFG.allowedProviders.join("/")}`,
      got: `model=${model}, enabled=${Array.isArray(en) ? en.join("/") : "(default)"}`,
      note: extra.length ? `unexpected providers: ${extra.join(", ")}` : "" };
  });
  await check("opencode", "SSE /event — 8s sample", async () => {
    const ctrl = new AbortController();
    const kinds = {}; const samples = [];
    try {
      const r = await fetch(`${CFG.ocBase}/event`, { headers: ocHeaders, signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error(`/event ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        // Race the read against a tick so a silent stream can't block past the
        // deadline (a hard abort here would throw away the whole tally).
        const step = await Promise.race([
          reader.read(),
          new Promise((res) => setTimeout(() => res("tick"), 1000)),
        ]);
        if (step === "tick") continue;
        if (step.done) break;
        buf += dec.decode(step.value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(line.slice(5).trim());
              kinds[ev.type] = (kinds[ev.type] || 0) + 1;
              if (samples.length < 3) samples.push(redact(ev));
            } catch { /* partial frame at cutoff */ }
          }
        }
      }
    } catch (e) {
      if (!/abort/i.test(String((e && e.name) || e))) throw e; // real error, not our cutoff
    } finally {
      try { ctrl.abort(); } catch { /* already closed */ }
    }
    o.eventKinds = kinds; o.eventSamples = samples;
    const total = Object.values(kinds).reduce((a, x) => a + x, 0);
    return { status: total > 0 ? "pass" : "warn", expected: "events flowing",
      got: `${total} events / 8s — ${Object.keys(kinds).slice(0, 8).join(", ") || "none (idle server?)"}` };
  });
}

async function sectionDashboard() {
  const d = raw.dashboard = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let snap = null;
  await check("dashboard", "page + snapshot", async () => {
    const page = await tget(`${CFG.dashBase}/`, 4000);
    snap = await jget(`${CFG.dashBase}/snapshot`, {}, 4000).catch(() => null);
    if (!page.ok || !snap) return { status: "warn", got: `page ${page.status}, snapshot ${snap ? "ok" : "down"}`,
      note: "start it: node dashboard/dashboard.js" };
    return { status: "pass", got: `rateSource=${snap.ninfer.rateSource}, oc=${snap.oc.up}, quota=${snap.quota.present}` };
  });
  await check("dashboard", "charts track live traffic", async () => {
    if (!snap) return { status: "warn", got: "no snapshot" };
    const before = { pp: snap.ninfer.ppSeries.length, tg: snap.ninfer.tgSeries.length };
    // ninfer prints throughput lines on a ~5s grid — poll until the series
    // grows (≤14s), which proves the whole pipeline: logs → parser → series.
    for (let i = 0; i < 7; i++) {
      await sleep(2000);
      snap = await jget(`${CFG.dashBase}/snapshot`, {}, 4000).catch(() => null);
      if (!snap) break;
      const after = { pp: snap.ninfer.ppSeries.length, tg: snap.ninfer.tgSeries.length };
      if (after.pp > before.pp || after.tg > before.tg) {
        d.feed = { before, after };
        return { status: "pass", expected: "pp/tg series grows over time",
          got: `pp ${before.pp}→${after.pp}, tg ${before.tg}→${after.tg}` };
      }
    }
    const after = snap ? { pp: snap.ninfer.ppSeries.length, tg: snap.ninfer.tgSeries.length } : before;
    d.feed = { before, after };
    return { status: "fail", expected: "pp/tg series grows over time",
      got: `pp ${before.pp}→${after.pp}, tg ${before.tg}→${after.tg} in 14s`,
      note: "feed not moving — check docker-logs attach (or /metrics//slots fallbacks)" };
  });
}

async function sectionQuota() {
  const q = raw.quota = {};
  await check("quota", "zen-budget.sh --kv", async () => {
    const r = await new Promise((resolve) => {
      execFile(CFG.zenBudget, ["--kv"], { timeout: 5000 },
        (err, stdout, stderr) => resolve({ err: err ? String(err.message) : null,
          out: String(stdout || "").trim(), stderr: String(stderr || "").trim() }));
    });
    if (r.err) return { status: "warn", got: r.err, note: "guard absent → ledger defaults to protocol" };
    const kv = {};
    for (const m of r.out.matchAll(/([a-z]+)\s*=\s*(-?\d+)/g)) kv[m[1]] = parseInt(m[2], 10);
    q.kv = kv;
    const hold = kv.zbudget != null && kv.zused != null && kv.zused < kv.zbudget;
    return { status: hold ? "pass" : "fail",
      expected: "zused < zbudget (25% reserve intact)", got: r.out,
      note: kv.ztrips > 0 ? "MiMo tripped 429 today — dead for the day per protocol" : "" };
  });
}

async function sectionScouts() {
  if (!CFG.scouts) {
    await check("scouts", "live scout ping", () => ({ status: "info",
      note: "skipped — run with --scouts to include (costs ~1 MiMo + ~1 NIM call)" }));
    return;
  }
  const pings = [["scout-local", null], ["scout-mimo", null], ["scout-nim", null]];
  for (const [agent] of pings) {
    await check("scouts", `ping ${agent}`, async () => {
      const t0 = Date.now();
      const r = await new Promise((resolve) => {
        execFile("opencode", ["run", "--agent", agent,
          "Reply with exactly: ok"], { timeout: 120000 },
          (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ""), stderr: String(stderr || "") }));
      });
      const ms = Date.now() - t0;
      (raw.scouts ||= {})[agent] = { ms, out: r.stdout.slice(0, 200) };
      if (r.err) return { status: "fail", got: r.stderr.slice(0, 200) || String(r.err.message) };
      return { status: /ok/i.test(r.stdout) ? "pass" : "warn",
        got: `${ms}ms — ${r.stdout.slice(0, 80).replace(/\n/g, " ")}` };
    });
  }
}

// --------------------------------------------------------------- report ----

function writeReport() {
  const dir = path.join(__dirname, "..", "reports");
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const json = { generatedAt: new Date().toISOString(), cfg: { ocBase: CFG.ocBase,
    nBase: CFG.nBase, dashBase: CFG.dashBase, scouts: CFG.scouts }, results, raw };
  fs.writeFileSync(path.join(dir, `bug-report-${ts}.json`), JSON.stringify(json, null, 2));

  const icon = { pass: "✓", fail: "✗", warn: "⚠", info: "·" };
  const fails = results.filter((r) => r.status === "fail");
  const warns = results.filter((r) => r.status === "warn");
  let md = `# Bug report — ${json.generatedAt}\n\n`;
  md += `**Verdict:** ${fails.length ? `${fails.length} FAILURE(S)` : "no failures"}` +
        `${warns.length ? `, ${warns.length} warning(s)` : ""}\n\n`;
  if (fails.length) md += `## Failures\n` + fails.map((r) =>
    `- **${r.section}/${r.name}** — expected \`${r.expected}\`, got \`${r.got}\`${r.note ? ` — ${r.note}` : ""}`).join("\n") + "\n\n";
  let sec = "";
  for (const r of results) {
    if (r.section !== sec) { sec = r.section; md += `\n## ${sec}\n\n`; }
    md += `- ${icon[r.status] || "·"} **${r.name}** — ${r.got ?? ""}` +
      (r.expected ? ` _(expected: ${r.expected})_` : "") + (r.note ? ` — ${r.note}` : "") + "\n";
  }
  md += `\n---\nAttach BOTH this file and the matching .json when reporting back.\n`;
  const mdPath = path.join(dir, `bug-report-${ts}.md`);
  fs.writeFileSync(mdPath, md);

  console.log(`\n${md}`);
  console.log(`report written:\n  ${mdPath}\n  ${path.join(dir, `bug-report-${ts}.json`)}`);
  process.exitCode = fails.length ? 1 : 0;
}

// ---------------------------------------------------------------- main -----

(async () => {
  console.log("qwen-parent deployment benchmark — this takes ~1 minute\n");
  await sectionEnv();

  await sectionNinfer();
  await sectionBench();
  await sectionOpencode();
  await sectionDashboard();
  await sectionQuota();
  await sectionScouts();
  writeReport();
})();
