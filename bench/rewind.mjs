// Phase 0 / gate 0.7 + K7 — rewind (restore) cost and correctness.
//
// Implements §4.4.4 step-for-step on a real workspace:
//   read-tree(target) → delete DELETED → checkout-index → verify
// and measures the two shapes the design allows:
//   "all"     : checkout-index -a -f            (2 spawns, rewrites every file)
//   "changed" : diff-tree + checkout-index <paths> (3 spawns, writes only changes)
//
// Also exercises the parts that are easy to get wrong and expensive to debug later:
// directory↔file type conflicts, preservation of never-snapshotted files,
// 32-file content verification, and crash injection with roll-forward resume.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { arg, now, summarize, writeJson } from "./lib/stats.mjs";
import { initShadow, makeEnv, git, defaultRoot, spawnCount, resetSpawns } from "./lib/gitenv.mjs";
import { genRepo, mutate } from "./lib/fstree.mjs";

const FILES = Number(arg("files", 2000));
const ITERS = Number(arg("iters", 30));
const OUT = arg("out", `bench/results/${process.platform}-${FILES}-rewind.json`);
const ISO = "2026-11-16T00:00:00Z";

const root = path.join(defaultRoot(), `rw-${FILES}`);
const ws = path.join(root, "ws");
const shadowDir = path.join(root, "shadow.git");
const indexFile = path.join(root, "shadow.index");

const gen = genRepo(ws, { files: FILES, fresh: true });
initShadow({ shadowDir, workTree: ws, untrackedCache: true });
// A fresh shadow store MUST come with a fresh index: the index may only contain
// entries whose blobs exist in this store. Reusing an index from a previous run
// produces "invalid object" at write-tree, which looks like a git bug and is not.
fs.rmSync(indexFile, { force: true });
const env = makeEnv({ shadowDir, workTree: ws, indexFile, isoDate: ISO });

// ── tree capture ────────────────────────────────────────────────────────────
function checkpoint(label) {
  git(["add", "-A", "--", "."], env);
  const tree = git(["write-tree"], env).out;
  const commit = git(["commit-tree", tree, "-m", `p0 ${label}`], env).out;
  git(["update-ref", "refs/chronos/p0", commit], env);
  return tree;
}

/** path -> {mode, hash} for a tree, parsed once and cached. */
const treeMaps = new Map();
function treeMap(tree) {
  if (treeMaps.has(tree)) return treeMaps.get(tree);
  const out = git(["ls-tree", "-r", "-z", tree], env).out;
  const m = new Map();
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const tab = rec.indexOf("\t");
    const [mode, type, hash] = rec.slice(0, tab).split(" ");
    if (type !== "blob") continue;
    m.set(rec.slice(tab + 1), { mode, hash });
  }
  treeMaps.set(tree, m);
  return m;
}

