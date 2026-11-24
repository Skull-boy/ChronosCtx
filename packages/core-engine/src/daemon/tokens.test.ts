import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChronosError, type Clock } from "@chronos-ctx/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT_PARAMS,
  hasScope,
  issueToken,
  parseToken,
  TokenStore,
  verifyToken,
} from "./tokens.js";

class FixedClock implements Clock {
  public t = Date.UTC(2026, 10, 1);

  public now(): number {
    return this.t;
  }

  public advance(ms: number): void {
    this.t += ms;
  }
}

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "chronos-tokens-"));
  temporaryDirectories.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const dir = temporaryDirectories.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe("token format", () => {
  it("issues chr_<id>_<secret> and parses both halves", async () => {
    const issued = await issueToken(
      { label: "cli", scopes: ["read"] },
      { clock: new FixedClock() },
    );
    expect(issued.token).toMatch(/^chr_[A-Za-z0-9_-]{11}_[A-Za-z0-9_-]{43}$/u);
    const parsed = parseToken(issued.token);
    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(issued.record.id);
    expect(issued.record.hash).not.toContain(parsed?.secret ?? "never");
  });

  it("rejects malformed tokens", () => {
    for (const token of ["", "chr_", "chr_id", "chr_id_secret", "bearer", "chr_id_secret!"]) {
      expect(parseToken(token), token).toBeNull();
    }
  });
});

describe("issueToken", () => {
  it("stores only a hash and a salt", async () => {
    const clock = new FixedClock();
    const issued = await issueToken({ label: "agent", scopes: ["read", "write"] }, { clock });
    expect(issued.record.hash).not.toHaveLength(0);
    expect(issued.record.salt).not.toHaveLength(0);
    expect(issued.record.params).toEqual(DEFAULT_SCRYPT_PARAMS);
    expect(await verifyToken(issued.token, issued.record, clock.now())).toBe(true);
  });

  it("rejects an empty scope set and an expiry in the past", async () => {
    const clock = new FixedClock();
    await expect(issueToken({ label: "x", scopes: [] }, { clock })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(
      issueToken({ label: "x", scopes: ["read"], expiresAt: clock.now() }, { clock }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("TokenStore", () => {
  it("authenticates a valid token and refuses a wrong secret", async () => {
    const clock = new FixedClock();
    const store = new TokenStore({ clock });
    const issued = await store.issue({ label: "cli", scopes: ["read", "write"] });

    const grant = await store.authenticate(issued.token);
    expect(grant).toMatchObject({ id: issued.metadata.id, scopes: ["read", "write"] });

    const parsed = parseToken(issued.token);
    expect(parsed).not.toBeNull();
    const secret = parsed?.secret ?? "";
    const replacement = secret.endsWith("A") ? "B" : "A";
    const tampered = `chr_${parsed?.id ?? ""}_${secret.slice(0, -1)}${replacement}`;
    await expect(store.authenticate(tampered)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("enforces scopes with admin > write > read", async () => {
    const clock = new FixedClock();
    const store = new TokenStore({ clock });
    const read = await store.issue({ label: "read", scopes: ["read"] });
    const admin = await store.issue({ label: "admin", scopes: ["admin"] });

    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["write"], "read")).toBe(true);
    expect(hasScope(["admin"], "write")).toBe(true);

    await expect(store.require(read.token, "write")).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(store.require(admin.token, "write")).resolves.toMatchObject({
      label: "admin",
    });
  });

  it("refuses an expired token", async () => {
    const clock = new FixedClock();
    const store = new TokenStore({ clock });
    const issued = await store.issue({
      label: "short",
      scopes: ["read"],
      expiresAt: clock.now() + 1000,
    });
    clock.advance(1000);
    await expect(store.authenticate(issued.token)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect((await store.list())[0]?.expired).toBe(true);
  });

  it("persists hashes, not the plaintext, and reloads them", async () => {
    const dir = temporaryDirectory();
    const file = join(dir, "tokens.json");
    const clock = new FixedClock();
    const store = new TokenStore({ file, clock });
    const issued = await store.issue({ label: "extension", scopes: ["read"] });

    const persisted = readFileSync(file, "utf8");
    expect(persisted).not.toContain(issued.token);
    expect(persisted).toContain(issued.metadata.id);

    const reloaded = new TokenStore({ file, clock });
    await expect(reloaded.authenticate(issued.token)).resolves.toMatchObject({
      label: "extension",
    });
  });

  it("revokes a token by deleting its record", async () => {
    const clock = new FixedClock();
    const store = new TokenStore({ clock });
    const issued = await store.issue({ label: "revoked", scopes: ["read"] });
    expect(await store.revoke(issued.metadata.id)).toBe(true);
    expect(await store.revoke(issued.metadata.id)).toBe(false);
    await expect(store.authenticate(issued.token)).rejects.toBeInstanceOf(ChronosError);
    expect(await store.list()).toHaveLength(0);
  });

  it("fails closed when the token file is corrupt", async () => {
    const dir = temporaryDirectory();
    const file = join(dir, "tokens.json");
    const store = new TokenStore({ file, clock: new FixedClock() });
    await store.load();
    writeFileSync(file, "{ not json", "utf8");
    const corrupt = new TokenStore({ file, clock: new FixedClock() });
    await expect(corrupt.list()).rejects.toMatchObject({ code: "INTERNAL" });
  });
});
