import { describe, expect, it } from "vitest";
import {
  ChronosError,
  httpStatusFor,
  isChronosError,
  jsonRpcCodeFor,
  TOOL_ERROR_CODES,
  toToolErrorBody,
} from "./errors.js";

describe("ChronosError", () => {
  it("derives retriable from the code unless it is overridden", () => {
    expect(new ChronosError("PROJECT_BUSY", "busy").retriable).toBe(true);
    expect(new ChronosError("DAEMON_UNAVAILABLE", "down").retriable).toBe(true);
    expect(new ChronosError("CHECKPOINT_PARTIAL", "partial").retriable).toBe(true);
    expect(new ChronosError("PORT_RANGE_EXHAUSTED", "full").retriable).toBe(true);
    expect(new ChronosError("INTERNAL", "boom").retriable).toBe(false);

    expect(new ChronosError("PROJECT_BUSY", "busy", { retriable: false }).retriable).toBe(false);
    expect(new ChronosError("INTERNAL", "boom", { retriable: true }).retriable).toBe(true);
  });

  it("carries optional retry, hint, details and cause", () => {
    const cause = new Error("root cause");
    const error = new ChronosError("PROJECT_BUSY", "busy", {
      retryAfterMs: 250,
      hint: "retry later",
      details: { project_id: "prj_1" },
      cause,
    });

    expect(error.name).toBe("ChronosError");
    expect(error.message).toBe("busy");
    expect(error.retryAfterMs).toBe(250);
    expect(error.hint).toBe("retry later");
    expect(error.details).toEqual({ project_id: "prj_1" });
    expect(error.cause).toBe(cause);
  });

  it("omits absent optional fields from the wire body", () => {
    expect(new ChronosError("INTERNAL", "boom").toBody()).toEqual({
      code: "INTERNAL",
      message: "boom",
      retriable: false,
    });

    expect(
      new ChronosError("PROJECT_BUSY", "busy", {
        retryAfterMs: 10,
        hint: "wait",
        details: { retry: 1 },
      }).toBody(),
    ).toEqual({
      code: "PROJECT_BUSY",
      message: "busy",
      retriable: true,
      retry_after_ms: 10,
      hint: "wait",
      details: { retry: 1 },
    });
  });
});

describe("error guards and transport mappings", () => {
  it("recognises only ChronosError instances", () => {
    expect(isChronosError(new ChronosError("INTERNAL", "boom"))).toBe(true);
    expect(isChronosError(new Error("plain"))).toBe(false);
    expect(isChronosError("boom")).toBe(false);
    expect(isChronosError(null)).toBe(false);
  });

  it("maps every declared code to a JSON-RPC code", () => {
    expect(jsonRpcCodeFor("INTERNAL")).toBe(-32603);
    expect(jsonRpcCodeFor("HOST_NOT_ALLOWED")).toBe(-32600);
    expect(jsonRpcCodeFor("ORIGIN_NOT_ALLOWED")).toBe(-32600);
    expect(jsonRpcCodeFor("PATH_INVALID")).toBe(-32602);
    expect(jsonRpcCodeFor("UNAUTHORIZED")).toBe(-32602);
    expect(jsonRpcCodeFor("PROJECT_BUSY")).toBe(-32603);
    for (const code of TOOL_ERROR_CODES) {
      expect(Number.isInteger(jsonRpcCodeFor(code))).toBe(true);
    }
  });

  it("maps codes to HTTP statuses and falls back to 500", () => {
    expect(httpStatusFor("NODE_NOT_FOUND")).toBe(404);
    expect(httpStatusFor("PATH_INVALID")).toBe(400);
    expect(httpStatusFor("INVALID_REQUEST")).toBe(400);
    expect(httpStatusFor("EVIDENCE_REQUIRED")).toBe(409);
    expect(httpStatusFor("CAPSULE_INVALID")).toBe(422);
    expect(httpStatusFor("UNSAFE_FILESYSTEM")).toBe(422);
    expect(httpStatusFor("PROJECT_BUSY")).toBe(429);
    expect(httpStatusFor("BUDGET_EXCEEDED")).toBe(413);
    expect(httpStatusFor("UNAUTHORIZED")).toBe(401);
    expect(httpStatusFor("HOST_NOT_ALLOWED")).toBe(403);
    expect(httpStatusFor("PORT_RANGE_EXHAUSTED")).toBe(503);
    expect(httpStatusFor("UNSUPPORTED")).toBe(501);
    expect(httpStatusFor("INTERNAL")).toBe(500);

    // Declared domain codes with no explicit status still get a valid answer.
    expect(httpStatusFor("EDGE_ORPHANED")).toBe(500);
    expect(httpStatusFor("ALIAS_REDIRECT")).toBe(500);
  });

  it("normalises unknown failures into the internal shape", () => {
    const domain = new ChronosError("CONFLICT", "already exists", { hint: "pick another name" });
    expect(toToolErrorBody(domain)).toEqual(domain.toBody());

    expect(toToolErrorBody(new Error("plain failure"))).toEqual({
      code: "INTERNAL",
      message: "plain failure",
      retriable: false,
    });
    expect(toToolErrorBody("not an error")).toEqual({
      code: "INTERNAL",
      message: "internal error",
      retriable: false,
    });
  });

  it("declares every error code exactly once", () => {
    expect(new Set(TOOL_ERROR_CODES).size).toBe(TOOL_ERROR_CODES.length);
  });
});
