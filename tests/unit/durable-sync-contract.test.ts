import { describe, expect, expectTypeOf, it } from "vitest";

import { memoryDurableHost, type DurableHost, type snapshotDurableHost } from "../../src/lib/session/durable";
import { InMemorySessionStore } from "../../src/lib/session/store";

/**
 * DurableHost.change runs its callback as one synchronous decision: snapshot mode commits right after the callback
 * returns, and memory mode cleans up in the same step. A callback that returns a promise (or any thenable) would finish
 * its work after that point, so the type rejects it. Awaited work stays outside the callback.
 *
 * These checks are enforced by `tsc --noEmit` (the typecheck gate): each @ts-expect-error line must produce a type
 * error, or the typecheck fails. The function is never called, so no promise-returning callback ever runs.
 */
function promiseReturningCallbacksDoNotCompile(memory: DurableHost, snapshot: ReturnType<typeof snapshotDurableHost>) {
  for (const host of [memory, snapshot]) {
    // @ts-expect-error an async callback returns a promise
    void host.change(async () => 1);
    // @ts-expect-error an async callback with no value still returns a promise
    void host.change(async (scratch) => void scratch);
    // @ts-expect-error a callback returning a promise
    void host.change(() => Promise.resolve("value"));
    // @ts-expect-error a callback returning any thenable
    void host.change(() => ({ then: (resolve: (value: number) => void) => resolve(1) }));
    // @ts-expect-error a callback that may return a promise
    void host.change((): number | Promise<number> => 1);
    // @ts-expect-error an untyped (any) result, here from JSON.parse, cannot prove it is not a promise
    void host.change(() => JSON.parse("1"));
  }
}

describe("DurableHost.change accepts synchronous callbacks only", () => {
  it("rejects promise-returning callbacks at compile time (checked by the typecheck gate)", () => {
    expect(typeof promiseReturningCallbacksDoNotCompile).toBe("function");
  });

  it("keeps ordinary callbacks' return types", async () => {
    const host = memoryDurableHost({}, new InMemorySessionStore(), { windowStartedAt: null, count: 0 });
    expectTypeOf(host.change(() => 1)).toEqualTypeOf<Promise<number>>();
    expectTypeOf(host.change(() => undefined)).toEqualTypeOf<Promise<undefined>>();
    expectTypeOf(host.change((scratch) => void scratch)).toEqualTypeOf<Promise<undefined>>();
    expectTypeOf(
      host.change((scratch) => {
        void scratch;
      }),
    ).toEqualTypeOf<Promise<void>>();
    expectTypeOf(host.change(() => ({ kind: "done" as const, count: 2 }))).toEqualTypeOf<Promise<{ kind: "done"; count: number }>>();
    expectTypeOf(host.change((): "stale" | null => null)).toEqualTypeOf<Promise<"stale" | null>>();
    expectTypeOf(host.change((): unknown => 1)).toEqualTypeOf<Promise<unknown>>();
    await expect(host.change(() => 7)).resolves.toBe(7);
    await expect(host.change(() => ({ kind: "done" as const }))).resolves.toEqual({ kind: "done" });
  });
});
