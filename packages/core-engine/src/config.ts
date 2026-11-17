import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Runtime configuration (§3.3). `CHRONOS_HOME` is the single global location
 * for the database, shadow objects, locks, logs and tokens.
 */

export const PORT_RANGE = { start: 4870, end: 4899, reserved: 4872 } as const;

export interface EnginePaths {
  root: string;
  database: string;
  objects: string;
  run: string;
  logs: string;
  tokens: string;
  backups: string;
  cache: string;
  locks: string;
}

export interface EngineConfig {
  home: string;
  paths: EnginePaths;
  ports: typeof PORT_RANGE;
  dbFile: string;
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CHRONOS_HOME;
  if (configured !== undefined && configured.trim().length > 0) return resolve(configured);
  return join(homedir(), ".chronos-ctx");
}

export function enginePaths(home: string): EnginePaths {
  return {
    root: home,
    database: join(home, "chronos.db"),
    objects: join(home, "objects"),
    run: join(home, "run"),
    logs: join(home, "logs"),
    tokens: join(home, "tokens"),
    backups: join(home, "backups"),
    cache: join(home, "cache"),
    locks: join(home, "run"),
  };
}

export function loadConfig(overrides: { home?: string } = {}): EngineConfig {
  const home = overrides.home === undefined ? resolveHome() : resolve(overrides.home);
  const paths = enginePaths(home);
  return { home, paths, ports: PORT_RANGE, dbFile: paths.database };
}
