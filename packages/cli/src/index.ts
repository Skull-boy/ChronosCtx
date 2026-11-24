#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BootService,
  CapsuleService,
  countCheckpoints,
  DaemonServer,
  type Engine,
  getProjectById,
  isTokenScope,
  measureSurface,
  openEngine,
  PageInService,
  type Project,
  probeFilesystem,
  type TokenScope,
  TokenStore,
  verifyCapsuleDocument,
} from "@chronos-ctx/core-engine";
import { ChronosError, toToolErrorBody } from "@chronos-ctx/shared-types";
import { Command } from "commander";

interface PackageManifest {
  version: string;
}

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

const jsonRequested = process.argv.includes("--json");

function report(error: unknown): void {
  if (jsonRequested) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: toToolErrorBody(error) }, null, 2)}\n`,
    );
    return;
  }
  if (error instanceof ChronosError) {
    process.stderr.write(`chronos: ${error.code}: ${error.message}\n`);
    if (error.hint !== undefined) process.stderr.write(`         hint: ${error.hint}\n`);
    return;
  }
  process.stderr.write(`chronos: ${error instanceof Error ? error.message : String(error)}\n`);
}

async function projectByRef(engine: Engine, reference: string): Promise<Project> {
  const project = reference.startsWith("prj_")
    ? await getProjectById(engine.db, reference)
    : await engine.projects.bySlug(reference);
  if (project === null) {
    throw new ChronosError("PROJECT_NOT_FOUND", `project "${reference}" does not exist`);
  }
  return project;
}

function tokenStore(engine: Engine): TokenStore {
  return new TokenStore({
    file: join(engine.config.paths.tokens, "tokens.json"),
    clock: engine.clock,
  });
}

const program = new Command();
program
  .name("chronos")
  .description("ChronosCtx — stateful context and time travel for LLM coding agents")
  .version(manifest.version, "-v, --version");

program
  .command("migrate")
  .description("apply forward migrations, or report pending ones with --check/--dry-run")
  .option("--check", "report pending migrations without applying them", false)
  .option("--dry-run", "alias for --check", false)
  .option("--to <version>", "apply migrations up to this level only")
  .option("--json", "machine-readable output", false)
  .action(async (options: { check: boolean; dryRun: boolean; to?: string; json: boolean }) => {
    const dryRun = options.check || options.dryRun;
    let target: number | undefined;
    if (options.to !== undefined) {
      target = Number(options.to);
      if (!Number.isInteger(target) || target < 0) {
        throw new ChronosError(
          "UNSUPPORTED",
          `--to expects a non-negative integer, got "${options.to}"`,
        );
      }
    }
    const engine = await openEngine({ migrate: false });
    try {
      const result = await engine.migrate(
        target === undefined ? { dryRun } : { dryRun, to: target },
      );
      const pending = result.pending.map((migration) => ({
        version: migration.version,
        name: migration.name,
      }));

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: pending.length === 0,
              from: result.from,
              to: result.to,
              applied: result.applied,
              pending,
              dry_run: dryRun,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(`schema: ${result.from} -> ${result.to}\n`);
        if (dryRun) {
          process.stdout.write(
            pending.length === 0
              ? "migrations: up to date\n"
              : `migrations: ${pending.length} pending (${pending.map((m) => m.name).join(", ")})\n`,
          );
        } else {
          process.stdout.write(
            result.applied.length === 0
              ? "migrations: already up to date\n"
              : `migrations: applied ${result.applied.map((m) => `${m.version}:${m.name}`).join(", ")}\n`,
          );
        }
      }

      if (dryRun && pending.length > 0) process.exitCode = 1;
    } finally {
      engine.close();
    }
  });

program
  .command("doctor")
  .description("check the database, pragmas, schema level and runtime prerequisites")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    const engine = await openEngine({ migrate: false });
    try {
      const status = await engine.status();
      const [major, minor] = process.versions.node.split(".").map(Number);
      const nodeOk = (major ?? 0) > 22 || ((major ?? 0) === 22 && (minor ?? 0) >= 15);
      const checks = [
        {
          name: "node",
          ok: nodeOk,
          detail: `${process.versions.node} (requires >= 22.15)`,
        },
        {
          name: "schema",
          ok: !status.schema.pending,
          detail: `v${status.schema.current} (latest ${status.schema.latest})`,
        },
        {
          name: "journal_mode",
          ok: status.database.journalMode === "wal",
          detail: status.database.journalMode,
        },
        {
          name: "foreign_keys",
          ok: status.database.foreignKeys,
          detail: status.database.foreignKeys ? "on" : "off",
        },
        {
          name: "busy_timeout",
          ok: status.database.busyTimeoutMs === 5000,
          detail: `${status.database.busyTimeoutMs} ms`,
        },
      ];
      const ok = checks.every((check) => check.ok);

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ok,
              version: manifest.version,
              home: status.config.home,
              database: status.database,
              schema: status.schema,
              checks,
            },
            null,
            2,
          )}\n`,
        );
      } else {
        process.stdout.write(`chronos ${manifest.version}\n`);
        process.stdout.write(`  home      ${status.config.home}\n`);
        process.stdout.write(`  database  ${status.database.file}\n`);
        for (const check of checks) {
          process.stdout.write(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}: ${check.detail}\n`);
        }
        process.stdout.write(ok ? "\nall checks passed\n" : "\none or more checks failed\n");
      }

      if (!ok) process.exitCode = 1;
    } finally {
      engine.close();
    }
  });

program
  .command("boot <project>")
  .description("print the bounded boot index")
  .option("-b, --branch <branch>", "branch name")
  .option("--max-tokens <n>", "token budget", (value: string) => Number(value))
  .option("--summaries", "include node summaries", false)
  .option("--json", "machine-readable output", false)
  .action(
    async (
      reference: string,
      options: { branch?: string; maxTokens?: number; summaries: boolean; json: boolean },
    ) => {
      const engine = await openEngine();
      try {
        const project = await projectByRef(engine, reference);
        const boot = new BootService({ db: engine.db });
        const result = await boot.boot({
          projectId: project.id,
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          includeSummaries: options.summaries,
        });
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        } else {
          process.stdout.write(`${result.text}\n`);
        }
      } finally {
        engine.close();
      }
    },
  );

program
  .command("page-in <project>")
  .description("page in node detail within a token budget")
  .option("-b, --branch <branch>", "branch name")
  .option("-p, --path <paths...>", "node paths (space separated)")
  .option("--max-tokens <n>", "token budget", (value: string) => Number(value))
  .option("--format <format>", "markdown or json", "markdown")
  .option("--json", "machine-readable output", false)
  .action(
    async (
      reference: string,
      options: {
        branch?: string;
        path?: string[];
        maxTokens?: number;
        format: string;
        json: boolean;
      },
    ) => {
      if (options.path === undefined || options.path.length === 0) {
        throw new ChronosError("PATH_INVALID", "page-in requires at least one --path");
      }
      const engine = await openEngine();
      try {
        const project = await projectByRef(engine, reference);
        const pager = new PageInService({ db: engine.db });
        const result = await pager.pageIn({
          projectId: project.id,
          paths: options.path,
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          format: options.format === "json" ? "json" : "markdown",
        });
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        } else {
          process.stdout.write(`${result.text}\n`);
        }
      } finally {
        engine.close();
      }
    },
  );

program
  .command("surface")
  .description("measure the MCP tool surface against the token budget")
  .option("--profile <profile>", "full or lean", "full")
  .option("--json", "machine-readable output", false)
  .action((options: { profile: string; json: boolean }) => {
    if (options.profile !== "full" && options.profile !== "lean") {
      throw new ChronosError("UNSUPPORTED", `unknown profile "${options.profile}"`);
    }
    const measurement = measureSurface(options.profile);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ...measurement }, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `profile ${measurement.profile}: ${measurement.tools} tools, ${measurement.total_tokens} tokens\n`,
    );
    process.stdout.write(
      `  instructions ${measurement.instructions_tokens} · schemas ${measurement.schema_tokens}\n`,
    );
    process.stdout.write(
      `  target ${measurement.target} · hard ${measurement.hard_cap} · lean ${measurement.lean_cap}\n`,
    );
    for (const tool of measurement.per_tool) {
      process.stdout.write(`  ${tool.name}  ${tool.tokens}\n`);
    }
    const verdict = measurement.within_target
      ? "within target"
      : measurement.within_hard
        ? "within hard cap"
        : "OVER HARD CAP";
    process.stdout.write(`  ${verdict}\n`);
    if (!measurement.within_hard) process.exitCode = 1;
  });

const capsuleCommand = program
  .command("capsule")
  .description("render and verify re-hydration capsules");

capsuleCommand
  .command("export <project>")
  .description("render a capsule from a checkpoint snapshot")
  .option("-b, --branch <branch>", "branch name")
  .option("-c, --checkpoint <id>", "checkpoint id (defaults to the branch head)")
  .option("--max-tokens <n>", "token budget", (value: string) => Number(value))
  .option("--objective <text>", "override the objective line")
  .option("--out <file>", "write to a file (.json writes text + JSON)")
  .option("--json", "machine-readable output", false)
  .action(
    async (
      reference: string,
      options: {
        branch?: string;
        checkpoint?: string;
        maxTokens?: number;
        objective?: string;
        out?: string;
        json: boolean;
      },
    ) => {
      const engine = await openEngine();
      try {
        const project = await projectByRef(engine, reference);
        const capsule = new CapsuleService({ db: engine.db });
        const result = await capsule.export({
          projectId: project.id,
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          ...(options.checkpoint === undefined ? {} : { checkpointId: options.checkpoint }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.objective === undefined ? {} : { objective: options.objective }),
        });

        if (options.out !== undefined) {
          const asJson = options.out.toLowerCase().endsWith(".json");
          writeFileSync(
            options.out,
            asJson
              ? `${JSON.stringify({ text: result.text, capsule: result.capsule }, null, 2)}\n`
              : result.text,
            "utf8",
          );
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        } else if (options.out === undefined) {
          process.stdout.write(`${result.text}\n`);
        } else {
          process.stdout.write(
            `capsule written to ${options.out} (${result.tokens} tokens, ${result.capsule.render_hash})\n`,
          );
        }
      } finally {
        engine.close();
      }
    },
  );

capsuleCommand
  .command("verify <file>")
  .description("recompute a capsule render hash and refuse a doctored file")
  .option("--hash <hash>", "expected render hash")
  .option("--json", "machine-readable output", false)
  .action((file: string, options: { hash?: string; json: boolean }) => {
    const content = readFileSync(file, "utf8");
    const verification = verifyCapsuleDocument(content, options.hash ?? null);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ...verification }, null, 2)}\n`);
    } else {
      process.stdout.write(`render_hash ${verification.computed}\n`);
      if (verification.expected !== null) {
        process.stdout.write(`expected    ${verification.expected}\n`);
      }
      if (verification.reason !== null) process.stdout.write(`${verification.reason}\n`);
      process.stdout.write(verification.ok ? "ok\n" : "FAILED\n");
    }
    if (!verification.ok) process.exitCode = 1;
  });

