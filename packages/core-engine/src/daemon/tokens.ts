import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { ChronosError, type Clock, systemClock } from "@chronos-ctx/shared-types";

/**
 * Bearer tokens for the loopback HTTP surface (roadmap §3.4, ADR-0027).
 *
 * A token is `chr_<id>_<secret>`. Only a scrypt hash of the secret is stored;
 * the plaintext is returned once, when it is issued. Tokens carry scopes and
 * an optional expiry, and are revoked by deleting the record.
 *
 * scrypt is used instead of argon2id because argon2id requires a native addon.
 * The install-time contract (1 package, 0 transitive, 0 lifecycle scripts)
 * rules that out; `node:crypto` is already in the runtime.
 */

export type TokenScope = "read" | "write" | "admin";

export const TOKEN_SCOPES: readonly TokenScope[] = ["read", "write", "admin"];

const SCOPE_RANK: Readonly<Record<TokenScope, number>> = {
  read: 1,
  write: 2,
  admin: 3,
};

export interface ScryptParams {
  /** CPU/memory cost. Must be a power of two greater than 1. */
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/** 16 MiB of scrypt memory at the default cost; ~50 ms on a modern laptop. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16384, r: 8, p: 1, keylen: 32 };

const MAX_SCRYPT_MEMORY = 64 * 1024 * 1024;
const TOKEN_PREFIX = "chr_";
const TOKEN_ID_BYTES = 8;
/** base64url of 8 bytes is always 11 characters. */
const TOKEN_ID_LENGTH = 11;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const TOKEN_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

export interface TokenRecord {
  id: string;
  label: string;
  scopes: TokenScope[];
  created_at: number;
  expires_at: number | null;
  /** base64url, 16 random bytes. */
  salt: string;
  /** base64url scrypt output. */
  hash: string;
  params: ScryptParams;
}

export interface TokenMetadata {
  id: string;
  label: string;
  scopes: TokenScope[];
  created_at: number;
  expires_at: number | null;
  expired: boolean;
}

export interface TokenGrant {
  id: string;
  label: string;
  scopes: TokenScope[];
}

export interface ParsedToken {
  id: string;
  secret: string;
}

export interface IssueTokenInput {
  label: string;
  scopes: readonly TokenScope[];
  /** Absolute epoch milliseconds. Omit for a non-expiring token. */
  expiresAt?: number | null;
}

export interface IssuedToken {
  token: string;
  record: TokenRecord;
}

export function isTokenScope(value: string): value is TokenScope {
  return (TOKEN_SCOPES as readonly string[]).includes(value);
}

export function hasScope(granted: readonly TokenScope[], required: TokenScope): boolean {
  return granted.some((scope) => SCOPE_RANK[scope] >= SCOPE_RANK[required]);
}

/**
 * Parse positionally, not with a greedy regex. The id is fixed-width
 * base64url and the secret is variable-width, so an `_` inside either half
 * cannot be mistaken for the delimiter.
 */
export function parseToken(token: string): ParsedToken | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const idStart = TOKEN_PREFIX.length;
  const separatorIndex = idStart + TOKEN_ID_LENGTH;
  if (token[separatorIndex] !== "_") return null;
  const id = token.slice(idStart, separatorIndex);
  const secret = token.slice(separatorIndex + 1);
  if (!TOKEN_ID_PATTERN.test(id) || !TOKEN_SECRET_PATTERN.test(secret)) return null;
  return { id, secret };
}

function validateParams(params: ScryptParams): ScryptParams {
  const powerOfTwo = params.N > 1 && (params.N & (params.N - 1)) === 0;
  if (
    !powerOfTwo ||
    !Number.isInteger(params.r) ||
    params.r < 1 ||
    !Number.isInteger(params.p) ||
    params.p < 1 ||
    !Number.isInteger(params.keylen) ||
    params.keylen < 16 ||
    params.keylen > 64
  ) {
    throw new ChronosError("INTERNAL", "invalid scrypt parameters in the token store");
  }
  return params;
}

