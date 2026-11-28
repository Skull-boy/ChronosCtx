import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ChronosError } from "@chronos-ctx/shared-types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireDaemonLock,
  allocatePort,
  clearDaemonState,
  daemonFiles,
  isPortFree,
  isProcessAlive,
  parseLsofListeners,
  parseNetstatListeners,
  parseSsListeners,
  readDaemonLockFor,
  readDaemonState,
  releaseDaemonLock,
  writeDaemonState,
} from "./lifecycle.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "chronos-lifecycle-"));
});

afterEach(() => {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } catch {
    // Windows can hold a handle briefly.
  }
});

function state(overrides: Partial<Parameters<typeof writeDaemonState>[1]> = {}) {
  return {
    version: 1 as const,
    pid: process.pid,
    protocol: "http" as const,
    port: 4870,
    url: "http://127.0.0.1:4870",
    ipc_path: null,
    started_at: 1,
    cli_version: "0.0.0",
    ...overrides,
  };
}

describe("daemon state discovery", () => {
  it("writes, reads and clears the discovery file", async () => {
    expect(await readDaemonState(home)).toBeNull();
    await writeDaemonState(home, state());
    expect(await readDaemonState(home)).toEqual(state());
    await clearDaemonState(home);
    expect(await readDaemonState(home)).toBeNull();
  });

  it("treats a corrupt or unknown discovery file as absent", async () => {
    await writeDaemonState(home, state());
    const files = daemonFiles(home);
    writeFileSync(files.state, "{not json");
    expect(await readDaemonState(home)).toBeNull();

    writeFileSync(files.state, JSON.stringify({ version: 99, pid: 1 }));
    expect(await readDaemonState(home)).toBeNull();

    writeFileSync(files.state, JSON.stringify({ ...state(), version: 1, pid: 0 }));
    expect(await readDaemonState(home)).toBeNull();
  });
});

describe("daemon lock", () => {
  it("grants the lock once and refuses a live holder", async () => {
    const first = await acquireDaemonLock(home, {
      pid: process.pid,
      protocol: "http",
      created_at: 1,
    });
    expect(first).toEqual({ acquired: true });

    const second = await acquireDaemonLock(home, {
      pid: process.pid,
      protocol: "http",
      created_at: 2,
    });
    expect(second.acquired).toBe(false);
    expect(second.holder?.pid).toBe(process.pid);

    const held = await readDaemonLockFor(home);
    expect(held).toMatchObject({ pid: process.pid, protocol: "http", created_at: 1 });

    await releaseDaemonLock(home);
    expect(await readDaemonLockFor(home)).toBeNull();
    expect(
      (await acquireDaemonLock(home, { pid: process.pid, protocol: "http", created_at: 3 }))
        .acquired,
    ).toBe(true);
  });

  it("recovers a lock whose holder is gone or whose bytes are corrupt", async () => {
    const files = daemonFiles(home);
    mkdirSync(dirname(files.lock), { recursive: true });
    // A PID this high is not a live process on any supported platform.
    writeFileSync(
      files.lock,
      JSON.stringify({ version: 1, pid: 2_147_483_647, protocol: "http", created_at: 1 }),
    );
    const recovered = await acquireDaemonLock(home, {
      pid: process.pid,
      protocol: "http",
      created_at: 2,
    });
    expect(recovered).toEqual({ acquired: true, recovered: true });

    await releaseDaemonLock(home);
    writeFileSync(files.lock, "garbage");
    const fromGarbage = await acquireDaemonLock(home, {
      pid: process.pid,
      protocol: "http",
      created_at: 3,
    });
    expect(fromGarbage.acquired).toBe(true);
    expect(fromGarbage.recovered).toBe(true);
  });

  it("reports liveness without delivering a signal", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(2_147_483_647)).toBe(false);
  });
});

async function adjacentFreePorts(): Promise<[number, number]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("no address"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (port + 1 <= 65_535 && (await isPortFree(port)) && (await isPortFree(port + 1))) {
      return [port, port + 1];
    }
  }
  throw new Error("could not find two adjacent free ports");
}

