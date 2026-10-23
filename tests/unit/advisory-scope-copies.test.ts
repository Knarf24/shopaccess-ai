import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdvisoryTransportRequest } from "@/lib/providers/qwen-advisory";
import { TEST_SESSION_KEY } from "./helpers";

// Found in the blocked-provider dry run (October 22): under the dev server advisory-limits.ts is loaded once per route
// bundle. Each copy had its own AsyncLocalStorage, so a session scope set by a route was invisible to the limited
// transport that the cached runtime had built from another copy, and every external AI attempt was refused as LIMITED.
// Only the storage container is shared now; each request's session stays inside its own async scope.
const SCOPE_KEY = Symbol.for("shopaccess.advisorySessionScope");
const APPLICATION_KEY = Symbol.for("shopaccess.application");
const SYNTHORAI = "https://synthorai.io/v1/chat/completions";
const ENV = {
  SHOPACCESS_SESSION_KEY: TEST_SESSION_KEY.toString("base64"),
  SHOPACCESS_TRUSTED_ORIGINS: "https://shop.example.test",
  PAYMENT_PROVIDER_MODE: "mock",
  SHOPACCESS_AI_MODEL_ID: "qwen3.7-plus",
  SHOPACCESS_AI_ENDPOINT: SYNTHORAI,
  SHOPACCESS_AI_API_KEY: "synthetic-test-key",
  SHOPACCESS_AI_LIMIT_PER_SESSION: "2",
  SHOPACCESS_AI_LIMIT_PER_HOUR: "3",
  SHOPACCESS_AI_LIMIT_PER_DAY: "3",
} as const;

type LimitsModule = typeof import("@/server/advisory-limits");

/** A fresh copy of the module, as a separate route bundle would load it. */
async function freshCopy(): Promise<LimitsModule> {
  vi.resetModules();
  return import("@/server/advisory-limits");
}

function transportRequest(): AdvisoryTransportRequest {
  return { url: SYNTHORAI, method: "POST", headers: {}, body: new Uint8Array(), signal: new AbortController().signal } as AdvisoryTransportRequest;
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(ENV)) delete process.env[key];
  delete (globalThis as Record<symbol, unknown>)[APPLICATION_KEY];
});

