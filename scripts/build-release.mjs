#!/usr/bin/env node
/**
 * Release builder (gate 1.17).
 *
 * `--dry-run` builds a real, installable artifact on the host platform:
 *
 *   bundle (vite) → stage one platform package → CycloneDX SBOM →
 *   npm pack → sign + verify → install into a clean consumer → smoke test
 *
 * The install contract is the measured claim: exactly one package, zero
 * transitive dependencies and zero lifecycle scripts. The signature is a local
 * Ed25519 dry-run signature; it proves the sign/verify path but is **not** a
 * release attestation. CI replaces it with Cosign keyless provenance (gate
 * 6.18); `--require-cosign` makes its absence fatal.
 *
 * Usage:
 *   node scripts/build-release.mjs --dry-run
 *   node scripts/build-release.mjs --dry-run --require-signature
 *   node scripts/build-release.mjs --dry-run --require-cosign
 *   node scripts/build-release.mjs --dry-run --json
 */

import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_DIR = join(ROOT, "release");
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const requireSignature = argv.includes("--require-signature");
const requireCosign = argv.includes("--require-cosign");
const keep = argv.includes("--keep");
const json = argv.includes("--json");

if (!dryRun) {
  process.stderr.write(
    "build-release: publishing is CI-only; pass --dry-run to build and verify locally\n",
  );
  process.exit(2);
}

function run(bin, args, options = {}) {
  const executable =
    process.platform === "win32" && ["npm", "npx", "corepack"].includes(bin) ? `${bin}.cmd` : bin;
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    timeout: options.timeout ?? 300_000,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runOrThrow(label, bin, args, options = {}) {
  const result = run(bin, args, options);
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u).slice(-12).join("\n");
    throw new Error(`${label} failed (exit ${result.status})\n${detail}`);
  }
  return result;
}

function commandExists(name) {
  const probe = run(process.platform === "win32" ? "where" : "which", [name]);
  return probe.status === 0;
}

/** Walk up from a resolved module until the package.json with this name. */
function findPackageJson(start, name) {
  let directory = dirname(start);
  for (let hop = 0; hop < 10; hop += 1) {
    const candidate = join(directory, "package.json");
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, "utf8"));
      if (manifest.name === name) return { path: candidate, manifest };
    }
    directory = dirname(directory);
  }
  return null;
}

function platformInfo() {
  const { platform, arch } = process;
  const isGlibc = (() => {
    if (platform !== "linux") return false;
    const report = process.report?.getReport?.();
    return typeof report === "object" && report !== null && "glibcVersionRuntime" in report.header;
  })();

  if (platform === "win32" && arch === "x64") {
    return { suffix: "win32-x64", native: "@libsql/win32-x64-msvc", os: "win32", cpu: "x64" };
  }
  if (platform === "win32" && arch === "arm64") {
    return { suffix: "win32-arm64", native: "@libsql/win32-arm64-msvc", os: "win32", cpu: "arm64" };
  }
  if (platform === "darwin") {
    return { suffix: `darwin-${arch}`, native: `@libsql/darwin-${arch}`, os: "darwin", cpu: arch };
  }
  if (platform === "linux") {
    const libc = isGlibc ? "gnu" : "musl";
    return {
      suffix: `linux-${arch}-${libc}`,
      native: `@libsql/linux-${arch}-${libc}`,
      os: "linux",
      cpu: arch,
    };
  }
  throw new Error(`unsupported release platform: ${platform}-${arch}`);
}

function resolveNative() {
  const platform = platformInfo();
  const engineRequire = createRequire(join(ROOT, "packages", "core-engine", "package.json"));
  const clientMain = engineRequire.resolve("@libsql/client");
  const client = findPackageJson(clientMain, "@libsql/client");
  if (client === null) throw new Error("@libsql/client package.json not found");

  const clientRequire = createRequire(client.path);
  const libsqlMain = clientRequire.resolve("libsql");
  const libsql = findPackageJson(libsqlMain, "libsql");
  if (libsql === null) throw new Error("libsql package.json not found");

  const libsqlRequire = createRequire(libsql.path);
  const nativeMain = libsqlRequire.resolve(platform.native);
  const native = findPackageJson(nativeMain, platform.native);
  if (native === null) throw new Error(`${platform.native} package.json not found`);

  const nodeFile = join(dirname(native.path), "index.node");
  if (!existsSync(nodeFile)) throw new Error(`native addon missing: ${nodeFile}`);
  return { platform, nodeFile, nativeVersion: native.manifest.version };
}

