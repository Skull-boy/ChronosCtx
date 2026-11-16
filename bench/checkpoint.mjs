// Phase 0 / gate 0.1 + K1 + K2 — checkpoint cost on real trees, §4.4.3 recipe.
//
// Measures the recipe as written (4 spawns) AND a 2-spawn variant, plus the
// process-creation floor, because on Windows the spawn count can dominate the
// whole budget. Without the floor number a 60 ms gate is uninterpretable.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { arg, now, summarize, rssMB, writeJson } from "./lib/stats.mjs";
import { initShadow, makeEnv, git, defaultRoot, spawnCount, resetSpawns } from "./lib/gitenv.mjs";
import { genRepo, mutate } from "./lib/fstree.mjs";

const FILES = Number(arg("files", 2000));
const OUT = arg("out", `bench/results/${process.platform}-${FILES}.json`);
const ITERS = Number(arg("iters", FILES >= 20000 ? 20 : 30));
const STEPS = Number(arg("steps", 5)); // §4.4.3 has 5 steps; 4 excludes UI bookkeeping
const QUICK = Boolean(arg("quick", false));
const ISO = "2026-11-16T00:00:00Z";
let saltBase = 0;

const root = path.join(defaultRoot(), `cp-${FILES}`);
const ws = path.join(root, "ws");
const shadowDir = path.join(root, "shadow.git");
const indexFile = path.join(root, "shadow.index");

console.log(`[checkpoint] ${FILES} files on ${process.platform}`);
const gen = genRepo(ws, { files: FILES });
console.log(`[checkpoint] fixture: ${(gen.buildMs / 1000).toFixed(1)}s`);

function spawnFloor(env, n = 20) {
  const t = [];
  for (let i = 0; i < n; i++) t.push(git(["--version"], env).ms);
  return summarize("spawn-floor:git --version", t);
}

function cp4(env, parent, label, i) {
  resetSpawns();
  const t0 = now();
  const add = git(["add", "-A", "--", "."], env);
  const tree = git(["write-tree"], env);
  const commit = git(["commit-tree", tree.out, ...(parent ? ["-p", parent] : []), "-m", `p0 ${label} ${i}`], env);
  git(["update-ref", "refs/chronos/p0", commit.out], env);
  // §4.4.3 step 5: cheap bookkeeping for the UI (files changed per checkpoint).
  let book = null;
  if (STEPS >= 5) book = git(["diff-tree", "-r", "--numstat", parent ?? tree.out, tree.out], env, { allowFail: true });
  return { total: now() - t0, add: add.ms, tree: tree.out, commit: commit.out, bookMs: book?.ms ?? null, spawns: spawnCount(), rss: rssMB() };
}

function cp2(env, label, i) {
  resetSpawns();
  const t0 = now();
  const add = git(["add", "-A", "--", "."], env);
  const commit = git(["commit", "--quiet", "--no-verify", "--allow-empty", "-m", `p0 ${label} ${i}`], env);
  let book = null;
  if (STEPS >= 5) book = git(["diff-tree", "-r", "--numstat", "HEAD^", "HEAD"], env, { allowFail: true });
  return { total: now() - t0, add: add.ms, commit: "", bookMs: book?.ms ?? null, spawns: spawnCount(), rss: rssMB() };
}

