import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BUDGETS, ChronosError, httpStatusFor, toToolErrorBody } from "@chronos-ctx/shared-types";
import { z } from "zod";
import { CapsuleService } from "../capsule/export.js";
import type { Engine } from "../engine.js";
import { BootService } from "../paging/boot.js";
import { PageInService } from "../paging/page-in.js";
import { type GuardPolicy, guardRequest } from "./guard.js";
import type { TokenGrant, TokenScope, TokenStore } from "./tokens.js";

/**
 * The loopback HTTP surface (roadmap §3.4, gates 1.13 and 1.14).
 *
 * `node:http` is deliberate: Fastify was retired in ADR-0025 because it adds a
 * dependency tree and a lifecycle script surface for a local server with six
 * routes. Routing is a switch, bodies are zod-validated, and every response is
 * JSON with no-store caching.
 *
 * Order of checks on every request:
 *   1. `Host` (DNS rebinding) and `Origin` (CORS allowlist) — before routing.
 *   2. Method and path.
 *   3. Bearer token and scope, except `/v1/health`.
 *   4. Content-Type, size limit, JSON parse, zod schema.
 */

export const MAX_BODY_BYTES = 1024 * 1024;

const bootSchema = z
  .object({
    project_id: z.string().min(1).max(128),
    branch: z.string().min(1).max(128).optional(),
    max_tokens: z.number().int().min(50).max(BUDGETS.boot.hard).optional(),
    include_summaries: z.boolean().optional(),
  })
  .strict();

const pageInSchema = z
  .object({
    project_id: z.string().min(1).max(128),
    branch: z.string().min(1).max(128).optional(),
    paths: z.array(z.string().min(1).max(512)).min(1).max(12),
    max_tokens: z.number().int().min(50).max(BUDGETS.page_in.hard).optional(),
    include_negative_constraints: z.boolean().optional(),
    format: z.enum(["markdown", "json"]).optional(),
  })
  .strict();

const capsuleSchema = z
  .object({
    project_id: z.string().min(1).max(128),
    branch: z.string().min(1).max(128).optional(),
    checkpoint_id: z.string().min(1).max(128).optional(),
    max_tokens: z.number().int().min(150).max(BUDGETS.capsule.hard).optional(),
    objective: z.string().max(2000).nullable().optional(),
  })
  .strict();

export interface DaemonLogEvent {
  event: string;
  [key: string]: unknown;
}

export interface DaemonServerOptions {
  engine: Engine;
  /** Required unless `allowAnonymous` is explicitly true. */
  tokens?: TokenStore;
  /** Test and local-development escape hatch; prints no warning by itself. */
  allowAnonymous?: boolean;
  /** 0 selects an ephemeral port, which tests use. */
  port?: number;
  /** Loopback address to bind. Defaults to 127.0.0.1. */
  host?: string;
  /** Exact extension origins. Loopback origins are added unless disabled. */
  allowedOrigins?: readonly string[];
  allowLoopbackOrigins?: boolean;
  maxBodyBytes?: number;
  /** 0 disables idle shutdown. */
  idleTimeoutMs?: number;
  version?: string;
  pid?: number;
  logger?: (event: DaemonLogEvent) => void;
}

interface ResponseHeaders {
  [header: string]: string;
}