describe("advisory session scope across module copies", () => {
  it("a scope set through one copy is visible to another, and only the storage container is global", async () => {
    const first = await freshCopy();
    const second = await freshCopy();
    expect(second).not.toBe(first);

    const seen = await first.withAdvisorySession("ses_a", async () => {
      await Promise.resolve();
      return second.currentAdvisorySession();
    });
    expect(seen).toBe("ses_a");
    expect(first.currentAdvisorySession()).toBeNull();
    expect(second.currentAdvisorySession()).toBeNull();

    const holder = (globalThis as Record<symbol, unknown>)[SCOPE_KEY];
    expect(holder).toBeInstanceOf(AsyncLocalStorage);
    expect((holder as AsyncLocalStorage<unknown>).getStore()).toBeUndefined();
    const advisoryGlobals = Object.getOwnPropertySymbols(globalThis).filter((symbol) => symbol.description?.startsWith("shopaccess.advisory"));
    expect(advisoryGlobals).toEqual([SCOPE_KEY]);
    const globals = globalThis as unknown as Record<string, unknown>;
    expect(Object.getOwnPropertyNames(globalThis).filter((name) => globals[name] === "ses_a")).toEqual([]);
  });

  it("a limited transport built from one copy forwards calls scoped by another and refuses unscoped calls", async () => {
    const first = await freshCopy();
    const second = await freshCopy();
    const sent: (string | null)[] = [];
    const inner = vi.fn(async () => {
      sent.push(first.currentAdvisorySession());
      return { status: 200, redirected: false, headers: new Headers(), body: null };
    });
    const limiter = first.createAdvisoryLimiter({ perSession: 5, perHour: 5, perDay: 5 }, () => new Date("2026-10-22T12:00:00Z"));
    const transport = first.createLimitedAdvisoryTransport(inner, limiter);

    await second.withAdvisorySession("ses_a", () => transport(transportRequest()));
    expect(sent).toEqual(["ses_a"]);

    await expect(transport(transportRequest())).rejects.toMatchObject({ code: "LIMITED" });
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("overlapping sessions keep their own scope through interleaved awaits and lose it after completion or failure", async () => {
    const first = await freshCopy();
    const second = await freshCopy();
    const gateA = deferred();
    const gateB = deferred();
    const seen: string[] = [];
    const record = (label: string) => seen.push(`${label}:${second.currentAdvisorySession()}`);

    const runA = first.withAdvisorySession("ses_a", async () => {
      record("a-start");
      await gateA.promise;
      record("a-resumed");
      await new Promise((resolve) => setTimeout(resolve, 0));
      record("a-timer");
    });
    const runB = second.withAdvisorySession("ses_b", async () => {
      record("b-start");
      await gateB.promise;
      record("b-resumed");
      throw new Error("provider failed");
    });
    record("outside");
    gateB.release();
    await expect(runB).rejects.toThrow("provider failed");
    record("after-b");
    gateA.release();
    await runA;
    record("after-a");

    expect(seen).toEqual([
      "a-start:ses_a",
      "b-start:ses_b",
      "outside:null",
      "b-resumed:ses_b",
      "after-b:null",
      "a-resumed:ses_a",
      "a-timer:ses_a",
      "after-a:null",
    ]);
    expect(() =>
      first.withAdvisorySession("ses_c", () => {
        throw new Error("synchronous failure");
      }),
    ).toThrow("synchronous failure");
    expect(first.currentAdvisorySession()).toBeNull();
    expect(second.currentAdvisorySession()).toBeNull();
  });

  it("concurrent sessions are each charged to their own allowance through a shared limiter", async () => {
    const first = await freshCopy();
    const second = await freshCopy();
    const gate = deferred();
    const charged: (string | null)[] = [];
    const inner = vi.fn(async () => {
      charged.push(first.currentAdvisorySession());
      await gate.promise;
      return { status: 200, redirected: false, headers: new Headers(), body: null };
    });
    const limiter = first.createAdvisoryLimiter({ perSession: 1, perHour: 10, perDay: 10 }, () => new Date("2026-10-22T12:00:00Z"));
    const transport = first.createLimitedAdvisoryTransport(inner, limiter);

    const a = first.withAdvisorySession("ses_a", () => transport(transportRequest()));
    const b = second.withAdvisorySession("ses_b", () => transport(transportRequest()));
    const aAgain = second.withAdvisorySession("ses_a", () => transport(transportRequest()));
    await expect(aAgain).rejects.toMatchObject({ code: "LIMITED" });
    gate.release();
    await Promise.all([a, b]);
    expect(charged).toEqual(["ses_a", "ses_b"]);
  });
});

describe("cached runtime across route bundles", () => {
  it("copies of the runtime share one application and one limiter, so limits hold across routes", async () => {
    Object.assign(process.env, ENV);
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);

    vi.resetModules();
    const routeOne = await import("@/server/runtime");
    const limitsOne = await import("@/server/advisory-limits");
    const application = routeOne.getApplication();
    vi.resetModules();
    const routeTwo = await import("@/server/runtime");
    const limitsTwo = await import("@/server/advisory-limits");
    expect(routeTwo).not.toBe(routeOne);
    expect(limitsTwo).not.toBe(limitsOne);
    expect(routeTwo.getApplication()).toBe(application);

    const one = routeOne.runtimeOf(application);
    const two = routeTwo.runtimeOf(routeTwo.getApplication());
    if (!one.ok || !two.ok) throw new Error("runtime configuration rejected");
    expect(two.value.advisoryLimiter).not.toBeNull();
    expect(two.value.advisoryLimiter).toBe(one.value.advisoryLimiter);

    const request = { instructions: "x", untrustedData: { shopperMessage: "a laptop", products: [] } };
    const attempt = (limits: LimitsModule | null, sessionId: string) =>
      (limits ? limits.withAdvisorySession(sessionId, () => one.value.ai.interpretNeeds(request)) : one.value.ai.interpretNeeds(request)).then(
        () => "sent",
        (error: { code?: string }) => error.code ?? "error",
      );

    expect(await attempt(limitsOne, "ses_a")).not.toBe("LIMITED");
    expect(await attempt(limitsTwo, "ses_a")).not.toBe("LIMITED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(await attempt(limitsOne, "ses_a")).toBe("LIMITED");
    expect(await attempt(null, "ses_b")).toBe("LIMITED");
    expect(await attempt(limitsTwo, "ses_b")).not.toBe("LIMITED");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(await attempt(limitsOne, "ses_c")).toBe("LIMITED");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
