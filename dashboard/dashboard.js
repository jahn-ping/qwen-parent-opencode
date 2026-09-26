#!/usr/bin/env node
// dashboard.js — live observability bridge for the Qwen-parent hierarchy.
//
// Watches the SAME opencode server the TUI talks to (launch the TUI with
// `opencode --hostname 127.0.0.1 --port 4096`), plus ninfer telemetry on :8080,
// plus the zen-budget quota guard, and serves one browser page on :8787.
//
// Zero npm dependencies. Node >= 18 (native fetch). All sources degrade
// gracefully: a source being down never kills the others.
//
// Env overrides:
//   OC_HOST/OC_PORT        opencode server (default 127.0.0.1:4096)
//   NINFER_HOST/NINFER_PORT  ninfer server (default 127.0.0.1:8080)
//   DASH_PORT              this dashboard (default 8787)
//   ZEN_BUDGET             path to quota script (default ~/scripts/zen-budget.sh)
//   OPENCODE_SERVER_PASSWORD  if the opencode server has basic auth set
//   OPENCODE_SERVER_USERNAME  (default "opencode")

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const CFG = {
  ocHost: process.env.OC_HOST || "127.0.0.1",
  ocPort: process.env.OC_PORT || "4096",
  nHost: process.env.NINFER_HOST || "127.0.0.1",
  nPort: process.env.NINFER_PORT || "8080",
  dashPort: parseInt(process.env.DASH_PORT || "8787", 10),
  zenBudget: process.env.ZEN_BUDGET ||
    path.join(os.homedir(), "scripts", "zen-budget.sh"),
};

const ocBase = `http://${CFG.ocHost}:${CFG.ocPort}`;
const nBase = `http://${CFG.nHost}:${CFG.nPort}`;

