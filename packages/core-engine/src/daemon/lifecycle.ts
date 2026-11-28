import { execFile } from "node:child_process";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ChronosError } from "@chronos-ctx/shared-types";

const execFileAsync = promisify(execFile);

/**
 * Daemon lifecycle primitives (roadmap 1.9).
 *
 * Three files under `CHRONOS_HOME` describe one running daemon:
 *
 *   run/daemon.lock  ownership. Created with `wx`, so exactly one process holds
 *                    it. A lock whose PID is gone is stale and recovered.
 *   run/daemon.json  discovery. PID, port, protocol and URL for clients. A
 *                    corrupt file is treated as absent, never trusted.
 *   logs/daemon.log  stdout/stderr of a detached daemon.
 *
 * The lock and the discovery file are deliberately separate: the lock answers
 * "may I start?", the discovery file answers "where do I connect?". A crash can
 * leave the second stale without weakening the first.
 *
 * Nothing here opens the database or an HTTP server, so it is safe to call from
 * `start`, `stop`, `status` and `logs` while a daemon is running.
 */

export const DAEMON_STATE_VERSION = 1;

export type DaemonProtocol = "http" | "ipc";

export interface DaemonState {
  version: typeof DAEMON_STATE_VERSION;
  pid: number;
  protocol: DaemonProtocol;
  port: number | null;
  url: string | null;
  ipc_path: string | null;
  started_at: number;
  cli_version: string;
}

export interface DaemonLock {
  version: 1;
  pid: number;
  protocol: DaemonProtocol;
  created_at: number;
}

export interface DaemonFiles {
  state: string;
  lock: string;
  log: string;
}

export function daemonFiles(home: string): DaemonFiles {
  const run = join(home, "run");
  return {
    state: join(run, "daemon.json"),
    lock: join(run, "daemon.lock"),
    log: join(home, "logs", "daemon.log"),
  };
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}

/**
 * Liveness test that does not depend on a signal being deliverable. `EPERM`
 * means the PID exists but belongs to another user, which still counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function coerceState(value: unknown): DaemonState | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== DAEMON_STATE_VERSION ||
    typeof raw.pid !== "number" ||
    !Number.isInteger(raw.pid) ||
    raw.pid <= 0 ||
    (raw.protocol !== "http" && raw.protocol !== "ipc") ||
    !(raw.port === null || (typeof raw.port === "number" && Number.isInteger(raw.port))) ||
    !(raw.url === null || typeof raw.url === "string") ||
    !(raw.ipc_path === null || typeof raw.ipc_path === "string") ||
    typeof raw.started_at !== "number" ||
    typeof raw.cli_version !== "string"
  ) {
    return null;
  }
  return {
    version: DAEMON_STATE_VERSION,
    pid: raw.pid,
    protocol: raw.protocol,
    port: raw.port,
    url: raw.url,
    ipc_path: raw.ipc_path,
    started_at: raw.started_at,
    cli_version: raw.cli_version,
  };
}

/** A missing or corrupt discovery file returns null; it is never trusted. */
export async function readDaemonState(home: string): Promise<DaemonState | null> {
  const { state } = daemonFiles(home);
  let text: string;
  try {
    text = await readFile(state, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw new ChronosError("INTERNAL", `cannot read ${state}`, { cause: error });
  }
  try {
    return coerceState(JSON.parse(text));
  } catch {
    return null;
  }
}

export async function writeDaemonState(home: string, state: DaemonState): Promise<void> {
  const { state: file } = daemonFiles(home);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    await rename(temporary, file);
  } catch {
    // Windows can refuse to rename over an existing file.
    await rm(file, { force: true });
    await rename(temporary, file);
  }
}

export async function clearDaemonState(home: string): Promise<void> {
  await rm(daemonFiles(home).state, { force: true });
}

async function readDaemonLock(file: string): Promise<DaemonLock | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    return null;
  }
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      raw.version !== 1 ||
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      (raw.protocol !== "http" && raw.protocol !== "ipc") ||
      typeof raw.created_at !== "number"
    ) {
      return null;
    }
    return {
      version: 1,
      pid: raw.pid,
      protocol: raw.protocol,
      created_at: raw.created_at,
    };
  } catch {
    return null;
  }
}

export interface AcquireLockResult {
  acquired: boolean;
  holder?: DaemonLock;
  recovered?: boolean;
}

/**
 * Exclusive lock creation with stale recovery. A lock is stale when it cannot
 * be parsed or its PID no longer exists; a live holder is authoritative and is
 * returned rather than overwritten.
 */
export async function acquireDaemonLock(
  home: string,
  holder: Omit<DaemonLock, "version">,
): Promise<AcquireLockResult> {
  const { lock: file } = daemonFiles(home);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const lock: DaemonLock = { version: 1, ...holder };
  let recovered = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return recovered ? { acquired: true, recovered: true } : { acquired: true };
    } catch (error) {
      if (!isAlreadyExists(error)) {
        throw new ChronosError("INTERNAL", `cannot create daemon lock ${file}`, { cause: error });
      }
      const existing = await readDaemonLock(file);
      if (existing !== null && isProcessAlive(existing.pid)) {
        return { acquired: false, holder: existing };
      }
      // Stale: unparsable, or the holder is gone.
      recovered = true;
      await rm(file, { force: true });
    }
  }

  throw new ChronosError("CONFLICT", "daemon lock is contended", {
    hint: "Another process is creating the lock repeatedly; retry, or remove run/daemon.lock manually.",
    details: { lock: file },
  });
}

