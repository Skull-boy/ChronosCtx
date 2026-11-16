// Phase 0 / gate 0.1 alternative mechanism + K1 — manifest store vs git.
//
// K1 (warm checkpoint p95 @2k ≤ 60 ms) is a budget for *a* snapshot mechanism,
// not necessarily for `git add -A`. This file implements the §4.4.7 manifest
// store — sorted path → {size, mtime, sha256, mode} plus content-addressed blobs
// — in Node, and measures the same series as the git recipe so the comparison is
// like-for-like on the same fixture, host, and mutation pattern.
//
// It also measures manifest restore (the rewind half) for K7.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { arg, now, summarize, writeJson } from "./lib/stats.mjs";
import { defaultRoot } from "./lib/gitenv.mjs";
import { genRepo, mutate, filePathFor } from "./lib/fstree.mjs";

const FILES = Number(arg("files", 2000));
const ITERS = Number(arg("iters", 30));
const OUT = arg("out", `bench/results/${process.platform}-${FILES}-manifest.json`);

const root = path.join(defaultRoot(), `mf-${FILES}`);
const ws = path.join(root, "ws");
const store = path.join(root, "store");
const gen = genRepo(ws, { files: FILES });
fs.rmSync(store, { recursive: true, force: true });
fs.mkdirSync(path.join(store, "blobs"), { recursive: true });
fs.mkdirSync(path.join(store, "manifests"), { recursive: true });

/** Depth-first walk, sorted, never descending into the object store or .git. */
function walk(dir, base = "", out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.name === ".git" || e.name === ".chronos") continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs, rel, out);
    else out.push(rel);
  }
  return out;
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

function checkpoint(prev) {
  const t0 = now();
  const paths = walk(ws);
  const walkMs = now() - t0;

  const t1 = now();
  const next = new Map();
  let hashed = 0, reused = 0, bytes = 0, blobsWritten = 0;
  for (const rel of paths) {
    const abs = path.join(ws, rel);
    const st = fs.lstatSync(abs);
    const before = prev?.get(rel);
    // mtime + size is git's own stat-cache heuristic; content is authoritative.
    if (before && before.size === st.size && before.mtimeMs === st.mtimeMs) {
      next.set(rel, before);
      reused++;
      continue;
    }
    const buf = fs.readFileSync(abs);
    const hash = sha256(buf);
    bytes += buf.length;
    hashed++;
    if (!fs.existsSync(path.join(store, "blobs", hash))) {
      fs.writeFileSync(path.join(store, "blobs", hash), buf);
      blobsWritten++;
    }
    next.set(rel, { size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, hash });
  }
  const statHashMs = now() - t1;

  const t2 = now();
  const lines = [...next.entries()].map(([p, e]) => `${p}\0${e.size}\0${e.mtimeMs}\0${e.mode}\0${e.hash}`);
  const body = lines.join("\n") + "\n";
  const id = sha256(Buffer.from(body, "utf8"));
  const file = path.join(store, "manifests", `${id}.mf`);
  fs.writeFileSync(file, body);
  const writeMs = now() - t2;

  return { total: now() - t0, id, map: next, walkMs, statHashMs, writeMs, hashed, reused, bytes, blobsWritten, file };
}

/** Restore: delete absent, materialize changed, verify a 32-file sample. */
function restore(prev, target, sampleSize = 32) {
  const t0 = now();
  const deleted = [], written = [];
  for (const rel of prev.keys()) {
    if (target.has(rel)) continue;
    try { fs.unlinkSync(path.join(ws, rel)); deleted.push(rel); } catch { /* gone */ }
  }
  for (const [rel, e] of target) {
    const abs = path.join(ws, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* absent */ }
    // Trust the recorded stat when it matches — the same heuristic git uses for
    // its index, and the reason a warm restore is O(changed), not O(tree).
    if (st && st.isFile() && st.size === e.size && Math.floor(st.mtimeMs) === Math.floor(e.mtimeMs)) continue;
    const blob = path.join(store, "blobs", e.hash);
    const buf = fs.readFileSync(blob);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf);
    written.push(rel);
  }
  const fsMs = now() - t0;

  // §4.4.4 step 8 equivalent: sample verification, not a full-tree rehash.
  const t1 = now();
  const entries = [...target.entries()];
  const step = Math.max(1, Math.floor(entries.length / sampleSize));
  let bad = null, sampled = 0;
  for (let i = 0; i < entries.length && sampled < sampleSize; i += step, sampled++) {
    const [rel, e] = entries[i];
    const buf = fs.readFileSync(path.join(ws, rel));
    if (buf.length !== e.size || sha256(buf) !== e.hash) { bad = rel; break; }
  }
  return { total: now() - t0, fsMs, verifyMs: now() - t1, deleted: deleted.length, written: written.length, sampled, ok: !bad, bad };
}

/** One-time full verification, reported but outside the timed series. */
function verifyFull(target) {
  const t0 = now();
  let bad = null;
  for (const [rel, e] of target) {
    const buf = fs.readFileSync(path.join(ws, rel));
    if (buf.length !== e.size || sha256(buf) !== e.hash) { bad = rel; break; }
  }
  return { ms: now() - t0, ok: !bad, bad };
}

/**
 * Incremental checkpoint: the caller already knows which paths changed (a file
 * watcher, or a git-diff from the user's repo). No full walk, so cost is
 * O(changed) rather than O(tree). This is the only shape that can meet
 * a 60 ms p95 at 2k files on either OS.
 */