function runSeries({ label, cold, mut, untrackedCache, variant, iters = ITERS }) {
  initShadow({ shadowDir, workTree: ws, untrackedCache });
  fs.rmSync(indexFile, { force: true });
  const env = makeEnv({ shadowDir, workTree: ws, indexFile, isoDate: ISO });
  if (variant === "2spawn") git(["symbolic-ref", "HEAD", "refs/chronos/p0"], env);
  const salt = ++saltBase * 1000;

  const prime = variant === "2spawn" ? cp2(env, "prime", 0) : cp4(env, null, "prime", 0);
  let parent = prime.commit;

  const samples = [], add = [], spawns = [], rss = [];
  for (let i = 0; i < iters; i++) {
    if (cold) fs.rmSync(indexFile, { force: true });
    if (mut > 0) mutate(ws, mut, salt + i, FILES);
    const r = variant === "2spawn" ? cp2(env, label, i) : cp4(env, parent, label, i);
    parent = r.commit;
    samples.push(r.total);
    add.push(r.add);
    spawns.push(r.spawns);
    rss.push(r.rss);
  }

  return {
    label,
    variant,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    git: git(["--version"], env).out,
    files: FILES,
    iterations: iters,
    coldIndex: cold,
    mutatedFilesPerIteration: mut,
    untrackedCache,
    initialCheckpointMs: prime.total,
    total: summarize(`${label}:total`, samples, { spawnsPerCheckpoint: spawns[0] ?? null, peakRssMB: Math.max(...rss) }),
    add: summarize(`${label}:add`, add),
    countObjects: git(["count-objects", "-v"], env, { allowFail: true }).out,
  };
}

const env0 = makeEnv({ shadowDir, workTree: ws, indexFile, isoDate: ISO });
initShadow({ shadowDir, workTree: ws, untrackedCache: true });
const floor = spawnFloor(env0);
console.log(`[checkpoint] spawn floor p50 ${floor.p50.toFixed(1)} ms`);

const series = [];
const small = FILES <= 5000;
series.push(runSeries({ label: "cold-index (4 spawns)", cold: true, mut: 0, untrackedCache: true, variant: "4spawn", iters: small ? ITERS : 10 }));
console.log("[checkpoint] cold-4 done", series.at(-1).total.p95.toFixed(1), "ms p95");
if (small && !QUICK) {
  series.push(runSeries({ label: "cold-index, utc off (4 spawns)", cold: true, mut: 0, untrackedCache: false, variant: "4spawn", iters: 15 }));
  console.log("[checkpoint] cold-utc-off done", series.at(-1).total.p95.toFixed(1), "ms p95");
}
series.push(runSeries({ label: "warm, 10 edits (4 spawns)", cold: false, mut: 10, untrackedCache: true, variant: "4spawn", iters: small ? ITERS : 10 }));
console.log("[checkpoint] warm10-4 done", series.at(-1).total.p95.toFixed(1), "ms p95");
if (!QUICK) {
  series.push(runSeries({ label: "warm, 0 edits (4 spawns)", cold: false, mut: 0, untrackedCache: true, variant: "4spawn", iters: small ? ITERS : 10 }));
  console.log("[checkpoint] warm0-4 done", series.at(-1).total.p95.toFixed(1), "ms p95");
  series.push(runSeries({ label: "warm, 10 edits (2 spawns)", cold: false, mut: 10, untrackedCache: true, variant: "2spawn", iters: small ? ITERS : 10 }));
  console.log("[checkpoint] warm10-2 done", series.at(-1).total.p95.toFixed(1), "ms p95");
  series.push(runSeries({ label: "warm, 0 edits (2 spawns)", cold: false, mut: 0, untrackedCache: true, variant: "2spawn", iters: small ? ITERS : 10 }));
  console.log("[checkpoint] warm0-2 done", series.at(-1).total.p95.toFixed(1), "ms p95");
}

writeJson(OUT, {
  gate: "0.1",
  title: "Checkpoint cost on real trees",
  files: FILES,
  platform: process.platform,
  host: os.hostname(),
  cpus: os.cpus().length,
  cpu: os.cpus()[0]?.model?.trim() ?? "unknown",
  os: os.version(),
  node: process.version,
  git: floor.out ?? undefined,
  fixtureBuildMs: gen.buildMs,
  recipe4: "git add -A ; write-tree ; commit-tree ; update-ref [; diff-tree --numstat]",
  recipe2: "git add -A ; git commit (HEAD = refs/chronos/p0) [; diff-tree --numstat]",
  stepsPerCheckpoint: STEPS,
  spawnFloor: floor,
  series,
});
console.log(`[checkpoint] wrote ${OUT}`);