export async function releaseDaemonLock(home: string): Promise<void> {
  await rm(daemonFiles(home).lock, { force: true });
}

/** Reads the lock without creating one; used by `status` and tests. */
export async function readDaemonLockFor(home: string): Promise<DaemonLock | null> {
  return readDaemonLock(daemonFiles(home).lock);
}

export interface PortRange {
  start: number;
  end: number;
  reserved?: number;
}

/**
 * Binds and immediately releases a port to test availability. The actual bind
 * can still race, so a caller that gets `PORT_RANGE_EXHAUSTED` from `listen`
 * should try the next candidate; `allocatePort` is the pre-flight estimate.
 */
export function isPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    let settled = false;
    const finish = (free: boolean): void => {
      if (settled) return;
      settled = true;
      if (free) {
        probe.close(() => resolve(true));
      } else {
        try {
          probe.close();
        } catch {
          // Not listening; nothing to close.
        }
        resolve(false);
      }
    };
    probe.once("error", () => finish(false));
    probe.once("listening", () => finish(true));
    probe.listen({ port, host, exclusive: true });
  });
}

export interface AllocatePortOptions {
  host?: string;
  /** Best-effort owners to report when the range is exhausted. */
  holders?: readonly { pid: number; port: number | null }[];
}

export function parseNetstatListeners(output: string): Map<number, number[]> {
  const listeners = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5) continue;
    const [proto, local, , state, pidText] = fields;
    if (proto?.toUpperCase() !== "TCP" || state?.toUpperCase() !== "LISTENING") continue;
    const port = lastPort(local);
    const pid = Number(pidText);
    if (port === null || !Number.isInteger(pid) || pid <= 0) continue;
    addListener(listeners, port, pid);
  }
  return listeners;
}

export function parseLsofListeners(output: string): Map<number, number[]> {
  const listeners = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/u)) {
    // node  1234 user  23u  IPv4 0xabc  0t0  TCP 127.0.0.1:4870 (LISTEN)
    const match = /^\S+\s+(\d+)\s+.*\s(?:TCP|UDP)\s+(\S+)\s+\(LISTEN\)/u.exec(line.trim());
    if (match === null) continue;
    const pid = Number(match[1]);
    const port = lastPort(match[2]);
    if (port === null || !Number.isInteger(pid) || pid <= 0) continue;
    addListener(listeners, port, pid);
  }
  return listeners;
}

export function parseSsListeners(output: string): Map<number, number[]> {
  const listeners = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/u)) {
    // LISTEN 0 511 127.0.0.1:4870 0.0.0.0:* users:(("node",pid=1234,fd=23))
    const match = /^LISTEN\s+\d+\s+\d+\s+(\S+)\s+\S+\s+users:\(.*pid=(\d+)/u.exec(line.trim());
    if (match === null) continue;
    const port = lastPort(match[1]);
    const pid = Number(match[2]);
    if (port === null || !Number.isInteger(pid) || pid <= 0) continue;
    addListener(listeners, port, pid);
  }
  return listeners;
}

function lastPort(address: string | undefined): number | null {
  if (address === undefined) return null;
  const match = /:(\d+)$/u.exec(address);
  if (match?.[1] === undefined) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

function addListener(listeners: Map<number, number[]>, port: number, pid: number): void {
  const existing = listeners.get(port);
  if (existing === undefined) {
    listeners.set(port, [pid]);
    return;
  }
  if (!existing.includes(pid)) existing.push(pid);
}

/**
 * Best-effort listener ownership for an exhausted range. `netstat`, `lsof` and
 * `ss` are diagnostics, not dependencies: a missing tool or an unparsable line
 * yields an empty map rather than failing the command that asked.
 */
export async function listListeningPorts(): Promise<Map<number, number[]>> {
  const options = { timeout: 2_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true } as const;
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], options);
      return parseNetstatListeners(stdout);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], options);
      return parseLsofListeners(stdout);
    }
    try {
      const { stdout } = await execFileAsync("ss", ["-ltnp"], options);
      return parseSsListeners(stdout);
    } catch {
      const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], options);
      return parseLsofListeners(stdout);
    }
  } catch {
    return new Map();
  }
}

/**
 * First free port in the per-user range, skipping the reserved port. The
 * reserved port is kept clear for a future fixed-purpose listener, so a daemon
 * must never occupy it.
 */
export async function allocatePort(
  range: PortRange,
  options: AllocatePortOptions = {},
): Promise<number> {
  const host = options.host ?? "127.0.0.1";
  const checked: number[] = [];
  for (let port = range.start; port <= range.end; port += 1) {
    if (port === range.reserved) continue;
    checked.push(port);
    if (await isPortFree(port, host)) return port;
  }

  const holders = [...(options.holders ?? [])];
  if (holders.length === 0) {
    const listeners = await listListeningPorts();
    for (const port of checked) {
      for (const pid of listeners.get(port) ?? []) holders.push({ pid, port });
    }
  }

  throw new ChronosError(
    "PORT_RANGE_EXHAUSTED",
    `no free port in the range ${range.start}-${range.end}`,
    {
      hint: "Stop the process holding the range, or start with an explicit --port, then retry.",
      details: {
        range: { start: range.start, end: range.end },
        reserved: range.reserved ?? null,
        checked: checked.length,
        holders,
      },
    },
  );
}