program
  .command("stats")
  .description("snapshot dedupe and checkpoint counts")
  .option("--dedupe", "report dedupe savings explicitly", false)
  .option("-p, --project <slug>", "limit to one project")
  .option("--json", "machine-readable output", false)
  .action(async (options: { dedupe: boolean; project?: string; json: boolean }) => {
    const engine = await openEngine();
    try {
      const projects =
        options.project === undefined
          ? await engine.projects.list()
          : [await engine.projects.bySlug(options.project)];
      if (projects.some((row) => row === null)) {
        throw new ChronosError("PROJECT_NOT_FOUND", `project "${options.project}" does not exist`);
      }

      const rows = [];
      for (const project of projects) {
        if (project === null) continue;
        const snapshots = await engine.snapshots.stats(project.id);
        const checkpoints = await countCheckpoints(engine.db, project.id);
        rows.push({
          slug: project.slug,
          project_id: project.id,
          checkpoints,
          snapshot_rows: snapshots.rows,
          distinct_content_roots: snapshots.distinctContentRoots,
          snapshot_bytes: snapshots.bytes,
          deduped_snapshots: Math.max(0, checkpoints - snapshots.rows),
        });
      }

      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, projects: rows }, null, 2)}\n`);
      } else if (rows.length === 0) {
        process.stdout.write("no projects\n");
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${row.slug}  checkpoints=${row.checkpoints}  snapshots=${row.snapshot_rows}  ` +
              `roots=${row.distinct_content_roots}  deduped=${row.deduped_snapshots}  ` +
              `bytes=${row.snapshot_bytes}\n`,
          );
        }
      }
    } finally {
      engine.close();
    }
  });