function hold(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

describe("listener parsers", () => {
  it("reads LISTENING rows from netstat and ignores other states", () => {
    const listeners = parseNetstatListeners(
      [
        "  TCP    127.0.0.1:4870         0.0.0.0:0              LISTENING       1234",
        "  TCP    0.0.0.0:4871            0.0.0.0:0              LISTENING       5678",
        "  TCP    127.0.0.1:5000         127.0.0.1:60000        ESTABLISHED     9999",
        "  TCP    [::1]:4872             [::]:0                 LISTENING       4321",
        "  UDP    127.0.0.1:4873          *:*                                    1111",
      ].join("\r\n"),
    );
    expect([...listeners.entries()]).toEqual([
      [4870, [1234]],
      [4871, [5678]],
      [4872, [4321]],
    ]);
  });

  it("reads lsof LISTEN rows and ignores established connections", () => {
    const listeners = parseLsofListeners(
      [
        "node      1234 shinjan   23u  IPv4 0x1234      0t0  TCP 127.0.0.1:4870 (LISTEN)",
        "node      5678 shinjan   24u  IPv6 0x5678      0t0  TCP [::1]:4871 (LISTEN)",
        "node      9999 shinjan   25u  IPv4 0x9999      0t0  TCP 127.0.0.1:5000->127.0.0.1:60000 (ESTABLISHED)",
      ].join("\n"),
    );
    expect([...listeners.entries()]).toEqual([
      [4870, [1234]],
      [4871, [5678]],
    ]);
  });

  it("reads ss LISTEN rows including a wildcard address", () => {
    const listeners = parseSsListeners(
      [
        "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process",
        'LISTEN 0      511          127.0.0.1:4870      0.0.0.0:*    users:(("node",pid=1234,fd=23))',
        'LISTEN 0      511                [::1]:4871         [::]:*    users:(("node",pid=5678,fd=24))',
        'LISTEN 0      511                  *:4872             *:*    users:(("chronos",pid=4321,fd=25))',
      ].join("\n"),
    );
    expect([...listeners.entries()]).toEqual([
      [4870, [1234]],
      [4871, [5678]],
      [4872, [4321]],
    ]);
  });

  it("returns an empty map for garbage instead of throwing", () => {
    expect(parseNetstatListeners("").size).toBe(0);
    expect(parseLsofListeners("not a listener").size).toBe(0);
    expect(parseSsListeners("garbage").size).toBe(0);
  });
});

describe("port allocation", () => {
  it("skips a busy port and a reserved port", async () => {
    const [first, second] = await adjacentFreePorts();

    // Nothing is listening: the reserved port is skipped, the next one is chosen.
    expect(await allocatePort({ start: first, end: second, reserved: first })).toBe(second);
    // With no reservation, the first free port wins.
    expect(await allocatePort({ start: first, end: second })).toBe(first);

    const holder = createServer();
    await hold(holder, first);
    try {
      // A bound port is skipped.
      expect(await allocatePort({ start: first, end: second })).toBe(second);
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("reports PORT_RANGE_EXHAUSTED with the range and checked count", async () => {
    const [first] = await adjacentFreePorts();
    const holder = createServer();
    await hold(holder, first);
    try {
      const caught = await allocatePort({ start: first, end: first }).catch(
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(ChronosError);
      const error = caught as ChronosError;
      expect(error.code).toBe("PORT_RANGE_EXHAUSTED");
      expect(error.retriable).toBe(true);
      expect(error.details).toMatchObject({ range: { start: first, end: first }, checked: 1 });
    } finally {
      await new Promise<void>((resolve) => holder.close(() => resolve()));
    }
  });

  it("never returns the reserved port when the range is otherwise free", async () => {
    const [first, second] = await adjacentFreePorts();
    const reserved = await allocatePort({ start: first, end: second, reserved: first });
    expect(reserved).toBe(second);
  });
});
