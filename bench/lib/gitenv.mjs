// Phase 0 — the §4.4.2 deterministic git environment, reproduced exactly.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const IS_WIN = process.platform === "win32";
let spawns = 0;

export function spawnCount() { return spawns; }
export function resetSpawns() { spawns = 0; }

/** Build a child env from the roadmap's §4.4.2 table. */
export function makeEnv({ shadowDir, workTree, indexFile, isoDate, optionalLocks = false }) {
  const env = {
    ...process.env,
    GIT_DIR: shadowDir,
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: "ChronosCtx",
    GIT_AUTHOR_EMAIL: "chronos@localhost",
    GIT_COMMITTER_NAME: "ChronosCtx",
    GIT_COMMITTER_EMAIL: "chronos@localhost",
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: IS_WIN ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    LANG: "C",
  };
  if (optionalLocks) env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** Run git synchronously against the shadow repo. Never uses a shell. */
export function git(args, env, { allowFail = false, cwd, input } = {}) {
  spawns += 1;
  const t0 = performance.now();
  const r = spawnSync("git", args, {
    env,
    cwd: cwd ?? env.GIT_WORK_TREE,
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    input,
  });
  const ms = performance.now() - t0;
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return { out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim(), status: r.status, ms };
}

function cfg(shadowDir, key, value) {
  const r = spawnSync("git", ["config", "--file", path.join(shadowDir, "config"), "--replace-all", key, String(value)], {
    encoding: "utf8", shell: false, windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git config ${key} failed: ${r.stderr}`);
}

/**
 * Create the dedicated shadow repository exactly as §4.4.2/§4.4.1 describe:
 * bare init, then core.bare=false + core.worktree so `add` works against the
 * user's working tree without ever writing to the user's .git.
 */
export function initShadow({ shadowDir, workTree, sha256 = false, untrackedCache = true, normalizeEol = false }) {
  fs.rmSync(shadowDir, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(path.dirname(shadowDir), { recursive: true });
  const initArgs = ["init", "--bare", "--quiet"];
  if (sha256) initArgs.push("--object-format=sha256");
  initArgs.push(shadowDir);
  const r = spawnSync("git", initArgs, { encoding: "utf8", shell: false, windowsHide: true });
  if (r.status !== 0) throw new Error(`git init failed: ${r.stderr}`);

  cfg(shadowDir, "core.bare", "false");
  cfg(shadowDir, "core.worktree", workTree.replaceAll("\\", "/"));
  cfg(shadowDir, "core.autocrlf", "false");
  cfg(shadowDir, "core.eol", "lf");
  cfg(shadowDir, "core.fileMode", "false");
  cfg(shadowDir, "core.symlinks", IS_WIN ? detectSymlink(workTree) : "true");
  cfg(shadowDir, "core.precomposeUnicode", "true");
  cfg(shadowDir, "core.untrackedCache", untrackedCache ? "true" : "false");
  cfg(shadowDir, "core.fsmonitor", "false");
  cfg(shadowDir, "gc.auto", "0");
  cfg(shadowDir, "commit.gpgsign", "false");
  cfg(shadowDir, "index.version", "4");
  if (IS_WIN) cfg(shadowDir, "core.longpaths", "true");
  cfg(shadowDir, "safe.directory", workTree.replaceAll("\\", "/"));
  cfg(shadowDir, "safe.directory", shadowDir.replaceAll("\\", "/"));

  if (normalizeEol) {
    fs.mkdirSync(path.join(shadowDir, "info"), { recursive: true });
    fs.writeFileSync(path.join(shadowDir, "info", "attributes"), "* text=auto eol=lf\n", "utf8");
  }
  return shadowDir;
}

function detectSymlink(workTree) {
  const p = path.join(workTree, `.symlink-probe-${process.pid}`);
  try {
    fs.symlinkSync("target", p);
    fs.unlinkSync(p);
    return "true";
  } catch {
    return "false";
  }
}

export function defaultRoot() {
  return process.env.CHRONOS_P0_ROOT || path.join(os.tmpdir(), "chronos-p0");
}

export function freshDir(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(p, { recursive: true });
  return p;
}
