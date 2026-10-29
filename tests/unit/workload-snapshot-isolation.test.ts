import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { openFoundationStore } from "../../src/lib/session/snapshot-store";

const directories: string[] = [];
const storesToClose: Array<{ close?: () => Promise<void> }> = [];

afterEach(async () => {
  try {
    for (const store of storesToClose.splice(0).reverse()) {
      await store.close?.();
    }
  } finally {
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

function freshDirectory(): { directory: string; keyFile: string } {
  const directory = fs.mkdtempSync(join(tmpdir(), "sa-workload-f9-"));
  fs.chmodSync(directory, 0o700);
  directories.push(directory);

  const keyFile = join(directory, "identity.key");
  fs.writeFileSync(keyFile, "isolated-workload-format9-test-key", { mode: 0o600 });
  return { directory, keyFile };
}

describe("format-9 workload snapshot isolation", () => {
  it("initializes format 9 only when explicitly requested", async () => {
    const { directory, keyFile } = freshDirectory();

    const opened = await openFoundationStore(directory, Buffer.from("isolated-workload-format9-test-key", "utf8"), {
      format9WorkloadTestStore: true,
      initializeEmpty: { keyFile },
    });

    expect(opened.status).toBe("ready");
    if (opened.status !== "ready") return;
    storesToClose.push(opened.value);

    const snapshot = opened.value.readPublished();
    expect(snapshot.status).toBe("ready");
    if (snapshot.status !== "ready") return;

    expect(snapshot.value.format).toBe(9);
    expect(snapshot.value.body.workloads).toEqual([]);
  });

  it("refuses an existing format-7 store without changing its snapshot bytes", async () => {
    const { directory, keyFile } = freshDirectory();

    const ordinary = await openFoundationStore(directory, Buffer.from("isolated-workload-format9-test-key", "utf8"), {
      initializeEmpty: { keyFile },
    });
    expect(ordinary.status).toBe("ready");
    if (ordinary.status !== "ready") return;
    storesToClose.push(ordinary.value);

    const before = fs.readFileSync(join(directory, "store.json"));

    // A restart uses a fresh directory so the original writer lock cannot
    // accidentally satisfy the format-isolation assertion.
    const restart = freshDirectory();
    fs.writeFileSync(join(restart.directory, "store.json"), before, { mode: 0o600 });

    const attempted = await openFoundationStore(
      restart.directory,
      Buffer.from("isolated-workload-format9-test-key", "utf8"),
      { format9WorkloadTestStore: true },
    );

    expect(attempted.status).toBe("unavailable");
    expect(fs.readFileSync(join(restart.directory, "store.json"))).toEqual(before);
    expect(fs.readFileSync(join(directory, "store.json"))).toEqual(before);
  });
});
