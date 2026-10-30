import fs from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "../../src/lib/session/cookie";
import { handleNeedsSession, handleNeedsSubmit } from "../../src/server/handlers";
import { runtimeOf } from "../../src/server/runtime";
import { openRuntime } from "../../src/server/runtime-access";
import { disposableStore, formatOnDisk, isolatedEnvironment, ORIGIN } from "./format10-accessor-helpers";

// The REAL process accessor with a store requested and NO workload setting: ordinary mode, format 7 stays format 7.
let restore: () => void = () => undefined;
let store: Awaited<ReturnType<typeof disposableStore>>;

beforeAll(async () => {
  store = await disposableStore({});
  restore = isolatedEnvironment({ SHOPACCESS_MOCK_STORE_DIR: store.dir, SHOPACCESS_MOCK_STORE_KEY_FILE: store.keyFile });
});
afterAll(() => {
  restore();
  store.remove();
});

describe("process accessor default", () => {
  it("opens an ordinary store, writes format 7 and keeps no workload records on disk", async () => {
    expect(process.env.SHOPACCESS_WORKLOAD_RECORDS).toBeUndefined();
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
    await handleNeedsSubmit(
      new Request(`${ORIGIN}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${token}` },
        body: new URLSearchParams({ lang: "en", csrfToken: resolved.value.csrfToken, shopperText: "I want to train AI models locally" }).toString(),
      }),
      runtime.value,
    );
    expect(formatOnDisk(store.dir)).toBe(7);
    expect(JSON.parse(fs.readFileSync(join(store.dir, "store.json"), "utf8")).body.workloads).toBeUndefined();
  });
});
