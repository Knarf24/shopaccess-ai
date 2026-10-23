import { describe, expect, it } from "vitest";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import {
  CSRF_COOKIE_NAME,
  handleDemoAdmissionSubmit,
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_WINDOW_MS,
  resolveDemoAdmission,
} from "@/server/demo-admission";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// A matching passphrase refunds the attempt it reserved. The refund is bound to that reservation's window: a request that
// spent in an older window and finishes after a newer window opened must not give back an attempt of the newer window.

const ORIGIN = "https://shop.example.test";
const PASSPHRASE = "test-passphrase-value";
const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] };

function admissionOn() {
  const admission = resolveDemoAdmission(
    { NODE_ENV: "production", SHOPACCESS_DEMO_ADMISSION: "on", SHOPACCESS_DEMO_ADMISSION_KEY: Buffer.alloc(32, 9).toString("base64"), SHOPACCESS_DEMO_PASSPHRASE: PASSPHRASE },
    TEST_SESSION_KEY,
  );
  if (admission.mode !== "on") throw new Error("admission did not turn on");
  return admission;
}

function diskStore() {
  let published = structuredClone(EMPTY);
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 2, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      published = structuredClone(body) as PublishedBody;
      return { status: "ready", value: { format: 2, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
    },
  };
  return { store, window: () => published.admissionLogin };
}

/** A runtime with admission on, in memory or snapshot mode, and a reader for the admission window it relies on. */
async function admissionRuntime(mode: "memory" | "snapshot") {
  const time = createTestClock();
  const admission = admissionOn();
  const options = { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) };
  if (mode === "memory") {
    const runtime = createRuntime(options, { clock: time.clock, admission });
    return { time, runtime, window: () => ({ ...admission.attempts }) };
  }
  const disk = diskStore();
  const opened = await recoverStateGate(disk.store, time.clock());
  if (opened.status !== "ready") throw new Error(opened.code);
  const runtime = createRuntime(options, { clock: time.clock, gate: opened.gate, admission });
  return { time, runtime, window: disk.window };
}

function submit(fields: Record<string, string>, csrf?: string): Request {
  const headers = new Headers({ origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" });
  if (csrf) headers.set("cookie", `${CSRF_COOKIE_NAME}=${csrf}`);
  return new Request(`${ORIGIN}/demo/admission/submit`, { method: "POST", headers, body: new URLSearchParams(fields) });
}

async function csrfFor(runtime: Runtime): Promise<string> {
  const response = await handleDemoAdmissionSubmit(submit({ lang: "en" }), runtime);
  return response.headers.getSetCookie()[0].split(";")[0].slice(CSRF_COOKIE_NAME.length + 1);
}

const attempt = (runtime: Runtime, csrf: string, passphrase: string) =>
  handleDemoAdmissionSubmit(submit({ lang: "en", demoCsrf: csrf, passphrase }, csrf), runtime);

/** Runs `between` once, right after the next admission spend is durable and before that request compares its passphrase. */
function interleave(runtime: Runtime, between: () => Promise<void>) {
  const spend = runtime.durable.spendAdmissionAttempt.bind(runtime.durable);
  let pending = true;
  Object.assign(runtime.durable, {
    spendAdmissionAttempt: async (...args: Parameters<typeof spend>) => {
      const decision = await spend(...args);
      if (pending) {
        pending = false;
        await between();
      }
      return decision;
    },
  });
}

for (const mode of ["memory", "snapshot"] as const) {
  describe(`admission refund is bound to its own window (${mode})`, () => {
    it("an old success finishing after rollover leaves a newer window full of wrong attempts full", async () => {
      const { time, runtime, window } = await admissionRuntime(mode);
      const csrf = await csrfFor(runtime);
      let newWindowStart = 0;
      interleave(runtime, async () => {
        time.advance(LOGIN_WINDOW_MS);
        newWindowStart = runtime.clock().getTime();
        const fresh = await csrfFor(runtime);
        for (let wrong = 1; wrong <= LOGIN_ATTEMPT_LIMIT; wrong += 1) {
          expect((await attempt(runtime, fresh, `${PASSPHRASE}-wrong`)).headers.get("location")).toBe("/en/demo/admission?notice=rejected");
        }
      });

      const old = await attempt(runtime, csrf, PASSPHRASE);
      expect(old.headers.get("location")).toBe("/?lang=en");
      expect(window()).toEqual({ windowStartedAt: newWindowStart, count: LOGIN_ATTEMPT_LIMIT });

      const fresh = await csrfFor(runtime);
      expect((await attempt(runtime, fresh, PASSPHRASE)).headers.get("location")).toBe("/en/demo/admission?notice=retry");
      expect((await attempt(runtime, fresh, `${PASSPHRASE}-guess`)).headers.get("location")).toBe("/en/demo/admission?notice=retry");
    });

    it("an old success finishing after rollover leaves a newer window's single wrong attempt counted", async () => {
      const { time, runtime, window } = await admissionRuntime(mode);
      const csrf = await csrfFor(runtime);
      let newWindowStart = 0;
      interleave(runtime, async () => {
        time.advance(LOGIN_WINDOW_MS + 1);
        newWindowStart = runtime.clock().getTime();
        await attempt(runtime, await csrfFor(runtime), `${PASSPHRASE}-wrong`);
      });
      expect((await attempt(runtime, csrf, PASSPHRASE)).headers.get("location")).toBe("/?lang=en");
      expect(window()).toEqual({ windowStartedAt: newWindowStart, count: 1 });
    });

    it("a success in the same window refunds only its own attempt, not a wrong one made meanwhile", async () => {
      const { runtime, window } = await admissionRuntime(mode);
      const csrf = await csrfFor(runtime);
      const start = runtime.clock().getTime();
      interleave(runtime, async () => {
        expect((await attempt(runtime, csrf, `${PASSPHRASE}-wrong`)).headers.get("location")).toBe("/en/demo/admission?notice=rejected");
      });
      expect((await attempt(runtime, csrf, PASSPHRASE)).headers.get("location")).toBe("/?lang=en");
      expect(window()).toEqual({ windowStartedAt: start, count: 1 });
    });
  });
}