const daemon = program.command("daemon").description("run and inspect the loopback daemon");

daemon
  .command("probe <path>")
  .description("classify a path and report whether it is safe for CHRONOS_HOME")
  .option("--json", "machine-readable output", false)
  .action((path: string, options: { json: boolean }) => {
    const result = probeFilesystem(path);
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ ok: result.safe, ...result }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.path}\n`);
      process.stdout.write(`  kind      ${result.kind}\n`);
      process.stdout.write(`  fs_type   ${result.fs_type ?? "unknown"}\n`);
      process.stdout.write(`  safe      ${result.safe ? "yes" : "NO"}\n`);
      process.stdout.write(`  evidence  ${result.evidence}\n`);
      if (!result.safe && result.remediation !== undefined) {
        process.stdout.write(`  fix       ${result.remediation}\n`);
      }
    }
    if (!result.safe) process.exitCode = 1;
  });

daemon
  .command("serve")
  .description("serve the loopback HTTP API in the foreground")
  .option(
    "--port <n>",
    "port to bind (0 selects an ephemeral port)",
    (value: string) => Number(value),
    4870,
  )
  .option(
    "--idle <seconds>",
    "shut down after this many idle seconds (0 disables)",
    (value: string) => Number(value),
    0,
  )
  .option("--anonymous", "allow requests without a bearer token (local testing only)", false)
  .option("--json", "machine-readable startup output", false)
  .action(async (options: { port: number; idle: number; anonymous: boolean; json: boolean }) => {
    const engine = await openEngine();
    let server: DaemonServer | undefined;
    try {
      const tokens = tokenStore(engine);
      if (!options.anonymous && (await tokens.list()).length === 0) {
        throw new ChronosError("UNAUTHORIZED", "no daemon tokens exist", {
          hint:
            "run `chronos token issue --label local --scope read --scope write` first, " +
            "or pass --anonymous for a throwaway loopback session",
        });
      }

      server = new DaemonServer({
        engine,
        tokens,
        allowAnonymous: options.anonymous,
        port: options.port,
        idleTimeoutMs: Math.max(0, options.idle) * 1000,
        version: manifest.version,
        logger: (event) => {
          if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
        },
      });
      const { url, port } = await server.start();

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, url, port, anonymous: options.anonymous })}\n`,
        );
      } else {
        process.stdout.write(`chronos daemon listening on ${url}\n`);
        if (options.anonymous) {
          process.stdout.write(
            "warning: anonymous loopback access is enabled; use only for local testing\n",
          );
        }
      }

      await new Promise<void>((resolve) => {
        const shutdown = (): void => resolve();
        process.once("SIGINT", shutdown);
        process.once("SIGTERM", shutdown);
      });
    } finally {
      if (server !== undefined) await server.stop();
      engine.close();
    }
  });

