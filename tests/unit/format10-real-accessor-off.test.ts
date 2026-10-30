import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openRuntime } from "../../src/server/runtime-access";
import { disposableStore, formatOnDisk, isolatedEnvironment } from "./format10-accessor-helpers";

// The REAL process accessor without the workload setting, over a format-10 store: it must refuse, not downgrade.
let restore: () => void = () => undefined;
let store: Awaited<ReturnType<typeof disposableStore>>;
let before = "";

beforeAll(async () => {
  store = await disposableStore({ workloadRecords: true });
  before = fs.readFileSync(join(store.dir, "store.json"), "utf8");
  restore = isolatedEnvironment({ SHOPACCESS_MOCK_STORE_DIR: store.dir, SHOPACCESS_MOCK_STORE_KEY_FILE: store.keyFile });
});
afterAll(() => {
  restore();
  store.remove();
});

describe("process accessor without the workload setting", () => {
  it("refuses a format-10 store explicitly and leaves it untouched", async () => {
    expect(process.env.SHOPACCESS_WORKLOAD_RECORDS).toBeUndefined();
    expect(await openRuntime()).toEqual({ status: "unavailable", code: "open-format-10-requires-workload-setting" });
    expect(fs.readFileSync(join(store.dir, "store.json"), "utf8")).toBe(before);
    expect(formatOnDisk(store.dir)).toBe(10);
  });
});
