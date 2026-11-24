import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Clock, createIdGenerator } from "@chronos-ctx/shared-types";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "../db/client.js";
import { migrate } from "../db/migrate.js";
import { type Engine, openEngine } from "../engine.js";
import { DaemonServer } from "./server.js";
import { TokenStore } from "./tokens.js";

class FixedClock implements Clock {
  public t = Date.UTC(2026, 10, 1);

  public now(): number {
    this.t += 10;
    return this.t;
  }
}

interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: unknown;
}

function call(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
  },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: {
          ...(payload === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": String(payload.length),
              }),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = null;
          try {
            body = text.length === 0 ? null : JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
        });
      },
    );
    request.on("error", reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

function errorCode(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { code?: unknown }).code;
}

const ORIGIN = "chrome-extension://abcdefghijklmnop";

describe("gate 1.13 — loopback Host/Origin rejection suite (8 cases)", () => {
  let engine: Engine;
  let db: Database;
  let server: DaemonServer;
  let token: string;
  let projectId: string;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "chronos-daemon-"));
    db = await openDatabase({ file: join(dir, "chronos.db") });
    await migrate(db);
    const clock = new FixedClock();
    const ids = createIdGenerator({ clock, deterministic: true });
    engine = await openEngine({ database: db, clock, ids, migrate: false });

    const created = await engine.projects.create({
      slug: "daemon-fixture",
      name: "Daemon Fixture",
      activeObjective: "Serve loopback safely.",
    });
    projectId = created.project.id;
    await engine.commit.commit({
      projectId,
      branch: "main",
      path: "auth/spec",
      title: "Auth spec",
      summary: "Bearer tokens are scoped",
      content: "The daemon accepts loopback requests only.",
      sourceSurface: "opencode-cli",
    });
    await engine.checkpoints.createStateOnly({
      projectId,
      branch: "main",
      message: "ready",
    });

    const tokens = new TokenStore({ clock });
    token = (await tokens.issue({ label: "test", scopes: ["read", "write"] })).token;

    server = new DaemonServer({
      engine,
      tokens,
      port: 0,
      allowedOrigins: [ORIGIN],
      maxBodyBytes: 512,
      version: "test",
      pid: 4242,
    });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    engine.close();
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      // Windows can hold a WAL handle briefly after close.
    }
  });

  function host(): string {
    return `127.0.0.1:${server.port}`;
  }

  it("1/8 accepts 127.0.0.1:<port> for an unauthenticated health check", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/health",
      headers: { host: host() },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, status: "ok", pid: 4242 });
  });

  it("2/8 accepts localhost:<port>", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/health",
      headers: { host: `localhost:${server.port}` },
    });
    expect(response.status).toBe(200);
  });

  it("3/8 accepts [::1]:<port>", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/health",
      headers: { host: `[::1]:${server.port}` },
    });
    expect(response.status).toBe(200);
  });

  it("4/8 rejects the right host name on the wrong port", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/health",
      headers: { host: `127.0.0.1:${server.port + 1}` },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("HOST_NOT_ALLOWED");
  });

  it("5/8 rejects an attacker-controlled host name", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/health",
      headers: { host: `evil.example:${server.port}` },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("HOST_NOT_ALLOWED");
  });

  it("6/8 rejects a web origin that is not on the allowlist", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/projects",
      headers: { host: host(), origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("ORIGIN_NOT_ALLOWED");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("7/8 answers an allowed extension preflight with exact CORS headers", async () => {
    const response = await call(server.port, {
      method: "OPTIONS",
      path: "/v1/projects",
      headers: {
        host: host(),
        origin: ORIGIN,
        "access-control-request-method": "GET",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(response.headers["access-control-allow-origin"]).not.toBe("*");
  });

  it("8/8 rejects the literal null origin", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/projects",
      headers: { host: host(), origin: "null" },
    });
    expect(response.status).toBe(403);
    expect(errorCode(response.body)).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("requires a bearer token for a non-health route", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/projects",
      headers: { host: host() },
    });
    expect(response.status).toBe(401);
    expect(errorCode(response.body)).toBe("UNAUTHORIZED");
  });

  it("serves projects and the three read tools with a read token", async () => {
    const authorization = `Bearer ${token}`;
    const projects = await call(server.port, {
      method: "GET",
      path: "/v1/projects",
      headers: { host: host(), authorization },
    });
    expect(projects.status).toBe(200);
    expect(projects.body).toMatchObject({ ok: true });
    expect((projects.body as { projects: unknown[] }).projects).toHaveLength(1);

    const boot = await call(server.port, {
      method: "POST",
      path: "/v1/tools/context_boot",
      headers: { host: host(), authorization },
      body: { project_id: projectId },
    });
    expect(boot.status).toBe(200);
    expect((boot.body as { text: string }).text).toContain("daemon-fixture");

    const pageIn = await call(server.port, {
      method: "POST",
      path: "/v1/tools/context_page_in",
      headers: { host: host(), authorization },
      body: { project_id: projectId, paths: ["auth/spec"] },
    });
    expect(pageIn.status).toBe(200);
    expect((pageIn.body as { nodes: unknown[] }).nodes).toHaveLength(1);

    const capsule = await call(server.port, {
      method: "POST",
      path: "/v1/tools/context_capsule",
      headers: { host: host(), authorization },
      body: { project_id: projectId },
    });
    expect(capsule.status).toBe(200);
    expect((capsule.body as { text: string }).text).toContain("RESUME PROTOCOL");
  });

  it("rejects a schema violation with INVALID_REQUEST", async () => {
    const response = await call(server.port, {
      method: "POST",
      path: "/v1/tools/context_boot",
      headers: { host: host(), authorization: `Bearer ${token}` },
      body: { project_id: projectId, max_tokens: 5 },
    });
    expect(response.status).toBe(400);
    expect(errorCode(response.body)).toBe("INVALID_REQUEST");
  });

  it("rejects a body over the configured limit with BUDGET_EXCEEDED", async () => {
    const response = await call(server.port, {
      method: "POST",
      path: "/v1/tools/context_boot",
      headers: { host: host(), authorization: `Bearer ${token}` },
      body: { project_id: projectId, padding: "x".repeat(1024) },
    });
    expect(response.status).toBe(413);
    expect(errorCode(response.body)).toBe("BUDGET_EXCEEDED");
  });

  it("returns 404 for an unknown route", async () => {
    const response = await call(server.port, {
      method: "GET",
      path: "/v1/nope",
      headers: { host: host() },
    });
    expect(response.status).toBe(404);
  });
});