function buildPackages() {
  for (const pkg of ["@chronos-ctx/shared-types", "@chronos-ctx/core-engine", "@chronos-ctx/cli"]) {
    runOrThrow(`build ${pkg}`, "corepack", ["pnpm", "-F", pkg, "build"]);
  }
}

function buildBundle(outDir) {
  mkdirSync(outDir, { recursive: true });
  runOrThrow(
    "bundle",
    "corepack",
    ["pnpm", "exec", "vite", "build", "--config", "scripts/release/vite.config.mjs"],
    {
      env: { CHRONOS_RELEASE_OUT: outDir },
    },
  );
  const bundle = join(outDir, "index.cjs");
  if (!existsSync(bundle)) throw new Error("bundle did not produce dist/index.cjs");
  return bundle;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function workspaceVersion(path) {
  const manifest = readJson(join(path, "package.json"));
  return manifest.version ?? "0.0.0";
}

function flattenTree(tree, out = new Map()) {
  for (const [name, dependency] of Object.entries(tree ?? {})) {
    const version = dependency.version?.startsWith("link:")
      ? workspaceVersion(dependency.path)
      : dependency.version;
    if (typeof version === "string" && version.length > 0) {
      out.set(`${name}@${version}`, { name, version });
    }
    flattenTree(dependency.dependencies, out);
  }
  return out;
}

function purl(name, version) {
  return `pkg:npm/${name.replace(/^@/u, "%40")}@${version}`;
}

function buildSbom(platform, version, components) {
  const componentList = [...components.values()]
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`))
    .map((component) => ({
      type: "library",
      name: component.name,
      version: component.version,
      purl: purl(component.name, component.version),
    }));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: new Date().toISOString(),
      tools: [{ vendor: "ChronosCtx", name: "build-release", version }],
      component: {
        type: "application",
        name: `@chronos-ctx/${platform.suffix}`,
        version,
        purl: purl(`@chronos-ctx/${platform.suffix}`, version),
        licenses: [{ license: { id: "Apache-2.0" } }],
      },
    },
    components: componentList,
  };
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function signArtifact(file) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const bytes = readFileSync(file);
  const signature = sign(null, bytes, privateKey);
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signaturePath = `${file}.sig`;
  const publicPath = `${file}.pub`;
  writeFileSync(signaturePath, `${signature.toString("base64")}\n`);
  writeFileSync(publicPath, publicPem);

  const verified = verify(null, bytes, createPublicKey(publicPem), signature);
  return {
    algorithm: "ed25519",
    kind: "local-dry-run",
    verified,
    signature_path: basename(signaturePath),
    public_key_path: basename(publicPath),
    public_key_pem: publicPem.trim(),
    release_attestation: false,
    note: "Dry-run signature proves the sign/verify path. CI replaces it with Cosign keyless provenance.",
  };
}

function installAndSmoke(tarball, platformPackage, version) {
  const consumer = mkdtempSync(join(tmpdir(), "chronos-release-consumer-"));
  const home = mkdtempSync(join(tmpdir(), "chronos-release-home-"));
  try {
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify(
        { name: "chronos-release-consumer", version: "1.0.0", private: true },
        null,
        2,
      ),
    );

    runOrThrow(
      "install tarball",
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", tarball],
      { cwd: consumer },
    );

    const ls = runOrThrow("npm ls", "npm", ["ls", "--all", "--omit=dev", "--json"], {
      cwd: consumer,
    });
    const tree = JSON.parse(ls.stdout);
    const packages = [];
    (function walk(dependencies) {
      for (const [name, dependency] of Object.entries(dependencies ?? {})) {
        packages.push({ name, version: dependency.version });
        walk(dependency.dependencies);
      }
    })(tree.dependencies);

    const installedManifestPath = join(
      consumer,
      "node_modules",
      ...platformPackage.split("/"),
      "package.json",
    );
    const installed = readJson(installedManifestPath);
    const dependencyCount = Object.keys(installed.dependencies ?? {}).length;
    const scriptCount = Object.keys(installed.scripts ?? {}).length;

    const binPath = join(
      consumer,
      "node_modules",
      ...platformPackage.split("/"),
      "bin",
      "chronos.cjs",
    );
    const env = { CHRONOS_HOME: home };
    const versionRun = runOrThrow("packaged --version", "node", [binPath, "--version"], { env });
    const versionOutput = versionRun.stdout.trim();
    if (!versionOutput.includes(version)) {
      throw new Error(`packaged --version returned "${versionOutput}", expected ${version}`);
    }

    // Exercise the native database through the packaged bin, not a workspace
    // binary: this is what proves the tarball is self-contained.
    const migrate = runOrThrow("packaged migrate", "node", [binPath, "migrate"], { env });
    const check = runOrThrow("packaged migrate --check", "node", [binPath, "migrate", "--check"], {
      env,
    });

    const npx = run("npx", ["--no-install", "chronos", "--version"], { cwd: consumer, env });
    const npxVersion = npx.status === 0 ? npx.stdout.trim() : null;

    return {
      installedPackages: packages.length,
      packages,
      dependencyCount,
      scriptCount,
      version: versionOutput,
      migrate: migrate.stdout.trim().split(/\r?\n/u).slice(-1)[0] ?? "",
      migrateCheck: check.stdout.trim().split(/\r?\n/u).slice(-1)[0] ?? "",
      npxVersion,
      npxResolved: npxVersion !== null,
    };
  } finally {
    if (!keep) {
      rmSync(consumer, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

function main() {
  const started = Date.now();
  const version = readJson(join(ROOT, "packages", "cli", "package.json")).version ?? "0.0.0";
  const { platform, nodeFile } = resolveNative();
  const platformPackage = `@chronos-ctx/${platform.suffix}`;

  rmSync(RELEASE_DIR, { recursive: true, force: true });
  mkdirSync(RELEASE_DIR, { recursive: true });
  const stage = join(RELEASE_DIR, "stage");
  const stageDist = join(stage, "dist");
  mkdirSync(join(stage, "bin"), { recursive: true });
  mkdirSync(stageDist, { recursive: true });

  buildPackages();
  const bundle = buildBundle(stageDist);
  cpSync(nodeFile, join(stageDist, "index.node"));
  cpSync(join(ROOT, "packages", "core-engine", "migrations"), join(stage, "migrations"), {
    recursive: true,
  });

  writeFileSync(
    join(stage, "bin", "chronos.cjs"),
    [
      "#!/usr/bin/env node",
      '"use strict";',
      "// The bundled libSQL build loads its native addon from the bundle directory.",
      'process.env.LIBSQL_JS_DEV = "1";',
      'require("../dist/index.cjs");',
      "",
    ].join("\n"),
  );
  if (process.platform !== "win32") chmodSync(join(stage, "bin", "chronos.cjs"), 0o755);

  const dependencyTree = JSON.parse(
    runOrThrow("dependency tree", "corepack", [
      "pnpm",
      "-F",
      "@chronos-ctx/cli",
      "list",
      "--prod",
      "--json",
      "--depth",
      "Infinity",
    ]).stdout,
  );
  const components = flattenTree(dependencyTree[0]?.dependencies);
  const sbom = buildSbom(platform, version, components);
  writeFileSync(join(stage, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

  writeFileSync(
    join(stage, "package.json"),
    `${JSON.stringify(
      {
        name: platformPackage,
        version,
        description: `ChronosCtx self-contained bundle for ${platform.os}-${platform.cpu}`,
        license: "Apache-2.0",
        os: [platform.os],
        cpu: [platform.cpu],
        engines: { node: ">=22.15" },
        bin: { chronos: "./bin/chronos.cjs" },
        files: ["bin", "dist", "migrations", "sbom.cdx.json"],
      },
      null,
      2,
    )}\n`,
  );

  const packed = runOrThrow(
    "npm pack",
    "npm",
    ["pack", "--json", "--pack-destination", RELEASE_DIR],
    {
      cwd: stage,
    },
  );
  const packInfo = JSON.parse(packed.stdout);
  const tarball = join(RELEASE_DIR, packInfo[0].filename);
  const digest = sha256(tarball);
  const signature = signArtifact(tarball);

  if (requireCosign && !commandExists("cosign")) {
    throw new Error(
      "--require-cosign was set but cosign is not on PATH; release provenance must be signed in CI",
    );
  }
  if (requireSignature && !signature.verified) {
    throw new Error("artifact signature did not verify");
  }

  const smoke = installAndSmoke(tarball, platformPackage, version);
  const contractOk =
    smoke.installedPackages === 1 &&
    smoke.dependencyCount === 0 &&
    smoke.scriptCount === 0 &&
    signature.verified;

  const report = {
    schema_version: 1,
    dry_run: true,
    result: contractOk ? "PASS" : "FAIL",
    platform: {
      os: platform.os,
      cpu: platform.cpu,
      package: platformPackage,
      native: platform.native,
    },
    artifact: {
      tarball: basename(tarball),
      bytes: packInfo[0].size,
      files: packInfo[0].entryCount,
      sha256: digest,
      bundle_bytes: readFileSync(bundle).byteLength,
      sbom: "sbom.cdx.json",
      sbom_components: sbom.components.length,
    },
    signature,
    provenance: {
      kind: "local-ed25519-dry-run",
      verified: signature.verified,
      release_attestation: false,
      cosign_available: commandExists("cosign"),
      note: "CI must replace this with Cosign keyless provenance; gate 6.18 requires it.",
    },
    install_contract: {
      packages: smoke.installedPackages,
      transitive: smoke.installedPackages - 1,
      lifecycle_scripts: smoke.scriptCount,
      dependencies_declared: smoke.dependencyCount,
    },
    smoke: {
      version: smoke.version,
      migrate: smoke.migrate,
      migrate_check: smoke.migrateCheck,
      npx_resolved: smoke.npxResolved,
      npx_version: smoke.npxVersion,
    },
    elapsed_ms: Date.now() - started,
  };

  writeFileSync(join(RELEASE_DIR, "release.json"), `${JSON.stringify(report, null, 2)}\n`);

  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("release dry-run\n");
    process.stdout.write(`  platform       ${platformPackage} (${platform.os}-${platform.cpu})\n`);
    process.stdout.write(
      `  tarball        ${report.artifact.tarball} (${report.artifact.bytes} bytes, ${report.artifact.files} files)\n`,
    );
    process.stdout.write(`  sha256         ${digest}\n`);
    process.stdout.write(
      `  sbom           ${report.artifact.sbom} (${report.artifact.sbom_components} components)\n`,
    );
    process.stdout.write(
      `  signature      ${signature.algorithm} ${signature.verified ? "verified" : "FAILED"} ` +
        `(${signature.kind}; not a release attestation)\n`,
    );
    process.stdout.write(
      `  install        ${smoke.installedPackages} package, ${smoke.installedPackages - 1} transitive, ` +
        `${smoke.scriptCount} lifecycle scripts\n`,
    );
    process.stdout.write(
      `  smoke          --version ${smoke.version}; ${smoke.migrate}; ${smoke.migrateCheck}` +
        `${smoke.npxResolved ? `; npx ${smoke.npxVersion}` : "; npx unresolved"}\n`,
    );
    process.stdout.write(`  result         ${report.result}\n`);
  }

  if (!keep) rmSync(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  if (!contractOk) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `build-release: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
