# Architecture Decision Records

One file per decision. Status is one of **Proposed**, **Accepted**, **Superseded** or **Rejected**. An accepted ADR is binding on the implementation; changing it requires a new ADR that names the evidence which changed.

The canonical decision list is Appendix B of `roadmap.md`. This index tracks which files exist - a decision with no file is not yet written, and the Phase 6 gate requires all 28.

## Phase 1 set

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-daemon-first-single-writer.md) | Daemon-first, single-writer architecture with stdio proxy | Accepted |
| [0002](0002-libsql-drizzle-migrations.md) | libSQL/SQLite storage, forward-only migrations, Drizzle mirror | Accepted |
| [0003](0003-ulid-typed-prefixes.md) | ULID identifiers with typed prefixes | Accepted |
| [0004](0004-shadow-repository-object-store.md) | Dedicated shadow git repository; home vs. portable object store | Accepted |
| [0005](0005-epistemic-gate.md) | Epistemic demotion on content mutation; evidence-only promotion | Accepted |
| [0006](0006-seven-tools-lean-profile.md) | Seven MCP tools, flagged eighth, lean profile | Accepted |
| [0007](0007-deterministic-distillation.md) | Deterministic distillation default; LLM distiller opt-in | Accepted |
| [0008](0008-budgets-truncation.md) | Token budgets, envelope accounting, deterministic truncation | Accepted |
| [0009](0009-capsule-v1.md) | Capsule v1 format, freshness markers, render hash | Accepted |
| [0013](0013-project-global-versions.md) | Project-global version semantics and fork lineage | Accepted |
| [0014](0014-tree-bound-freshness.md) | Tree-bound verification and computed freshness | Accepted |
| [0015](0015-typed-edges.md) | Typed `node_edges` layer and orphan reporting | Accepted |
| [0016](0016-single-authoritative-head.md) | One authoritative head; no denormalized project head | Accepted |
| [0017](0017-content-addressed-snapshots.md) | Content-addressed snapshots with schema-level dedupe | Accepted |
| [0018](0018-atomic-checkpoint-transaction.md) | Atomic checkpoint transaction and `snapshot_kind` semantics | Accepted |
| [0025](0025-supply-chain-model.md) | Supply-chain model and the Phase 0 swap decisions | Accepted |
| [0026](0026-snapshot-mechanism.md) | Incremental manifest snapshot mechanism | Accepted |
| [0027](0027-daemon-transport-security.md) | Loopback `Host`/`Origin` guard, scrypt bearer tokens, filesystem probe | Accepted |
| [0028](0028-release-artifact.md) | One self-contained platform package, Vite bundle, native addon beside the bundle, SBOM and dry-run signature | Accepted |

## Not yet written

0010 (rewind safety policy), 0011 (auto-fork on sync conflict), 0012 (extension scope), 0019 (enforcement tiers), 0020 (side-effect ledger), 0021 (conformance suite), 0023–0024, and any Phase 3+ decisions. Each is written when its owning phase begins, per Appendix B. **0022** (runtime security) is superseded by ADR-0027, which records the implemented guard, token and probe contract.
