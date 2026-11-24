# ADR-0028 — Release artifact: one self-contained platform package

- **Status:** Accepted (Phase 1, 2026-11-24)
- **Related:** ADR-0025 (supply-chain model), ADR-0027 (daemon security), roadmap §3.5, gate 1.17
- **Evidence:** `scripts/build-release.mjs --dry-run`, `scripts/release/vite.config.mjs`, `release/release.json` (generated)

## Context

The install-time contract is hard: a user must resolve **1 package, 0 transitive dependencies and 0 lifecycle scripts**. The CLI is written in TypeScript and depends on `commander`, `drizzle-orm`, `zod`, `@libsql/client` and the native `libsql` addon. Shipping that dependency graph to npm would violate the contract on the first install.

The native addon is the difficult part. `libsql` loads `@libsql/<target>/index.node` at runtime. A JavaScript bundler cannot inline a `.node` file, and a post-install download would reintroduce the install-time trust the contract exists to remove.

## Decision

### 1. One package per OS/architecture, containing the whole application

`scripts/build-release.mjs --dry-run` stages `@chronos-ctx/<platform>` (for example `@chronos-ctx/win32-x64`) with:

- `dist/index.cjs` — a Vite/Rollup bundle of the CLI, core engine, shared types and every pure-JS dependency;
- `dist/index.node` — the native libSQL addon for that platform;
- `migrations/0001_init.sql` — the normative DDL;
- `bin/chronos.cjs` — a launcher that sets `LIBSQL_JS_DEV=1` and requires the bundle;
- `sbom.cdx.json` — a CycloneDX 1.5 SBOM of the bundled components;
- a `package.json` with **no `dependencies` and no `scripts`**.

`LIBSQL_JS_DEV=1` selects `libsql`'s documented development path, which loads `index.node` from the bundle directory instead of resolving `@libsql/<target>`. That is what makes a single package self-contained without patching the addon loader.

The engine resolves migrations by probing the source layout (`../../migrations`), the bundled layout (`../migrations`) and `CHRONOS_MIGRATIONS_DIR`. A packaged install therefore works without a second package or a working-directory assumption.

### 2. The dry run measures the contract, not a fixture

The script packs the staged directory with `npm pack`, installs the tarball into a clean temporary consumer with `--ignore-scripts`, and asserts:

- `npm ls --all --omit=dev` reports exactly **1** package;
- the installed manifest declares **0** dependencies and **0** lifecycle scripts;
- `npx --no-install chronos --version` resolves and prints the package version;
- `chronos migrate` and `chronos migrate --check` run through the packaged bin, which exercises the native addon and the bundled migrations.

The Phase 0 fixture proved the shape with a stub. This gate proves the real artifact.

### 3. SBOM and signature

The SBOM lists the production dependency tree of `@chronos-ctx/cli` flattened from `pnpm list --prod --depth Infinity`, deduplicated by `name@version`.

A dry run signs the tarball with a fresh Ed25519 key and verifies the signature immediately. The report labels it `local-dry-run` and `release_attestation: false`: it proves the sign/verify path, not who built the artifact. CI replaces it with Cosign keyless provenance. `--require-cosign` makes the absence of Cosign fatal, so a release pipeline cannot silently fall back to the dry-run key.

## Alternatives considered

| Alternative | Why rejected |
| --- | --- |
| Ship `node_modules` inside the tarball | `npm ls` still walks it; the installed tree is not one package, and the layout breaks on hoisting. |
| Download the native addon in `postinstall` | Reintroduces install-time execution and network resolution, which the contract forbids. |
| Add `esbuild` as a ninth direct build dependency | The build-time budget is ≤ 8 direct (ADR-0025). Vite is already present and uses esbuild/Rollup internally. |
| Node SEA / single executable | Still needs a platform-specific Node binary and an embedding step per target; the native addon path is not simpler. |
| Treat the Ed25519 dry-run key as release provenance | A self-signed ephemeral key proves integrity, not identity. The report says so, and CI requires Cosign. |
| Publish the platform package with the native addon as an `optionalDependency` | The user would resolve a second package, breaking the one-package claim. The wrapper/platform split is the Phase 6 model, not the Phase 1 artifact. |

## Consequences

- The artifact is larger (the reference Windows bundle is ~0.8 MB of JavaScript plus the native addon) but installs with no resolution step.
- The release matrix must build one package per OS/architecture. A dry run only builds the host platform; CI builds the rest.
- `LIBSQL_JS_DEV=1` is set by the launcher, not the user. Importing `dist/index.cjs` directly on another platform is unsupported.
- The migration directory probe makes packaging tolerant of layout changes, but a missing directory fails loudly with `INTERNAL` and the searched paths.
- The SBOM describes the source dependency tree, not byte ranges inside the bundle. It is an inventory, not a reproducibility proof; the tarball SHA-256 is the byte-level identity.
- Gate 1.17 passes on the install contract, SBOM and signature verification. Cosign keyless provenance remains a CI/release requirement (gate 6.18) and is explicitly reported as deferred in a local dry run.