const ocHeaders = {};
if (process.env.OPENCODE_SERVER_PASSWORD) {
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  const tok = Buffer.from(`${user}:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64");
  ocHeaders.Authorization = `Basic ${tok}`;
}

// ---------------------------------------------------------------- state ----

const MAX_SAMPLES = 900; // 1 Hz * 15 min
const state = {
  oc: { up: false, sessions: {}, statuses: {}, tree: [], tails: {}, serverConnected: false },
  ninfer: {
    up: false, metricsPrefix: null, slots: [],
    ppSeries: [], tgSeries: [], // [{t, v}]
    pp: 0, tg: 0, processing: null, deferred: null,
    counters: null,     // last /metrics counters {prompt, predicted, t}
    slotPrev: {},       // per-lane last sample {task, prompt, decoded}
    lastT: 0,
  },
  quota: { present: false, raw: null, kv: null, ts: 0 },
  events: [], // ring buffer of forwarded opencode events {t, kind, summary, text}
};

const clients = new Set(); // browser SSE connections

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { /* dropped client, reaped on close */ }
  }
}

async function jfetch(url, opts = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------ opencode events ----

// message.updated fires on every streamed token — forwarding each one floods
// the ticker. High-frequency kinds are coalesced to one line per session per
// window; everything else (finished, error, session, permission…) passes now.
const COALESCE_MS = 1500;
const coalesce = new Map(); // key -> last-forwarded ts

function extractText(p) {
  // Shapes vary by version; look in the usual places for a text part.
  const part = p.part ||
    (p.snapshot && (p.snapshot.part ||
      (Array.isArray(p.snapshot.parts) && p.snapshot.parts[p.snapshot.parts.length - 1]))) ||
    (p.message && p.message.part);
  if (part && typeof part.text === "string") return part.text;
  if (typeof p.text === "string") return p.text;
  return null;
}

function summarizeEvent(ev) {
  const p = ev && ev.properties ? ev.properties : {};
  const bit = [];
  if (p.sessionID) bit.push(String(p.sessionID).slice(0, 8));
  if (p.agent) bit.push(p.agent);
  const model = p.model && typeof p.model === "object" ? p.model.modelID : p.model;
  if (model) bit.push(model);
  if (p.role) bit.push(p.role);
  const part = p.part || p.snapshot || p.message;
  if (part && part.type) bit.push(part.type);
  return bit.join(" ");
}

function rememberAndForward(ev) {
  const kind = ev.type || "?";
  const p = ev.properties || {};
  const text = extractText(p);
  const summary = summarizeEvent(ev);
  const sid = p.sessionID || "";

  if (kind.startsWith("message.")) {
    const key = `${sid}|${kind}`;
    const now = Date.now();
    const last = coalesce.get(key) || 0;
    const terminal = kind.includes("finished") || kind.includes("error") ||
      kind.includes("aborted");
    if (!terminal && now - last < COALESCE_MS) return; // coalesce the flood
    coalesce.set(key, now);
  }

  const rec = { t: Date.now(), kind, summary, text: text ? String(text).slice(-300) : null };
  state.events.push(rec);
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  broadcast({ type: "oc-event", ev: rec });
}

async function ocEventPump() {
  // Persistent SSE subscription to the opencode server's bus. One retry
  // loop; a failed connection just marks the source down and retries.
  for (;;) {
    try {
      const r = await fetch(`${ocBase}/event`, { headers: ocHeaders });
      if (!r.ok || !r.body) throw new Error(`event stream ${r.status}`);
      state.oc.up = true;
      state.oc.serverConnected = true;
      broadcast({ type: "hello", cfg: publicCfg() });
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("event stream closed");
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let ev;
            try { ev = JSON.parse(payload); } catch { continue; }
            rememberAndForward(ev);
          }
        }
      }
    } catch {
      state.oc.up = false;
      await new Promise((rj) => setTimeout(rj, 3000));
    }
  }
}

function tailFromMessages(msgs) {
  // msgs: [{info, parts}] newest-last (opencode returns chronological).
  // Return {label, text} from the newest reasoning or text part we can find.
  for (let i = msgs.length - 1; i >= 0; i--) {
    const parts = (msgs[i] && msgs[i].parts) || [];
    for (let j = parts.length - 1; j >= 0; j--) {
      const p = parts[j];
      if (p.type === "reasoning" && p.text) return { label: "thinking", text: p.text };
      if (p.type === "text" && p.text) return { label: "text", text: p.text };
      if (p.type === "tool" && p.tool) return { label: `tool:${p.tool}`, text: p.state || "" };
    }
  }
  return null;
}

async function ocPoll() {
  try {
    const [sessions, statuses] = await Promise.all([
      jfetch(`${ocBase}/session`, { headers: ocHeaders }),
      jfetch(`${ocBase}/session/status`, { headers: ocHeaders }),
    ]);
    state.oc.up = true;
    const byId = {};
    for (const s of sessions || []) byId[s.id] = s;
    state.oc.sessions = byId;
    state.oc.statuses = statuses || {};

    // tree: parent sessions first, children (task-tool subagent runs) under them
    const children = {};
    for (const s of sessions || []) {
      if (s.parentID && byId[s.parentID]) (children[s.parentID] ||= []).push(s);
    }
    state.oc.tree = (sessions || [])
      .filter((s) => !s.parentID || !byId[s.parentID])
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .slice(0, 6)
      .map((s) => ({
        id: s.id,
        title: s.title || "session",
        agent: s.agent || null,
        updated: s.time?.updated || 0,
        children: (children[s.id] || []).map((c) => ({
          id: c.id, title: c.title || "task", agent: c.agent || null,
          updated: c.time?.updated || 0,
        })),
      }));

    // tails for the most recently active sessions (bounded to keep it light)
    const active = (sessions || [])
      .slice()
      .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
      .slice(0, 8);
    const tails = {};
    await Promise.all(active.map(async (s) => {
      try {
        const msgs = await jfetch(`${ocBase}/session/${s.id}/message?limit=3`, { headers: ocHeaders });
        const tail = tailFromMessages(msgs || []);
        if (tail) tails[s.id] = {
          ...tail,
          agent: s.agent || null,
          status: (state.oc.statuses[s.id]) || null,
          text: String(tail.text).slice(-400),
        };
      } catch { /* session gone mid-poll */ }
    }));
    state.oc.tails = tails;
  } catch {
    state.oc.up = false;
  }
}

// --------------------------------------------------------- ninfer polls ----

function parsePrometheus(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_:]+)(\{[^}]*\})?\s+(-?[\d.eE+]+)/);
    if (m) out[m[1]] = parseFloat(m[3]);
  }
  return out;
}

async function ninferPoll() {
  const now = Date.now();
  const dt = state.ninfer.lastT ? (now - state.ninfer.lastT) / 1000 : 0;
  state.ninfer.lastT = now;

  let slotRate = null;
  try {
    // /slots is on by default in llama.cpp servers; shape per-slot objects.
    const slots = await jfetch(`${nBase}/slots`, {}, 3000);
    state.ninfer.slots = Array.isArray(slots) ? slots : [];
    state.ninfer.up = true;

    // Fallback rates from per-lane deltas — works WITHOUT /metrics, which is
    // exactly what we need while the container runs without --metrics.
    const prevMap = state.ninfer.slotPrev;
    const newPrev = {};
    let ppAcc = 0, tgAcc = 0, sawLane = false;
    for (const s of state.ninfer.slots) {
      const nPrompt = s.n_prompt_tokens_processed || 0;
      const nDec = (s.next_token && s.next_token[0] && s.next_token[0].n_decoded) || 0;
      const prev = prevMap[s.id];
      if (s.is_processing && prev && prev.task === s.id_task && dt > 0.2) {
        ppAcc += Math.max(0, nPrompt - prev.prompt);
        tgAcc += Math.max(0, nDec - prev.decoded);
        sawLane = true;
      }
      newPrev[s.id] = { task: s.id_task, prompt: nPrompt, decoded: nDec };
    }
    state.ninfer.slotPrev = newPrev;
    if (sawLane) slotRate = { pp: ppAcc / dt, tg: tgAcc / dt };
  } catch {
    state.ninfer.up = false;
  }

  let metricsRate = null;
  try {
    const r = await fetch(`${nBase}/metrics`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      const m = parsePrometheus(await r.text());
      const pfx = "llamacpp:prompt_tokens_total" in m ? "llamacpp:"
        : "llama_prompt_tokens_total" in m ? "llama_" : null;
      state.ninfer.metricsPrefix = pfx;
      if (pfx) {
        const prompt = m[`${pfx}prompt_tokens_total`];
        const predicted = m[`${pfx}tokens_predicted_total`] ?? m[`${pfx}predicted_tokens_total`];
        state.ninfer.processing = m[`${pfx}requests_processing`] ?? null;
        state.ninfer.deferred = m[`${pfx}requests_deferred`] ?? null;
        const prev = state.ninfer.counters;
        if (prev && typeof prompt === "number" && typeof predicted === "number" && dt > 0.2) {
          metricsRate = {
            pp: Math.max(0, (prompt - prev.prompt) / dt),
            tg: Math.max(0, (predicted - prev.predicted) / dt),
          };
        }
        state.ninfer.counters = { prompt, predicted, t: now };
      }
    }
  } catch {
    // /metrics disabled (--metrics flag) — slot-derived rates carry the charts
  }

  // Exact /metrics counters win; per-lane /slots deltas are the fallback.
  const rate = metricsRate || slotRate;
  if (rate) {
    state.ninfer.pp = rate.pp;
    state.ninfer.tg = rate.tg;
    state.ninfer.ppSeries.push({ t: now, v: rate.pp });
    state.ninfer.tgSeries.push({ t: now, v: rate.tg });
    if (state.ninfer.ppSeries.length > MAX_SAMPLES) state.ninfer.ppSeries.shift();
    if (state.ninfer.tgSeries.length > MAX_SAMPLES) state.ninfer.tgSeries.shift();
  }
  state.ninfer.rateSource = metricsRate ? "metrics" : (slotRate ? "slots" : null);
}

// ------------------------------------------------------------- quota ------

function pollQuota() {
  execFile(CFG.zenBudget, ["--kv"], { timeout: 5000 }, (err, stdout) => {
    if (err) {
      state.quota.present = false;
      return;
    }
    const kv = {};
    for (const m of String(stdout).matchAll(/([a-z]+)\s*=\s*(-?\d+)/g)) kv[m[1]] = parseInt(m[2], 10);
    state.quota = { present: true, raw: String(stdout).trim(), kv, ts: Date.now() };
  });
}

function publicCfg() {
  return {
    ocBase, nBase, dashPort: CFG.dashPort,
    zenBudget: CFG.zenBudget,
    refs: { ppBand: [205, 614], tgBand: [27, 59] }, // verified V100 reference bands
  };
}

// ------------------------------------------------------------ serving -----

const INDEX = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    fs.createReadStream(INDEX).pipe(res);
    return;
  }
  if (req.url === "/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ type: "hello", cfg: publicCfg() })}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }
  if (req.url === "/snapshot") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

function snapshot() {
  return {
    t: Date.now(),
    cfg: publicCfg(),
    oc: state.oc,
    ninfer: {
      up: state.ninfer.up, slots: state.ninfer.slots,
      metricsPrefix: state.ninfer.metricsPrefix,
      rateSource: state.ninfer.rateSource,
      pp: state.ninfer.pp, tg: state.ninfer.tg,
      processing: state.ninfer.processing, deferred: state.ninfer.deferred,
      ppSeries: state.ninfer.ppSeries, tgSeries: state.ninfer.tgSeries,
    },
    quota: state.quota,
    events: state.events.slice(-200),
  };
}

// Snapshots at 1 Hz keep the charts smooth; they carry the series too, so a
// freshly opened page is immediately full (no waiting to accumulate).
setInterval(() => broadcast({ type: "snapshot", data: snapshot() }), 1000);
setInterval(ocPoll, 2000);
setInterval(ninferPoll, 1000);

ocEventPump();
ocPoll();
ninferPoll();
pollQuota();
setInterval(pollQuota, 30000);

server.listen(CFG.dashPort, "127.0.0.1", () => {
  console.log(`qwen-parent dashboard  →  http://127.0.0.1:${CFG.dashPort}`);
  console.log(`opencode server        →  ${ocBase}   (TUI: opencode --hostname ${CFG.ocHost} --port ${CFG.ocPort})`);
  console.log(`ninfer telemetry       →  ${nBase}`);
  console.log(`quota guard            →  ${CFG.zenBudget}`);
});
