#!/usr/bin/env node
/**
 * Supply-chain policy check (§3.5.3, six rules).
 *
 * Scope note, stated so the check is not stronger than it is:
 * rule 1 (no lifecycle scripts) is enforced on the *runtime closure of published
 * packages* — the tree a user eventually runs. The build-time tree legitimately
 * contains packages that declare `postinstall`/`prepare` (esbuild via vitest,
 * for example); those are recorded and ratcheted instead, because §3.5.5
 * already separates the two graphs. `pnpm.onlyBuiltDependencies: []` plus
 * `ignore-scripts=true` means none of them execute here.
 *
 * Usage: node scripts/check-supply-chain.mjs [--json] [--release] [--no-git]
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIFECYCLE_KEYS = ["preinstall", "install", "postinstall", "prepare"];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA_PINNED_ACTION = /^[^\s@]+@[0-9a-f]{40}(?:\s+#.*)?$/;
const MAX_DIRECT_RUNTIME = 8;
const BUILD_BASELINE = join(ROOT, "docs", "supply-chain", "baseline.json");

const args = new Set(process.argv.slice(2));
const asJson = args.has("--json");
const release = args.has("--release");
const useGit = !args.has("--no-git");

/** @returns {{name:string,version:string,path:string,manifest:object}[]} */
function workspacePackages() {
  const found = [];
  const add = (file) => {
    const manifest = readJson(file);
    found.push({ name: manifest.name, version: manifest.version, path: file, manifest });
  };
  for (const entry of readdirSync(join(ROOT, "packages"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(ROOT, "packages", entry.name, "package.json");
    if (existsSync(file)) add(file);
  }
  for (const dir of ["bench", "tests"]) {
    const file = join(ROOT, dir, "package.json");
    if (existsSync(file)) add(file);
  }
  return found;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function prodClosure(packageDir) {
  const result = spawnSync(
    process.platform === "win32" ? "corepack.cmd" : "corepack",
    ["pnpm", "list", "--prod", "--depth", "Infinity", "--json"],
    { cwd: packageDir, encoding: "utf8", shell: process.platform === "win32" },
  );
  // pnpm exits 1 for warnings (peer notices) while still printing a complete
  // tree, so parse stdout and treat unparseable output as the only failure.
  const raw = result.stdout ?? "";
  if (raw.trim().length === 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const seen = new Set();
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.name && node.version && node.path) {
      const key = `${node.name}@${node.version}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ name: node.name, version: node.version, path: node.path });
      }
    }
    for (const child of Object.values(node.dependencies ?? {})) walk(child);
  };
  for (const node of Array.isArray(parsed) ? parsed : [parsed]) walk(node);
  return out;
}

/** Every package present in the installed tree, for the build-time ratchet. */
function installedTree() {
  const store = join(ROOT, "node_modules", ".pnpm");
  if (!existsSync(store)) return [];
  const out = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const nested = join(store, entry.name, "node_modules");
    if (!existsSync(nested)) continue;
    for (const pkg of readdirSync(nested, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      if (pkg.name.startsWith("@")) {
        for (const scoped of readdirSync(join(nested, pkg.name), { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          const file = join(nested, pkg.name, scoped.name, "package.json");
          if (existsSync(file)) out.push(file);
        }
      } else {
        const file = join(nested, pkg.name, "package.json");
        if (existsSync(file)) out.push(file);
      }
    }
  }
  return out;
}

function lifecycleOf(manifestPath) {
  const manifest = readJson(manifestPath);
  const declared = LIFECYCLE_KEYS.filter((key) => manifest.scripts?.[key]);
  return { manifest, declared };
}

function checkExactPins(packages) {
  const failures = [];
  for (const pkg of packages) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, range] of Object.entries(pkg.manifest[field] ?? {})) {
        if (range.startsWith("workspace:")) continue;
        if (!EXACT_VERSION.test(range)) {
          failures.push({
            rule: 2,
            package: pkg.name,
            field,
            dependency: name,
            value: range,
            message: "dependency is not exactly pinned",
          });
        }
      }
    }
  }
  return failures;
}

function checkRuntimeLifecycle(packages) {
  const failures = [];
  const inspected = new Set();
  const closures = [];
  for (const pkg of packages) {
    if (pkg.manifest.private === true) continue;
    const closure = prodClosure(dirname(pkg.path));
    const declaredDeps = Object.keys(pkg.manifest.dependencies ?? {}).filter(
      (name) => !name.startsWith("@chronos-ctx/"),
    );
    if (declaredDeps.length > 0 && closure.length === 0) {
      failures.push({
        rule: 0,
        package: pkg.name,
        message: "could not resolve the production closure; refusing to report a vacuous pass",
      });
    }
    closures.push({ package: pkg.name, services: closure.length });
    for (const dep of closure) {
      const key = `${dep.name}@${dep.version}`;
      if (inspected.has(key)) continue;
      inspected.add(key);
      const manifestPath = join(dep.path, "package.json");
      if (!existsSync(manifestPath)) continue;
      const { declared } = lifecycleOf(manifestPath);
      for (const script of declared) {
        failures.push({
          rule: 1,
          package: dep.name,
          version: dep.version,
          script,
          message: "runtime dependency declares a lifecycle script",
        });
      }
    }
  }
  return { failures, closures, inspected: inspected.size };
}

function checkBuildRatchet() {
  const entries = installedTree();
  const withScripts = [];
  for (const file of entries) {
    try {
      const { manifest, declared } = lifecycleOf(file);
      if (declared.length > 0) {
        withScripts.push({ name: manifest.name, version: manifest.version, scripts: declared });
      }
    } catch {
      // A malformed package.json in the store is not ours to police here.
    }
  }
  const baseline = existsSync(BUILD_BASELINE) ? readJson(BUILD_BASELINE) : null;
  const failures = [];
  if (baseline !== null) {
    if (withScripts.length > baseline.buildTreeLifecyclePackages) {
      failures.push({
        rule: 4,
        metric: "buildTreeLifecyclePackages",
        value: withScripts.length,
        baseline: baseline.buildTreeLifecyclePackages,
        message: "build-time lifecycle-script count increased; requires an ADR amendment",
      });
    }
  }
  return { failures, withScripts, baseline };
}

async function checkProvenance(packages) {
  if (!release) return { failures: [], checked: 0, skipped: true };
  const failures = [];
  let checked = 0;
  for (const pkg of packages) {
    if (pkg.manifest.private === true) continue;
    for (const [name, version] of Object.entries(pkg.manifest.dependencies ?? {})) {
      if (version.startsWith("workspace:")) continue;
      checked += 1;
      try {
        const response = await fetch(
          `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`,
          { headers: { accept: "application/json" } },
        );
        if (!response.ok) {
          failures.push({
            rule: 3,
            package: name,
            version,
            message: `no provenance attestation (HTTP ${response.status})`,
          });
        }
      } catch (error) {
        failures.push({
          rule: 3,
          package: name,
          version,
          message: `provenance lookup failed: ${String(error)}`,
        });
      }
    }
  }
  return { failures, checked, skipped: false };
}

function checkActionPins() {
  const dir = join(ROOT, ".github", "workflows");
  if (!existsSync(dir)) return [];
  const failures = [];
  for (const file of readdirSync(dir)) {
    if (!/\.ya?ml$/u.test(file)) continue;
    const text = readFileSync(join(dir, file), "utf8");
    text.split(/\r?\n/u).forEach((line, index) => {
      const match = /^\s*(?:-\s*)?uses:\s*(\S+)/u.exec(line);
      if (!match) return;
      const value = match[1];
      if (value.startsWith("./")) return;
      if (!SHA_PINNED_ACTION.test(value)) {
        failures.push({
          rule: 5,
          file: `.github/workflows/${file}`,
          line: index + 1,
          value,
          message: "GitHub Action is not pinned to a 40-character commit SHA",
        });
      }
    });
  }
  return failures;
}

function checkLockfilePairing() {
  if (!useGit) return [];
  let changed;
  try {
    changed = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/u)
      .filter(Boolean);
    changed = changed.concat(
      execFileSync("git", ["diff", "--name-only", "--cached"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/u)
        .filter(Boolean),
    );
  } catch {
    return [];
  }
  const lockChanged = changed.includes("pnpm-lock.yaml");
  const manifestChanged = changed.some(
    (file) => file.endsWith("package.json") || file === "pnpm-workspace.yaml",
  );
  if (lockChanged && !manifestChanged) {
    return [
      {
        rule: 6,
        message: "pnpm-lock.yaml changed without a package.json change",
      },
    ];
  }
  return [];
}

function checkNpmrc() {
  const file = join(ROOT, ".npmrc");
  if (!existsSync(file)) {
    return [{ rule: 0, message: ".npmrc is missing" }];
  }
  const text = readFileSync(file, "utf8");
  const required = [
    "ignore-scripts=true",
    "save-exact=true",
    "strict-peer-dependencies=true",
    "auto-install-peers=false",
    "verify-store-integrity=true",
    "minimum-release-age=4320",
    "fund=false",
  ];
  return required
    .filter((line) => !text.includes(line))
    .map((line) => ({ rule: 0, message: `.npmrc missing normative setting: ${line}` }));
}

function checkOnlyBuiltDependencies() {
  const rootManifest = readJson(join(ROOT, "package.json"));
  const declared = rootManifest.pnpm?.onlyBuiltDependencies;
  if (!Array.isArray(declared)) {
    return [{ rule: 0, message: "pnpm.onlyBuiltDependencies must be declared" }];
  }
  if (declared.length > 0) {
    return [{ rule: 0, message: "pnpm.onlyBuiltDependencies must be empty" }];
  }
  return [];
}

async function main() {
  const packages = workspacePackages();
  const rootManifest = readJson(join(ROOT, "package.json"));
  const runtimeClosure = checkRuntimeLifecycle(packages);
  const ratchet = checkBuildRatchet();
  const provenance = await checkProvenance(packages);

  const directRuntime = new Set();
  for (const pkg of packages) {
    if (pkg.manifest.private === true) continue;
    for (const name of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (!name.startsWith("@chronos-ctx/")) directRuntime.add(name);
    }
  }

  const budgetFailures = [];
  if (directRuntime.size > MAX_DIRECT_RUNTIME) {
    budgetFailures.push({
      rule: 4,
      metric: "directRuntime",
      value: directRuntime.size,
      baseline: MAX_DIRECT_RUNTIME,
      message: "direct runtime dependencies exceed the ADR-0025 budget",
    });
  }
  const sharedTypes = packages.find((pkg) => pkg.name === "@chronos-ctx/shared-types");
  if (sharedTypes !== undefined) {
    const deps = Object.keys(sharedTypes.manifest.dependencies ?? {});
    if (deps.length > 0) {
      budgetFailures.push({
        rule: 4,
        metric: "sharedTypesRuntimeDeps",
        value: deps.length,
        baseline: 0,
        message: "shared-types must have zero runtime dependencies",
      });
    }
  }

  const results = {
    scope: {
      installTime: "runtime closure of published packages",
      buildTime: "ratcheted against docs/supply-chain/baseline.json",
      release,
    },
    counts: {
      workspacePackages: packages.length,
      directRuntime: directRuntime.size,
      runtimeClosurePackages: runtimeClosure.inspected,
      buildTreePackages: installedTree().length,
      buildTreeLifecyclePackages: ratchet.withScripts.length,
    },
    runtimeClosures: runtimeClosure.closures,
    packageManager: rootManifest.packageManager ?? null,
    ratchetBaseline: ratchet.baseline,
    buildTreeLifecycle: ratchet.withScripts,
    failures: [
      ...checkNpmrc(),
      ...checkOnlyBuiltDependencies(),
      ...checkExactPins(packages),
      ...runtimeClosure.failures,
      ...ratchet.failures,
      ...budgetFailures,
      ...provenance.failures,
      ...checkActionPins(),
      ...checkLockfilePairing(),
    ],
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  } else {
    process.stdout.write("supply-chain check\n");
    process.stdout.write(`  workspace packages      ${results.counts.workspacePackages}\n`);
    process.stdout.write(
      `  direct runtime deps     ${results.counts.directRuntime} (budget ${MAX_DIRECT_RUNTIME})\n`,
    );
    process.stdout.write(`  package manager         ${results.packageManager ?? "MISSING"}\n`);
    process.stdout.write(
      `  build tree              ${results.counts.buildTreePackages} packages, ${results.counts.buildTreeLifecyclePackages} declare lifecycle scripts (ratcheted)\n`,
    );
    for (const item of results.buildTreeLifecycle) {
      process.stdout.write(`    - ${item.name}@${item.version}: ${item.scripts.join(", ")}\n`);
    }
    if (results.failures.length === 0) {
      process.stdout.write("  result                  PASS\n");
    } else {
      process.stdout.write(`  result                  FAIL (${results.failures.length})\n`);
      for (const failure of results.failures) {
        process.stdout.write(`    ! ${JSON.stringify(failure)}\n`);
      }
    }
  }

  process.exitCode = results.failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`supply-chain check crashed: ${String(error)}\n`);
  process.exitCode = 2;
});