const token = program.command("token").description("issue, list and revoke daemon bearer tokens");

token
  .command("issue")
  .description("issue a scoped token; the plaintext is printed once")
  .option("--label <label>", "human-readable label", "local")
  .option("--scope <scope...>", "scopes: read, write, admin", ["read"])
  .option("--expires-in <days>", "expiry in days (omit for no expiry)", (value: string) =>
    Number(value),
  )
  .option("--json", "machine-readable output", false)
  .action(
    async (options: { label: string; scope: string[]; expiresIn?: number; json: boolean }) => {
      const scopes: TokenScope[] = options.scope.map((scope) => {
        if (!isTokenScope(scope)) {
          throw new ChronosError("INVALID_REQUEST", `unknown token scope "${scope}"`);
        }
        return scope;
      });

      const engine = await openEngine();
      try {
        const store = tokenStore(engine);
        const now = engine.clock.now();
        const expiresAt =
          options.expiresIn === undefined ? null : now + options.expiresIn * 86_400_000;
        if (expiresAt !== null && !(expiresAt > now)) {
          throw new ChronosError(
            "INVALID_REQUEST",
            "--expires-in must be a positive number of days",
          );
        }

        const issued = await store.issue({ label: options.label, scopes, expiresAt });
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({ ok: true, token: issued.token, ...issued.metadata }, null, 2)}\n`,
          );
        } else {
          process.stdout.write(`token ${issued.token}\n`);
          process.stdout.write(`  id       ${issued.metadata.id}\n`);
          process.stdout.write(`  scopes   ${issued.metadata.scopes.join(", ")}\n`);
          process.stdout.write(
            `  expires  ${
              issued.metadata.expires_at === null
                ? "never"
                : new Date(issued.metadata.expires_at).toISOString()
            }\n`,
          );
          process.stdout.write("\nstore this token now; it cannot be recovered\n");
        }
      } finally {
        engine.close();
      }
    },
  );

token
  .command("list")
  .description("list token metadata without secrets")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    const engine = await openEngine();
    try {
      const rows = await tokenStore(engine).list();
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, tokens: rows }, null, 2)}\n`);
      } else if (rows.length === 0) {
        process.stdout.write("no tokens\n");
      } else {
        for (const row of rows) {
          process.stdout.write(
            `${row.id}  ${row.label}  ${row.scopes.join(",")}  ` +
              `${row.expired ? "expired" : row.expires_at === null ? "never" : new Date(row.expires_at).toISOString()}\n`,
          );
        }
      }
    } finally {
      engine.close();
    }
  });

