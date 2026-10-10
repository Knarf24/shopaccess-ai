import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * PostgreSQL integration tests (Milestone 002, Increment 1).
 *
 * Deliberately separate from vitest.config.mts, so `npm test` never loads or
 * runs a database test. Running this configuration needs the Gate B-X
 * authorization and a positively verified disposable PostgreSQL 17 cluster
 * (see tests/db/harness.ts). Without SHOPACCESS_PG_TEST_ADMIN_URL every suite
 * is reported as skipped, never as passed.
 *
 * Test files run one at a time: they share cluster-wide roles.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/db/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
