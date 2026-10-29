import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  openFoundationStore,
  type FoundationStore,
} from "../../src/lib/session/snapshot-store";

const KEY = Buffer.from("isolated-snapshot-close-test-key");

type ClosableStore = FoundationStore & {
  close(): Promise<void>;
};

async function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-store-close-"));
  fs.chmodSync(directory, 0o700);

  const keyFile = join(directory, "identity.key");
  fs.writeFileSync(keyFile, KEY, { mode: 0o600 });

  const opened = await openFoundationStore(directory, KEY, {
    initializeEmpty: { keyFile },
  });

  if (opened.status !== "ready") {
    fs.rmSync(directory, { recursive: true, force: true });
    throw new Error(`Could not open fixture: ${opened.code}`);
  }

  return {
    directory,
    store: opened.value as ClosableStore,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

describe("snapshot store lifecycle", () => {
  it("releases the exclusive writer lock when closed", async () => {
    const test = await fixture();

    try {
      expect(typeof test.store.close).toBe("function");

      await test.store.close();

      const reopened = await openFoundationStore(test.directory, KEY);
      expect(reopened.status).toBe("ready");

      if (reopened.status === "ready") {
        await (reopened.value as ClosableStore).close();
      }
    } finally {
      test.cleanup();
    }
  });

  it("allows repeated close calls", async () => {
    const test = await fixture();

    try {
      await test.store.close();
      await expect(test.store.close()).resolves.toBeUndefined();
    } finally {
      test.cleanup();
    }
  });

  it("refuses reads and commits after close", async () => {
    const test = await fixture();

    try {
      const published = test.store.readPublished();
      expect(published.status).toBe("ready");

      await test.store.close();

      expect(test.store.readPublished().status).toBe("unavailable");

      if (published.status === "ready") {
        const result = await test.store.commit(published.value.body);
        expect(result).toEqual({
          status: "unavailable",
          outcome: "definite",
        });
      }
    } finally {
      test.cleanup();
    }
  });

  it("finishes an accepted queued commit before closing", async () => {
    const test = await fixture();

    try {
      const published = test.store.readPublished();
      expect(published.status).toBe("ready");
      if (published.status !== "ready") return;

      const commit = test.store.commit(published.value.body);
      const close = test.store.close();

      const result = await commit;
      expect(result.status).toBe("ready");

      await close;

      expect(test.store.readPublished().status).toBe("unavailable");
    } finally {
      test.cleanup();
    }
  });
});
