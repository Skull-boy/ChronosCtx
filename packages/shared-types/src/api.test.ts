import { describe, expect, it } from "vitest";
import { isWebSurface, SURFACES, WEB_SURFACES, type WebSurface } from "./api.js";

describe("surfaces", () => {
  it("declares the authenticated surface set", () => {
    expect(SURFACES).toEqual([
      "opencode-cli",
      "antigravity",
      "claude-code",
      "cline",
      "cursor",
      "pi",
      "gemini-web",
      "chatgpt-web",
      "claude-web",
      "qwen-web",
      "extension",
      "cli",
      "import",
    ]);
    expect(new Set(SURFACES).size).toBe(SURFACES.length);
  });

  it("classifies exactly the four web surfaces", () => {
    expect(WEB_SURFACES).toEqual(["gemini-web", "chatgpt-web", "claude-web", "qwen-web"]);
    for (const surface of WEB_SURFACES) {
      expect(isWebSurface(surface)).toBe(true);
      expect(isWebSurface(surface as WebSurface)).toBe(true);
    }
    for (const surface of SURFACES) {
      if ((WEB_SURFACES as readonly string[]).includes(surface)) continue;
      expect(isWebSurface(surface)).toBe(false);
    }
  });
});
