// Phase 0 / gate 0.12 — the Tier-2 swap decision, measured instead of argued.
//
// Gate 0.12 adopts a swap only if (a) ≤ 10% latency regression on checkpoint,
// rewind, boot and p95 HTTP, (b) ≤ 5 engineer-days, (c) tests unchanged.
// This file supplies (a). (b) and (c) are recorded in ADR-0025 by hand.
//
// Everything is measured against the real library at the pinned version, in
// this process or a fresh child process where module-load cost matters.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { arg, writeJson, summarize, rng } from "./lib/stats.mjs";

const OUT = arg("out", `bench/results/${process.platform}-swap.json`);
const DEPS = path.join(process.cwd(), "bench", ".deps", "swap");
const results = { platform: process.platform, node: process.version, deps: {}, measurements: {} };

// ── ensure the candidate set is installed (throwaway, dev-only) ─────────────
const SPEC = ["fastify@5", "@fastify/cors@11", "pino@9", "execa@9", "picocolors@1", "@clack/prompts@0.10", "chokidar@4"];
if (!fs.existsSync(path.join(DEPS, "node_modules", "fastify"))) {
  fs.mkdirSync(DEPS, { recursive: true });
  fs.writeFileSync(path.join(DEPS, "package.json"), JSON.stringify({ name: "p0-swap", version: "0.0.0", private: true }, null, 2));
  // Windows needs a shell to spawn the npm .cmd shim (CVE-2024-27980 hardening).
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", ...SPEC],
    { cwd: DEPS, encoding: "utf8", windowsHide: true, timeout: 600000, shell: process.platform === "win32" });
  if (r.error) throw new Error(`swap deps install failed: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`swap deps install failed (${r.status}): ${(r.stderr || r.stdout || "").slice(0, 600)}`);
}
const requireFromDeps = createRequire(path.join(DEPS, "index.cjs"));
async function load(name) {
  const resolved = requireFromDeps.resolve(name);
  return import(pathToFileURL(resolved).href);
}
for (const name of ["fastify", "pino", "execa", "picocolors", "@clack/prompts", "chokidar"]) {
  results.deps[name] = JSON.parse(fs.readFileSync(path.join(DEPS, "node_modules", name, "package.json"), "utf8")).version;
}

const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]; };

// ── 1. process spawn: node:child_process vs execa ──────────────────────────
{
  const N = 30;
  const raw = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
    raw.push(performance.now() - t);
    if (r.status !== 0) throw new Error("git --version failed");
  }
  const { execa } = await load("execa");
  const ex = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    const r = await execa("git", ["--version"]);
    ex.push(performance.now() - t);
    if (r.exitCode !== 0) throw new Error("execa git failed");
  }
  results.measurements.spawn = {
    note: "spawnSync vs execa for `git --version`; the checkpoint/rewind path spawns 2-4 of these",
    spawnSync: summarize("spawnSync", raw),
    execa: summarize("execa", ex),
    p50DeltaMs: pct(ex, 50) - pct(raw, 50),
    p50DeltaPct: (pct(ex, 50) / pct(raw, 50) - 1) * 100,
  };
  console.log(`[swap] spawn p50 spawnSync=${pct(raw, 50).toFixed(1)} execa=${pct(ex, 50).toFixed(1)} ms`);
}

// ── 2. HTTP: node:http + 9-route mini-router vs Fastify ─────────────────────
const newAgent = () => new http.Agent({ keepAlive: true, maxSockets: 8 });
let keepAlive = newAgent();

function httpRequest(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const req = http.request({ host: "127.0.0.1", port, method, path: urlPath, agent: keepAlive, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolve({ ms: performance.now() - t, status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) { req.write(body); req.end(); } else { req.end(); }
  });
}

async function benchHttp(port, n) {
  const samples = [];
  for (let i = 0; i < 20; i++) await httpRequest(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "context_page_in", arguments: { paths: ["backend/auth/jwt-spec"], max_tokens: 1200 } } }));
  for (let i = 0; i < n; i++) {
    const r = i % 4 === 0
      ? await httpRequest(port, "GET", "/health", null)
      : await httpRequest(port, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "context_page_in", arguments: { paths: ["backend/auth/jwt-spec"], max_tokens: 1200 } } }));
    if (r.status !== 200) throw new Error(`http ${r.status}`);
    samples.push(r.ms);
  }
  return samples;
}

{
  const N = Number(arg("http-iters", 300));
  // node:http implementation — the "swap" side.
  const nh = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/health") { res.end('{"ok":true}'); return; }
      if (req.method === "POST" && req.url === "/mcp") {
        let msg;
        try { msg = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { res.statusCode = 400; res.end('{"error":"PARSE"}'); return; }
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: { schema_version: 1, tokens: { content: 812, envelope: 41, schema: 27, total: 880 } } } }));
        return;
      }
      res.statusCode = 404; res.end('{"error":"NOT_FOUND"}');
    });
  });
  await new Promise((r) => nh.listen(0, "127.0.0.1", r));
  const nhPort = nh.address().port;
  const t0 = performance.now();
  const nhSamples = await benchHttp(nhPort, N);
  const nhTotal = performance.now() - t0;
  keepAlive.destroy(); keepAlive = newAgent();
  nh.closeAllConnections?.();
  await new Promise((r) => nh.close(r));

  // Fastify — identical routes, no JSON schema (schemas add compile cost once).
  const { default: Fastify } = await load("fastify");
  const app = Fastify({ logger: false, disableRequestLogging: true });
  app.get("/health", async () => ({ ok: true }));
  app.post("/mcp", async (req, reply) => {
    reply.header("content-type", "application/json");
    const msg = req.body ?? {};
    return { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }], structuredContent: { schema_version: 1, tokens: { content: 812, envelope: 41, schema: 27, total: 880 } } } };
  });
  const bootT = performance.now();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const fastifyBootMs = performance.now() - bootT;
  const fPort = Number(new URL(app.listeningOrigin).port);
  const fSamples = await benchHttp(fPort, N);
  keepAlive.destroy(); keepAlive = newAgent();
  app.server.closeAllConnections?.();
  await app.close();

  results.measurements.http = {
    note: `keep-alive client, ${N} requests, 1:4 GET /health : POST /mcp`,
    nodeHttp: { ...summarize("node:http", nhSamples), throughputRps: (N / nhTotal) * 1000 },
    fastify: { ...summarize("fastify", fSamples), bootMs: fastifyBootMs },
    p95DeltaMs: pct(fSamples, 95) - pct(nhSamples, 95),
    p95DeltaPct: (pct(fSamples, 95) / pct(nhSamples, 95) - 1) * 100,
  };
  console.log(`[swap] http p95 node:http=${pct(nhSamples, 95).toFixed(2)} fastify=${pct(fSamples, 95).toFixed(2)} ms`);
}

// ── 3. boot: module load time of each HTTP stack in a fresh process ────────
{
  const boots = { nodeHttp: [], fastify: [] };
  for (const impl of ["nodeHttp", "fastify"]) {
    for (let i = 0; i < 3; i++) {
      const r = spawnSync(process.execPath, [path.join("bench", "lib", "boot-probe.mjs"), impl], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, env: { ...process.env, P0_DEPS: DEPS } });
      if (r.status !== 0) throw new Error(`boot probe failed: ${r.stderr}`);
      boots[impl].push(JSON.parse(r.stdout.trim()).ms);
    }
  }
  results.measurements.boot = {
    note: "fresh `node` process: require/import + create server + listen, 3 reps, median reported",
    nodeHttp: summarize("node:http boot", boots.nodeHttp),
    fastify: summarize("fastify boot", boots.fastify),
    p50DeltaMs: pct(boots.fastify, 50) - pct(boots.nodeHttp, 50),
  };
  console.log(`[swap] boot p50 node:http=${pct(boots.nodeHttp, 50).toFixed(1)} fastify=${pct(boots.fastify, 50).toFixed(1)} ms`);
}

// ── 4. logging: pino vs ~50-line NDJSON writer ─────────────────────────────
{
  const N = 20000;
  const logFile = path.join(DEPS, "pino.ndjson");
  const { default: pino } = await load("pino");
  fs.rmSync(logFile, { force: true });
  const dest = pino.destination({ dest: logFile, sync: false });
  const log = pino({ level: "info", base: { pid: 1, host: "x" } }, dest);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) log.info({ op: "checkpoint", ms: 12.4, files: 2000, seq: i }, "checkpoint complete");
  await new Promise((r) => dest.flush ? dest.flush(r) : setImmediate(r));
  // pino destination has no flush callback on all versions; force a tick drain.
  await new Promise((r) => setTimeout(r, 100));
  const pinoMs = performance.now() - t0;
  const pinoBytes = fs.statSync(logFile).size;

  const ndFile = path.join(DEPS, "ndjson.log");
  fs.rmSync(ndFile, { force: true });
  const fd = fs.openSync(ndFile, "a");
  const buf = [];
  const t1 = performance.now();
  for (let i = 0; i < N; i++) {
    buf.push(JSON.stringify({ level: "info", time: 1763251200000 + i, pid: 1, host: "x", op: "checkpoint", ms: 12.4, files: 2000, seq: i, msg: "checkpoint complete" }));
    if (buf.length >= 256) { fs.writeSync(fd, buf.join("\n") + "\n"); buf.length = 0; }
  }
  if (buf.length) fs.writeSync(fd, buf.join("\n") + "\n");
  fs.fsyncSync(fd);
  const ndMs = performance.now() - t1;
  fs.closeSync(fd);
  const ndBytes = fs.statSync(ndFile).size;

  results.measurements.logging = {
    note: `${N} records; both async/batched; byte size is the honest cost of pino's extra fields`,
    records: N,
    pino: { ms: pinoMs, recordsPerSec: (N / pinoMs) * 1000, bytes: pinoBytes },
    ndjson: { ms: ndMs, recordsPerSec: (N / ndMs) * 1000, bytes: ndBytes },
    perRequestCostUs: { pino: (pinoMs / N) * 1000, ndjson: (ndMs / N) * 1000 },
  };
  console.log(`[swap] log ${N} rec pino=${pinoMs.toFixed(0)}ms ndjson=${ndMs.toFixed(0)}ms`);
}