function normalizeScopes(scopes: readonly TokenScope[]): TokenScope[] {
  const unique: TokenScope[] = [];
  for (const scope of scopes) {
    if (!isTokenScope(scope)) {
      throw new ChronosError("INVALID_REQUEST", `unknown token scope "${String(scope)}"`);
    }
    if (!unique.includes(scope)) unique.push(scope);
  }
  if (unique.length === 0) {
    throw new ChronosError("INVALID_REQUEST", "a token needs at least one scope");
  }
  return unique;
}

function derive(secret: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      secret,
      salt,
      params.keylen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_SCRYPT_MEMORY },
      (error, key) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(key);
      },
    );
  });
}

export interface IssueTokenOptions {
  clock?: Clock;
  params?: ScryptParams;
  /** Injected for deterministic tests; defaults to `crypto.randomBytes`. */
  random?: (size: number) => Buffer;
}

export async function issueToken(
  input: IssueTokenInput,
  options: IssueTokenOptions = {},
): Promise<IssuedToken> {
  const clock = options.clock ?? systemClock;
  const params = validateParams(options.params ?? DEFAULT_SCRYPT_PARAMS);
  const random = options.random ?? randomBytes;

  const label = input.label.trim();
  if (label.length === 0 || label.length > 120) {
    throw new ChronosError("INVALID_REQUEST", "token label must be 1-120 characters");
  }
  const scopes = normalizeScopes(input.scopes);
  const now = clock.now();
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null && (!Number.isInteger(expiresAt) || expiresAt <= now)) {
    throw new ChronosError("INVALID_REQUEST", "token expiry must be a future epoch millisecond");
  }

  const id = random(TOKEN_ID_BYTES).toString("base64url");
  const secret = random(32).toString("base64url");
  const salt = random(16);
  const hash = await derive(secret, salt, params);

  return {
    token: `chr_${id}_${secret}`,
    record: {
      id,
      label,
      scopes,
      created_at: now,
      expires_at: expiresAt,
      salt: salt.toString("base64url"),
      hash: hash.toString("base64url"),
      params,
    },
  };
}

export async function verifyToken(
  token: string,
  record: TokenRecord,
  now: number = Date.now(),
): Promise<boolean> {
  const parsed = parseToken(token);
  if (parsed === null || parsed.id !== record.id) return false;
  if (record.expires_at !== null && now >= record.expires_at) return false;

  const expected = Buffer.from(record.hash, "base64url");
  const actual = await derive(parsed.secret, Buffer.from(record.salt, "base64url"), record.params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function toMetadata(record: TokenRecord, now: number): TokenMetadata {
  return {
    id: record.id,
    label: record.label,
    scopes: [...record.scopes],
    created_at: record.created_at,
    expires_at: record.expires_at,
    expired: record.expires_at !== null && now >= record.expires_at,
  };
}

function coerceRecord(value: unknown): TokenRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    typeof raw.label !== "string" ||
    !Array.isArray(raw.scopes) ||
    !raw.scopes.every((scope) => typeof scope === "string" && isTokenScope(scope)) ||
    typeof raw.created_at !== "number" ||
    !(raw.expires_at === null || typeof raw.expires_at === "number") ||
    typeof raw.salt !== "string" ||
    typeof raw.hash !== "string" ||
    typeof raw.params !== "object" ||
    raw.params === null
  ) {
    return null;
  }

  const params = raw.params as Record<string, unknown>;
  if (
    typeof params.N !== "number" ||
    typeof params.r !== "number" ||
    typeof params.p !== "number" ||
    typeof params.keylen !== "number"
  ) {
    return null;
  }

  return {
    id: raw.id,
    label: raw.label,
    scopes: raw.scopes as TokenScope[],
    created_at: raw.created_at,
    expires_at: raw.expires_at,
    salt: raw.salt,
    hash: raw.hash,
    params: { N: params.N, r: params.r, p: params.p, keylen: params.keylen },
  };
}

export interface TokenStoreOptions {
  /** JSON file. Omit for an in-memory store used by tests. */
  file?: string;
  clock?: Clock;
  params?: ScryptParams;
}

/**
 * Hashed token registry. Writes are atomic (temp file + rename) and the file
 * is chmod 0600 on POSIX. A corrupt file fails closed with `INTERNAL` rather
 * than silently accepting an empty registry.
 */
