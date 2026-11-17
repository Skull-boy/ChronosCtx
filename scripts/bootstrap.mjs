#!/usr/bin/env node
/**
 * One-command bootstrap: enable corepack, install with the committed lockfile,
 * build every package. Documented in README and used by contributors and CI.
 *
 * Turborepo shells out to `pnpm`, so a working `pnpm` on PATH is required even
 * though every task can also be run as `corepack pnpm <task>`. When
 * `corepack enable` cannot write shims next to the Node binary (a locked-down
 * Windows install, for example), we install them into `.tools/bin` and prepend
 * that directory to PATH for the child processes. See CONTRIBUTING.md.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const LOCAL_SHIMS = join(ROOT, ".tools", "bin");

function run(bin, args, options = {}) {
  const executable = isWindows ? `${bin}.cmd` : bin;
  process.stdout.write(`\n$ ${bin} ${args.join(" ")}\n`);
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    stdio: "inherit",
    shell: isWindows,
    env: process.env,
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(`\n${bin} ${args.join(" ")} failed with exit code ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
}

function corepack(args) {
  return spawnSync(isWindows ? "corepack.cmd" : "corepack", args, {
    cwd: ROOT,
    stdio: "ignore",
    shell: isWindows,
    env: process.env,
  });
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (Number.isNaN(nodeMajor) || nodeMajor < 22) {
  process.stderr.write(
    `ChronosCtx requires Node >= 22.15; this is ${process.versions.node}. See .nvmrc.\n`,
  );
  process.exit(1);
}

// Prefer the global shims; fall back to a repo-local directory so turbo can
// still find `pnpm` without elevated permissions.
const globalEnable = corepack(["enable"]);
if (globalEnable.status === 0) {
  process.stdout.write("corepack: global shims enabled\n");
} else {
  mkdirSync(LOCAL_SHIMS, { recursive: true });
  const localEnable = corepack(["enable", "--install-directory", LOCAL_SHIMS]);
  if (localEnable.status !== 0) {
    process.stderr.write(
      "corepack: could not install shims globally or into .tools/bin.\n" +
        "          Every task still works as `corepack pnpm <task>`, but `pnpm build`\n" +
        "          (turborepo) needs pnpm on PATH. See CONTRIBUTING.md.\n",
    );
    process.exit(localEnable.status ?? 1);
  }
  process.env.PATH = `${LOCAL_SHIMS}${isWindows ? ";" : ":"}${process.env.PATH ?? ""}`;
  process.stdout.write(`corepack: shims installed into ${LOCAL_SHIMS} (added to PATH)\n`);
}

run("corepack", ["pnpm", "install", "--frozen-lockfile"]);
run("corepack", ["pnpm", "build"]);

process.stdout.write("\nbootstrap complete\n");
process.stdout.write("  next: corepack pnpm test\n");
process.stdout.write("        node scripts/verify-phase.mjs --phase 1\n");
