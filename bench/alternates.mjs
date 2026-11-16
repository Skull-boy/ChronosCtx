// Phase 0 / gate 0.2 (third bullet) — sha256 object-format and alternates.
//
// §4.4.1 allows `objects/info/alternates` only when the workspace is a git repo,
// the object format is sha1, and both live on the same filesystem. The dangerous
// case is a sha256 workspace: the shadow store must be sha256 too, or git must
// refuse the alternate rather than silently link incompatible object ids.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { arg, writeJson } from "./lib/stats.mjs";
import { defaultRoot, makeEnv, git } from "./lib/gitenv.mjs";

const OUT = arg("out", `bench/results/${process.platform}-alternates.json`);
const root = path.join(defaultRoot(), "alt");

function sh(cwd, args, env) {
  const r = spawnSync("git", args, { cwd, env: env ?? process.env, encoding: "utf8", windowsHide: true });
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function makeWorkspace(name, format) {
  const ws = path.join(root, name);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.mkdirSync(ws, { recursive: true });
  const init = sh(ws, ["init", "--quiet", ...(format === "sha256" ? ["--object-format=sha256"] : [])]);
  if (init.status !== 0) throw new Error(init.err);
  fs.writeFileSync(path.join(ws, "a.txt"), "hello alternates\n");
  const hash = sh(ws, ["hash-object", "-w", "a.txt"]);
  if (hash.status !== 0) throw new Error(hash.err);
  return { ws, hash: hash.out, format };
}

function makeShadow(name, { format = "sha1", ws, alternates }) {
  const shadow = path.join(root, name);
  fs.rmSync(shadow, { recursive: true, force: true });
  const init = sh(root, ["init", "--bare", "--quiet", ...(format === "sha256" ? ["--object-format=sha256"] : []), shadow]);
  if (init.status !== 0) throw new Error(init.err);
  sh(shadow, ["config", "core.bare", "false"]);
  sh(shadow, ["config", "core.worktree", ws.replaceAll("\\", "/")]);
  if (alternates) {
    // Correct location for a bare repo is <gitdir>/objects/info/alternates.
    // <gitdir>/info/ is the excludes/attributes directory; git never reads
    // alternates from there, which is a silent failure worth pinning in a test.
    fs.mkdirSync(path.join(shadow, "objects", "info"), { recursive: true });
    fs.writeFileSync(path.join(shadow, "objects", "info", "alternates"), path.join(ws, ".git", "objects").replaceAll("\\", "/") + "\n");
  }
  return shadow;
}

const results = [];
const sameDev = (a, b) => {
  const dev = (p) => { try { return fs.statSync(p).dev; } catch { return null; } };
  return dev(a) === dev(b);
};

// Case 1 — sha1 workspace, sha1 shadow, alternates: must read.
{
  const w = makeWorkspace("ws-sha1", "sha1");
  const shadow = makeShadow("shadow-sha1", { ws: w.ws, alternates: true });
  const read = sh(shadow, ["--git-dir", shadow, "cat-file", "-e", w.hash]);
  const env = makeEnv({ shadowDir: shadow, workTree: w.ws, indexFile: path.join(root, "i1"), isoDate: "2026-11-16T00:00:00Z", optionalLocks: true });
  const add = git(["add", "-A", "--", "."], env, { allowFail: true });
  const tree = git(["write-tree"], env, { allowFail: true });
  results.push({
    case: "sha1 workspace, sha1 shadow, alternates",
    hashLength: w.hash.length,
    alternatesReadSucceeded: read.status === 0,
    sameFilesystem: sameDev(path.join(w.ws, ".git", "objects"), path.join(shadow, "objects")),
    addStatus: add.status,
    treeLength: tree.out.length,
    conclusion: read.status === 0 && add.status === 0 && tree.out.length === 40 ? "PASS" : "FAIL",
  });
}

// Case 2 — sha256 workspace, sha1 shadow, alternates: must NOT read (formats differ).
{
  const w = makeWorkspace("ws-sha256", "sha256");
  const shadow = makeShadow("shadow-sha1-vs256", { ws: w.ws, alternates: true, format: "sha1" });
  const read = sh(shadow, ["--git-dir", shadow, "cat-file", "-e", w.hash]);
  const env = makeEnv({ shadowDir: shadow, workTree: w.ws, indexFile: path.join(root, "i2"), isoDate: "2026-11-16T00:00:00Z", optionalLocks: true });
  const add = git(["add", "-A", "--", "."], env, { allowFail: true });
  results.push({
    case: "sha256 workspace, sha1 shadow, alternates",
    hashLength: w.hash.length,
    alternatesReadSucceeded: read.status === 0,
    alternateReadError: read.err || null,
    addStatus: add.status,
    addError: (add.err || "").split("\n")[0] || null,
    conclusion: read.status !== 0 ? "PASS (format mismatch refused; probe must set alternates=false)" : "FAIL (cross-format alternate was honoured)",
  });
}

// Case 3 — sha256 workspace, sha256 shadow, self-contained: must snapshot correctly.
{
  const w = makeWorkspace("ws-sha256b", "sha256");
  const shadow = makeShadow("shadow-sha256", { ws: w.ws, alternates: false, format: "sha256" });
  const env = makeEnv({ shadowDir: shadow, workTree: w.ws, indexFile: path.join(root, "i3"), isoDate: "2026-11-16T00:00:00Z", optionalLocks: true });
  const add = git(["add", "-A", "--", "."], env, { allowFail: true });
  const tree = git(["write-tree"], env, { allowFail: true });
  const ls = git(["ls-tree", "-r", tree.out], env, { allowFail: true });
  results.push({
    case: "sha256 workspace, sha256 shadow, self-contained",
    hashLength: w.hash.length,
    addStatus: add.status,
    treeLength: tree.out.length,
    entries: ls.out.split("\n").filter(Boolean).length,
    conclusion: add.status === 0 && tree.out.length === 64 && ls.status === 0 ? "PASS" : "FAIL",
  });
}

writeJson(OUT, {
  gate: "0.2",
  title: "sha256 object format and alternates preconditions",
  platform: process.platform,
  node: process.version,
  git: sh(root, ["--version"]).out,
  results,
  probeRule: "alternates=true only when workspace is a sha1 repo on the same device; sha256 workspaces always get a self-contained sha256 store",
});
for (const r of results) console.log(`[alternates] ${r.case} → ${r.conclusion}`);
console.log(`[alternates] wrote ${OUT}`);
