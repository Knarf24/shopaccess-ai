import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { prepareConfirmation } from "@/lib/confirmation/confirmation";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { MAX_CONVERSATION_TURNS, readConversation } from "@/lib/session/conversation";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { handleCheckoutStart, handleConfirm, handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const ORIGIN = "https://shop.example.test";

function world() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  return { runtime };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session not established");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken, session: session.value };
}

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

function draftFor(runtime: Runtime, sessionId: string) {
  const draft = needsDraftsFor(runtime.store).get(sessionId);
  if (!draft) throw new Error("draft missing");
  return draft;
}

describe("guided conversation increment", () => {
  it("keeps later messages in a bounded history and does not confirm them implicitly", async () => {
    const { runtime } = world();
    expect(runtime.advisory).toBe("local");
    expect(runtime.channel3.mode).toBe("disabled");
    expect(runtime.channel3.search).toBeNull();
    expect(runtime.paymentMode).toBe("mock");
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const responses: { understoodUse: "schoolwork"; budgetDollars: string | null; followUp: "budget" | null }[] = [
      { understoodUse: "schoolwork", budgetDollars: null, followUp: "budget" },
      { understoodUse: "schoolwork", budgetDollars: "580", followUp: null },
    ];
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          return responses[Math.min(interpretations, responses.length) - 1] ?? responses[0]!;
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "I need a laptop for school.", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const first = draftFor(runtime, buyer.sessionId);
    expect(first.prefilledUse).toBe("schoolwork");
    expect(first.prefilledBudgetDollars).toBeNull();
    expect(first.confirmedUse).toBeNull();
    expect(first.notice).toBe("missing_budget");

    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "es",
          draftId: first.draftId,
          version: String(first.version),
          shopperText: "My budget is 580",
          use: "schoolwork",
          budget: "",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(interpretations).toBe(2);
    const ready = draftFor(runtime, buyer.sessionId);
    expect(ready.language).toBe("en");
    expect(ready.prefilledUse).toBe("schoolwork");
    expect(ready.prefilledBudgetDollars).toBe("580");
    expect(ready.confirmedUse).toBeNull();
    expect(ready.confirmedBudgetDollars).toBeNull();
    expect(ready.notice).toBe("review");
    const state = readConversation(runtime.store, buyer.sessionId);
    expect(state?.interfaceLanguage).toBe("en");
    expect(state?.draftId).toBe(ready.draftId);
    expect(state?.turns.filter((turn) => turn.role === "shopper").map((turn) => turn.text)).toEqual([
      "I need a laptop for school.",
      "My budget is 580",
    ]);
    const copy = journeyCopy("en");
    const markup = renderToStaticMarkup(
      <NeedsConversation copy={copy} language="en" csrfToken={buyer.csrfToken} draft={ready} mode="clarify" turns={state?.turns} />,
    );
    expect(markup).toContain("<textarea");
    expect(markup).toContain('id="needs-budget"');
    expect(markup).toContain('name="draftId"');
    expect(markup).toContain(copy.notices.missing_budget);
    expect(markup).toContain("My budget is 580");

    await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "en", draftId: ready.draftId, version: String(ready.version), use: "schoolwork", budget: "580", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    expect(draftFor(runtime, buyer.sessionId).confirmedBudgetDollars).toBe("580");
    expect(interpretations).toBe(2);

    const spanish = await shopper(runtime);
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: "Necesito una computadora para la escuela.", csrfToken: spanish.csrfToken }, spanish.cookie),
      guided,
    );
    expect(readConversation(runtime.store, spanish.sessionId)?.interfaceLanguage).toBe("es");
    expect(draftFor(runtime, spanish.sessionId).language).toBe("es");
  });

  it("corrects use through a later message and ignores a budget the text does not support", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          return { understoodUse: "programming" as const, budgetDollars: "900", followUp: null };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "580", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const saved = draftFor(runtime, buyer.sessionId);
    await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "en", draftId: saved.draftId, version: String(saved.version), use: "schoolwork", budget: "580", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    const confirmed = draftFor(runtime, buyer.sessionId);
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: confirmed.draftId,
          version: String(confirmed.version),
          shopperText: "I need it for programming",
          use: "schoolwork",
          budget: "580",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(interpretations).toBe(1);
    const corrected = draftFor(runtime, buyer.sessionId);
    expect(corrected.prefilledUse).toBe("programming");
    expect(corrected.prefilledBudgetDollars).toBe("580");
    expect(corrected.confirmedUse).toBeNull();
    expect(corrected.confirmedBudgetDollars).toBeNull();
    expect(corrected.notice).toBe("review");
    expect(JSON.stringify(corrected)).not.toContain("900");
    expect(interpretations).toBe(1);

    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: corrected.draftId,
          version: String(corrected.version),
          use: "general_productivity",
          budget: "450",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(interpretations).toBe(1);
    const structured = draftFor(runtime, buyer.sessionId);
    expect(structured.prefilledUse).toBe("general_productivity");
    expect(structured.prefilledBudgetDollars).toBe("450");
    expect(structured.confirmedUse).toBeNull();
    expect(structured.notice).toBe("review");
  });

  it("asks again for an ambiguous budget and does not adopt a guessed amount", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          return { understoodUse: "schoolwork" as const, budgetDollars: "750", followUp: null };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "400", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const saved = draftFor(runtime, buyer.sessionId);
    await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "en", draftId: saved.draftId, version: String(saved.version), use: "schoolwork", budget: "400", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    const confirmed = draftFor(runtime, buyer.sessionId);
    const journey = await loadNeedsJourney(guided, buyer.session);
    expect(journey.draft?.recommendation).not.toBeNull();
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: confirmed.draftId,
          version: String(confirmed.version),
          shopperText: "under 500 or 600",
          use: "schoolwork",
          budget: "400",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    const asked = draftFor(runtime, buyer.sessionId);
    expect(asked.notice).toBe("ambiguous");
    expect(asked.prefilledUse).toBe("schoolwork");
    expect(asked.prefilledBudgetDollars).toBe("400");
    expect(asked.confirmedUse).toBe("schoolwork");
    expect(asked.confirmedBudgetDollars).toBe("400");
    expect(asked.recommendation).toEqual(journey.draft?.recommendation);
    expect(JSON.stringify(asked)).not.toContain("750");
    expect(readConversation(runtime.store, buyer.sessionId)?.turns.at(-1)).toEqual({ role: "assistant", text: "ambiguous" });
  });

  it("keeps the confirmed requirements when interpretation fails", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          if (interpretations === 1) throw new Error("interpreter down");
          return { understoodUse: "programming" as const, budgetDollars: "900", followUp: null, extra: true };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const saved = draftFor(runtime, buyer.sessionId);
    await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "en", draftId: saved.draftId, version: String(saved.version), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    await loadNeedsJourney(guided, buyer.session);
    const confirmed = draftFor(runtime, buyer.sessionId);
    expect(confirmed.recommendation).not.toBeNull();
    const unavailable = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: confirmed.draftId,
          version: String(confirmed.version),
          shopperText: "Try a different wording",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(unavailable.headers.get("location")).toContain("notice=unavailable");
    const kept = draftFor(runtime, buyer.sessionId);
    expect(kept.notice).toBe("unavailable");
    expect(kept.confirmedUse).toBe("schoolwork");
    expect(kept.confirmedBudgetDollars).toBe("500");
    expect(kept.prefilledUse).toBe("schoolwork");
    expect(kept.prefilledBudgetDollars).toBe("500");
    expect(kept.recommendation).toEqual(confirmed.recommendation);

    const malformed = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: kept.draftId,
          version: String(kept.version),
          shopperText: "Please switch the intended use",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(malformed.headers.get("location")).toContain("notice=malformed");
    const still = draftFor(runtime, buyer.sessionId);
    expect(still.notice).toBe("malformed");
    expect(still.confirmedUse).toBe("schoolwork");
    expect(still.confirmedBudgetDollars).toBe("500");
    expect(still.prefilledUse).toBe("schoolwork");
    expect(still.prefilledBudgetDollars).toBe("500");
    expect(still.recommendation).toEqual(confirmed.recommendation);
  });

  it("invalidates a needs checkout when a supported change withdraws confirmation", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          return { understoodUse: "programming" as const, budgetDollars: "900", followUp: null };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "580", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const saved = draftFor(runtime, buyer.sessionId);
    await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang: "en", draftId: saved.draftId, version: String(saved.version), use: "schoolwork", budget: "580", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    const journey = await loadNeedsJourney(guided, buyer.session);
    expect(journey.draft?.recommendation).not.toBeNull();
    const started = await handleCheckoutStart(
      post(
        "/checkout/start",
        {
          productId: "dmp_aspirego15",
          variantId: "dmv_aspirego15",
          quantity: "1",
          use: "schoolwork",
          budget: "580",
          lang: "en",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    const intentId = started.headers.get("location")?.split("/").pop() ?? "";
    expect(intentId.startsWith("ci_")).toBe(true);
    const intent = await runtime.store.findIntent(intentId);
    const quoteId = intent?.snapshot.context.quoteId;
    if (!quoteId) throw new Error("quote missing");
    const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const confirmed = draftFor(runtime, buyer.sessionId);
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: confirmed.draftId,
          version: String(confirmed.version),
          shopperText: "I need it for programming and my budget is 900",
          use: "schoolwork",
          budget: "580",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    const withdrawn = draftFor(runtime, buyer.sessionId);
    expect(withdrawn.confirmedUse).toBeNull();
    expect(withdrawn.confirmedBudgetDollars).toBeNull();
    expect(withdrawn.prefilledUse).toBe("programming");
    expect(withdrawn.prefilledBudgetDollars).toBe("900");
    expect(withdrawn.recommendation).toBeNull();
    expect(withdrawn.notice).toBe("review");

    const refused = await handleConfirm(
      post(
        `/checkout/${intentId}/confirm`,
        {
          confirmationId: challenge.value.confirmationId,
          nonce: challenge.value.nonce,
          quoteId: challenge.value.quoteId,
          quoteDigest: challenge.value.quoteDigest,
          acknowledged: "yes",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
      intentId,
    );
    expect(refused.headers.get("location")).toContain("error=QUOTE_NO_LONGER_VALID");
    const record = await runtime.store.findConfirmationForSession(buyer.sessionId, challenge.value.confirmationId);
    expect(record?.consumedAt).toBeNull();

    const stale = await handleCheckoutStart(
      post(
        "/checkout/start",
        {
          productId: "dmp_aspirego15",
          variantId: "dmv_aspirego15",
          quantity: "1",
          use: "schoolwork",
          budget: "580",
          lang: "en",
          price: "1",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(stale.headers.get("location")).toContain("error=STALE_DRAFT");

    await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        {
          lang: "en",
          draftId: withdrawn.draftId,
          version: String(withdrawn.version),
          use: "programming",
          budget: "900",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(draftFor(runtime, buyer.sessionId).confirmedUse).toBe("programming");
    const restarted = await handleCheckoutStart(
      post(
        "/checkout/start",
        {
          productId: "dmp_aspire14ai",
          variantId: "dmv_aspire14ai",
          quantity: "1",
          use: "programming",
          budget: "900",
          lang: "en",
          price: "1",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    const nextId = restarted.headers.get("location")?.split("/").pop() ?? "";
    const next = await runtime.store.findIntent(nextId);
    const nextQuoteId = next?.snapshot.context.quoteId;
    if (!nextQuoteId) throw new Error("replacement quote missing");
    const nextQuote = await runtime.store.findQuote(nextQuoteId);
    expect(nextQuote?.totalCents).toBe(87999);
  });

  it("drops the oldest turns once the history bound is reached", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds(request: { untrustedData: { shopperMessage: string } }) {
          const amount = request.untrustedData.shopperMessage.match(/[1-9][0-9]{1,4}/)?.[0] ?? null;
          return { understoodUse: "schoolwork" as const, budgetDollars: amount, followUp: null };
        },
      },
    };
    let current = { draftId: "", version: "" };
    for (let index = 0; index < MAX_CONVERSATION_TURNS / 2 + 1; index += 1) {
      const text = `School budget is ${400 + index}`;
      await handleNeedsSubmit(
        post(
          "/shop/needs/submit",
          {
            lang: "en",
            shopperText: text,
            ...(current.draftId ? { draftId: current.draftId, version: current.version, use: "schoolwork", budget: String(400 + index - 1 || 400) } : {}),
            csrfToken: buyer.csrfToken,
          },
          buyer.cookie,
        ),
        guided,
      );
      const draft = draftFor(runtime, buyer.sessionId);
      current = { draftId: draft.draftId, version: String(draft.version) };
    }
    const state = readConversation(runtime.store, buyer.sessionId);
    expect(state?.turns).toHaveLength(MAX_CONVERSATION_TURNS);
    expect(state?.turns.some((turn) => turn.text === "School budget is 400")).toBe(false);
    expect(state?.turns.some((turn) => turn.text === `School budget is ${400 + MAX_CONVERSATION_TURNS / 2}`)).toBe(true);
    expect(draftFor(runtime, buyer.sessionId).confirmedUse).toBeNull();
  });
});
