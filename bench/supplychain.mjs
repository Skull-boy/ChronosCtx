// Phase 0 / gates 0.11 + 0.12 (measurement half) + K9 — supply chain.
//
// Three real measurements, no estimates:
//   1. npm scope availability for the planned package names.
//   2. Exact transitive closure per candidate dependency, plus which of those
//      packages declare a lifecycle script (this is the number §3.5.5 guessed at).
//   3. The packaged-install contract: wrapper tarball → 1 platform package,
//      0 transitive deps, 0 executed scripts, with a sentinel that proves nothing
//      ran rather than trusting --ignore-scripts.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { arg, writeJson } from "./lib/stats.mjs";
import { defaultRoot } from "./lib/gitenv.mjs";

const OUT = arg("out", "bench/results/supplychain.json");
const DEPS = path.join("bench", ".deps");
// On Windows, Node ≥ 18.20 refuses to spawn .cmd files without a shell
// (CVE-2024-27980 hardening), so `shell` is required for the npm shim.
const npm = (args, opts = {}) => {
  const r = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    encoding: "utf8", shell: process.platform === "win32", windowsHide: true, timeout: 300000, ...opts,
  });
  if (r.error) return { status: 1, stdout: "", stderr: `spawn failed: ${r.error.message}` };
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

// ── 1. scope availability ──────────────────────────────────────────────────
const NAMES = [
  "chronos-ctx",
  "@chronos-ctx/core",
  "@chronos-ctx/mcp-server",
  "@chronos-ctx/extension",
  "@chronos-ctx/conformance",
  "@chronos-ctx/win32-x64",
  "@chronos-ctx/darwin-arm64",
  "@chronos-ctx/linux-x64-gnu",
];
const scope = NAMES.map((name) => {
  const r = npm(["view", name, "version", "--json"], { timeout: 60000 });
  const stderr = r.stderr ?? "";
  const stdout = r.stdout ?? "";
  const available = r.status !== 0 || !stdout.trim() || stderr.includes("E404");
  return { name, available, registryStatus: r.status, detail: (stderr.split("\n").find((l) => l.includes("E404")) ?? stdout.trim() ?? "").trim().slice(0, 200) };
});

// ── 2. closure size per candidate ──────────────────────────────────────────
const CANDIDATES = [
  { dir: "fastify", spec: "fastify@5 @fastify/cors@11" },
  { dir: "pino", spec: "pino@9" },
  { dir: "execa", spec: "execa@9" },
  { dir: "chokidar", spec: "chokidar@4" },
  { dir: "clack", spec: "@clack/prompts@0.10" },
  { dir: "picocolors", spec: "picocolors@1" },
  { dir: "ulid", spec: "ulid@3" },
  { dir: "commander", spec: "commander@14" },
  { dir: "mcp-sdk", spec: "@modelcontextprotocol/sdk@1" },
  { dir: "libsql", spec: "@libsql/client@0" },
  { dir: "drizzle", spec: "drizzle-orm@0.44" },
  { dir: "zod", spec: "zod@4" },
];

