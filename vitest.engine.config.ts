import { defineConfig } from "vitest/config";

/**
 * Release-only engine job. It must be pointed at an approved Stockfish binary
 * via CHESSONGLASS_STOCKFISH whose SHA-256 matches docs/rights/artifacts.json.
 * The job fails when no test file or binary is available; it must never be
 * downgraded to describe.skipIf.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/engine/**/*.engine.test.ts"],
    exclude: ["node_modules/**", "dist/**", "tests/**", "evals/**"],
    testTimeout: 60000
  }
});
