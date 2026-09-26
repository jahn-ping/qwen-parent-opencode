#!/usr/bin/env node
// dashboard.js v2 — live observability bridge for the Qwen-parent hierarchy.
//
// AUTO-DISCOVERY: watches EVERY opencode server on this box — the desktop
// app's random-port server, any pinned-port TUI, headless runs — by scanning
// listening sockets for opencode processes and reading their environment for
// the server password. No pinned port or TUI required: work in any session,
// the dashboard follows it. (OC_PORT env still pins an extra server if set.)
//
// Also watches ninfer telemetry on :8080 (rates parsed from the container's
// own throughput logs — this fork has no /metrics or /slots), plus the
// zen-budget quota guard. Serves one browser page.
//
// Zero npm dependencies. Node >= 18. Sources degrade independently.
//
// Env overrides:
//   OC_PORT                extra/pinned opencode server port (optional now)
//   NINFER_HOST/NINFER_PORT  ninfer server (default 127.0.0.1:8080)
//   DASH_PORT/DASH_HOST    this dashboard (default 8787, bound to 127.0.0.1)
//   ZEN_BUDGET             path to quota script (default ~/scripts/zen-budget.sh)
//   NINFER_CONTAINER       container name for docker logs (default: auto-find)
//   NINFER_LOGS=off        disable the docker-logs engine feed

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile, spawn } = require("node:child_process");

const CFG = {
  pinOcPort: process.env.OC_PORT || null,
  nHost: process.env.NINFER_HOST || "127.0.0.1",
  nPort: process.env.NINFER_PORT || "8080",
  dashPort: parseInt(process.env.DASH_PORT || "8787", 10),
  dashHost: process.env.DASH_HOST || "127.0.0.1",
  zenBudget: process.env.ZEN_BUDGET ||
    path.join(os.homedir(), "scripts", "zen-budget.sh"),
};

const nBase = `http://${CFG.nHost}:${CFG.nPort}`;

// ---------------------------------------------------------------- state ----

const MAX_SAMPLES = 900; // 1 Hz * 15 min
const state = {
  // discovered opencode servers: port -> {port, name, pid, pass, up, sessions}
  servers: new Map(),
  oc: { up: false, tree: [], tails: {}, statuses: {}, tokens: null },
  ninfer: {
    up: false, metricsPrefix: null, slots: [],
    ppSeries: [], tgSeries: [], ttftSeries: [], mtpSeries: [],
    pp: 0, tg: 0, ttft: null, mtp: null,
    processing: null, deferred: null,
    counters: null, slotPrev: {}, lastT: 0,
    busyPrev: null, queuePrev: null,
  },
  quota: { present: false, raw: null, kv: null, ts: 0 },
  events: [],
  englog: [],
  dockerLogs: false,
};

const clients = new Set();

function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) {
    try { res.write(line); } catch { /* dropped client */ }
  }
}

async function jfetch(url, headers = {}, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.json();
  } finally { clearTimeout(timer); }
}

// --------------------------------------------------- opencode discovery ----

// Scan listening sockets for opencode-owned ports; read each owner's
// environment for the server password (works for anything this user runs,
// including the desktop app and its spawned servers).
function discoverServers() {
  execFile("ss", ["-tlnp"], { timeout: 6000 }, (err, out) => {
    if (err) return;
    const found = new Map(); // port -> {pid, name}
    for (const line of String(out).split("\n")) {
      const pm = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
      if (!pm) continue;
      const [, name, pid] = pm;
      if (!/opencode/i.test(name)) continue;
      const lm = line.match(/(?:127\.0\.0\.1|\[::1\]|0\.0\.0\.0|\[::\]):(\d+)\s/);
      if (!lm) continue;
      const port = parseInt(lm[1], 10);
      if (port === CFG.dashPort || port === 631) continue;
      found.set(port, { pid: parseInt(pid, 10), name });
    }
    if (CFG.pinOcPort && !found.has(String(CFG.pinOcPort))) {
      found.set(String(CFG.pinOcPort), { pid: null, name: "pinned" });
    }
    // drop servers that stopped listening
    for (const [port, srv] of state.servers) {
      if (!found.has(String(port)) && String(port) !== String(CFG.pinOcPort)) {
        state.servers.delete(port);
        engLog(`opencode server :${port} gone — dropped from watch list`, "warn");
      }
    }
    // add new ones
    for (const [portStr, info] of found) {
      const port = parseInt(portStr, 10);
      if (state.servers.has(port)) {
        Object.assign(state.servers.get(port), { name: info.name, pid: info.pid });
        continue;
      }
      const pass = info.pid ? readEnvironPassword(info.pid) : null;
      const srv = { port, name: info.name, pass, up: false, sessions: 0 };
      state.servers.set(port, srv);
      startServerWatch(srv);
      engLog(`discovered opencode server :${port} (${info.name})` +
        (pass ? " [password from env]" : ""), "ok");
    }
  });
}

