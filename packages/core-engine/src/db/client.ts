import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ChronosError } from "@chronos-ctx/shared-types";
import {
  type Client,
  createClient,
  type InStatement,
  type ResultSet,
  type Transaction,
} from "@libsql/client";

/**
 * libSQL client with the normative pragmas (§4.2) and a single-flight queue.
 *
 * Why the queue exists: the local libSQL client will service concurrent
 * `execute` calls from more than one underlying connection. Connection-scoped
 * pragmas are not shared, so a concurrent call can observe `busy_timeout=0`
 * (measured) and, worse, run with `foreign_keys=OFF`. ChronosCtx is a
 * single-writer engine, so serialising every statement costs nothing real and
 * removes a class of silent integrity failures.
 */

export interface OpenDatabaseOptions {
  file: string;
}

export interface DatabaseHealth {
  file: string;
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  userVersion: number;
}

export type TxMode = "write" | "read" | "deferred";

export interface Database {
  readonly file: string;
  execute(statement: InStatement): Promise<ResultSet>;
  batch(statements: Array<InStatement>, mode?: TxMode): Promise<ResultSet[]>;
  executeMultiple(sql: string): Promise<void>;
  withTx<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  health(): Promise<DatabaseHealth>;
  close(): void;
}

class Mutex {
  private tail: Promise<void> = Promise.resolve();

  public async run<T>(fn: () => Promise<T>): Promise<T> {
    const wait = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await wait;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function fileUrl(file: string): string {
  const normalized = file.replace(/\\/gu, "/");
  return normalized.startsWith("file:") ? normalized : `file:${normalized}`;
}

export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  mkdirSync(dirname(options.file), { recursive: true });

  const raw: Client = createClient({ url: fileUrl(options.file) });

  try {
    // WAL is refused on some network filesystems; that is a hard failure, not a
    // warning (§3.3: a WAL database on a sync daemon is a corruption generator).
    const journal = await raw.execute("PRAGMA journal_mode = WAL");
    const journalMode = String(journal.rows[0]?.journal_mode ?? "").toLowerCase();
    if (journalMode !== "wal") {
      throw new ChronosError(
        "UNSAFE_FILESYSTEM",
        `WAL is not available at ${options.file} (journal_mode=${journalMode || "unknown"})`,
        { hint: "Move CHRONOS_HOME to a local, non-synced filesystem." },
      );
    }
    await raw.execute("PRAGMA synchronous = NORMAL");
    await raw.execute("PRAGMA foreign_keys = ON");
    await raw.execute("PRAGMA busy_timeout = 5000");
  } catch (error) {
    raw.close();
    throw error;
  }

  const mutex = new Mutex();

  const withTx = async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    mutex.run(async () => {
      const tx = await raw.transaction("write");
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (error) {
        try {
          await tx.rollback();
        } catch {
          // The original error is more useful than a rollback error.
        }
        throw error;
      }
    });

  const health = async (): Promise<DatabaseHealth> =>
    mutex.run(async () => {
      // Sequential on purpose: see the module note on connection affinity.
      const journal = await raw.execute("PRAGMA journal_mode");
      const fk = await raw.execute("PRAGMA foreign_keys");
      const busy = await raw.execute("PRAGMA busy_timeout");
      const version = await raw.execute("PRAGMA user_version");
      return {
        file: options.file,
        journalMode: String(journal.rows[0]?.journal_mode ?? "").toLowerCase(),
        foreignKeys: Number(fk.rows[0]?.foreign_keys ?? 0) === 1,
        busyTimeoutMs: Number(busy.rows[0]?.timeout ?? 0),
        userVersion: Number(version.rows[0]?.user_version ?? 0),
      };
    });

  return {
    file: options.file,
    execute: (statement: InStatement): Promise<ResultSet> =>
      mutex.run(async () => raw.execute(statement)),
    batch: (statements: Array<InStatement>, mode?: TxMode): Promise<ResultSet[]> =>
      mutex.run(async () => raw.batch(statements, mode)),
    executeMultiple: (sql: string): Promise<void> =>
      mutex.run(async () => raw.executeMultiple(sql)),
    withTx,
    health,
    close: (): void => {
      raw.close();
    },
  };
}