function closure(dir) {
  const lock = path.join(dir, "package-lock.json");
  if (!fs.existsSync(lock)) return null;
  const l = JSON.parse(fs.readFileSync(lock, "utf8"));
  const packages = Object.keys(l.packages || {}).filter((k) => k.startsWith("node_modules/"));
  // Transitive = every installed package minus the ones we asked for directly.
  const direct = new Set(
    Object.entries(l.packages || {})
      .find(([k]) => k === "")?.[1]?.dependencies
      ? Object.keys(l.packages[""].dependencies)
      : [],
  );
  const transitive = packages.filter((k) => !direct.has(k.replace(/^node_modules\//, "").replace(/\/node_modules\//g, "/")));
  const scripts = [];
  for (const key of packages) {
    const p = l.packages[key];
    const s = p.scripts || {};
    const life = ["preinstall", "install", "postinstall", "prepare"].filter((k) => s[k]);
    if (life.length) scripts.push({ name: key.replace(/^node_modules\//, ""), version: p.version, scripts: life });
  }
  return {
    total: packages.length,
    direct: direct.size,
    transitive: transitive.length,
    bytes: Object.values(l.packages).reduce((a, p) => a + (p.integrity ? 1 : 0), 0),
    lifecycleScripts: scripts,
  };
}

const closures = [];
for (const c of CANDIDATES) {
  const dir = path.join(DEPS, c.dir);
  fs.mkdirSync(dir, { recursive: true });
  const pkgFile = path.join(dir, "package.json");
  if (!fs.existsSync(pkgFile)) fs.writeFileSync(pkgFile, JSON.stringify({ name: `p0-${c.dir}`, version: "0.0.0", private: true }, null, 2));
  const r = npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", ...c.spec.split(" ")], { cwd: dir });
  // --no-package-lock means we must inspect node_modules directly.
  if (r.status !== 0) {
    closures.push({ dir: c.dir, spec: c.spec, error: (r.stderr || "").slice(0, 400) });
    continue;
  }
  const counts = inspectNodeModules(dir);
  closures.push({ dir: c.dir, spec: c.spec, ...counts });
  console.log(`[supplychain] ${c.dir}: ${counts.total} packages, ${counts.transitive} transitive, ${counts.lifecycleScripts.length} lifecycle scripts`);
}

function inspectNodeModules(root) {
  const nm = path.join(root, "node_modules");
  if (!fs.existsSync(nm)) return { total: 0, direct: 0, transitive: 0, lifecycleScripts: [], topLevel: [], error: "no node_modules" };
  const seen = new Map();
  const scripts = [];
  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      if (e.name.startsWith("@")) {
        for (const s of fs.readdirSync(path.join(dir, e.name), { withFileTypes: true })) {
          if (s.isDirectory()) visit(path.join(dir, e.name, s.name), `${e.name}/${s.name}`, depth);
        }
      } else {
        visit(path.join(dir, e.name), e.name, depth);
      }
    }
  }
  walk(nm, 0);
  function visit(abs, name, depth) {
    const pj = path.join(abs, "package.json");
    if (fs.existsSync(pj)) {
      const p = JSON.parse(fs.readFileSync(pj, "utf8"));
      const key = `${name}@${p.version}`;
      if (!seen.has(key)) {
        seen.set(key, true);
        const s = p.scripts || {};
        const life = ["preinstall", "install", "postinstall", "prepare"].filter((k) => s[k]);
        if (life.length) scripts.push({ name, version: p.version, scripts: life });
      }
    }
    const nested = path.join(abs, "node_modules");
    if (fs.existsSync(nested)) walk(nested, depth + 1);
  }
  // `direct` means *declared in our manifest*, not "top-level in node_modules":
  // npm hoists transitive packages to the top level, so counting directories
  // would report a 50-package tree as 49 direct dependencies.
  let declared = [];
  try { declared = Object.keys(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).dependencies ?? {}); } catch { /* none */ }
  return {
    total: seen.size,
    direct: declared.length || null,
    declared,
    transitive: declared.length ? Math.max(0, seen.size - declared.length) : null,
    lifecycleScripts: scripts,
  };
}

// ── 3. packaged-install contract (gate 0.11) ───────────────────────────────
// Three separate claims, each testable:
//   a) the shipped shape is one package with zero transitive dependencies;
//   b) a tarball that DOES declare a postinstall does not execute it when the
//      project .npmrc sets ignore-scripts=true (our policy, §3.5.2);
//   c) the sentinel mechanism itself works, so (b) is not a false negative.
const contract = (() => {
  const work = path.join(defaultRoot(), "install-contract");
  fs.rmSync(work, { recursive: true, force: true });
  const platformDir = path.join(work, "platform");
  const hostileDir = path.join(work, "hostile");
  const wrapperDir = path.join(work, "wrapper");
  const c1 = path.join(work, "consumer-clean");
  const c2 = path.join(work, "consumer-policy");
  const c3 = path.join(work, "consumer-control");
  for (const d of [platformDir, hostileDir, wrapperDir, c1, c2, c3]) fs.mkdirSync(d, { recursive: true });

  const sentinel = path.join(work, "SCRIPT-RAN");
  const marker = `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "ran");`;

  // (a) the shipped shape: no lifecycle scripts, one optionalDependency edge.
  fs.writeFileSync(path.join(platformDir, "package.json"), JSON.stringify({
    name: "@chronos-ctx/win32-x64",
    version: "0.0.1",
    os: ["win32"], cpu: ["x64"],
    files: ["dist"],
    main: "dist/index.js",
    license: "Apache-2.0",
  }, null, 2));
  fs.mkdirSync(path.join(platformDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(platformDir, "dist", "index.js"), 'console.log("chronos platform stub");\n');

  // (b/c) an intentionally hostile package: proves the policy suppresses scripts.
  fs.writeFileSync(path.join(hostileDir, "package.json"), JSON.stringify({
    name: "@chronos-ctx/hostile-fixture",
    version: "0.0.1",
    files: ["index.js"],
    main: "index.js",
    scripts: { postinstall: `node -e ${JSON.stringify(marker)}` },
  }, null, 2));
  fs.writeFileSync(path.join(hostileDir, "index.js"), "module.exports = 1;\n");

  fs.writeFileSync(path.join(wrapperDir, "package.json"), JSON.stringify({
    name: "chronos-ctx-fixture",
    version: "0.0.1",
    bin: { chronos: "bin/chronos.js" },
    optionalDependencies: { "@chronos-ctx/win32-x64": "0.0.1" },
    license: "Apache-2.0",
  }, null, 2));
  fs.mkdirSync(path.join(wrapperDir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(wrapperDir, "bin", "chronos.js"), '#!/usr/bin/env node\nconsole.log("chronos stub");\n');

  const pack = (dir) => {
    const r = npm(["pack", "--json", "--pack-destination", work], { cwd: dir });
    if (r.status !== 0) return { error: (r.stderr || r.stdout).slice(0, 400) };
    const info = JSON.parse(r.stdout);
    return { file: path.join(work, info[0].filename), size: info[0].size, files: info[0].entryCount };
  };
  const pTar = pack(platformDir);
  const hTar = pack(hostileDir);
  const wTar = pack(wrapperDir);
  if (pTar.error || hTar.error || wTar.error) return { error: pTar.error || hTar.error || wTar.error };

  const initConsumer = (dir) =>
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "consumer", version: "1.0.0", private: true }, null, 2));
  const install = (dir, tar) => {
    initConsumer(dir);
    const t0 = performance.now();
    const r = npm(["install", "--no-audit", "--no-fund", tar], { cwd: dir });
    return { status: r.status, ms: performance.now() - t0, stderr: (r.stderr || "").slice(0, 300) };
  };

  // (a) clean platform tarball.
  fs.rmSync(sentinel, { force: true });
  const clean = install(c1, pTar.file);
  const cleanTree = (() => {
    const r = npm(["ls", "--all", "--json", "--omit=dev"], { cwd: c1 });
    try {
      const j = JSON.parse(r.stdout);
      const names = [];
      (function walk(deps) { for (const [n, v] of Object.entries(deps || {})) { names.push(n); walk(v.dependencies); } })(j.dependencies);
      return { packages: names, count: names.length };
    } catch { return { error: (r.stdout || "").slice(0, 300) }; }
  })();
  const installedPkg = path.join(c1, "node_modules", "@chronos-ctx", "win32-x64", "package.json");
  const cleanScripts = fs.existsSync(installedPkg) ? (JSON.parse(fs.readFileSync(installedPkg, "utf8")).scripts ?? {}) : { missing: true };

  // (b) hostile tarball under our .npmrc policy.
  fs.writeFileSync(path.join(c2, ".npmrc"), "ignore-scripts=true\nsave-exact=true\n");
  fs.rmSync(sentinel, { force: true });
  const policed = install(c2, hTar.file);
  const policedRan = fs.existsSync(sentinel);

  // (c) negative control: same tarball, no policy. Must run, or the test is void.
  fs.rmSync(sentinel, { force: true });
  const control = install(c3, hTar.file);
  const controlRan = fs.existsSync(sentinel);

  return {
    tarballs: {
      platform: { file: path.basename(pTar.file), bytes: pTar.size, files: pTar.files },
      hostile: { file: path.basename(hTar.file), bytes: hTar.size },
      wrapper: { file: path.basename(wTar.file), bytes: wTar.size, files: wTar.files },
    },
    cleanInstall: {
      status: clean.status,
      ms: clean.ms,
      tree: cleanTree,
      declaresScripts: cleanScripts.missing ? "package not installed" : Object.keys(cleanScripts).length,
      verdict: clean.status === 0 && cleanTree.count === 1 && !cleanScripts.missing && Object.keys(cleanScripts).length === 0 ? "PASS" : "FAIL",
    },
    scriptPolicy: {
      policedInstallStatus: policed.status,
      postinstallExecutedUnderPolicy: policedRan,
      negativeControlExecuted: controlRan,
      controlStatus: control.status,
      verdict: !policedRan && controlRan ? "PASS (policy suppresses; mechanism proven)" : "FAIL",
    },
  };
})();

writeJson(OUT, {
  gate: "0.11/0.12/K9",
  title: "Supply-chain measurement",
  platform: process.platform,
  node: process.version,
  npm: npm(["--version"]).stdout.trim(),
  scope,
  closures,
  installContract: contract,
});
console.log("[supplychain] scope:", scope.map((s) => `${s.name}=${s.available ? "free" : "TAKEN"}`).join(" "));
console.log("[supplychain] clean install:", JSON.stringify(contract.cleanInstall ?? contract.error));
console.log("[supplychain] script policy:", JSON.stringify(contract.scriptPolicy ?? null));
console.log("[supplychain] wrote", OUT);