function readEnvironPassword(pid) {
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`);
    for (const kv of env.toString().split("\0")) {
      const m = kv.match(/^OPENCODE_SERVER_PASSWORD=(.+)$/);
      if (m) return m[1];
    }
  } catch { /* not ours / gone */ }
  return null;
}

function headersFor(srv) {
  const h = {};
  if (srv.pass) {
    h.Authorization = "Basic " +
      Buffer.from(`opencode:${srv.pass}`).toString("base64");
  }
  return h;
}

// per-server event pump + liveness
function startServerWatch(srv) {
  const base = `http://127.0.0.1:${srv.port}`;
  const watch = async () => {
    try {
      const r = await fetch(`${base}/event`, { headers: headersFor(srv) });
      if (!r.ok || !r.body) throw new Error(String(r.status));
      srv.up = true;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("closed");
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let ev; try { ev = JSON.parse(payload); } catch { continue; }
            forwardEvent(srv, ev);
          }
        }
      }
    } catch {
      srv.up = false;
      setTimeout(watch, 5000);
    }
  };
  watch();
}

const COALESCE_MS = 1500;
const coalesce = new Map();

function extractText(p) {
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

function forwardEvent(srv, ev) {
  const kind = ev.type || "?";
  const p = ev.properties || {};
  const text = extractText(p);
  const summary = summarizeEvent(ev);
  const sid = p.sessionID || "";

  if (kind.startsWith("message.")) {
    const key = `${srv.port}|${sid}|${kind}`;
    const now = Date.now();
    const last = coalesce.get(key) || 0;
    const terminal = kind.includes("finished") || kind.includes("error") ||
      kind.includes("aborted");
    if (!terminal && now - last < COALESCE_MS) return;
    coalesce.set(key, now);
  }
  const rec = { t: Date.now(), kind, summary, srv: srv.port,
    text: text ? String(text).slice(-300) : null };
  state.events.push(rec);
  if (state.events.length > 400) state.events.splice(0, state.events.length - 400);
  broadcast({ type: "oc-event", ev: rec });
}

function tailFromMessages(msgs) {
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
  let anyUp = false;
  const allSessions = []; // each tagged with its server port
  const statuses = {};

  for (const srv of state.servers.values()) {
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      const [sessions, sts] = await Promise.all([
        jfetch(`${base}/session`, headersFor(srv)),
        jfetch(`${base}/session/status`, headersFor(srv)).catch(() => ({})),
      ]);
      srv.up = true; anyUp = true;
      srv.sessions = (sessions || []).length;
      for (const s of sessions || []) { s._srv = srv.port; allSessions.push(s); }
      for (const [k, v] of Object.entries(sts || {})) statuses[`${srv.port}:${k}`] = v;
    } catch {
      srv.up = false;
    }
  }
  state.oc.up = anyUp;
  if (!anyUp) { state.oc.tree = []; return; }

  // parent/child tree within each server
  const byKey = new Map();
  for (const s of allSessions) byKey.set(`${s._srv}:${s.id}`, s);
  const children = new Map();
  for (const s of allSessions) {
    if (s.parentID && byKey.has(`${s._srv}:${s.parentID}`)) {
      const k = `${s._srv}:${s.parentID}`;
      if (!children.has(k)) children.set(k, []);
      children.get(k).push(s);
    }
  }
  const tops = allSessions
    .filter((s) => !s.parentID || !byKey.has(`${s._srv}:${s.parentID}`))
    .sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    .slice(0, 8);
  state.oc.tree = tops.map((s) => ({
    id: s.id, srv: s._srv,
    title: s.title || "session",
    dir: (s.directory || "").replace(/^\/home\/[^/]+/, "~") || null,
    tokens: s.tokens ? { input: s.tokens.input, output: s.tokens.output,
      reasoning: s.tokens.reasoning } : null,
    updated: s.time?.updated || 0,
    children: (children.get(`${s._srv}:${s.id}`) || []).map((c) => ({
      id: c.id, srv: c._srv, title: c.title || "task",
      tokens: c.tokens ? { input: c.tokens.input, output: c.tokens.output,
        reasoning: c.tokens.reasoning } : null,
      updated: c.time?.updated || 0,
    })),
  }));

  // aggregate token totals across all sessions on all servers
  const agg = { input: 0, output: 0, reasoning: 0 };
  for (const s of allSessions) {
    agg.input += s.tokens?.input || 0;
    agg.output += s.tokens?.output || 0;
    agg.reasoning += s.tokens?.reasoning || 0;
  }
  state.oc.tokens = agg;

  // thinking/text tails for the most active sessions
  const active = allSessions
    .slice().sort((a, b) => (b.time?.updated || 0) - (a.time?.updated || 0))
    .slice(0, 8);
  const tails = {};
  await Promise.all(active.map(async (s) => {
    try {
      const srv = state.servers.get(s._srv);
      const msgs = await jfetch(
        `http://127.0.0.1:${s._srv}/session/${s.id}/message?limit=6`,
        headersFor(srv || { pass: null }));
      const tail = tailFromMessages(msgs || []);
      if (tail) tails[s.id] = {
        ...tail, agent: s.agent || s._srv,
        status: statuses[`${s._srv}:${s.id}`] || null,
        text: String(tail.text).slice(-1600),
      };
    } catch { /* gone mid-poll */ }
  }));
  state.oc.tails = tails;
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

function pushSeries(arr, v, now) {
  arr.push({ t: now, v });
  if (arr.length > MAX_SAMPLES) arr.shift();
}

// ninfer's own logs: periodic 5s throughput lines + per-request summaries.
const RE_THROUGHPUT = /throughput \| [\d.]+s \| (?:prefill ([\d.]+) tok\/s(?: \([\d,]+ tok\))? \| )?decode ([\d.]+) tok\/s(?: \([\d,]+ tok\))? \| running (\d+)/;
const RE_REQ_DONE = /req#\d+ done .*?TTFT (\d+) ms.*?decode ([\d.]+) tok\/s(?:.*?mtp accepted (\d+)\/(\d+) \(([\d.]+)%\))?/;

function handleNinferLine(l) {
  let m = l.match(RE_THROUGHPUT);
  if (m) {
    const now = Date.now();
    state.ninfer.pp = m[1] ? parseFloat(m[1]) : 0;
    state.ninfer.tg = parseFloat(m[2]);
    state.ninfer.processing = parseInt(m[3], 10);
    pushSeries(state.ninfer.ppSeries, state.ninfer.pp, now);
    pushSeries(state.ninfer.tgSeries, state.ninfer.tg, now);
    if (state.ninfer.rateSource !== "metrics" && state.ninfer.rateSource !== "slots")
      state.ninfer.rateSource = "docker-logs";
  }
  m = l.match(RE_REQ_DONE);
  if (m) {
    const now = Date.now();
    state.ninfer.ttft = parseInt(m[1], 10);
    state.ninfer.mtp = m[5] ? parseFloat(m[5]) : null;
    pushSeries(state.ninfer.ttftSeries, state.ninfer.ttft, now);
    if (m[5]) pushSeries(state.ninfer.mtpSeries, state.ninfer.mtp, now);
  }
}

function classifyDockerLine(l) {
  if (/\sW\s|warning/i.test(l)) return "warn";
  if (/\sE\s|error/i.test(l)) return "err";
  if (/throughput|req#\d+ done|tok\/s|tokens per second|print_timing|per token/i.test(l)) return "timing";
  return "";
}

function engLog(line, cls) {
  const rec = { t: Date.now(), line: String(line).slice(0, 300), cls: cls || "" };
  state.englog.push(rec);
  if (state.englog.length > 300) state.englog.shift();
  broadcast({ type: "eng", line: rec });
}

function startDockerLogs() {
  if (process.env.NINFER_LOGS === "off") return;
  if (state.dockerLogs || startDockerLogs.attaching) return;
  const pick = (name) => {
    if (!name || state.dockerLogs || startDockerLogs.attaching) return;
    startDockerLogs.attaching = true;
    const child = spawn("docker", ["logs", "-f", "--tail", "60", name],
      { stdio: ["ignore", "pipe", "pipe"] }); // ninfer logs to stderr — take both
    let buf = "";
    const onChunk = (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (l) { handleNinferLine(l); engLog(l, classifyDockerLine(l)); }
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", () => { /* no docker / no perms */ });
    child.on("close", () => {
      startDockerLogs.attaching = false;
      state.dockerLogs = false;
      if (state.ninfer.rateSource === "docker-logs") state.ninfer.rateSource = null;
      engLog("docker logs follower exited — reattaching in 5s", "warn");
      setTimeout(startDockerLogs, 5000);
    });
    const bye = () => { try { child.kill(); } catch { /* gone */ } };
    process.on("exit", bye); process.on("SIGTERM", bye); process.on("SIGINT", bye);
    state.dockerLogs = true;
    startDockerLogs.attaching = false;
    engLog(`attached: docker logs -f ${name}`, "ok");
  };
  const forced = process.env.NINFER_CONTAINER;
  if (forced) return pick(forced);
  execFile("docker", ["ps", "--format", "{{.Names}}"], { timeout: 5000 }, (err, stdout) => {
    if (err) return;
    const hit = String(stdout).split("\n").find((n) => /ninfer/i.test(n));
    if (hit) pick(hit.trim());
  });
}

async function ninferPoll() {
  const now = Date.now();
  const dt = state.ninfer.lastT ? (now - state.ninfer.lastT) / 1000 : 0;
  state.ninfer.lastT = now;

  let slotRate = null;
  try {
    const slots = await jfetch(`${nBase}/slots`, {}, 3000);
    state.ninfer.slots = Array.isArray(slots) ? slots : [];
    state.ninfer.up = true;
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
  } catch { /* /metrics off */ }

  const rate = metricsRate || slotRate;
  if (rate) {
    state.ninfer.pp = rate.pp;
    state.ninfer.tg = rate.tg;
    pushSeries(state.ninfer.ppSeries, rate.pp, now);
    pushSeries(state.ninfer.tgSeries, rate.tg, now);
  }
  if (metricsRate) state.ninfer.rateSource = "metrics";
  else if (slotRate) state.ninfer.rateSource = "slots";
  else if (state.ninfer.rateSource !== "docker-logs") state.ninfer.rateSource = null;

  // synthetic engine-log lines for transitions (docker feed covers the rest)
  const busy = state.ninfer.processing, queue = state.ninfer.deferred;
  if (rate && dt > 0.2 && (rate.pp > 1 || rate.tg > 1) && !state.dockerLogs)
    engLog(`slot print_timing: pp ${Math.round(rate.pp * dt)} tok @ ${rate.pp.toFixed(1)} t/s | tg ${Math.round(rate.tg * dt)} tok @ ${rate.tg.toFixed(1)} t/s`, "timing");
  if (busy != null && busy !== state.ninfer.busyPrev && !state.dockerLogs)
    engLog(`srv  slots: busy ${busy}/2${queue ? ` · queue ${queue}` : ""}`, "ok");
  state.ninfer.busyPrev = busy;
  state.ninfer.queuePrev = queue;
}

function pollQuota() {
  execFile(CFG.zenBudget, ["--kv"], { timeout: 5000 }, (err, stdout) => {
    if (err) { state.quota.present = false; return; }
    const kv = {};
    for (const m of String(stdout).matchAll(/([a-z]+)\s*=\s*(-?\d+)/g)) kv[m[1]] = parseInt(m[2], 10);
    state.quota = { present: true, raw: String(stdout).trim(), kv, ts: Date.now() };
  });
}

function publicCfg() {
  return {
    nBase, dashPort: CFG.dashPort,
    zenBudget: CFG.zenBudget,
    refs: { ppBand: [205, 614], tgBand: [27, 59], ttftBand: [120, 900] },
  };
}

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
    servers: [...state.servers.values()].map((s) => ({
      port: s.port, name: s.name, up: s.up, sessions: s.sessions })),
    oc: state.oc,
    ninfer: {
      up: state.ninfer.up, slots: state.ninfer.slots,
      metricsPrefix: state.ninfer.metricsPrefix, rateSource: state.ninfer.rateSource,
      pp: state.ninfer.pp, tg: state.ninfer.tg,
      ttft: state.ninfer.ttft, mtp: state.ninfer.mtp,
      processing: state.ninfer.processing, deferred: state.ninfer.deferred,
      ppSeries: state.ninfer.ppSeries, tgSeries: state.ninfer.tgSeries,
      ttftSeries: state.ninfer.ttftSeries, mtpSeries: state.ninfer.mtpSeries,
    },
    quota: state.quota,
    events: state.events.slice(-200),
    englog: state.englog.slice(-200),
    dockerLogs: state.dockerLogs,
  };
}

setInterval(() => broadcast({ type: "snapshot", data: snapshot() }), 1000);
setInterval(ocPoll, 2000);
setInterval(ninferPoll, 1000);
setInterval(discoverServers, 15000);

discoverServers();
ocPoll();
ninferPoll();
pollQuota();
setInterval(pollQuota, 30000);
startDockerLogs();

server.listen(CFG.dashPort, CFG.dashHost, () => {
  console.log(`qwen-parent dashboard v2 →  http://${CFG.dashHost === "0.0.0.0" ? require("node:os").hostname() : CFG.dashHost}:${CFG.dashPort}`);
  console.log(`opencode servers        →  auto-discovered (scans every 15s${CFG.pinOcPort ? `; pinned :${CFG.pinOcPort}` : ""})`);
  console.log(`ninfer telemetry        →  ${nBase} (rates from docker logs)`);
  console.log(`quota guard             →  ${CFG.zenBudget}`);
});