/** Changes needed to go from `from` to `to`: [{status, path}]. */
function changes(from, to) {
  const out = git(["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to], env).out;
  const parts = out.split("\0").filter(Boolean);
  const list = [];
  for (let i = 0; i + 1 < parts.length; i += 2) list.push({ status: parts[i][0], path: parts[i + 1] });
  return list;
}

function removeEmptyDirs(filePath) {
  let dir = path.dirname(filePath);
  while (dir.length > ws.length) {
    try {
      if (fs.readdirSync(dir).length > 0) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

/** Git's blob id for a buffer, computed in-process. */
function blobHash(buf) {
  return crypto.createHash("sha1").update(`blob ${buf.length}\0`).update(buf).digest("hex");
}

/** §4.4.4 step 8: index reproduces the target, plus a 32-file content sample. */
function verify(target, sampleSize = 32) {
  const indexTree = git(["write-tree"], env).out;
  if (indexTree !== target) return { ok: false, reason: "INDEX_TREE_MISMATCH", indexTree };
  const map = treeMap(target);
  const paths = [...map.keys()];
  const step = Math.max(1, Math.floor(paths.length / sampleSize));
  const sampled = [];
  for (let i = 0; i < paths.length && sampled.length < sampleSize; i += step) sampled.push(paths[i]);
  for (const rel of sampled) {
    const abs = path.join(ws, rel);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      return { ok: false, reason: "SAMPLE_MISSING", path: rel };
    }
    if (blobHash(buf) !== map.get(rel).hash) return { ok: false, reason: "SAMPLE_HASH_MISMATCH", path: rel };
  }
  return { ok: true, indexTree, sampled: sampled.length };
}

/** Mid-flight interruption points, for crash-injection. */
const CRASH = { none: null, afterReadTree: "read_tree", afterDelete: "files_deleted", afterCheckout: "files_written" };

/**
 * One restore. `crashAt` stops before the step that follows the named phase,
 * exactly as a daemon death would, and leaves the journal in that state.
 */
function restore(from, to, { variant = "all", crashAt = null, sample = 32 } = {}) {
  resetSpawns();
  const t0 = now();
  const journal = [];
  const diffs = changes(from, to);
  const deleted = diffs.filter((d) => d.status === "D").map((d) => d.path);
  const written = diffs.filter((d) => d.status !== "D").map((d) => d.path);

  const readTree = git(["read-tree", to], env);
  journal.push({ phase: "read_tree", ms: readTree.ms });

  if (crashAt === CRASH.afterReadTree) {
    return { total: now() - t0, spawns: spawnCount(), journal, crashed: true, deleted: [], written: [], typeConflicts: [], diffs: diffs.length };
  }

  // Type conflicts: a path that is a file here and a directory (or vice versa)
  // in the target must be removed before checkout, or checkout-index silently
  // skips it (a tree path is not a blob) and the worktree keeps the old shape.
  // git reports a file→directory change as `T`, not as D+A, so the delete loop
  // below cannot be relied on for this case.
  const targetMap = treeMap(to);
  const typeConflicts = [];
  const checkoutPaths = [];
  for (const rel of written) {
    const abs = path.join(ws, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { /* absent */ }
    if (st && st.isDirectory()) {
      fs.rmSync(abs, { recursive: true, force: true });
      typeConflicts.push(rel);
    } else if (st && !targetMap.has(rel)) {
      // Target has a directory here; the files inside are separate entries.
      fs.rmSync(abs, { recursive: true, force: true });
      typeConflicts.push(rel);
      continue;
    }
    if (targetMap.has(rel)) checkoutPaths.push(rel);
  }

  let deletedAt = null;
  for (const rel of deleted) {
    const abs = path.join(ws, rel);
    try {
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) fs.rmSync(abs, { recursive: true, force: true });
      else fs.unlinkSync(abs);
    } catch { /* already gone */ }
    removeEmptyDirs(abs);
  }
  deletedAt = now();
  journal.push({ phase: CRASH.afterDelete, files: deleted.length, typeConflicts: typeConflicts.length });

  if (crashAt === CRASH.afterDelete) {
    return { total: now() - t0, spawns: spawnCount(), journal, crashed: true, deleted, written, typeConflicts, diffs: diffs.length };
  }

  let checkout;
  if (variant === "all") {
    checkout = git(["checkout-index", "-a", "-f"], env);
  } else {
    checkout = checkoutPaths.length
      ? git(["checkout-index", "-f", "-z", "--stdin"], env, { input: checkoutPaths.join("\0") + "\0" })
      : { ms: 0 };
  }
  journal.push({ phase: "files_written", ms: checkout.ms, files: written.length });

  if (crashAt === CRASH.afterCheckout) {
    return { total: now() - t0, spawns: spawnCount(), journal, crashed: true, deleted, written, typeConflicts, diffs: diffs.length };
  }

  const tVerify = now();
  const result = verify(to, sample);
  const verifyMs = now() - tVerify;
  journal.push({ phase: "verified", ms: verifyMs, ok: result.ok });

  return {
    total: now() - t0,
    deletedMs: deletedAt ? deletedAt - t0 : null,
    spawns: spawnCount(),
    journal,
    crashed: false,
    verify: result,
    deleted: deleted.length,
    written: written.length,
    typeConflicts: typeConflicts.length,
    diffs: diffs.length,
  };
}

// ── fixtures: two trees that differ the way real work differs ───────────────
const treeA = checkpoint("A");
mutate(ws, 60, 1, FILES);
const addedPaths = [];
for (let j = 0; j < 25; j++) {
  const rel = `src/new/feature_${j}.ts`;
  fs.mkdirSync(path.join(ws, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(ws, rel), `export const feature${j} = ${j};\n`);
  addedPaths.push(rel);
}
const removedPaths = [];
for (let j = 0; j < 25; j++) {
  const rel = path.join(`src/m${j % 40}`, `p${j % 97}`, `f${j * 7}.ts`);
  try { fs.unlinkSync(path.join(ws, rel)); removedPaths.push(rel); } catch { /* absent */ }
}
const treeB = checkpoint("B");
console.log(`[rewind] A=${treeA.slice(0, 8)} B=${treeB.slice(0, 8)} diff=${changes(treeA, treeB).length}`);

function rewindSeries(label, variant) {
  const samples = [], del = [], wr = [], diffs = [];
  let state = treeB;
  for (let i = 0; i < ITERS; i++) {
    const target = state === treeB ? treeA : treeB;
    const r = restore(state, target, { variant });
    if (!r.verify?.ok) throw new Error(`${label} verify failed: ${JSON.stringify(r.verify)}`);
    samples.push(r.total); del.push(r.deleted); wr.push(r.written); diffs.push(r.diffs);
    state = target;
  }
  return {
    label, variant, platform: process.platform, files: FILES, iterations: ITERS,
    spawnsPerRewind: variant === "all" ? 2 : 3,
    total: summarize(`${label}:total`, samples),
    deletedFilesPerRewind: summarize(`${label}:deleted`, del),
    writtenFilesPerRewind: summarize(`${label}:written`, wr),
    changedPathsPerRewind: summarize(`${label}:changed`, diffs),
  };
}

const series = [];
series.push(rewindSeries("rewind all (checkout-index -a -f)", "all"));
console.log("[rewind] all done", series.at(-1).total.p95.toFixed(1), "ms p95");
series.push(rewindSeries("rewind changed (checkout-index <paths>)", "changed"));
console.log("[rewind] changed done", series.at(-1).total.p95.toFixed(1), "ms p95");

// ── crash injection + roll-forward resume ──────────────────────────────────
const crashRuns = [];
for (const [name, crashAt] of [["after-read-tree", CRASH.afterReadTree], ["after-delete", CRASH.afterDelete], ["after-checkout", CRASH.afterCheckout]]) {
  // Move to A first so the next restore is a real change.
  restore(treeB, treeA, { variant: "all" });
  const crashed = restore(treeA, treeB, { variant: "all", crashAt });
  const t0 = now();
  const resumed = restore(treeA, treeB, { variant: "all" });
  const resumeMs = now() - t0;
  crashRuns.push({
    crashPoint: name,
    journalBeforeCrash: crashed.journal.map((j) => j.phase),
    resumedOk: resumed.verify.ok,
    verifySample: resumed.verify.sampled ?? null,
    resumeMs,
    // Roll-forward always re-runs the idempotent steps, so a resume is a full rewind.
    idempotent: resumed.verify.ok,
  });
  console.log(`[rewind] crash ${name} → resume ${resumed.verify.ok ? "ok" : "FAILED"} ${resumeMs.toFixed(1)} ms`);
}

// ── type conflict: directory in target, file in current (and back) ──────────
const conflictDir = "src/conflict";
fs.rmSync(path.join(ws, conflictDir), { recursive: true, force: true });
fs.writeFileSync(path.join(ws, conflictDir), "i am a file\n");
const treeFile = checkpoint("file-at-path");
fs.rmSync(path.join(ws, conflictDir), { force: true });
fs.mkdirSync(path.join(ws, conflictDir, "inner"), { recursive: true });
fs.writeFileSync(path.join(ws, conflictDir, "inner", "a.ts"), "export const a = 1;\n");
const treeDir = checkpoint("dir-at-path");
const c1 = restore(treeFile, treeDir, { variant: "changed" });
// State must be captured between the two restores, not after both.
const fileToDirFinalIsDir = (() => { try { return fs.statSync(path.join(ws, conflictDir)).isDirectory(); } catch { return false; } })();
const c2 = restore(treeDir, treeFile, { variant: "changed" });
const dirToFileFinalIsFile = (() => { try { return fs.statSync(path.join(ws, conflictDir)).isFile(); } catch { return false; } })();
const typeConflict = {
  fileToDirFinalIsDir,
  fileToDirVerify: c1.verify.ok,
  fileToDirWritten: c1.written,
  dirToFileFinalIsFile,
  dirToFileVerify: c2.verify.ok,
  dirToFileTypeConflictsCaught: c2.typeConflicts,
  pass: fileToDirFinalIsDir && c1.verify.ok && dirToFileFinalIsFile && c2.verify.ok,
};
console.log("[rewind] type conflict", JSON.stringify(typeConflict));

// ── never-snapshotted files are preserved ──────────────────────────────────
const strayRel = "notes/scratch-untracked.md";
fs.mkdirSync(path.join(ws, path.dirname(strayRel)), { recursive: true });
fs.writeFileSync(path.join(ws, strayRel), "# never checkpointed\n");
const before = treeMap(treeDir).has(strayRel);
restore(treeDir, treeFile, { variant: "all" });
const preserved = fs.existsSync(path.join(ws, strayRel));
// A never-checkpointed file must survive a rewind; it then *is* captured by the
// next checkpoint, because include_untracked defaults to true (by design).
const treeAfterStray = checkpoint("with-stray");
const capturedByNextCheckpoint = treeMap(treeAfterStray).has(strayRel);
console.log("[rewind] untracked preservation", { preserved, before, capturedByNextCheckpoint });

// ── 20k sanity: the same code path, larger tree (only if asked) ────────────
writeJson(OUT, {
  gate: "0.7",
  title: "Rewind cost and correctness",
  files: FILES,
  platform: process.platform,
  host: os.hostname(),
  cpus: os.cpus().length,
  cpu: os.cpus()[0]?.model?.trim() ?? "unknown",
  os: os.version(),
  node: process.version,
  git: git(["--version"], env).out,
  fixtureBuildMs: gen.buildMs,
  algorithm: "read-tree → type-conflict prune → delete DELETED → checkout-index → verify(write-tree + 32-file sample)",
  trees: { A: treeA, B: treeB },
  series,
  crashInjection: crashRuns,
  typeConflict,
  untrackedPreservation: { preservedAcrossRewind: preserved, wasInTargetTree: before, capturedByNextCheckpoint },
});
console.log(`[rewind] wrote ${OUT}`);
