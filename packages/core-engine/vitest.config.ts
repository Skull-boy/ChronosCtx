import { defineConfig } from "vitest/config";

/**
 * Gate 1.15: statement coverage is a release gate, not a vanity metric.
 * Test files and fixtures are excluded so the number describes shipped code.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.fixture.ts", "src/**/__fixtures__/**"],
      thresholds: {
        statements: 85,
      },
    },
  },
});