function headerNumber(value: string | string[] | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export class DaemonServer {
  public readonly server: Server;
  private readonly engine: Engine;
  private readonly tokens: TokenStore | undefined;
  private readonly allowAnonymous: boolean;
  private readonly host: string;
  private readonly requestedPort: number;
  private readonly guard: Omit<GuardPolicy, "port">;
  private readonly maxBodyBytes: number;
  private readonly idleTimeoutMs: number;
  private readonly version: string;
  private readonly pid: number;
  private readonly logger: ((event: DaemonLogEvent) => void) | undefined;
  private actualPort = 0;
  private started = false;
  private activeRequests = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  public constructor(options: DaemonServerOptions) {
    if (options.tokens === undefined && options.allowAnonymous !== true) {
      throw new Error("DaemonServer requires a TokenStore or allowAnonymous: true");
    }
    this.engine = options.engine;
    this.tokens = options.tokens;
    this.allowAnonymous = options.allowAnonymous === true;
    this.host = options.host ?? "127.0.0.1";
    this.requestedPort = options.port ?? 0;
    this.guard = {
      ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
      ...(options.allowLoopbackOrigins === undefined
        ? {}
        : { allowLoopbackOrigins: options.allowLoopbackOrigins }),
    };
    this.maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 0;
    this.version = options.version ?? "0.0.0";
    this.pid = options.pid ?? process.pid;
    this.logger = options.logger;

    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on("upgrade", (request, socket) => {
      const decision = guardRequest({ headers: request.headers, policy: this.currentPolicy() });
      if (!decision.ok) {
        socket.write("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
      } else {
        socket.write(
          "HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        );
      }
      socket.destroy();
    });
  }

  public get port(): number {
    return this.actualPort;
  }

  public get url(): string {
    const host = this.host.includes(":") ? `[${this.host}]` : this.host;
    return `http://${host}:${this.actualPort}`;
  }

  public async start(): Promise<{ port: number; url: string }> {
    if (this.started) return { port: this.actualPort, url: this.url };

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        this.server.off("listening", onListening);
        reject(
          error.code === "EADDRINUSE"
            ? new ChronosError("PORT_RANGE_EXHAUSTED", `port ${this.requestedPort} is in use`, {
                details: { port: this.requestedPort },
              })
            : error,
        );
      };
      const onListening = (): void => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.requestedPort, this.host);
    });

    const address = this.server.address();
    if (address === null || typeof address === "string") {
      throw new ChronosError("INTERNAL", "daemon did not bind a TCP address");
    }
    this.actualPort = address.port;
    this.started = true;
    this.armIdleTimer();
    return { port: this.actualPort, url: this.url };
  }

  public async stop(): Promise<void> {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.started) return;
    this.started = false;
    this.server.closeIdleConnections();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  }

  private currentPolicy(): GuardPolicy {
    return { ...this.guard, port: this.actualPort };
  }

  private armIdleTimer(): void {
    if (this.idleTimeoutMs <= 0 || !this.started) return;
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.activeRequests > 0) {
        this.armIdleTimer();
        return;
      }
      this.logger?.({ event: "idle_shutdown", idle_ms: this.idleTimeoutMs });
      void this.stop();
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.activeRequests += 1;
    let cors: Readonly<Record<string, string>> = {};
    try {
      const decision = guardRequest({
        headers: request.headers,
        policy: this.currentPolicy(),
      });
      if (!decision.ok) {
        const error = new ChronosError(
          decision.code ?? "HOST_NOT_ALLOWED",
          decision.message ?? "request rejected by the loopback guard",
        );
        this.sendError(response, 403, error, cors);
        return;
      }
      cors = decision.cors;

      const method = request.method ?? "GET";
      if (method === "OPTIONS") {
        if (decision.origin === null) {
          this.sendError(
            response,
            400,
            new ChronosError("INVALID_REQUEST", "CORS preflight requires an Origin header"),
            cors,
          );
          return;
        }
        response.writeHead(204, {
          ...cors,
          "content-length": "0",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        response.end();
        return;
      }

      const url = this.parseUrl(request.url);
      if (url === null) {
        this.sendError(
          response,
          400,
          new ChronosError("INVALID_REQUEST", "request target is not an origin-form path"),
          cors,
        );
        return;
      }

      if (method === "GET" && url.pathname === "/v1/health") {
        await this.health(response, cors);
        return;
      }

      if (method === "GET" && url.pathname === "/v1/projects") {
        await this.authorize(request, "read");
        const projects = await this.engine.projects.list();
        this.send(
          response,
          200,
          {
            ok: true,
            projects: projects.map((project) => ({
              id: project.id,
              slug: project.slug,
              name: project.name,
              default_branch: project.defaultBranch,
              active_branch: project.activeBranch,
              active_objective: project.activeObjective,
              created_at: project.createdAt,
              updated_at: project.updatedAt,
            })),
          },
          cors,
        );
        return;
      }

      if (method === "POST" && url.pathname === "/v1/tools/context_boot") {
        await this.authorize(request, "read");
        const body = parseBody(bootSchema, await this.readJson(request));
        const boot = new BootService({ db: this.engine.db });
        const result = await boot.boot({
          projectId: body.project_id,
          ...(body.branch === undefined ? {} : { branch: body.branch }),
          ...(body.max_tokens === undefined ? {} : { maxTokens: body.max_tokens }),
          includeSummaries: body.include_summaries ?? false,
          surface: "extension",
          tier: "T2",
          daemon: { version: this.version, pid: this.pid },
        });
        this.send(response, 200, { ok: true, ...result }, cors);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/tools/context_page_in") {
        await this.authorize(request, "read");
        const body = parseBody(pageInSchema, await this.readJson(request));
        const pager = new PageInService({ db: this.engine.db });
        const result = await pager.pageIn({
          projectId: body.project_id,
          paths: body.paths,
          ...(body.branch === undefined ? {} : { branch: body.branch }),
          ...(body.max_tokens === undefined ? {} : { maxTokens: body.max_tokens }),
          includeNegativeConstraints: body.include_negative_constraints ?? true,
          format: body.format ?? "markdown",
          surface: "extension",
          tier: "T2",
          daemon: { version: this.version, pid: this.pid },
        });
        this.send(response, 200, { ok: true, ...result }, cors);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/tools/context_capsule") {
        await this.authorize(request, "read");
        const body = parseBody(capsuleSchema, await this.readJson(request));
        const capsule = new CapsuleService({ db: this.engine.db });
        const result = await capsule.export({
          projectId: body.project_id,
          ...(body.branch === undefined ? {} : { branch: body.branch }),
          ...(body.checkpoint_id === undefined ? {} : { checkpointId: body.checkpoint_id }),
          ...(body.max_tokens === undefined ? {} : { maxTokens: body.max_tokens }),
          ...(body.objective === undefined ? {} : { objective: body.objective }),
        });
        this.send(response, 200, { ok: true, ...result }, cors);
        return;
      }

      this.send(
        response,
        404,
        {
          ok: false,
          error: toToolErrorBody(
            new ChronosError("INVALID_REQUEST", `no route for ${method} ${url.pathname}`),
          ),
        },
        cors,
      );
    } catch (error) {
      this.sendErrorFrom(response, error, cors);
    } finally {
      this.activeRequests -= 1;
      this.armIdleTimer();
    }
  }

  private async health(
    response: ServerResponse,
    cors: Readonly<Record<string, string>>,
  ): Promise<void> {
    const status = await this.engine.status();
    this.send(
      response,
      200,
      {
        ok: true,
        status: "ok",
        version: this.version,
        pid: this.pid,
        schema: status.schema,
      },
      cors,
    );
  }

  private async authorize(request: IncomingMessage, scope: TokenScope): Promise<TokenGrant> {
    if (this.allowAnonymous) {
      return { id: "anonymous", label: "anonymous", scopes: ["admin"] };
    }
    if (this.tokens === undefined) {
      throw new ChronosError("UNAUTHORIZED", "the daemon has no token store");
    }

    const header = request.headers.authorization;
    if (header === undefined || Array.isArray(header)) {
      throw new ChronosError("UNAUTHORIZED", "a bearer token is required");
    }
    const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
    const token = match?.[1];
    if (token === undefined) {
      throw new ChronosError("UNAUTHORIZED", "authorization must use the Bearer scheme");
    }
    return this.tokens.require(token, scope);
  }

  private parseUrl(raw: string | undefined): URL | null {
    if (raw === undefined || !raw.startsWith("/") || raw.startsWith("//")) return null;
    try {
      return new URL(raw, "http://127.0.0.1");
    } catch {
      return null;
    }
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const declared = headerNumber(request.headers["content-length"]);
    if (declared !== null && declared > this.maxBodyBytes) {
      throw new ChronosError("BUDGET_EXCEEDED", `request body exceeds ${this.maxBodyBytes} bytes`, {
        details: { max_bytes: this.maxBodyBytes },
      });
    }

    const contentType = request.headers["content-type"];
    if (
      typeof contentType !== "string" ||
      !contentType.toLowerCase().startsWith("application/json")
    ) {
      throw new ChronosError("INVALID_REQUEST", "content-type must be application/json");
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buffer.length;
      if (total > this.maxBodyBytes) {
        throw new ChronosError(
          "BUDGET_EXCEEDED",
          `request body exceeds ${this.maxBodyBytes} bytes`,
          { details: { max_bytes: this.maxBodyBytes } },
        );
      }
      chunks.push(buffer);
    }

    if (total === 0) return {};
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      throw new ChronosError("INVALID_REQUEST", "request body is not valid JSON");
    }
  }

  private send(
    response: ServerResponse,
    status: number,
    body: unknown,
    cors: Readonly<Record<string, string>>,
  ): void {
    const payload = JSON.stringify(body);
    const headers: ResponseHeaders = {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(payload)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...cors,
    };
    response.writeHead(status, headers);
    response.end(payload);
  }

  private sendError(
    response: ServerResponse,
    status: number,
    error: ChronosError,
    cors: Readonly<Record<string, string>>,
  ): void {
    this.send(response, status, { ok: false, error: error.toBody() }, cors);
  }

  private sendErrorFrom(
    response: ServerResponse,
    error: unknown,
    cors: Readonly<Record<string, string>>,
  ): void {
    if (error instanceof ChronosError) {
      this.sendError(response, httpStatusFor(error.code), error, cors);
      return;
    }
    this.logger?.({
      event: "request_error",
      message: error instanceof Error ? error.message : String(error),
    });
    this.sendError(response, 500, new ChronosError("INTERNAL", "internal error"), cors);
  }
}

function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ChronosError("INVALID_REQUEST", "request body failed validation", {
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
