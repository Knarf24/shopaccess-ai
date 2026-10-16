import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * PostgreSQL integration tests (Milestone 002, Increment 1).
 *
 * Deliberately separate from vitest.config.mts, so `npm test` never loads or
 * runs a database test. Running this configuration needs the Gate B-X
 * authorization and a positively verified disposable PostgreSQL 17 cluster
 * (see tests/db/harness.ts). Only while SHOPACCESS_PG_TEST_ADMIN_URL is not
 * set at all is every suite reported as skipped, never as passed. Once it is
 * set, even to an empty string, the suites run: the URL must then have the
 * harness's strict form and repeat SHOPACCESS_PG_TEST_AUTHORIZED_PORT, and an
 * empty, malformed or refused configuration FAILS instead of skipping.
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
