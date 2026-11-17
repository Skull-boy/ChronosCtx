#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  BootService,
  countCheckpoints,
  type Engine,
  getProjectById,
  measureSurface,
  openEngine,
  PageInService,
  type Project,
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
