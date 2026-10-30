import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../src/lib/session/cookie";
import { needsDraftsFor } from "../../src/lib/session/store";
import { handleNeedsSession, handleNeedsSubmit } from "../../src/server/handlers";
import { runtimeOf } from "../../src/server/runtime";
import { openRuntime } from "../../src/server/runtime-access";
import { disposableStore, formatOnDisk, isolatedEnvironment, ORIGIN } from "./format10-accessor-helpers";

// The REAL process accessor (openRuntime, with its module-level singleton) started with SHOPACCESS_WORKLOAD_RECORDS=1
// over a brand-new disposable format-10 store. One test file means one singleton, so this file never restarts it.
let restore: () => void = () => undefined;
let store: Awaited<ReturnType<typeof disposableStore>>;

beforeAll(async () => {
  store = await disposableStore({ workloadRecords: true });
  restore = isolatedEnvironment({ SHOPACCESS_MOCK_STORE_DIR: store.dir, SHOPACCESS_MOCK_STORE_KEY_FILE: store.keyFile, SHOPACCESS_WORKLOAD_RECORDS: "1" });
});
afterAll(() => {
  restore();
  store.remove();
});

describe("process accessor with the workload setting on", () => {
  it("honours the setting: the real openRuntime opens the format-10 store and the record reaches the disk", async () => {
    const access = await openRuntime();
    expect(access.status).toBe("ready");
    if (access.status !== "ready") return;
    const runtime = runtimeOf(access.application);
    if (!runtime.ok) throw new Error("no runtime");
    vi.spyOn(runtime.value.ai, "interpretNeeds").mockResolvedValue({ understoodUse: "programming", budgetDollars: "900", followUp: null });
    const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime.value);
    const token = started.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    const resolved = await runtime.value.sessions.resolve(token);
    if (!resolved.ok) throw new Error("session");
    const response = await handleNeedsSubmit(
      new Request(`${ORIGIN}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: new URLSearchParams({ lang: "en", csrfToken: resolved.value.csrfToken, shopperText: "I want to train AI models locally" }).toString(),
      }),
      runtime.value,
    );
    expect(response.status).toBe(303);
    expect(needsDraftsFor(runtime.value.store).get(resolved.value.id)).toBeTruthy();
    expect(formatOnDisk(store.dir)).toBe(10);
    const body = JSON.parse(fs.readFileSync(join(store.dir, "store.json"), "utf8")).body;
    expect(body.workloads).toHaveLength(1);
    expect(body.workloads[0]).toMatchObject({ sessionId: resolved.value.id, kind: "local_training" });
  });
});