token
  .command("revoke <id>")
  .description("revoke a token by id")
  .option("--json", "machine-readable output", false)
  .action(async (id: string, options: { json: boolean }) => {
    const engine = await openEngine();
    try {
      const revoked = await tokenStore(engine).revoke(id);
      if (!revoked) {
        throw new ChronosError("INVALID_REQUEST", `token ${id} does not exist`);
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, revoked: id }, null, 2)}\n`);
      } else {
        process.stdout.write(`revoked ${id}\n`);
      }
    } finally {
      engine.close();
    }
  });

const project = program.command("project").description("create, list and fork projects");

project
  .command("create <slug>")
  .description("create a project and its default branch")
  .option("-n, --name <name>", "human-readable name")
  .option("-b, --default-branch <branch>", "default branch name", "main")
  .option("-w, --workspace <path>", "workspace root (local only, never synced)")
  .option("--json", "machine-readable output", false)
  .action(
    async (
      slug: string,
      options: { name?: string; defaultBranch: string; workspace?: string; json: boolean },
    ) => {
      const engine = await openEngine();
      try {
        const created = await engine.projects.create({
          slug,
          name: options.name ?? slug,
          defaultBranch: options.defaultBranch,
          workspaceRoot: options.workspace ?? null,
        });
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              { ok: true, project: created.project, branch: created.branch },
              null,
              2,
            )}\n`,
          );
        } else {
          process.stdout.write(
            `${created.project.slug}  ${created.project.id}  (branch ${created.branch.name})\n`,
          );
        }
      } finally {
        engine.close();
      }
    },
  );

project
  .command("list")
  .description("list projects")
  .option("--json", "machine-readable output", false)
  .action(async (options: { json: boolean }) => {
    const engine = await openEngine();
    try {
      const projects = await engine.projects.list();
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, projects }, null, 2)}\n`);
      } else if (projects.length === 0) {
        process.stdout.write("no projects\n");
      } else {
        for (const row of projects) {
          process.stdout.write(`${row.slug}\t${row.id}\t${row.defaultBranch}\n`);
        }
      }
    } finally {
      engine.close();
    }
  });

project
  .command("fork <project> <branch>")
  .description("create a logical fork that shares the version sequence")
  .option("-f, --from <branch>", "base branch")
  .option("--json", "machine-readable output", false)
  .action(async (reference: string, branch: string, options: { from?: string; json: boolean }) => {
    const engine = await openEngine();
    try {
      const target = reference.startsWith("prj_")
        ? { id: reference }
        : ((await engine.projects.bySlug(reference)) ?? null);
      if (target === null) {
        throw new ChronosError("PROJECT_NOT_FOUND", `project "${reference}" does not exist`);
      }
      const created = await engine.projects.fork(target.id, branch, {
        ...(options.from === undefined ? {} : { fromBranch: options.from }),
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify({ ok: true, branch: created }, null, 2)}\n`);
      } else {
        process.stdout.write(
          `${created.projectId}  ${created.name}  (base ${created.baseBranch})\n`,
        );
      }
    } finally {
      engine.close();
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  report(error);
  process.exitCode = 1;
});
