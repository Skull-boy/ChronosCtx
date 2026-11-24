#!/usr/bin/env node
/**
 * Gate 1.15 — statement coverage.
 *
 * Runs each package's suite under V8 coverage and fails unless statements are
 * at least 85%. The vitest configs carry the same threshold; this script is the
 * authoritative gate because it also checks the parsed number, so removing a
 * config threshold cannot silently weaken the release contract.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const THRESHOLD = 85;
const PACKAGES = ["@chronos-ctx/core-engine", "@chronos-ctx/shared-types"];

function runCoverage(pkg) {
  const executable = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const result = spawnSync(
    executable,
    ["pnpm", "-F", pkg, "exec", "vitest", "run", "--coverage", "--coverage.reporter=text-summary"],
    {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
      env: { ...process.env, CI: "1" },
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const match = /Statements\s*:\s*([\d.]+)%/u.exec(output);
  const percent = match?.[1] === undefined ? null : Number(match[1]);
  return {
    pkg,
    exitCode: result.status ?? 1,
    percent,
    output: output.trim().split(/\r?\n/u).slice(-20).join("\n"),
  };
}

const results = PACKAGES.map(runCoverage);
let failed = false;

for (const result of results) {
  const measured = result.percent === null ? "unmeasured" : `${result.percent.toFixed(2)}%`;
  const ok = result.exitCode === 0 && result.percent !== null && result.percent >= THRESHOLD;
  if (!ok) failed = true;
  process.stdout.write(
    `  ${ok ? "PASS" : "FAIL"}  ${result.pkg}  statements ${measured} (threshold ${THRESHOLD}%)\n`,
  );
  if (!ok) {
    for (const line of result.output.split("\n")) process.stdout.write(`         ${line}\n`);
  }
}

if (failed) {
  process.stderr.write("coverage gate failed\n");
  process.exitCode = 1;
} else {
  process.stdout.write(`coverage gate satisfied for ${results.length} packages\n`);
}
