#!/usr/bin/env node
/**
 * Gate 1.16 — `chronos doctor` on a clean machine is all green.
 *
 * "Clean" means a fresh CHRONOS_HOME with nothing but the first-run migration.
 * The gate runs the real CLI, not a library call, so the executable contract
 * (argument parsing, JSON shape, exit code) is what is measured.
 *
 * Requires a built CLI (`corepack pnpm build`), which CI does before gates run.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages", "cli", "dist", "index.js");

if (!existsSync(CLI)) {
  process.stderr.write(`gate 1.16: ${CLI} is missing; run \`corepack pnpm build\` first\n`);
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), "chronos-doctor-gate-"));
const env = { ...process.env, CHRONOS_HOME: home };

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let exitCode = 1;
try {
  const migrated = run(["migrate", "--json"]);
  if (migrated.status !== 0) {
    process.stderr.write(`gate 1.16: migrate failed\n${migrated.stderr ?? ""}`);
    process.exit(1);
  }

  const doctor = run(["doctor", "--json"]);
  const report = JSON.parse(doctor.stdout ?? "{}");

  const checks = Array.isArray(report.checks) ? report.checks : [];
  const failed = checks.filter((check) => check.ok !== true);
  const ok = report.ok === true && doctor.status === 0 && checks.length >= 5 && failed.length === 0;

  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        home_was_clean: true,
        checks: checks.map((check) => ({ name: check.name, ok: check.ok, detail: check.detail })),
        exit_code: doctor.status,
      },
      null,
      2,
    )}\n`,
  );

  if (!ok) {
    process.stderr.write(`gate 1.16: ${failed.length} check(s) failed\n`);
  }
  exitCode = ok ? 0 : 1;
} catch (error) {
  process.stderr.write(`gate 1.16 crashed: ${String(error)}\n`);
  exitCode = 2;
} finally {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // A leaked temp directory is not a gate failure.
  }
}

process.exitCode = exitCode;
