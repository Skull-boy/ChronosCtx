import {
  type Clock,
  createIdGenerator,
  type IdGenerator,
  systemClock,
} from "@chronos-ctx/shared-types";
import { type EngineConfig, loadConfig } from "./config.js";
import { type Database, type DatabaseHealth, openDatabase } from "./db/client.js";
import {
  currentVersion,
  latestVersion,
  type MigrateOptions,
  type MigrateResult,
  migrate,
} from "./db/migrate.js";
import { CheckpointService } from "./services/checkpoints.js";
import { CommitService } from "./services/commit.js";
import { ProjectService } from "./services/projects.js";
import { SnapshotService } from "./services/snapshots.js";

export interface OpenEngineOptions {
  home?: string;
  /** Injected for tests; the engine will not close a database it does not own. */
  database?: Database;
  clock?: Clock;
  ids?: IdGenerator;
  /** Run forward migrations on open. Defaults to true. */
  migrate?: boolean;
}

export interface EngineStatus {
  config: EngineConfig;
  database: DatabaseHealth;
  schema: { current: number; latest: number; pending: boolean };
}

export interface Engine {
  readonly config: EngineConfig;
  readonly db: Database;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly projects: ProjectService;
  readonly commit: CommitService;
  readonly snapshots: SnapshotService;
  readonly checkpoints: CheckpointService;
  status(): Promise<EngineStatus>;
  migrate(options?: MigrateOptions): Promise<MigrateResult>;
  close(): void;
}

/**
 * Composition root. One engine per process (ADR-0001); every service takes its
 * clock and id generator from here so tests can freeze both without patching.
 */
export async function openEngine(options: OpenEngineOptions = {}): Promise<Engine> {
  const config = loadConfig(options.home === undefined ? {} : { home: options.home });
  const ownsDatabase = options.database === undefined;
  const db = options.database ?? (await openDatabase({ file: config.dbFile }));
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? createIdGenerator();

  if (options.migrate !== false) {
    await migrate(db);
  }

  const projects = new ProjectService({ db, ids, clock });
  const commit = new CommitService({ db, ids, clock });
  const snapshots = new SnapshotService({ db, ids, clock });
  const checkpoints = new CheckpointService({ db, ids, clock });

  return {
    config,
    db,
    clock,
    ids,
    projects,
    commit,
    snapshots,
    checkpoints,
    status: async (): Promise<EngineStatus> => {
      const database = await db.health();
      const current = await currentVersion(db);
      const latest = latestVersion();
      return { config, database, schema: { current, latest, pending: current < latest } };
    },
    migrate: (migrateOptions: MigrateOptions = {}): Promise<MigrateResult> =>
      migrate(db, migrateOptions),
    close: (): void => {
      if (ownsDatabase) db.close();
    },
  };
}
