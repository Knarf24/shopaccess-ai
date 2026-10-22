import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { beginInterpretation, deleteNeedsDrafts, mergeClarification, needsDraftsFor } from "@/lib/session/store";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { visibleNeedsNotice } from "@/server/shopping";
import { HOUR, createTestClock, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";
const SHOPPER_TEXT = "PortatilDePrueba para tareas";

function world() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  return { time, runtime };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${ORIGIN}/session/needs?lang=es`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session not established");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken, session: session.value };
}

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      cookie,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

describe("guided draft sharing", () => {
  it("shares a draft between separate module instances of the same store and isolates another store", async () => {
    const route = await import("@/lib/session/store");
    vi.resetModules();
    const page = await import("@/lib/session/store");
    expect(route.needsDraftsFor).not.toBe(page.needsDraftsFor);
    expect(Object.getOwnPropertySymbols(globalThis)).not.toContain(Symbol.for("shopaccess.needsDrafts"));

    const store = {};
    const other = {};
    const now = Date.now();
    const claimed = route.beginInterpretation(store, "session-a", {
      submittedVersion: null,
      language: "es",
      shopperText: SHOPPER_TEXT,
      expiresAtMs: now + 60_000,
      now,
    });
    if (claimed.kind !== "claimed") throw new Error(claimed.kind);
    expect(page.needsDraftsFor(store).get("session-a")?.draftId).toBe(claimed.draft.draftId);
    expect(page.needsDraftsFor(store).get("session-a")?.shopperText).toBe(SHOPPER_TEXT);
    expect(Object.getOwnPropertySymbols(store)).toContain(Symbol.for("shopaccess.needsDrafts"));
    expect(Object.getOwnPropertySymbols(other)).not.toContain(Symbol.for("shopaccess.needsDrafts"));
    expect(page.needsDraftsFor(other).has("session-a")).toBe(false);
    expect(page.needsDraftsFor(other).size).toBe(0);

    const { runtime: first } = world();
    const { runtime: second } = world();
    beginInterpretation(first.store, "session-a", {
      submittedVersion: null,
      language: "en",
      shopperText: "first runtime",
      expiresAtMs: now + 60_000,
      now,
    });
    beginInterpretation(second.store, "session-b", {
      submittedVersion: null,
      language: "en",
      shopperText: "second runtime",
      expiresAtMs: now + 60_000,
      now,
    });
    expect(needsDraftsFor(first.store).has("session-b")).toBe(false);
    expect(needsDraftsFor(second.store).has("session-a")).toBe(false);
    deleteNeedsDrafts(first.store, ["session-a"]);
    expect(needsDraftsFor(first.store).has("session-a")).toBe(false);
    expect(needsDraftsFor(second.store).get("session-b")?.shopperText).toBe("second runtime");
  });

  it("keeps shopper text and the structured review when interpretation is malformed, and shows a safe notice when the draft is missing", async () => {
    const page = readFileSync("src/app/[lang]/shop/needs/page.tsx", "utf8");
    const body = page.slice(page.indexOf("async function NeedsContent"));
    expect(body.indexOf("resolvePageSession")).toBeGreaterThan(-1);
    expect(body.indexOf("resolvePageSession")).toBeLessThan(body.indexOf("visibleNeedsNotice"));
    expect(body).toContain("showConfirm =");
    expect(body).toContain('journey.draft.notice === "review"');

    const { runtime } = world();
    const buyer = await shopper(runtime);
    const secret = "model-prose-secret";
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          return { understoodUse: "schoolwork", budgetDollars: "500", followUp: null, note: secret };
        },
      },
    };
    const submitted = await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: SHOPPER_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const location = submitted.headers.get("location") ?? "";
    expect(location).toBe("/es/shop/needs?notice=malformed");
    expect(location).not.toContain(SHOPPER_TEXT);
    expect(location).not.toContain(secret);
    expect(location).not.toContain(buyer.sessionId);
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    expect(draft.notice).toBe("malformed");
    expect(draft.shopperText).toBe(SHOPPER_TEXT);
    expect(draft.prefilledUse).toBeNull();
    expect(draft.confirmedUse).toBeNull();
    expect(visibleNeedsNotice({ sessionLive: true, draft, queryNotice: "malformed" })).toBe("malformed");

    const copy = journeyCopy("es");
    const kept = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="alert">
          {copy.notices.malformed}
        </p>
        <NeedsConversation copy={copy} language="es" csrfToken={buyer.csrfToken} draft={draft} mode="clarify" noticeRendered />
      </>,
    );
    expect(kept).toContain(SHOPPER_TEXT);
    expect(kept).toContain(copy.clarificationExplanation);
    expect(kept).toContain(copy.useLabel);
    expect(kept).toContain(copy.budgetLabel);
    expect(kept).toContain('name="draftId"');
    expect(kept).toContain("<textarea");
    expect(kept).not.toContain(copy.reviewTitle);
    expect(kept).not.toContain(copy.confirmReview);
    expect(kept).not.toContain(secret);

    const missing = visibleNeedsNotice({ sessionLive: true, draft: null, queryNotice: "malformed" });
    expect(missing).toBe("malformed");
    const fallback = renderToStaticMarkup(
      <>
        {missing === "malformed" ? <p role="alert">{copy.notices[missing]}</p> : null}
        <NeedsConversation copy={copy} language="es" csrfToken={buyer.csrfToken} draft={null} mode="first" />
      </>,
    );
    expect(fallback).toContain('role="alert"');
    expect(fallback).toContain(copy.notices.malformed);
    expect(fallback).toContain(copy.useLabel);
    expect(fallback).toContain("<textarea");
    expect(fallback).not.toContain(copy.reviewTitle);
    expect(fallback).not.toContain('name="draftId"');
    expect(fallback).not.toContain(SHOPPER_TEXT);
    expect(visibleNeedsNotice({ sessionLive: false, draft: null, queryNotice: "malformed" })).toBeNull();
    expect(visibleNeedsNotice({ sessionLive: true, draft: null, queryNotice: "https://evil.example" })).toBeNull();
    expect(visibleNeedsNotice({ sessionLive: true, draft: { notice: null }, queryNotice: "malformed" })).toBeNull();
  });

  it("clears the malformed alert only after a successful confirmation", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          return { understoodUse: "schoolwork", budgetDollars: "500", followUp: null, note: "kept-out" };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: SHOPPER_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    expect(draft.notice).toBe("malformed");
    const copy = journeyCopy("es");
    const alertFor = (notice: typeof draft.notice) =>
      renderToStaticMarkup(<>{notice === "malformed" || notice === "unavailable" ? <p role="alert">{copy.notices[notice]}</p> : null}</>);

    const stale = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "es", draftId: draft.draftId, version: String(draft.version + 1), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    expect(stale.headers.get("location")).toBe("/es/shop/needs?error=STALE_DRAFT");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.notice).toBe("malformed");

    const incomplete = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "es", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    expect(incomplete.headers.get("location")).toBe("/es/shop/needs?error=CONFIRM_INCOMPLETE");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.notice).toBe("malformed");
    expect(alertFor("malformed")).toContain(copy.notices.malformed);

    const confirmed = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "es", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    expect(confirmed.headers.get("location")).toBe("/es/shop/needs");
    const kept = needsDraftsFor(runtime.store).get(buyer.sessionId);
    expect(kept?.notice).toBeNull();
    expect(kept?.confirmedUse).toBe("schoolwork");
    expect(kept?.confirmedBudgetDollars).toBe("500");
    const cleared = visibleNeedsNotice({ sessionLive: true, draft: kept ?? null, queryNotice: "malformed" });
    expect(cleared).toBeNull();
    expect(alertFor(cleared)).not.toContain(copy.notices.malformed);

    const conflict = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "es", draftId: draft.draftId, version: String(draft.version), use: "programming", budget: "800", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    expect(conflict.headers.get("location")).toBe("/es/shop/needs?error=STALE_DRAFT");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.notice).toBeNull();
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.confirmedUse).toBe("schoolwork");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.confirmedBudgetDollars).toBe("500");
  });

  it("refuses an expired session and a stale interpretation result", async () => {
    const { time, runtime } = world();
    const buyer = await shopper(runtime);
    let release: () => void = () => {};
    let markStarted: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          markStarted();
          await gate;
          return { understoodUse: "programming", budgetDollars: "800", followUp: null };
        },
      },
    };
    const pending = handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: SHOPPER_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    await started;
    const version = needsDraftsFor(runtime.store).get(buyer.sessionId)!.version;
    const replaced = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        { lang: "es", shopperText: "", use: "schoolwork", budget: "500", version: String(version), csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    expect(replaced.headers.get("location")).toBe("/es/shop/needs");
    release();
    const late = await pending;
    expect(late.headers.get("location")).toBe("/es/shop/needs");
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    expect(draft?.prefilledUse).toBe("schoolwork");
    expect(draft?.prefilledBudgetDollars).toBe("500");
    expect(draft?.notice).toBe("review");
    expect(draft?.confirmedUse).toBeNull();
    expect(visibleNeedsNotice({ sessionLive: true, draft: draft ?? null, queryNotice: "malformed" })).toBe("review");

    const expiredWorld = world();
    const other = await shopper(expiredWorld.runtime);
    let releaseExpired: () => void = () => {};
    let markExpired: () => void = () => {};
    const expiredGate = new Promise<void>((resolve) => {
      releaseExpired = resolve;
    });
    const expiredStarted = new Promise<void>((resolve) => {
      markExpired = resolve;
    });
    const expiring = {
      ...expiredWorld.runtime,
      ai: {
        ...expiredWorld.runtime.ai,
        async interpretNeeds() {
          markExpired();
          await expiredGate;
          return { understoodUse: "schoolwork", budgetDollars: "500", followUp: null };
        },
      },
    };
    const hanging = handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: SHOPPER_TEXT, csrfToken: other.csrfToken }, other.cookie),
      expiring,
    );
    await expiredStarted;
    expiredWorld.time.advance(2 * HOUR);
    releaseExpired();
    const refused = await hanging;
    expect(refused.headers.get("location")).toBe("/es/shop/needs?error=DRAFT_EXPIRED");
    expect(refused.headers.get("location")).not.toContain("notice=");
    expect(needsDraftsFor(expiredWorld.runtime.store).get(other.sessionId)?.notice).toBeNull();
    expect(needsDraftsFor(expiredWorld.runtime.store).get(other.sessionId)?.prefilledUse).toBeNull();
    await expiredWorld.runtime.maintain();
    expect(needsDraftsFor(expiredWorld.runtime.store).has(other.sessionId)).toBe(false);
    const confirm = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "es", draftId: `nd_${"ab".repeat(16)}`, version: "1", use: "schoolwork", budget: "500", csrfToken: other.csrfToken },
        other.cookie,
      ),
      expiredWorld.runtime,
    );
    expect(confirm.status).toBe(403);
  });

  it("merges clarification only onto the session-owned draft and refuses at the write when expired", async () => {
    const first = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: createTestClock().clock });
    const second = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: createTestClock().clock });
    const now = Date.parse("2026-10-08T12:00:00.000Z");
    beginInterpretation(first.store, "session-a", {
      submittedVersion: null,
      language: "en",
      shopperText: "I need a laptop for school.",
      expiresAtMs: now + HOUR,
      now,
    });
    const owned = needsDraftsFor(first.store).get("session-a");
    if (!owned) throw new Error("owned draft missing");
    needsDraftsFor(first.store).set("session-a", {
      ...owned,
      prefilledUse: "schoolwork",
      prefilledBudgetDollars: null,
      notice: "missing_budget",
    });

    const merged = mergeClarification(
      first.store,
      "session-a",
      {
        draftId: owned.draftId,
        version: owned.version,
        use: "schoolwork",
        budgetDollars: "500",
        expiresAtMs: now + HOUR,
        now,
      },
      () => true,
    );
    if (typeof merged === "string") throw new Error(merged);
    expect(merged.shopperText).toBe("I need a laptop for school.");
    expect(merged.language).toBe("en");
    expect(merged.version).toBe(owned.version + 1);
    expect(merged.confirmedUse).toBeNull();
    expect(merged.recommendationClaim).toBeNull();
    expect(merged.notice).toBe("review");
    expect(needsDraftsFor(second.store).has("session-a")).toBe(false);

    needsDraftsFor(first.store).set("session-a", { ...merged, expiresAtMs: now - 1 });
    const expired = mergeClarification(
      first.store,
      "session-a",
      {
        draftId: merged.draftId,
        version: merged.version,
        use: "schoolwork",
        budgetDollars: "500",
        expiresAtMs: now + HOUR,
        now,
      },
      () => true,
    );
    expect(expired).toBe("expired");
    expect(needsDraftsFor(first.store).has("session-a")).toBe(false);

    const dead = mergeClarification(
      first.store,
      "session-a",
      {
        draftId: merged.draftId,
        version: merged.version,
        use: "schoolwork",
        budgetDollars: "500",
        expiresAtMs: now + HOUR,
        now,
      },
      () => false,
    );
    expect(dead).toBe("session_dead");
  });

  it("checks the version present at the synchronous clarification write", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: SHOPPER_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    const firstVersion = draft.version;
    needsDraftsFor(runtime.store).set(buyer.sessionId, {
      ...draft,
      prefilledUse: "schoolwork",
      prefilledBudgetDollars: null,
      notice: "missing_budget",
    });
    const winner = mergeClarification(
      runtime.store,
      buyer.sessionId,
      {
        draftId: draft.draftId,
        version: firstVersion,
        use: "schoolwork",
        budgetDollars: "500",
        expiresAtMs: draft.expiresAtMs,
        now: runtime.clock().getTime(),
      },
      () => runtime.checkout.sessionIsLive(buyer.sessionId),
    );
    if (typeof winner === "string") throw new Error(winner);
    const loser = mergeClarification(
      runtime.store,
      buyer.sessionId,
      {
        draftId: draft.draftId,
        version: firstVersion,
        use: "programming",
        budgetDollars: "800",
        expiresAtMs: draft.expiresAtMs,
        now: runtime.clock().getTime(),
      },
      () => runtime.checkout.sessionIsLive(buyer.sessionId),
    );
    expect(loser).toBe("stale");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.prefilledUse).toBe("schoolwork");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.prefilledBudgetDollars).toBe("500");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.version).toBe(firstVersion + 1);
  });
});
