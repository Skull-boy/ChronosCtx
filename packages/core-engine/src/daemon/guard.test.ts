import { describe, expect, it } from "vitest";
import {
  corsHeadersFor,
  guardRequest,
  isLoopbackOrigin,
  parseHostHeader,
  validateHost,
  validateOrigin,
} from "./guard.js";

const policy = {
  port: 4870,
  allowedOrigins: ["chrome-extension://abcdefghijklmnop"],
};

describe("parseHostHeader", () => {
  it("accepts the three loopback forms with a port", () => {
    expect(parseHostHeader("127.0.0.1:4870")).toEqual({ hostname: "127.0.0.1", port: 4870 });
    expect(parseHostHeader("localhost:4870")).toEqual({ hostname: "localhost", port: 4870 });
    expect(parseHostHeader("[::1]:4870")).toEqual({ hostname: "::1", port: 4870 });
  });

  it("normalises case and accepts a bare host without a port", () => {
    expect(parseHostHeader("LOCALHOST")).toEqual({ hostname: "localhost", port: null });
    expect(parseHostHeader("[::1]")).toEqual({ hostname: "::1", port: null });
  });

  it("rejects malformed, duplicated and out-of-range forms", () => {
    for (const value of [
      "",
      "127.0.0.1:",
      "127.0.0.1:0",
      "127.0.0.1:65536",
      "127.0.0.1:4870,evil",
      "user@127.0.0.1:4870",
      "127.0.0.1:4870/path",
      "::1:4870",
      "[::1",
      "localhost:4870 ",
    ]) {
      expect(parseHostHeader(value), value).toBeNull();
    }
  });
});

describe("validateHost", () => {
  it("requires the exact daemon port", () => {
    expect(validateHost("127.0.0.1:4870", 4870).ok).toBe(true);
    expect(validateHost("127.0.0.1:4871", 4870).ok).toBe(false);
    expect(validateHost("localhost:4870", 4870).ok).toBe(true);
    expect(validateHost("[::1]:4870", 4870).ok).toBe(true);
  });

  it("rejects a missing host, a non-loopback name and a missing port", () => {
    expect(validateHost(undefined, 4870).ok).toBe(false);
    expect(validateHost("evil.example:4870", 4870).ok).toBe(false);
    expect(validateHost("127.0.0.1", 4870).ok).toBe(false);
  });
});

describe("validateOrigin", () => {
  it("allows an absent origin and exact extension origins", () => {
    expect(validateOrigin(null, policy).ok).toBe(true);
    expect(validateOrigin("chrome-extension://abcdefghijklmnop", policy).ok).toBe(true);
  });

  it("allows loopback origins only on the daemon port", () => {
    expect(validateOrigin("http://localhost:4870", policy).ok).toBe(true);
    expect(validateOrigin("http://127.0.0.1:4870", policy).ok).toBe(true);
    expect(validateOrigin("http://[::1]:4870", policy).ok).toBe(true);
    expect(validateOrigin("http://localhost:4871", policy).ok).toBe(false);
    expect(validateOrigin("https://localhost:4870", policy).ok).toBe(false);
  });

  it("rejects null, an empty origin and an unlisted web origin", () => {
    expect(validateOrigin("null", policy).ok).toBe(false);
    expect(validateOrigin("", policy).ok).toBe(false);
    expect(validateOrigin("https://evil.example", policy).ok).toBe(false);
  });

  it("can disable loopback origins without affecting the extension allowlist", () => {
    const strict = { ...policy, allowLoopbackOrigins: false };
    expect(validateOrigin("http://localhost:4870", strict).ok).toBe(false);
    expect(validateOrigin("chrome-extension://abcdefghijklmnop", strict).ok).toBe(true);
  });
});

describe("isLoopbackOrigin", () => {
  it("rejects an origin with a path, credentials or the wrong scheme", () => {
    expect(isLoopbackOrigin("http://localhost:4870/", 4870)).toBe(true);
    expect(isLoopbackOrigin("http://localhost:4870/path", 4870)).toBe(false);
    expect(isLoopbackOrigin("http://user@localhost:4870", 4870)).toBe(false);
    expect(isLoopbackOrigin("ftp://localhost:4870", 4870)).toBe(false);
  });
});

describe("corsHeadersFor", () => {
  it("echoes the exact origin and never emits a wildcard", () => {
    const headers = corsHeadersFor("chrome-extension://abcdefghijklmnop", policy);
    expect(headers["access-control-allow-origin"]).toBe("chrome-extension://abcdefghijklmnop");
    expect(headers["access-control-allow-origin"]).not.toBe("*");
    expect(headers.vary).toBe("Origin");
  });

  it("returns no headers for a disallowed origin", () => {
    expect(corsHeadersFor("https://evil.example", policy)).toEqual({});
  });
});

describe("guardRequest", () => {
  it("rejects a bad Host before looking at Origin", () => {
    const decision = guardRequest({
      headers: { host: "evil.example:4870", origin: "chrome-extension://abcdefghijklmnop" },
      policy,
    });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("HOST_NOT_ALLOWED");
    expect(decision.cors).toEqual({});
  });

  it("rejects a bad Origin and withholds CORS headers", () => {
    const decision = guardRequest({
      headers: { host: "127.0.0.1:4870", origin: "https://evil.example" },
      policy,
    });
    expect(decision.ok).toBe(false);
    expect(decision.code).toBe("ORIGIN_NOT_ALLOWED");
    expect(decision.cors).toEqual({});
  });

  it("allows a non-browser client with no Origin", () => {
    const decision = guardRequest({ headers: { host: "127.0.0.1:4870" }, policy });
    expect(decision.ok).toBe(true);
    expect(decision.origin).toBeNull();
    expect(decision.cors).toEqual({});
  });

  it("returns exact CORS headers for an allowed origin", () => {
    const decision = guardRequest({
      headers: { host: "localhost:4870", origin: "chrome-extension://abcdefghijklmnop" },
      policy,
    });
    expect(decision.ok).toBe(true);
    expect(decision.cors["access-control-allow-origin"]).toBe(
      "chrome-extension://abcdefghijklmnop",
    );
  });
});
