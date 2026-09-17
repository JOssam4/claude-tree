import path from "node:path";
import { defineConfig } from "vitest/config";

// Single root-level config so `npm test` (vitest run) covers the server and
// web packages together non-interactively. Node environment is sufficient
// everywhere tested here — no DOM/component rendering is in scope (see the
// plan doc's "what NOT to test").
export default defineConfig({
  resolve: {
    alias: {
      // All current consumers only ever `import type` from this package, so
      // aliasing straight to its TS source (rather than requiring a prior
      // `tsc` build of packages/shared/dist) keeps `npm test` buildless.
      "@claude-tree/shared": path.resolve(__dirname, "packages/shared/src/types.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["packages/server/src/**/*.test.ts", "packages/web/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    watch: false,
  },
});
