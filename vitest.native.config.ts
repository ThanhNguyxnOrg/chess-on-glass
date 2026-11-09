import { defineConfig } from "vitest/config";

/**
 * Release/native integration job. These tests need approved local binaries
 * (for example CHESSONGLASS_FFMPEG) and fail closed when one is missing; they
 * are never silently skipped and never run in the default unit suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/native/**/*.integration.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/**", "evals/**"],
    testTimeout: 120_000
  }
});
