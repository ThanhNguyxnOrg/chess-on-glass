import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

const workspaceAliases = {
  "@chessonglass/contracts": resolve(root, "packages/contracts/src/index.ts"),
  "@chessonglass/platform": resolve(root, "packages/platform/src/index.ts"),
  "@chessonglass/chess": resolve(root, "packages/chess/src/index.ts"),
  "@chessonglass/perception": resolve(root, "packages/perception/src/index.ts"),
  "@chessonglass/game": resolve(root, "packages/game/src/index.ts")
};

export default defineConfig({
  resolve: {
    alias: workspaceAliases
  },
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "**/*.integration.test.ts"
    ],
    testTimeout: 15000
  }
});