function checkpointIncremental(prev, changedPaths) {
  const t0 = now();
  const next = new Map(prev);
  let hashed = 0, bytes = 0, deleted = 0, blobsWritten = 0;
  for (const rel of changedPaths) {
    const abs = path.join(ws, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { st = null; }
    if (!st) { if (next.delete(rel)) deleted++; continue; }
    const buf = fs.readFileSync(abs);
    const hash = sha256(buf);
    bytes += buf.length;
    hashed++;
    if (!fs.existsSync(path.join(store, "blobs", hash))) {
      fs.writeFileSync(path.join(store, "blobs", hash), buf);
      blobsWritten++;
    }
    next.set(rel, { size: st.size, mtimeMs: st.mtimeMs, mode: st.mode & 0o777, hash });
  }
  const t1 = now();
  const lines = [...next.entries()].map(([p, e]) => `${p}\0${e.size}\0${e.mtimeMs}\0${e.mode}\0${e.hash}`);
  const body = lines.join("\n") + "\n";
  const id = sha256(Buffer.from(body, "utf8"));
  fs.writeFileSync(path.join(store, "manifests", `${id}.mf`), body);
  const writeMs = now() - t1;
  return { total: now() - t0, id, map: next, hashed, deleted, bytes, blobsWritten, writeMs };
}
// ── series, mirroring bench/checkpoint.mjs exactly ─────────────────────────
function series(label, { mut }) {
  // In production a previous manifest always exists, so "warm" reuses it and
  // only stats. The one-time full hash is measured separately as `prime`.
  const prime = checkpoint(null);
  let prev = prime;
  const samples = [], hashed = [], walkMs = [], writeMs = [];
  for (let i = 0; i < ITERS; i++) {
    if (mut > 0) mutate(ws, mut, 1000 + i, FILES);
    const r = checkpoint(prev.map);
    prev = r;
    samples.push(r.total); hashed.push(r.hashed); walkMs.push(r.walkMs); writeMs.push(r.writeMs);
  }
  return {
    label,
    mutatedFilesPerIteration: mut,
    primeMs: prime.total,
    primeFilesHashed: prime.hashed,
    total: summarize(`${label}:total`, samples),
    filesHashed: summarize(`${label}:hashed`, hashed),
    walk: summarize(`${label}:walk`, walkMs),
    manifestWrite: summarize(`${label}:write`, writeMs),
  };
}

const results = [];
results.push(series("manifest warm, 10 edits", { mut: 10 }));
console.log("[manifest] warm10", results.at(-1).total.p95.toFixed(1), "ms p95");
results.push(series("manifest warm, 0 edits", { mut: 0 }));
console.log("[manifest] warm0", results.at(-1).total.p95.toFixed(1), "ms p95");

// ── incremental: watcher supplies the changed set, no full walk ────────────
const incremental = (() => {
  let prev = checkpoint(null);
  const samples = [], hashed = [];
  for (let i = 0; i < ITERS; i++) {
    const salt = 50000 + i;
    const changed = [];
    for (let j = 0; j < 10; j++) changed.push(filePathFor((j * 13 + salt * 7) % FILES));
    mutate(ws, 10, salt, FILES);
    const r = checkpointIncremental(prev.map, changed);
    prev = r;
    samples.push(r.total);
    hashed.push(r.hashed);
  }
  return {
    label: "incremental (watcher-supplied changed set, 10 edits)",
    mutatedFilesPerIteration: 10,
    total: summarize("manifest incremental", samples),
    filesHashed: summarize("manifest incremental:hashed", hashed),
    note: "O(changed): no readdir, no lstat of unchanged files",
  };
})();
console.log("[manifest] incremental", incremental.total.p95.toFixed(2), "ms p95");

// ── restore cost (K7 comparison) ───────────────────────────────────────────
const base0 = checkpoint(null);
mutate(ws, 60, 7, FILES);
const base = { map: base0.map };
const dirty = checkpoint(base.map);
const rSamples = [];
let state = dirty;
for (let i = 0; i < ITERS; i++) {
  const target = state === dirty ? base : dirty;
  const r = restore(state.map, target.map);
  if (!r.ok) throw new Error(`manifest restore verify failed at ${r.bad}`);
  rSamples.push(r.total);
  state = target;
}
const fullVerify = verifyFull(state.map);
const restoreSeries = {
  label: "manifest restore (alternating)",
  iterations: ITERS,
  total: summarize("manifest restore", rSamples),
  changedPathsPerRestore: 60,
  sampledPerRestore: 32,
  fullVerifyMs: fullVerify.ms,
  fullVerifyOk: fullVerify.ok,
};
console.log("[manifest] restore", restoreSeries.total.p95.toFixed(1), "ms p95");

const blobCount = fs.readdirSync(path.join(store, "blobs")).length;
const blobBytes = fs.readdirSync(path.join(store, "blobs")).reduce((a, f) => a + fs.statSync(path.join(store, "blobs", f)).size, 0);

writeJson(OUT, {
  gate: "0.1/K1 (alternative mechanism)",
  title: "Manifest store: checkpoint and restore cost",
  mechanism: "§4.4.7 manifest: sorted path → {size, mtime, sha256, mode} + content-addressed blobs (raw, uncompressed)",
  files: FILES,
  platform: process.platform,
  host: os.hostname(),
  cpus: os.cpus().length,
  cpu: os.cpus()[0]?.model?.trim() ?? "unknown",
  os: os.version(),
  node: process.version,
  fixtureBuildMs: gen.buildMs,
  iterations: ITERS,
  series: results,
  incremental,
  restore: restoreSeries,
  dedupe: { blobs: blobCount, bytes: blobBytes, distinctFiles: FILES + 60 },
});
console.log("[manifest] wrote", OUT);
