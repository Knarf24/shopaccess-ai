import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * HTTP and application-restart integration driver (specification 19.19, Increment 2.3). NEVER RUN.
 *
 * Deliberately separate from vitest.config.mts and vitest.db.config.mts: `npm test` never loads the driver, and the
 * database suites never load it either. It selects only tests/integration/*.integration.test.ts.
 *
 * Running it needs its own authorization: a newly provisioned disposable PostgreSQL 17 cluster that the execution
 * gate verified, and the explicit inputs named in tests/integration/app-process.ts. While the authorization input
 * is not set at all, every case is reported as skipped, never as passed, and nothing is opened or started. Once it
 * is set, a missing or malformed input FAILS before anything is opened.
 *
 * One file, one case at a time: the cases share one fixture, one application port and one sequence.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/*.integration.test.ts"],
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    // Above the helper's own deadlines (60 s to start, 15 s a request, 5 s plus 5 s to stop), so a helper deadline
    // is what reports a stall, with its own name.
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
