#!/usr/bin/env node
/**
 * Phase gate runner (§6.2). A gate is a *measured assertion*, not a checklist:
 * every implemented check runs a command or reads an artifact and reports what
 * it observed. Unimplemented gates report `pending` and fail the run, so a
 * phase cannot be declared complete by omission.
 *
 * Usage:
 *   node scripts/verify-phase.mjs --phase 1
 *   node scripts/verify-phase.mjs --phase 1 --json
 *   node scripts/verify-phase.mjs --phase 1 --only 1.1
 *   node scripts/verify-phase.mjs --list
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);

function flag(name) {
  return argv.includes(`--${name}`);
}

function option(name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

const PHASES = {
  0: [
    {
      id: "0.10",
      assertion: "Written Phase 0 verdict committed with GO",
      run: () => {
        const file = join(ROOT, "docs", "phase0", "REPORT.md");
        if (!existsSync(file)) return { ok: false, detail: "docs/phase0/REPORT.md is missing" };
        const text = readFileSync(file, "utf8");
        // The verdict sentence is normative prose, so match it loosely on the
        // two facts that matter: GO, and the conditional amendment set.
        const go = /GO for Phase 1/u.test(text);
        const conditional = /A1[–-]A8/u.test(text);
        return {
          ok: go && conditional,
          detail:
            go && conditional
              ? "GO for Phase 1, conditional on A1–A8"
              : `verdict=${go ? "GO" : "missing"} amendments=${conditional ? "A1–A8" : "missing"}`,
        };
      },
    },
    {
      id: "0.11",
      assertion: "Phase 0 harness and measurements are reproducible from the repo",
      run: () => {
        const required = [
          "bench/checkpoint.mjs",
          "bench/manifest.mjs",
          "bench/rewind.mjs",
          "bench/determinism.mjs",
          "bench/tokens.mjs",
          "bench/supplychain.mjs",
          "docs/phase0/METHOD.md",
        ];
        const missing = required.filter((file) => !existsSync(join(ROOT, file)));
        return {
          ok: missing.length === 0,
          detail: missing.length === 0 ? "harness complete" : `missing: ${missing.join(", ")}`,
        };
      },
    },
  ],
  1: [
    {
      id: "1.1",
      assertion: "Migration from empty DB succeeds; PRAGMA table_info parity with Drizzle",
      command: {
        bin: "corepack",
        args: ["pnpm", "-F", "@chronos-ctx/core-engine", "test"],
      },
    },
    { id: "1.2", assertion: "10k random commit sequences: zero unevidenced verified heads" },
    {
      id: "1.3",
      assertion: "Web-surface verified attempts rejected (12/12)",
      command: {
        bin: "corepack",
        args: [
          "pnpm",
          "-F",
          "@chronos-ctx/core-engine",
          "exec",
          "vitest",
          "run",
          "src/services/epistemic.test.ts",
        ],
      },
    },
    { id: "1.4", assertion: "Boot payload on 300-node fixture ≤150/≤200 tokens" },
    { id: "1.5", assertion: "page_in 12 paths, max_tokens=1200, envelope counted" },
    { id: "1.6", assertion: "Capsule render determinism, no timestamp-like fields" },
    {
      id: "1.7",
      assertion: "VERSION_CONFLICT returns current version + hash, no write",
      command: {
        bin: "corepack",
        args: [
          "pnpm",
          "-F",
          "@chronos-ctx/core-engine",
          "exec",
          "vitest",
          "run",
          "src/services/commit.test.ts",
          "-t",
          "VERSION_CONFLICT",
        ],
      },
    },
    { id: "1.8", assertion: "Freshness correctness across 5k generated histories" },
    {
      id: "1.9",
      assertion: "Snapshot dedupe: 200 checkpoints, 3 states → 3 rows",
      command: {
        bin: "corepack",
        args: [
          "pnpm",
          "-F",
          "@chronos-ctx/core-engine",
          "exec",
          "vitest",
          "run",
          "src/services/checkpoints.test.ts",
          "-t",
          "200 checkpoints",
        ],
      },
    },
    {
      id: "1.10",
      assertion: "Snapshot identity split: equal content_root, 2 rows",
      command: {
        bin: "corepack",
        args: [
          "pnpm",
          "-F",
          "@chronos-ctx/core-engine",
          "exec",
          "vitest",
          "run",
          "src/services/checkpoints.test.ts",
          "-t",
          "content_root",
        ],
      },
    },
    {
      id: "1.11",
      assertion: "Fork/commit interleavings: 1,000 across 3 branches",
      command: {
        bin: "corepack",
        args: [
          "pnpm",
          "-F",
          "@chronos-ctx/core-engine",
          "exec",
          "vitest",
          "run",
          "src/services/interleaving.test.ts",
        ],
      },
    },
    { id: "1.12", assertion: "Tool-surface measurement ≤1,200 hard / ≤900 target" },
    { id: "1.13", assertion: "Loopback Host/Origin rejection suite (8/8)" },
    { id: "1.14", assertion: "Network/synced-drive probe refuses with UNSAFE_FILESYSTEM" },
    { id: "1.15", assertion: "Coverage ≥85% statements in core-engine and shared-types" },
    {
      id: "1.16",
      assertion: "chronos doctor on a clean machine is all green",
      command: { bin: "node", args: ["scripts/gate-doctor.mjs"] },
    },
    { id: "1.17", assertion: "Release dry-run install contract" },
    {
      id: "1.18",
      assertion: "Install/build trees match ADR-0025 budgets",
      command: { bin: "node", args: ["scripts/check-supply-chain.mjs"] },
    },
  ],
};

function runCommand(bin, args) {
  const executable = process.platform === "win32" && bin === "corepack" ? "corepack.cmd" : bin;
  const result = spawnSync(executable, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
  return {
    ok: result.status === 0,
    detail: result.status === 0 ? "passed" : `exit ${result.status}`,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
      .trim()
      .split(/\r?\n/u)
      .slice(-12)
      .join("\n"),
  };
}

const phaseArg = option("phase");
const only = option("only");

if (flag("list")) {
  for (const [phase, gates] of Object.entries(PHASES)) {
    process.stdout.write(`phase ${phase}\n`);
    for (const gate of gates) {
      process.stdout.write(
        `  ${gate.id}  ${gate.assertion}${gate.run || gate.command ? "" : "  [pending]"}\n`,
      );
    }
  }
  process.exit(0);
}

const phase = phaseArg === undefined ? 1 : Number(phaseArg);
const gates = PHASES[phase];

if (gates === undefined) {
  process.stderr.write(`unknown phase: ${phaseArg} (known: ${Object.keys(PHASES).join(", ")})\n`);
  process.exit(2);
}

const selected = only === undefined ? gates : gates.filter((gate) => gate.id === only);
if (selected.length === 0) {
  process.stderr.write(`no gate matches --only ${only}\n`);
  process.exit(2);
}

const results = [];
for (const gate of selected) {
  let outcome;
  if (gate.run) {
    outcome = gate.run();
  } else if (gate.command) {
    outcome = runCommand(gate.command.bin, gate.command.args);
  } else {
    outcome = { ok: false, detail: "not implemented", pending: true };
  }
  results.push({ id: gate.id, assertion: gate.assertion, ...outcome });
}

const failures = results.filter((result) => !result.ok);

if (flag("json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        phase,
        passed: results.length - failures.length,
        failed: failures.filter((r) => r.pending !== true).length,
        pending: failures.filter((r) => r.pending === true).length,
        gates: results,
      },
      null,
      2,
    )}\n`,
  );
} else {
  process.stdout.write(`phase ${phase} gate run\n`);
  for (const result of results) {
    const mark = result.ok ? "PASS" : result.pending === true ? "PEND" : "FAIL";
    process.stdout.write(`  ${mark}  ${result.id}  ${result.assertion}\n`);
    if (!result.ok && result.output) {
      for (const line of result.output.split("\n")) process.stdout.write(`         ${line}\n`);
    } else if (!result.ok && result.detail) {
      process.stdout.write(`         ${result.detail}\n`);
    }
  }
  process.stdout.write(
    `\n  ${results.length - failures.length}/${results.length} gates satisfied` +
      (failures.length === 0 ? "\n" : `; ${failures.length} outstanding\n`),
  );
}

process.exitCode = failures.length === 0 ? 0 : 1;