export class TokenStore {
  private readonly file: string | undefined;
  private readonly clock: Clock;
  private readonly params: ScryptParams;
  private records: TokenRecord[] = [];
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(options: TokenStoreOptions = {}) {
    this.file = options.file;
    this.clock = options.clock ?? systemClock;
    this.params = validateParams(options.params ?? DEFAULT_SCRYPT_PARAMS);
  }

  public async load(): Promise<void> {
    if (this.loaded) return;
    if (this.file === undefined) {
      this.loaded = true;
      return;
    }

    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if (isNotFound(error)) {
        this.records = [];
        this.loaded = true;
        return;
      }
      throw new ChronosError("INTERNAL", `token store ${this.file} is unreadable`, {
        cause: error,
      });
    }

    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch (error) {
      throw new ChronosError("INTERNAL", `token store ${this.file} is not valid JSON`, {
        cause: error,
      });
    }

    if (
      typeof document !== "object" ||
      document === null ||
      (document as { version?: unknown }).version !== 1 ||
      !Array.isArray((document as { tokens?: unknown }).tokens)
    ) {
      throw new ChronosError("INTERNAL", `token store ${this.file} has an unknown shape`);
    }

    const records: TokenRecord[] = [];
    for (const raw of (document as { tokens: unknown[] }).tokens) {
      const record = coerceRecord(raw);
      if (record === null) {
        throw new ChronosError("INTERNAL", `token store ${this.file} contains an invalid record`);
      }
      records.push(record);
    }
    this.records = records;
    this.loaded = true;
  }

  public async issue(input: IssueTokenInput): Promise<{ token: string; metadata: TokenMetadata }> {
    await this.load();
    const issued = await issueToken(input, { clock: this.clock, params: this.params });
    this.records.push(issued.record);
    await this.persist();
    return { token: issued.token, metadata: toMetadata(issued.record, this.clock.now()) };
  }

  public async list(): Promise<TokenMetadata[]> {
    await this.load();
    const now = this.clock.now();
    return this.records
      .map((record) => toMetadata(record, now))
      .sort((left, right) => left.created_at - right.created_at);
  }

  public async revoke(id: string): Promise<boolean> {
    await this.load();
    const index = this.records.findIndex((record) => record.id === id);
    if (index === -1) return false;
    this.records.splice(index, 1);
    await this.persist();
    return true;
  }

  public async authenticate(token: string): Promise<TokenGrant> {
    await this.load();
    const parsed = parseToken(token);
    if (parsed === null) throw unauthorized("bearer token is malformed");

    const record = this.records.find((candidate) => candidate.id === parsed.id);
    if (record === undefined) throw unauthorized("bearer token is not recognised");
    if (record.expires_at !== null && this.clock.now() >= record.expires_at) {
      throw unauthorized("bearer token has expired");
    }
    if (!(await verifyToken(token, record, this.clock.now()))) {
      throw unauthorized("bearer token is not recognised");
    }

    return { id: record.id, label: record.label, scopes: [...record.scopes] };
  }

  public async require(token: string, scope: TokenScope): Promise<TokenGrant> {
    const grant = await this.authenticate(token);
    if (!hasScope(grant.scopes, scope)) {
      throw unauthorized(`bearer token lacks the "${scope}" scope`);
    }
    return grant;
  }

  private persist(): Promise<void> {
    const next = this.writeChain.then(
      () => this.write(),
      () => this.write(),
    );
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async write(): Promise<void> {
    if (this.file === undefined) return;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const document = JSON.stringify({ version: 1, tokens: this.records }, null, 2);
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${document}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporary, this.file);
    } catch {
      // Windows refuses rename over an existing file in some configurations.
      await rm(this.file, { force: true });
      await rename(temporary, this.file);
    }
    try {
      await chmod(this.file, 0o600);
    } catch {
      // chmod is a no-op on Windows; the file still lives under CHRONOS_HOME.
    }
  }
}

function unauthorized(message: string): ChronosError {
  return new ChronosError("UNAUTHORIZED", message);
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}