// ── 5. colour: picocolors vs node:util.styleText ───────────────────────────
{
  const { styleText } = await import("node:util");
  const pc = (await load("picocolors")).default;
  const N = 100000;
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < N; i++) acc += pc.green("ok").length + pc.red("fail").length;
  const pcMs = performance.now() - t0;
  const t1 = performance.now();
  let acc2 = 0;
  for (let i = 0; i < N; i++) acc2 += styleText("green", "ok").length + styleText("red", "fail").length;
  const stMs = performance.now() - t1;
  results.measurements.colour = {
    iterations: N,
    picocolorsMs: pcMs,
    styleTextMs: stMs,
    note: "not on the p95 path; included because picocolors is a 1-package removal with zero semantic risk",
    sameOutput: acc === acc2,
  };
  console.log(`[swap] colour picocolors=${pcMs.toFixed(1)}ms styleText=${stMs.toFixed(1)}ms`);
}

// ── 6. file watch: recorded, not gated ─────────────────────────────────────
// chokidar vs fs.watch is a correctness question (atomic-rename handling), not a
// latency question, so it cannot be decided by a percentile. Recorded as N/A.
results.measurements.watch = {
  decision: "not gated by latency",
  reason: "chokidar's value is atomic-write/rename handling; §3.5.5 keeps it unless implementation cost exceeds 5 engineer-days",
};

writeJson(OUT, { gate: "0.12", title: "Tier-2 swap measurements", ...results });
console.log("[swap] wrote", OUT);
