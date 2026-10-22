import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { GuidedLanguageChoice } from "@/components/mock-journey/GuidedLanguageChoice";
import { GuidedProgress } from "@/components/mock-journey/GuidedProgress";
import { InterpretedNeedsReview, NEEDS_REVIEW_HEADING_ID } from "@/components/mock-journey/InterpretedNeedsReview";
import { MockReviewGuidance } from "@/components/mock-journey/MockReviewGuidance";
import { NeedsConversation } from "@/components/mock-journey/NeedsConversation";
import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { spanishProductDescription } from "@/lib/catalog/demo-translations";
import { spanishFactorReason } from "@/lib/i18n/assessment-reasons";
import { prepareConfirmation } from "@/lib/confirmation/confirmation";
import { GUIDED_ENTRY_LABEL, GUIDED_ENTRY_SUBMIT, GUIDED_LANGUAGE_EN, GUIDED_LANGUAGE_ES, journeyCopy } from "@/lib/i18n/demo-copy";
import { guidedSessionEntry, guidedShopDestination } from "@/lib/i18n/language";
import { computeQuoteDigest } from "@/lib/quote/quote";
import { USE_REQUIREMENTS, assessReadiness, evidenceFromMerchantVariant } from "@/lib/readiness/engine";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import {
  MissingSessionNeeds,
  NEEDS_EXPIRED_ALERT_ID,
  NEEDS_PAGE_HEADING_ID,
  NEEDS_SUGGESTIONS_HEADING_ID,
  NEEDS_VALIDATION_ALERT_ID,
  SkipToCurrentStep,
  needsCurrentTargetId,
  selectNeedsCurrentTarget,
} from "@/app/[lang]/shop/needs/current-step";
import { handleCheckoutStart, handleConfirm, handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
import { HOUR, MINUTE, createTestClock, newSession, quotedIntent, TEST_SESSION_KEY, createWorld, permitCatalog } from "./helpers";

const SCHOOL_TEXT = "I need a laptop for school.";
const SCHOOL_TEXT_ES = "Necesito una computadora portátil para la escuela.";

function separateAssessment(reason: string, translation: string): string {
  return `<span class="assessment-languages"><span lang="en">${reason}</span><span>${translation}</span></span>`;
}

/** Drops whitespace-only text nodes, matching the accessible-name gap the purchase button hit. */
function accessibleNameFromContents(innerHtml: string): string {
  return innerHtml
    .split(/<[^>]*>/)
    .filter((node) => node.trim().length > 0)
    .join("");
}

function buttonContents(markup: string): string {
  const match = markup.match(/<button type="submit"[^>]*>([\s\S]*?)<\/button>/);
  if (!match?.[1]) throw new Error("purchase button missing");
  return match[1];
}

function describedIds(markup: string, fieldId: string, tag = "input"): string[] {
  const element = markup.match(new RegExp(`<${tag}\\b(?=[^>]*\\bid="${fieldId}")[^>]*>`));
  const described = element?.[0].match(/aria-describedby="([^"]*)"/);
  if (!described?.[1]) throw new Error(`missing description on ${fieldId}`);
  return described[1].split(" ").filter((id) => id.length > 0);
}

function assertDescribedByTargetsResolveOnce(markup: string): void {
  const referenced = [...markup.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((match) =>
    match[1].split(" ").filter((id) => id.length > 0),
  );
  for (const id of new Set(referenced)) {
    expect(markup.match(new RegExp(`\\bid="${id}"`, "g"))).toHaveLength(1);
  }
}

function textById(markup: string, id: string): string {
  const match = markup.match(new RegExp(`<p\\b(?=[^>]*\\bid="${id}")[^>]*>([\\s\\S]*?)</p>`));
  if (!match?.[1]) throw new Error(`missing #${id}`);
  return match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

const ORIGIN = "https://shop.example.test";

function world() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  return { time, runtime };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${ORIGIN}/session/needs?next=https://evil.example/steal`), runtime);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/en/shop/needs?started=1");
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session not established");
  // M2-3: a shopper creates the purchase permission before checking out.
  await permitCatalog(runtime, session.value.id);
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

describe("guided needs flow", () => {
  it("refuses a missing, stale, or expired draft and does not recreate one as confirmed", async () => {
    const { time, runtime } = world();
    const buyer = await shopper(runtime);
    const missing = await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "es", draftId: `nd_${"ab".repeat(16)}`, version: "1", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    expect(missing.headers.get("location")).toContain("error=DRAFT_NOT_FOUND");
    expect(needsDraftsFor(runtime.store).size).toBe(0);

    const submitted = await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    expect(submitted.headers.get("location")).toBe("/en/shop/needs");
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    expect(draft.confirmedUse).toBeNull();
    expect(draft.prefilledUse).toBe("schoolwork");
    expect(draft.prefilledBudgetDollars).toBe("500");

    const stale = await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: "99", use: "programming", budget: "900", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    expect(stale.headers.get("location")).toContain("error=STALE_DRAFT");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.prefilledUse).toBe("schoolwork");

    time.advance(2 * HOUR - MINUTE);
    await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    time.advance(2 * MINUTE);
    const expired = await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    expect(expired.headers.get("location")).toContain("error=DRAFT_EXPIRED");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)).toBeUndefined();
  });

  it("discards a late interpretation and does not ask again for a completed or failed recommendation", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    let suggestions = 0;
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
          interpretations += 1;
          markStarted();
          if (interpretations === 1) await gate;
          return { understoodUse: "programming", budgetDollars: "800", followUp: null };
        },
        async suggestProducts(input: Parameters<Runtime["ai"]["suggestProducts"]>[0]) {
          suggestions += 1;
          return runtime.ai.suggestProducts(input);
        },
      },
    };

    const first = handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: "Necesito un portátil", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    await started;
    expect(interpretations).toBe(1);
    const version = needsDraftsFor(runtime.store).get(buyer.sessionId)!.version;
    const replaced = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        { lang: "es", shopperText: "otra cosa", use: "schoolwork", budget: "500", version: String(version), csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    expect(replaced.status).toBe(303);
    release();
    await first;
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId)!;
    expect(draft.version).toBe(version + 1);
    expect(draft.prefilledUse).toBe("schoolwork");
    expect(draft.prefilledBudgetDollars).toBe("500");
    expect(draft.confirmedUse).toBeNull();
    expect(interpretations).toBe(1);

    await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "es", draftId: draft.draftId, version: String(draft.version), use: "schoolwork", budget: "580", csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const shown = await loadNeedsJourney(guided, buyer.session);
    expect(shown.draft?.recommendationClaim).toBe("completed");
    expect(shown.draft?.recommendation?.assistantMessage).toBe("These catalog items meet the stated use and budget.");
    expect(shown.draft?.recommendation?.recommendations.map((item) => item.variantId)).toEqual(["dmv_aspirego15"]);
    expect(shown.draft?.recommendation?.recommendations[0].unitAmountCents).toBe(57999);
    await loadNeedsJourney(guided, buyer.session);
    expect(suggestions).toBe(1);

    const failedRuntime = world();
    const other = await shopper(failedRuntime.runtime);
    let failedSuggestions = 0;
    const failing = {
      ...failedRuntime.runtime,
      ai: {
        ...failedRuntime.runtime.ai,
        async suggestProducts() {
          failedSuggestions += 1;
          throw new Error("advisory down");
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "200", csrfToken: other.csrfToken }, other.cookie),
      failing,
    );
    const low = needsDraftsFor(failedRuntime.runtime.store).get(other.sessionId)!;
    await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "en", draftId: low.draftId, version: String(low.version), use: "schoolwork", budget: "200", csrfToken: other.csrfToken }, other.cookie),
      failing,
    );
    const noMatch = await loadNeedsJourney(failing, other.session);
    expect(noMatch.draft?.recommendationClaim).toBe("completed");
    expect(noMatch.draft?.recommendation?.assistantMessage).toBe("No catalog item meets this use and budget.");
    expect(failedSuggestions).toBe(0);

    const down = world();
    const third = await shopper(down.runtime);
    const unavailable = {
      ...down.runtime,
      ai: {
        ...down.runtime.ai,
        async suggestProducts() {
          failedSuggestions += 1;
          throw new Error("advisory down");
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "580", csrfToken: third.csrfToken }, third.cookie),
      unavailable,
    );
    const ready = needsDraftsFor(down.runtime.store).get(third.sessionId)!;
    await handleNeedsConfirm(
      post("/shop/needs/confirm", { lang: "en", draftId: ready.draftId, version: String(ready.version), use: "schoolwork", budget: "580", csrfToken: third.csrfToken }, third.cookie),
      unavailable,
    );
    const firstFailure = await loadNeedsJourney(unavailable, third.session);
    expect(firstFailure.draft?.recommendationClaim).toBe("failed");
    await loadNeedsJourney(unavailable, third.session);
    expect(failedSuggestions).toBe(1);
  });

  it("keeps language off the quote, digest, and confirmation nonce", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const started = await handleCheckoutStart(
      post(
        "/checkout/start",
        { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai", quantity: "1", use: "programming", budget: "900", lang: "es", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    const intentId = started.headers.get("location")!.split("/").pop()!;
    const intent = (await runtime.store.findIntent(intentId))!;
    expect(intent.interfaceLanguage).toBe("es");
    const quote = (await runtime.store.findQuote(intent.snapshot.context.quoteId!))!;
    expect(JSON.stringify(quote)).not.toContain("interfaceLanguage");
    const { digest, ...body } = quote;
    expect(computeQuoteDigest(body)).toBe(digest);
    expect(quote.totalCents).toBe(87999);

    const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    expect(challenge.value.quoteDigest).toBe(quote.digest);
    const confirmed = await handleConfirm(
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
      runtime,
      intentId,
    );
    expect(confirmed.headers.get("location")).toContain("notice=CONFIRMED");

    // M2-3: the first checkout still holds its item's single-use permission, so this one is for another item.
    const plain = await handleCheckoutStart(
      post(
        "/checkout/start",
        { productId: "dmp_aspirego15", variantId: "dmv_aspirego15", quantity: "1", use: "programming", budget: "900", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    const plainIntent = (await runtime.store.findIntent(plain.headers.get("location")!.split("/").pop()!))!;
    expect(plainIntent.interfaceLanguage).toBeUndefined();
  });

  it("marks English catalog text inside Spanish content and leaves the English confirmation markup available", async () => {
    const home = readFileSync("src/app/(english)/page.tsx", "utf8");
    const mockBranch = home.slice(home.indexOf('if (application.mode === "mock")'), home.indexOf('if (application.mode === "invalid")'));
    expect(mockBranch).toContain("<GuidedLanguageChoice />");
    expect(home.slice(home.indexOf("const catalog = await loadPgCatalog(services);"))).not.toContain("GuidedLanguageChoice");
    expect(GUIDED_ENTRY_LABEL).toBe("Guided shopping in English or Spanish");
    expect(spanishProductDescription("dmp_missing")).toBeNull();

    const fixture = createWorld();
    const { session } = await newSession(fixture);
    const { quote } = await quotedIntent(fixture, session.id);
    const challenge = await prepareConfirmation(fixture.checkout, session.id, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const english = renderToStaticMarkup(<ConfirmationSummary challenge={challenge.value} csrfToken={session.csrfToken} action="/checkout/confirm" />);
    expect(english).toContain("approving the payment in PayPal is the step that would authorize payment");
    expect(english).toContain(`name="quoteDigest" value="${quote.digest}"`);
    expect(english).not.toContain('lang="es"');

    const spanish = renderToStaticMarkup(<ConfirmationSummary challenge={challenge.value} csrfToken={session.csrfToken} action="/checkout/confirm" language="es" />);
    expect(spanish).toContain('lang="en"');
    expect(spanish).toContain("Acer Aspire 14 AI");
    expect(spanish).toContain("$879.99");
    expect(spanish).toContain(`name="nonce" value="${challenge.value.nonce}"`);
    expect(spanish).toContain(`name="quoteDigest" value="${quote.digest}"`);
    expect(spanish).toContain(journeyCopy("es").confirmation.heading);

    const catalog = renderToStaticMarkup(
      <TranslatedCatalogList
        copy={journeyCopy("es")}
        language="es"
        csrfToken={session.csrfToken}
        confirmedUse="schoolwork"
        confirmedBudgetDollars="500"
        lines={[
          {
            productId: "dmp_aspirego15",
            variantId: "dmv_aspirego15",
            title: "Acer Aspire Go 15",
            description: "A light 14-inch laptop for notes, documents, browsing and video calls.",
            label: "8 GB LPDDR5, 256 GB PCIe NVMe SSD",
            unitAmountCents: 57999,
            currency: "USD",
            quotable: true,
            status: "READY",
            explanation: "The available evidence supports this laptop for your stated needs.",
            factors: [],
          },
        ]}
      />,
    );
    expect(catalog).toContain('lang="en"');
    expect(catalog).toContain("$579.99");
    expect(catalog).toContain('name="lang" value="es"');
    expect(catalog).toContain("Modelo AG15-21PT-R9TL, pieza NX.JJJAA.008");
    expect(catalog).not.toContain(journeyCopy("es").missingTranslation);
  });

  it("supplies Spanish assessment reasons from the server facts and keeps an unknown reason in English", () => {
    const { runtime } = world();
    const observedAt = runtime.clock().toISOString();
    const product = runtime.catalog.products.find((entry) => entry.productId === "dmp_aspirego15");
    const variant = product?.variants.find((entry) => entry.variantId === "dmv_aspirego15");
    if (!product || !variant) throw new Error("catalog fixture missing");
    expect(variant.unitAmountCents).toBe(57999);
    const assessed = assessReadiness(
      {
        subject: { productId: product.productId, variantId: variant.variantId, catalogRevision: runtime.catalog.revision },
        evidence: [
          { fact: "budgetCents", value: 50000, source: "shopper_stated", sourceRef: "confirmed by the shopper for this draft", observedAt },
          { fact: "intendedUse", value: "schoolwork", source: "shopper_stated", sourceRef: "confirmed by the shopper for this draft", observedAt },
          ...evidenceFromMerchantVariant(variant, runtime.catalog.revision, runtime.clock()),
        ],
      },
      runtime.clock(),
    );
    if (!assessed.ok) throw new Error(assessed.error);
    const factors = assessed.value.factors.map((factor) => ({
      factor: factor.factor,
      outcome: factor.outcome,
      reason: factor.reason,
      evidenceQuality: factor.evidenceQuality,
      facts: factor.evidence.map((item) => ({ fact: item.fact, value: item.value })),
    }));
    const copy = journeyCopy("es");
    const line = {
      productId: product.productId,
      variantId: variant.variantId,
      title: product.title,
      description: product.description,
      label: variant.label,
      unitAmountCents: variant.unitAmountCents,
      currency: "USD" as const,
      quotable: true,
      status: assessed.value.status,
      explanation: "The available evidence supports this laptop for your stated needs.",
      factors,
    };
    const recommendation = {
      assistantMessage: "These catalog items meet the stated use and budget.",
      recommendations: [{ productId: product.productId, variantId: variant.variantId, title: product.title, unitAmountCents: variant.unitAmountCents, currency: "USD" as const }],
    };
    const markup = renderToStaticMarkup(
      <TranslatedAdvisory copy={copy} language="es" draft={{ recommendationClaim: "completed", recommendation }} lines={[line]} />,
    );
    const memory = factors.find((factor) => factor.factor === "memory");
    const storage = factors.find((factor) => factor.factor === "storage");
    const weight = factors.find((factor) => factor.factor === "portability");
    if (!memory || !storage || !weight) throw new Error("assessment factors missing");
    const memorySpanish = spanishFactorReason(memory);
    const storageSpanish = spanishFactorReason(storage);
    const weightSpanish = spanishFactorReason(weight);
    if (!memorySpanish || !storageSpanish || !weightSpanish) throw new Error("missing Spanish assessment reason");
    expect(markup).toContain(separateAssessment(memory.reason, memorySpanish));
    expect(markup).toContain(separateAssessment(storage.reason, storageSpanish));
    expect(markup).toContain(separateAssessment(weight.reason, weightSpanish));
    const presentation = readFileSync("src/app/guided-presentation.css", "utf8");
    expect(presentation).toMatch(/\.guided-presentation \.assessment-languages\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*4px;/);
    const english = renderToStaticMarkup(
      <TranslatedAdvisory copy={journeyCopy("en")} language="en" draft={{ recommendationClaim: "completed", recommendation }} lines={[line]} />,
    );
    expect(english).toContain(memory.reason);
    expect(english).not.toContain("assessment-languages");
    expect(english).not.toContain('lang="en"');
    expect(memory.reason).toContain(String(variant.specs.ramGb));
    expect(storage.reason).toContain(String(variant.specs.storageGb));
    expect(weight.reason).toContain(String(variant.specs.weightKg));
    expect(markup).toContain(`${variant.specs.ramGb} GB de memoria cumplen los ${USE_REQUIREMENTS.schoolwork.recommendedRamGb} GB recomendados`);
    expect(markup).toContain(`${variant.specs.storageGb} GB de almacenamiento cumplen los ${USE_REQUIREMENTS.schoolwork.recommendedStorageGb} GB recomendados`);
    expect(markup).toContain(`Con ${variant.specs.weightKg} kg está dentro de la guía de 2 kg`);
    expect(markup).toContain("$579.99");
    expect(markup).not.toContain(copy.missingTranslation);

    const unknownReason = "synthetic-unknown-reason";
    const unknownFactor = { factor: "memory" as const, outcome: "UNKNOWN" as const, reason: unknownReason, evidenceQuality: "MISSING" as const, facts: [] };
    expect(spanishFactorReason(unknownFactor)).toBeNull();
    const unknown = renderToStaticMarkup(
      <TranslatedAdvisory
        copy={copy}
        language="es"
        draft={{ recommendationClaim: "completed", recommendation }}
        lines={[{ ...line, status: "INSUFFICIENT_EVIDENCE", explanation: unknownReason, factors: [unknownFactor] }]}
      />,
    );
    expect(unknown).toContain(separateAssessment(unknownReason, copy.missingTranslation));
    expect(unknown).toContain("$579.99");
  });

  async function carryLanguage(choiceLabel: string): Promise<string> {
    const entry = renderToStaticMarkup(<GuidedLanguageChoice />);
    expect(entry).toContain('method="get"');
    expect(entry).toContain(GUIDED_ENTRY_LABEL);
    expect(entry).toContain(GUIDED_ENTRY_SUBMIT);
    expect(entry).not.toContain("next=");
    const action = entry.match(/action="([^"]+)"/)?.[1];
    expect(action).toBe("/session/needs");
    const selected = entry.match(new RegExp(`value="(en|es)"[^>]*>\\s*${choiceLabel}`))?.[1];
    if (selected !== "en" && selected !== "es") throw new Error(`missing choice ${choiceLabel}`);

    const { runtime } = world();
    const opened = await handleNeedsSession(new Request(`${ORIGIN}${action}?lang=${selected}&next=https://evil.example/steal`), runtime);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("location")).toBe(guidedShopDestination(selected));
    expect(opened.headers.get("location")).not.toContain("evil.example");
    const token = opened.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    const resolved = await runtime.sessions.resolve(token);
    if (!resolved.ok) throw new Error("session not established");
    // M2-3: a shopper creates the purchase permission before checking out.
    await permitCatalog(runtime, resolved.value.id);
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const csrfToken = resolved.value.csrfToken;
    const carried = new URL(opened.headers.get("location")!, ORIGIN).pathname.split("/")[1];
    expect(carried).toBe(selected);

    const submitted = await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: carried ?? "", shopperText: "", use: "schoolwork", budget: "500", csrfToken }, cookie),
      runtime,
    );
    expect(submitted.headers.get("location")).toBe(`/${selected}/shop/needs`);
    const draft = needsDraftsFor(runtime.store).get(resolved.value.id);
    if (!draft) throw new Error("draft missing");
    expect(draft.language).toBe(selected);
    const copy = journeyCopy(draft.language);
    expect(draft.notice).toBe("review");
    expect(draft.prefilledUse).toBe("schoolwork");
    expect(draft.prefilledBudgetDollars).toBe("500");
    const review = renderToStaticMarkup(<InterpretedNeedsReview copy={copy} language={draft.language} csrfToken={csrfToken} draft={draft} />);
    expect(review).toContain(`name="lang" value="${selected}"`);
    expect(review).toContain(copy.reviewTitle);
    expect(review).toContain(copy.confirmReview);
    const reviewLang = review.match(/name="lang" value="(en|es)"/)?.[1];
    const confirmed = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        {
          lang: reviewLang ?? "",
          draftId: draft.draftId,
          version: String(draft.version),
          use: "schoolwork",
          budget: "580",
          csrfToken,
        },
        cookie,
      ),
      runtime,
    );
    expect(confirmed.headers.get("location")).toBe(`/${selected}/shop/needs`);
    expect(needsDraftsFor(runtime.store).get(resolved.value.id)?.language).toBe(selected);

    const journey = await loadNeedsJourney(runtime, resolved.value);
    const kept = journey.draft;
    if (!kept?.confirmedUse || !kept.confirmedBudgetDollars) throw new Error("draft not confirmed");
    expect(kept.language).toBe(selected);
    const lines = journey.lines.filter((line) => line.status === "READY" || line.status === "READY_WITH_CAVEATS");
    const study = lines.find((line) => line.variantId === "dmv_aspirego15");
    if (!study) throw new Error("studybook missing");
    expect(study.unitAmountCents).toBe(57999);
    const catalog = renderToStaticMarkup(
      <TranslatedCatalogList
        copy={copy}
        language={kept.language}
        csrfToken={csrfToken}
        lines={lines}
        confirmedUse={kept.confirmedUse}
        confirmedBudgetDollars={kept.confirmedBudgetDollars}
      />,
    );
    expect(catalog).toContain(copy.reviewPurchase);
    expect(catalog).toContain(`name="lang" value="${selected}"`);
    expect(catalog).toContain("$579.99");
    const postedLang = catalog.match(/name="lang" value="(en|es)"/)?.[1] ?? "";
    const started = await handleCheckoutStart(
      post(
        "/checkout/start",
        {
          productId: study.productId,
          variantId: study.variantId,
          quantity: "1",
          use: kept.confirmedUse,
          budget: kept.confirmedBudgetDollars,
          lang: postedLang,
          csrfToken,
        },
        cookie,
      ),
      runtime,
    );
    const location = started.headers.get("location") ?? "";
    expect(started.status).toBe(303);
    expect(location.startsWith("/checkout/")).toBe(true);
    expect(location).not.toContain("evil.example");
    const intent = (await runtime.store.findIntent(location.split("/").pop()!))!;
    expect(intent.interfaceLanguage).toBe(selected);
    const quote = (await runtime.store.findQuote(intent.snapshot.context.quoteId!))!;
    expect(quote.totalCents).toBe(57999);
    expect(JSON.stringify(quote)).not.toContain("interfaceLanguage");
    const { digest, ...body } = quote;
    expect(computeQuoteDigest(body)).toBe(digest);
    const challenge = await prepareConfirmation(runtime.checkout, resolved.value.id, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const interfaceLanguage = intent.interfaceLanguage;
    if (interfaceLanguage !== selected) throw new Error("language dropped");
    const guidance = renderToStaticMarkup(<MockReviewGuidance language={interfaceLanguage} />);
    expect(guidance).toContain(`lang="${selected}"`);
    expect(guidance).toContain(copy.purchaseGuidanceTitle);
    expect(guidance).not.toContain(copy.reviewTitle);
    expect(guidance).toContain(copy.reviewGuidance);
    const summary = renderToStaticMarkup(
      <ConfirmationSummary challenge={challenge.value} csrfToken={csrfToken} action={`/checkout/${intent.id}/confirm`} language={interfaceLanguage} />,
    );
    expect(summary).toContain(copy.confirmation.heading);
    expect(summary).toContain(`name="nonce" value="${challenge.value.nonce}"`);
    expect(summary).toContain(`name="quoteDigest" value="${quote.digest}"`);
    expect(summary).toContain('name="acknowledged"');
    expect(summary).toContain("$579.99");
    return summary;
  }

  it("carries Español from the guided entry through Spanish needs, confirmation, and purchase review", async () => {
    const entry = renderToStaticMarkup(<GuidedLanguageChoice />);
    expect(entry).toContain(`<label lang="es"`);
    expect(entry).toContain(GUIDED_LANGUAGE_ES);
    const summary = await carryLanguage(GUIDED_LANGUAGE_ES);
    expect(summary).toContain('lang="es"');
    expect(summary).toContain('lang="en"');
    expect(summary).toContain("Acer Aspire Go 15");
    expect(summary).toContain(journeyCopy("es").confirmation.heading);
  });

  it("carries English from the guided entry through English needs and purchase review", async () => {
    const summary = await carryLanguage(GUIDED_LANGUAGE_EN);
    expect(summary).toContain(journeyCopy("en").confirmation.heading);
    expect(summary).not.toContain('lang="es"');
    expect(summary).toContain("Acer Aspire Go 15");
  });

  it("defaults an invalid language and does not accept it as a redirect", async () => {
    const currentStep = readFileSync("src/app/[lang]/shop/needs/current-step.tsx", "utf8");
    expect(currentStep).toContain("redirect(guidedSessionEntry(");
    const invalid = ["", "fr", "EN", "ES", "es ", "https://evil.example/steal", "//evil.example", "/admin", "javascript:alert(1)", "<script>", "es&next=https://evil.example"];
    for (const value of invalid) {
      expect(guidedSessionEntry(value)).toBe("/session/needs?lang=en");
      expect(guidedShopDestination(value)).toBe("/en/shop/needs?started=1");
      expect(guidedSessionEntry(value)).not.toContain("evil.example");
      expect(guidedShopDestination(value)).not.toContain("evil.example");
    }
    expect(guidedSessionEntry(undefined)).toBe("/session/needs?lang=en");

    const { runtime } = world();
    for (const value of ["https://evil.example/steal", "fr", "EN", ""]) {
      const response = await handleNeedsSession(
        new Request(`${ORIGIN}/session/needs?lang=${encodeURIComponent(value)}&next=https://evil.example/steal`),
        runtime,
      );
      expect(response.headers.get("location")).toBe("/en/shop/needs?started=1");
      expect(response.headers.get("location")).not.toContain("evil.example");
    }
    const repeated = await handleNeedsSession(new Request(`${ORIGIN}/session/needs?lang=https://evil.example&lang=es`), runtime);
    expect(repeated.headers.get("location")).toBe("/en/shop/needs?started=1");

    const buyer = await shopper(runtime);
    const submitted = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        { lang: "https://evil.example/phish", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    expect(submitted.headers.get("location")).toBe("/en/shop/needs");
    expect(submitted.headers.get("location")).not.toContain("evil.example");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.language).toBe("en");

    const started = await handleCheckoutStart(
      post(
        "/checkout/start",
        {
          productId: "dmp_aspirego15",
          variantId: "dmv_aspirego15",
          quantity: "1",
          use: "schoolwork",
          budget: "500",
          lang: "https://evil.example/phish",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      runtime,
    );
    const location = started.headers.get("location") ?? "";
    expect(location.startsWith("/checkout/")).toBe(true);
    expect(location).not.toContain("evil.example");
    const intent = (await runtime.store.findIntent(location.split("/").pop()!))!;
    expect(intent.interfaceLanguage).toBeUndefined();
    const quote = (await runtime.store.findQuote(intent.snapshot.context.quoteId!))!;
    expect(quote.totalCents).toBe(57999);
    expect(JSON.stringify(quote)).not.toContain("interfaceLanguage");
    const challenge = await prepareConfirmation(runtime.checkout, buyer.sessionId, quote.quoteId);
    if (!challenge.ok) throw new Error(challenge.error);
    const summary = renderToStaticMarkup(<ConfirmationSummary challenge={challenge.value} csrfToken={buyer.csrfToken} action={`/checkout/${intent.id}/confirm`} />);
    expect(summary).toContain("Review and confirm this purchase summary");
    expect(summary).not.toContain('lang="es"');
    expect(summary).toContain("$579.99");
    expect(summary).toContain(`name="quoteDigest" value="${quote.digest}"`);
  });

  function itemMarkup(markup: string, variantId: string): string {
    const marker = `id="catalog-${variantId}"`;
    const start = markup.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const next = markup.indexOf('id="catalog-', start + marker.length);
    return markup.slice(start, next === -1 ? markup.length : next);
  }

  function expectHeadingsStayOutOfTabOrder(markup: string) {
    const headings = markup.match(/<h[1-6]\b[^>]*>/g) ?? [];
    expect(headings.length).toBeGreaterThan(0);
    for (const tag of headings) expect(tag).not.toMatch(/tabindex/i);
  }

  async function confirmedComparison(use: "schoolwork" | "programming", budget: string, lang: "en" | "es") {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const submitted = await handleNeedsSubmit(
      post("/shop/needs/submit", { lang, shopperText: "", use, budget, csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    expect(submitted.status).toBe(303);
    const before = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!before) throw new Error("draft missing");
    expect(before.confirmedUse).toBeNull();
    const unconfirmed = await loadNeedsJourney(runtime, buyer.session);
    expect(unconfirmed.lines).toEqual([]);
    const confirmed = await handleNeedsConfirm(
      post(
        "/shop/needs/confirm",
        { lang, draftId: before.draftId, version: String(before.version), use, budget, csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      runtime,
    );
    expect(confirmed.status).toBe(303);
    const journey = await loadNeedsJourney(runtime, buyer.session);
    const budgetCents = Number(budget) * 100;
    const lines = journey.lines.filter(
      (line) => (line.status === "READY" || line.status === "READY_WITH_CAVEATS") && line.unitAmountCents <= budgetCents,
    );
    const excludedLines = journey.lines.filter((line) => !lines.some((eligible) => eligible.variantId === line.variantId));
    return { buyer, before, lines, excludedLines, copy: journeyCopy(lang) };
  }

  it("keeps comparison and purchase controls off the page before needs confirmation", async () => {
    const needsPage = readFileSync("src/app/[lang]/shop/needs/page.tsx", "utf8");
    const guardAt = needsPage.indexOf("confirmedUse && confirmedBudgetDollars");
    expect(guardAt).toBeGreaterThan(-1);
    expect(needsPage.slice(0, guardAt)).not.toContain("<TranslatedCatalogList");
    expect(needsPage.indexOf("<TranslatedCatalogList")).toBeGreaterThan(guardAt);

    const { runtime } = world();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    expect(draft.confirmedUse).toBeNull();
    expect((await loadNeedsJourney(runtime, buyer.session)).lines).toEqual([]);
    const copy = journeyCopy("en");
    expect(draft.notice).toBe("review");
    const markup = renderToStaticMarkup(
      <InterpretedNeedsReview copy={copy} language="en" csrfToken={buyer.csrfToken} draft={draft} />,
    );
    expect(markup).toContain(copy.confirmReview);
    expect(markup).not.toContain(copy.checkLimitation);
    expect(markup).not.toContain(copy.whyThis);
    expect(markup).not.toContain(copy.excludedHeading);
    expect(markup).not.toContain("Review this purchase for");
    expect(markup).not.toContain('action="/checkout/start"');
  });

  it("explains Schoolwork at $580 in English and Spanish, including every failed factor", async () => {
    for (const lang of ["en", "es"] as const) {
      const { buyer, lines, excludedLines, copy } = await confirmedComparison("schoolwork", "580", lang);
      const entry = lines.find((line) => line.variantId === "dmv_aspirego15");
      const fourteen = excludedLines.find((line) => line.variantId === "dmv_aspire14ai");
      const vivobook = excludedLines.find((line) => line.variantId === "dmv_vivobook16");
      if (!entry || !fourteen || !vivobook) throw new Error("catalog comparison missing");
      expect(lines.map((line) => line.variantId)).toEqual(["dmv_aspirego15"]);
      expect(entry.unitAmountCents).toBe(57999);
      for (const excluded of [fourteen, vivobook]) {
        expect(excluded.factors.filter((factor) => factor.outcome === "FAIL" || factor.outcome === "UNKNOWN").map((factor) => factor.factor)).toEqual([
          "affordability",
        ]);
      }
      const markup = renderToStaticMarkup(
        <TranslatedCatalogList
          copy={copy}
          language={lang}
          csrfToken={buyer.csrfToken}
          lines={lines}
          excludedLines={excludedLines}
          confirmedUse="schoolwork"
          confirmedBudgetDollars="580"
        />,
      );
      expectHeadingsStayOutOfTabOrder(markup);
      expect(markup).toContain(copy.catalogNotice);
      expect(markup).toContain(copy.checkLimitation);
      expect(markup).toContain('src="/catalog/aspire-go-15.svg"');
      expect(markup).toContain('src="/catalog/aspire-14-ai.svg"');
      expect(markup).toContain('src="/catalog/vivobook-16.svg"');
      expect(markup).toContain('alt="Acer Aspire Go 15, illustration"');
      expect(markup).not.toContain("demo-laptop.png");
      expect(markup).toContain(copy.excludedHeading);
      const entryItem = itemMarkup(markup, entry.variantId);
      expect(entryItem).toContain(copy.whyThis);
      expect(entryItem).toContain("$579.99");
      expect(entryItem).toContain(
        lang === "es"
          ? "Revisar esta compra para"
          : "Review this purchase for Acer Aspire Go 15, 8 GB LPDDR5, 256 GB PCIe NVMe SSD",
      );
      if (lang === "es") {
        expect(entryItem).toContain('lang="en"');
        expect(entryItem).toContain(">Acer Aspire Go 15<");
        expect(entryItem).toContain(">8 GB LPDDR5, 256 GB PCIe NVMe SSD<");
        for (const factor of entry.factors) {
          const spanish = spanishFactorReason(factor);
          if (!spanish) throw new Error("missing Spanish eligible reason");
          expect(entryItem).toContain(separateAssessment(factor.reason, spanish));
        }
      } else {
        expect(entryItem).not.toContain("assessment-languages");
      }
      for (const excluded of [fourteen, vivobook]) {
        const excludedItem = itemMarkup(markup, excluded.variantId);
        expect(excludedItem).not.toContain("<button");
        expect(excludedItem).not.toContain('action="/checkout/start"');
        for (const factor of excluded.factors.filter((factor) => factor.outcome === "FAIL")) {
          expect(excludedItem).toContain(factor.reason);
          if (lang === "es") {
            const spanish = spanishFactorReason(factor);
            if (!spanish) throw new Error("missing Spanish failure reason");
            expect(excludedItem).toContain(separateAssessment(factor.reason, spanish));
          }
        }
      }
    }
  });

  it("compares every Programming laptop within $1100 and names each purchase button", async () => {
    const { buyer, lines, excludedLines, copy } = await confirmedComparison("programming", "1100", "en");
    expect(lines.map((line) => [line.variantId, line.unitAmountCents])).toEqual([
      ["dmv_aspirego15", 57999],
      ["dmv_aspire14ai", 87999],
      ["dmv_vivobook16", 99900],
    ]);
    expect(excludedLines).toEqual([]);
    const markup = renderToStaticMarkup(
      <TranslatedCatalogList
        copy={copy}
        language="en"
        csrfToken={buyer.csrfToken}
        lines={lines}
        excludedLines={excludedLines}
        confirmedUse="programming"
        confirmedBudgetDollars="1100"
      />,
    );
    expectHeadingsStayOutOfTabOrder(markup);
    expect(markup).toContain("Review this purchase for Acer Aspire 14 AI, 16 GB LPDDR5X, 512 GB PCIe NVMe SSD");
    expect(markup).toContain("Review this purchase for ASUS Vivobook 16, 16 GB DDR4, 1 TB PCIe NVMe SSD");
    expect(markup).toContain("Review this purchase for Acer Aspire Go 15, 8 GB LPDDR5, 256 GB PCIe NVMe SSD");
    expect(markup).toContain("$879.99");
    expect(markup).toContain("$999.00");
    expect(markup).toContain("$579.99");
    expect(markup).not.toContain(copy.excludedHeading);
  });

  it("shows unknown evidence in English and Spanish without a purchase control", () => {
    const { runtime } = world();
    const product = runtime.catalog.products.find((entry) => entry.productId === "dmp_aspirego15");
    const variant = product?.variants.find((entry) => entry.variantId === "dmv_aspirego15");
    if (!product || !variant) throw new Error("catalog fixture missing");
    const observedAt = runtime.clock().toISOString();
    const assessed = assessReadiness(
      {
        subject: { productId: product.productId, variantId: variant.variantId, catalogRevision: runtime.catalog.revision },
        evidence: [
          { fact: "budgetCents", value: 60000, source: "shopper_stated", sourceRef: "confirmed by the shopper for this draft", observedAt },
          { fact: "intendedUse", value: "schoolwork", source: "shopper_stated", sourceRef: "confirmed by the shopper for this draft", observedAt },
          ...evidenceFromMerchantVariant(variant, runtime.catalog.revision, runtime.clock()).filter((item) => item.fact !== "ramGb"),
        ],
      },
      runtime.clock(),
    );
    if (!assessed.ok) throw new Error(assessed.error);
    expect(assessed.value.status).toBe("INSUFFICIENT_EVIDENCE");
    const memory = assessed.value.factors.find((factor) => factor.factor === "memory");
    if (!memory || memory.outcome !== "UNKNOWN") throw new Error("memory was not unknown");
    const unknownReason = {
      factor: memory.factor,
      outcome: memory.outcome,
      evidenceQuality: memory.evidenceQuality,
      facts: memory.evidence.map((item) => ({ fact: item.fact, value: item.value })),
    };
    expect(spanishFactorReason(unknownReason)).toBeNull();
    const line = {
      productId: product.productId,
      variantId: variant.variantId,
      title: product.title,
      description: product.description,
      label: variant.label,
      unitAmountCents: variant.unitAmountCents,
      currency: "USD" as const,
      quotable: variant.availability === "IN_STOCK",
      status: assessed.value.status,
      explanation: memory.reason,
      factors: assessed.value.factors.map((factor) => ({
        factor: factor.factor,
        outcome: factor.outcome,
        reason: factor.reason,
        evidenceQuality: factor.evidenceQuality,
        facts: factor.evidence.map((item) => ({ fact: item.fact, value: item.value })),
      })),
    };
    for (const lang of ["en", "es"] as const) {
      const copy = journeyCopy(lang);
      const markup = renderToStaticMarkup(
        <TranslatedCatalogList
          copy={copy}
          language={lang}
          csrfToken="csrf-token"
          lines={[]}
          excludedLines={[line]}
          confirmedUse="schoolwork"
          confirmedBudgetDollars="500"
        />,
      );
      expectHeadingsStayOutOfTabOrder(markup);
      const item = itemMarkup(markup, variant.variantId);
      expect(item).toContain(memory.reason);
      expect(item).toContain(copy.outcomes.UNKNOWN);
      expect(item).not.toContain("<button");
      expect(item).not.toContain('action="/checkout/start"');
      if (lang === "es") {
        expect(item).toContain(separateAssessment(memory.reason, copy.missingTranslation));
        expect(item).toContain('lang="en"');
      } else {
        expect(item).not.toContain("assessment-languages");
        expect(item).not.toContain(journeyCopy("es").missingTranslation);
      }
    }
  });

  it("clarifies English school text with a structured budget before confirmation", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          return { understoodUse: "schoolwork" as const, budgetDollars: null, followUp: "budget" as const };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: SCHOOL_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    expect(interpretations).toBe(1);
    const afterInterpret = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!afterInterpret) throw new Error("draft missing");
    expect(afterInterpret.prefilledUse).toBe("schoolwork");
    expect(afterInterpret.prefilledBudgetDollars).toBeNull();
    expect(afterInterpret.notice).toBe("missing_budget");
    expect(afterInterpret.confirmedUse).toBeNull();
    const copy = journeyCopy("en");
    const clarify = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="status">
          {copy.notices.missing_budget}
        </p>
        <NeedsConversation copy={copy} language="en" csrfToken={buyer.csrfToken} draft={afterInterpret} mode="clarify" noticeRendered />
      </>,
    );
    expect(clarify).toContain(copy.clarificationExplanation);
    expect(clarify).toContain(SCHOOL_TEXT);
    expect(clarify).toContain("<textarea");
    expect(clarify).toContain('name="draftId"');
    expect(clarify).toContain('aria-invalid="true"');
    expect(clarify).toContain('id="needs-budget"');
    expect(clarify).not.toContain(copy.reviewTitle);
    expect(clarify).not.toContain(copy.confirmReview);

    const merged = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: afterInterpret.draftId,
          version: String(afterInterpret.version),
          use: "schoolwork",
          budget: "500",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(merged.headers.get("location")).toBe("/en/shop/needs");
    expect(interpretations).toBe(1);
    const ready = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!ready) throw new Error("draft missing after merge");
    expect(ready.shopperText).toBe(SCHOOL_TEXT);
    expect(ready.language).toBe("en");
    expect(ready.prefilledUse).toBe("schoolwork");
    expect(ready.prefilledBudgetDollars).toBe("500");
    expect(ready.notice).toBe("review");
    expect(ready.confirmedUse).toBeNull();
    expect(ready.version).toBe(afterInterpret.version + 1);
    expect(ready.recommendationClaim).toBeNull();
    const review = renderToStaticMarkup(
      <InterpretedNeedsReview copy={copy} language="en" csrfToken={buyer.csrfToken} draft={ready} />,
    );
    expect(review).toContain(copy.confirmReview);
    expect(review).toContain('value="schoolwork"');
    expect(review).toContain('value="500"');
  });

  it("clarifies Spanish school text with Spanish copy and no second model call", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          return { understoodUse: "schoolwork" as const, budgetDollars: null, followUp: "budget" as const };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "es", shopperText: SCHOOL_TEXT_ES, csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    const copy = journeyCopy("es");
    const clarify = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="status">
          {copy.notices.missing_budget}
        </p>
        <NeedsConversation copy={copy} language="es" csrfToken={buyer.csrfToken} draft={draft} mode="clarify" noticeRendered />
      </>,
    );
    expect(clarify).toContain(copy.clarificationExplanation);
    expect(clarify).toContain(SCHOOL_TEXT_ES);
    expect(clarify).toContain("<textarea");
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "es",
          draftId: draft.draftId,
          version: String(draft.version),
          use: "schoolwork",
          budget: "500",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(interpretations).toBe(1);
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.notice).toBe("review");
  });

  it("marks an ambiguous budget as the disputed field and merges without a model call", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          return { understoodUse: "schoolwork" as const, budgetDollars: null, followUp: "budget" as const };
        },
      },
    };
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        { lang: "en", shopperText: "Schoolwork under 500 or 600", csrfToken: buyer.csrfToken },
        buyer.cookie,
      ),
      guided,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    expect(draft.notice).toBe("ambiguous");
    expect(draft.prefilledBudgetDollars).toBeNull();
    const copy = journeyCopy("en");
    const clarify = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="status">
          {copy.notices.ambiguous}
        </p>
        <NeedsConversation copy={copy} language="en" csrfToken={buyer.csrfToken} draft={draft} mode="clarify" noticeRendered />
      </>,
    );
    expect(clarify).toContain('id="needs-budget"');
    expect(clarify).toContain('aria-invalid="true"');
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: draft.draftId,
          version: String(draft.version),
          use: "schoolwork",
          budget: "500",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(interpretations).toBe(1);
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.prefilledBudgetDollars).toBe("500");
  });

  it("rejects an invalid or empty structured clarification without changing the draft", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: SCHOOL_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    const version = draft.version;
    const invalidBudget = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: draft.draftId,
          version: String(version),
          use: "schoolwork",
          budget: "8",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      runtime,
    );
    expect(invalidBudget.headers.get("location")).toContain("error=CLARIFICATION_INVALID");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.version).toBe(version);
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.prefilledBudgetDollars).toBeNull();

    const emptyBudget = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: draft.draftId,
          version: String(version),
          use: "schoolwork",
          budget: "",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      runtime,
    );
    expect(emptyBudget.headers.get("location")).toContain("error=CLARIFICATION_INVALID");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.version).toBe(version);
  });

  it("refuses a stale clarification version and a foreign draft id", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: SCHOOL_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    const stale = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: draft.draftId,
          version: String(draft.version + 1),
          use: "schoolwork",
          budget: "500",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      runtime,
    );
    expect(stale.headers.get("location")).toContain("error=STALE_DRAFT");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.prefilledBudgetDollars).toBeNull();

    const foreign = await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: `nd_${"cd".repeat(16)}`,
          version: String(draft.version),
          use: "schoolwork",
          budget: "500",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      runtime,
    );
    expect(foreign.headers.get("location")).toContain("error=DRAFT_NOT_FOUND");
    expect(needsDraftsFor(runtime.store).get(buyer.sessionId)?.version).toBe(draft.version);
  });

  it("shows a restart action for an expired draft with a live session", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: SCHOOL_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      runtime,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    needsDraftsFor(runtime.store).set(buyer.sessionId, { ...draft, expiresAtMs: runtime.clock().getTime() - 1 });
    const journey = await loadNeedsJourney(runtime, buyer.session);
    expect(journey.expiredDraft).toBe(true);
    expect(journey.draft).toBeNull();
    expect(needsDraftsFor(runtime.store).has(buyer.sessionId)).toBe(false);
    expect(runtime.checkout.sessionIsLive(buyer.sessionId)).toBe(true);
    const copy = journeyCopy("en");
    expect(copy.alerts.DRAFT_EXPIRED).toContain("expired");
    expect(copy.restartNeeds).toBe("Start again");
  });

  it("redirects a missing session to guided entry and shows the dropped-cookie alert without a form", () => {
    const redirectTo = (started: string | undefined, lang: string | undefined): string => {
      try {
        renderToStaticMarkup(<MissingSessionNeeds started={started} lang={lang} />);
      } catch (error) {
        let current: unknown = error;
        for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
          const digest = (current as { digest?: unknown }).digest;
          if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) {
            return digest.split(";").slice(2, -2).join(";");
          }
          current = (current as { cause?: unknown }).cause;
        }
        throw error;
      }
      throw new Error("expected a redirect");
    };

    expect(redirectTo(undefined, undefined)).toBe(guidedSessionEntry(undefined));
    expect(redirectTo(undefined, "es")).toBe(guidedSessionEntry("es"));
    expect(redirectTo(undefined, "https://evil.example/steal")).toBe("/session/needs?lang=en");

    for (const lang of ["en", "es"] as const) {
      const markup = renderToStaticMarkup(<MissingSessionNeeds started="1" lang={lang} />);
      const copy = journeyCopy(lang);
      expect(markup).toContain(copy.alerts.COOKIE_DROPPED);
      expect(markup).toContain('role="alert"');
      expect(markup).not.toContain("<form");
      expect(markup).not.toContain("<textarea");
      expect(markup).not.toContain("<input");
      expect(markup).not.toContain("<select");
      expect(markup).not.toContain(copy.restartNeeds);
    }
  });

  it("uses structured clarification after interpretation failure without a second model call", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    let interpretations = 0;
    const guided = {
      ...runtime,
      ai: {
        ...runtime.ai,
        async interpretNeeds() {
          interpretations += 1;
          return { understoodUse: "schoolwork", budgetDollars: "500", followUp: null, note: "kept-out" };
        },
      },
    };
    await handleNeedsSubmit(
      post("/shop/needs/submit", { lang: "en", shopperText: SCHOOL_TEXT, csrfToken: buyer.csrfToken }, buyer.cookie),
      guided,
    );
    const draft = needsDraftsFor(runtime.store).get(buyer.sessionId);
    if (!draft) throw new Error("draft missing");
    expect(draft.notice).toBe("malformed");
    const copy = journeyCopy("en");
    expect(
      renderToStaticMarkup(
        <p id="needs-notice" role="alert">
          {copy.notices.malformed}
        </p>,
      ),
    ).toContain('role="alert"');
    await handleNeedsSubmit(
      post(
        "/shop/needs/submit",
        {
          lang: "en",
          draftId: draft.draftId,
          version: String(draft.version),
          use: "schoolwork",
          budget: "500",
          csrfToken: buyer.csrfToken,
        },
        buyer.cookie,
      ),
      guided,
    );
    expect(interpretations).toBe(1);
    const ready = needsDraftsFor(runtime.store).get(buyer.sessionId);
    expect(ready?.notice).toBe("review");
    expect(ready?.prefilledUse).toBe("schoolwork");
    expect(ready?.prefilledBudgetDollars).toBe("500");
    expect(ready?.confirmedUse).toBeNull();
  });

  it("shows the current guided stage without a control that clears the draft", () => {
    const english = journeyCopy("en");
    const needs = renderToStaticMarkup(<GuidedProgress copy={english} current="needs" />);
    expect(needs.match(/aria-current="step"/g)).toHaveLength(1);
    expect(needs).toContain(english.pageTitle);
    expect(needs).toContain(english.reviewTitle);
    expect(needs).toContain(english.advisoryHeading);
    expect(needs).toContain(english.confirmation.heading);
    expect(needs).not.toMatch(/<a |<button|tabindex/i);
    const purchase = renderToStaticMarkup(<GuidedProgress copy={journeyCopy("es")} current="purchase" />);
    expect(purchase).toContain(journeyCopy("es").confirmation.heading);
    expect(purchase.match(/aria-current="step"/g)).toHaveLength(1);

    const needsPage = readFileSync("src/app/[lang]/shop/needs/page.tsx", "utf8");
    expect(needsPage).toContain('className="guided-presentation');
    expect(needsPage).not.toContain("Start over");
    expect(needsPage).toContain("restartNeeds");
    const checkout = readFileSync("src/app/[lang]/checkout/[intentId]/page.tsx", "utf8");
    const postgres = checkout.slice(checkout.indexOf("function PgCheckoutContent"), checkout.indexOf("function CheckoutContent"));
    expect(postgres).not.toContain("guided-presentation");
    expect(checkout).toContain('action={`/checkout/${view.intentId}/confirm`}');
    expect(checkout).not.toContain("Purchase confirmation unavailable");
  });

  it("keeps spaces inside the purchase button name for English and Spanish", () => {
    const line = {
      productId: "dmp_aspirego15",
      variantId: "dmv_aspirego15",
      title: "Acer Aspire Go 15",
      description: "A light 14-inch laptop for notes, documents, browsing and video calls.",
      label: "8 GB LPDDR5, 256 GB PCIe NVMe SSD",
      unitAmountCents: 57999,
      currency: "USD" as const,
      quotable: true,
      status: "READY" as const,
      explanation: "The available evidence supports this laptop for your stated needs.",
      factors: [],
    };
    for (const language of ["en", "es"] as const) {
      const copy = journeyCopy(language);
      const markup = renderToStaticMarkup(
        <TranslatedCatalogList
          copy={copy}
          language={language}
          csrfToken="csrf-token"
          lines={[line]}
          confirmedUse="schoolwork"
          confirmedBudgetDollars="500"
        />,
      );
      const contents = buttonContents(markup);
      const expected =
        language === "es"
          ? "Revisar esta compra para Acer Aspire Go 15, 8 GB LPDDR5, 256 GB PCIe NVMe SSD"
          : "Review this purchase for Acer Aspire Go 15, 8 GB LPDDR5, 256 GB PCIe NVMe SSD";
      expect(accessibleNameFromContents(contents)).toBe(expected);
      expect(markup).toContain('action="/checkout/start"');
      expect(markup).toContain('name="csrfToken"');
      if (language === "es") {
        expect(contents).toContain('<span lang="en">Acer Aspire Go 15</span>');
        expect(contents).toContain('<span lang="en">8 GB LPDDR5, 256 GB PCIe NVMe SSD</span>');
      } else {
        expect(contents).not.toContain("<span");
      }
    }
  });

  it("associates the budget hint and validation alert only when that alert is rendered", () => {
    const copy = journeyCopy("en");
    const emptyDraft = {
      shopperText: "",
      prefilledUse: "schoolwork" as const,
      prefilledBudgetDollars: null,
      draftId: "draft-empty",
      version: 2,
      notice: "missing_budget" as const,
    };
    const withAlert = renderToStaticMarkup(
      <>
        <p id={NEEDS_VALIDATION_ALERT_ID} role="alert">
          {copy.alerts.CLARIFICATION_INVALID}
        </p>
        <p id="needs-notice" role="status">
          {copy.notices.missing_budget}
        </p>
        <NeedsConversation
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={emptyDraft}
          mode="clarify"
          validationAlertId={NEEDS_VALIDATION_ALERT_ID}
          noticeRendered
        />
      </>,
    );
    expect(withAlert).not.toContain(copy.clarificationExplanation);
    expect(withAlert).toContain("<textarea");
    expect(withAlert).toContain('name="draftId" value="draft-empty"');
    expect(describedIds(withAlert, "needs-budget")).toEqual([NEEDS_VALIDATION_ALERT_ID, "needs-notice", "budget-hint"]);
    expect(textById(withAlert, NEEDS_VALIDATION_ALERT_ID)).toBe(copy.alerts.CLARIFICATION_INVALID);
    expect(textById(withAlert, "needs-notice")).toBe(copy.notices.missing_budget);
    expect(textById(withAlert, "budget-hint")).toBe(copy.budgetHint);

    const withoutAlert = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="status">
          {copy.notices.missing_budget}
        </p>
        <NeedsConversation copy={copy} language="en" csrfToken="csrf-token" draft={emptyDraft} mode="clarify" noticeRendered />
      </>,
    );
    expect(withoutAlert).not.toContain(NEEDS_VALIDATION_ALERT_ID);
    expect(withoutAlert).not.toContain(copy.clarificationExplanation);
    expect(describedIds(withoutAlert, "needs-budget")).toEqual(["needs-notice", "budget-hint"]);
    expect(textById(withoutAlert, "budget-hint")).toBe(copy.budgetHint);

    const filledDraft = { ...emptyDraft, shopperText: SCHOOL_TEXT };
    const withText = renderToStaticMarkup(
      <NeedsConversation copy={copy} language="en" csrfToken="csrf-token" draft={filledDraft} mode="clarify" />,
    );
    expect(withText).toContain(copy.clarificationExplanation);
    expect(withText).toContain(SCHOOL_TEXT);
    expect(withText).toContain("<textarea");

    const reviewDraft = {
      prefilledUse: "schoolwork" as const,
      prefilledBudgetDollars: "500",
      draftId: "draft-review",
      version: 3,
    };
    const review = renderToStaticMarkup(
      <>
        <p id={NEEDS_VALIDATION_ALERT_ID} role="alert">
          {copy.alerts.CONFIRM_INCOMPLETE}
        </p>
        <InterpretedNeedsReview
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={reviewDraft}
          validationAlertId={NEEDS_VALIDATION_ALERT_ID}
        />
      </>,
    );
    expect(review).toContain('action="/shop/needs/confirm"');
    expect(review).toContain('name="version" value="3"');
    expect(describedIds(review, "review-budget")).toEqual([NEEDS_VALIDATION_ALERT_ID, "budget-hint"]);
    expect(textById(review, "budget-hint")).toBe(copy.budgetHint);
    expect(textById(review, NEEDS_VALIDATION_ALERT_ID)).toBe(copy.alerts.CONFIRM_INCOMPLETE);

    const reviewWithoutAlert = renderToStaticMarkup(
      <InterpretedNeedsReview copy={copy} language="en" csrfToken="csrf-token" draft={reviewDraft} />,
    );
    expect(reviewWithoutAlert).not.toContain(NEEDS_VALIDATION_ALERT_ID);
    expect(describedIds(reviewWithoutAlert, "review-budget")).toEqual(["budget-hint"]);
    expect(textById(reviewWithoutAlert, "budget-hint")).toBe(copy.budgetHint);

    const needsPage = readFileSync("src/app/[lang]/shop/needs/page.tsx", "utf8");
    expect(needsPage).toContain("const validationAlertId = !expiredDraft && alert ? NEEDS_VALIDATION_ALERT_ID : undefined;");
    expect(needsPage.match(/id=\{validationAlertId\}/g)).toHaveLength(1);
    expect(needsPage).toContain("validationAlertId={validationAlertId}");
    expect(needsPage).toContain("const noticeRendered = !expiredDraft && (failureNotice !== null || statusNotice !== null);");
    expect(needsPage.match(/noticeRendered=\{noticeRendered\}/g)).toHaveLength(3);
    expect(needsPage).not.toContain("autofocus");
  });

  it("describes an in-flight draft only with targets that are rendered", () => {
    const copy = journeyCopy("en");
    const inFlight = {
      shopperText: "",
      prefilledUse: null,
      prefilledBudgetDollars: null,
      draftId: "draft-inflight",
      version: 1,
      notice: null,
    };
    const markup = renderToStaticMarkup(
      <NeedsConversation copy={copy} language="en" csrfToken="csrf-token" draft={inFlight} mode="clarify" />,
    );
    expect(markup).not.toContain("needs-notice");
    expect(markup).toContain('aria-invalid="true"');
    expect(describedIds(markup, "needs-budget")).toEqual(["budget-hint"]);
    expect(markup).not.toMatch(/<select\b[^>]*aria-describedby=/);
    assertDescribedByTargetsResolveOnce(markup);
    expect(textById(markup, "budget-hint")).toBe(copy.budgetHint);

    const withAlert = renderToStaticMarkup(
      <>
        <p id={NEEDS_VALIDATION_ALERT_ID} role="alert">
          {copy.alerts.CLARIFICATION_INVALID}
        </p>
        <NeedsConversation
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={inFlight}
          mode="clarify"
          validationAlertId={NEEDS_VALIDATION_ALERT_ID}
        />
      </>,
    );
    expect(withAlert).not.toContain("needs-notice");
    expect(describedIds(withAlert, "needs-budget")).toEqual([NEEDS_VALIDATION_ALERT_ID, "budget-hint"]);
    assertDescribedByTargetsResolveOnce(withAlert);

    const missingUse = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="status">
          {copy.notices.missing_use}
        </p>
        <NeedsConversation
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={{ ...inFlight, prefilledBudgetDollars: "500", notice: "missing_use" }}
          mode="clarify"
          noticeRendered
        />
      </>,
    );
    expect(describedIds(missingUse, "needs-use", "select")).toEqual(["needs-notice"]);
    expect(describedIds(missingUse, "needs-budget")).toEqual(["budget-hint"]);
    expect(textById(missingUse, "needs-notice")).toBe(copy.notices.missing_use);
    assertDescribedByTargetsResolveOnce(missingUse);

    const missingBudget = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="status">
          {copy.notices.missing_budget}
        </p>
        <NeedsConversation
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={{ ...inFlight, prefilledUse: "schoolwork", notice: "missing_budget" }}
          mode="clarify"
          noticeRendered
        />
      </>,
    );
    expect(missingBudget).not.toMatch(/<select\b[^>]*aria-describedby=/);
    expect(describedIds(missingBudget, "needs-budget")).toEqual(["needs-notice", "budget-hint"]);
    expect(textById(missingBudget, "needs-notice")).toBe(copy.notices.missing_budget);
    assertDescribedByTargetsResolveOnce(missingBudget);

    const errored = renderToStaticMarkup(
      <>
        <p id="needs-notice" role="alert">
          {copy.notices.malformed}
        </p>
        <NeedsConversation
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={{ ...inFlight, shopperText: SCHOOL_TEXT, notice: "malformed" }}
          mode="clarify"
          noticeRendered
        />
      </>,
    );
    expect(describedIds(errored, "needs-use", "select")).toEqual(["needs-notice"]);
    expect(describedIds(errored, "needs-budget")).toEqual(["needs-notice", "budget-hint"]);
    expect(textById(errored, "needs-notice")).toBe(copy.notices.malformed);
    expect(errored).toContain(copy.clarificationExplanation);
    assertDescribedByTargetsResolveOnce(errored);
  });

  it("points the skip link at one rendered target and leaves purchase buttons alone", () => {
    expect(journeyCopy("en").skipToCurrentStep).toBe("Skip to the current step");
    expect(journeyCopy("es").skipToCurrentStep).toBe("Saltar al paso actual");

    const states = [
      { expiredDraft: true, validationAlert: true, noticeRendered: true, reviewRendered: false, suggestionsRendered: true, target: "expired" },
      { expiredDraft: false, validationAlert: true, noticeRendered: true, reviewRendered: false, suggestionsRendered: true, target: "alert" },
      { expiredDraft: false, validationAlert: false, noticeRendered: true, reviewRendered: false, suggestionsRendered: false, target: "notice" },
      { expiredDraft: false, validationAlert: false, noticeRendered: false, reviewRendered: false, suggestionsRendered: true, target: "suggestions" },
      { expiredDraft: false, validationAlert: false, noticeRendered: false, reviewRendered: false, suggestionsRendered: false, target: "heading" },
    ] as const;
    for (const state of states) {
      expect(selectNeedsCurrentTarget(state)).toBe(state.target);
      expect(needsCurrentTargetId(state.target)).toMatch(/^[a-z0-9-]+$/);
    }
    expect(needsCurrentTargetId("expired")).toBe(NEEDS_EXPIRED_ALERT_ID);
    expect(needsCurrentTargetId("alert")).toBe(NEEDS_VALIDATION_ALERT_ID);
    expect(needsCurrentTargetId("notice")).toBe("needs-notice");
    expect(needsCurrentTargetId("review")).toBe(NEEDS_REVIEW_HEADING_ID);
    expect(needsCurrentTargetId("suggestions")).toBe(NEEDS_SUGGESTIONS_HEADING_ID);
    expect(needsCurrentTargetId("heading")).toBe(NEEDS_PAGE_HEADING_ID);

    const english = journeyCopy("en");
    const spanish = journeyCopy("es");
    const inFlight = {
      shopperText: "",
      prefilledUse: "schoolwork" as const,
      prefilledBudgetDollars: null,
      draftId: "draft-skip",
      version: 2,
      notice: "missing_budget" as const,
    };

    function assertOneTarget(markup: string, targetId: string): void {
      const link = markup.match(/<a\b(?=[^>]*\bclass="skip-link")[^>]*>/);
      expect(link?.[0]).toContain(`href="#${targetId}"`);
      expect(markup.match(new RegExp(`\\bid="${targetId}"`, "g"))).toHaveLength(1);
      expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
      expect(markup).not.toMatch(/tabindex="[0-9]/);
      expect(markup).not.toContain("autofocus");
      expect(markup).not.toMatch(/<button\b[^>]*\btabindex=/);
      expect(markup).not.toMatch(new RegExp(`<button\\b(?=[^>]*\\bid="${targetId}")`));
    }

    const expired = renderToStaticMarkup(
      <div lang="en">
        <SkipToCurrentStep copy={english} targetId={needsCurrentTargetId("expired")} />
        <p id={NEEDS_EXPIRED_ALERT_ID} role="alert" tabIndex={-1}>
          {english.alerts.DRAFT_EXPIRED}
        </p>
        <p>
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- static fixture; the page renders this href with Link */}
          <a href="/en/shop/needs">{english.restartNeeds}</a>
        </p>
      </div>,
    );
    assertOneTarget(expired, NEEDS_EXPIRED_ALERT_ID);
    expect(expired).toContain(english.restartNeeds);
    expect(expired).toContain('href="/en/shop/needs"');
    expect(expired.indexOf('class="skip-link"')).toBeLessThan(expired.indexOf(`id="${NEEDS_EXPIRED_ALERT_ID}"`));

    const alertAndNotice = renderToStaticMarkup(
      <div lang="en">
        <SkipToCurrentStep copy={english} targetId={needsCurrentTargetId("alert")} />
        <p id={NEEDS_VALIDATION_ALERT_ID} role="alert" tabIndex={-1}>
          {english.alerts.CLARIFICATION_INVALID}
        </p>
        <p id="needs-notice" role="status">
          {english.notices.missing_budget}
        </p>
        <NeedsConversation
          copy={english}
          language="en"
          csrfToken="csrf-token"
          draft={inFlight}
          mode="clarify"
          validationAlertId={NEEDS_VALIDATION_ALERT_ID}
          noticeRendered
        />
      </div>,
    );
    assertOneTarget(alertAndNotice, NEEDS_VALIDATION_ALERT_ID);
    expect(describedIds(alertAndNotice, "needs-budget")).toEqual([NEEDS_VALIDATION_ALERT_ID, "needs-notice", "budget-hint"]);
    expect(alertAndNotice).toContain('action="/shop/needs/submit"');
    expect(alertAndNotice).toContain('name="draftId"');
    expect(alertAndNotice).toContain('name="csrfToken"');
    expect(alertAndNotice.indexOf('class="skip-link"')).toBeLessThan(alertAndNotice.indexOf("<form"));

    const noticeOnly = renderToStaticMarkup(
      <div lang="es">
        <SkipToCurrentStep copy={spanish} targetId={needsCurrentTargetId("notice")} />
        <p id="needs-notice" role="status" tabIndex={-1}>
          {spanish.notices.missing_budget}
        </p>
        <NeedsConversation
          copy={spanish}
          language="es"
          csrfToken="csrf-token"
          draft={inFlight}
          mode="clarify"
          noticeRendered
        />
      </div>,
    );
    assertOneTarget(noticeOnly, "needs-notice");
    expect(noticeOnly).toContain("Saltar al paso actual");
    expect(noticeOnly).toContain('lang="es"');
    expect(describedIds(noticeOnly, "needs-budget")).toEqual(["needs-notice", "budget-hint"]);
    expect(textById(noticeOnly, "needs-notice")).toBe(spanish.notices.missing_budget);

    const purchaseLine = {
      productId: "studybook-14",
      variantId: "studybook-14-base",
      title: "Acer Aspire Go 15",
      description: "A light 14-inch laptop.",
      label: "8 GB LPDDR5, 256 GB PCIe NVMe SSD",
      unitAmountCents: 57999,
      currency: "USD" as const,
      quotable: true,
      status: "READY" as const,
      explanation: "Shown for the confirmed need.",
      factors: [],
    };
    const suggestions = renderToStaticMarkup(
      <div lang="en">
        <SkipToCurrentStep copy={english} targetId={needsCurrentTargetId("suggestions")} />
        <TranslatedAdvisory
          copy={english}
          language="en"
          draft={{ recommendationClaim: "completed", recommendation: null }}
          lines={[purchaseLine]}
          headingTabIndex={-1}
        />
        <TranslatedCatalogList
          copy={english}
          language="en"
          csrfToken="csrf-token"
          lines={[purchaseLine]}
          confirmedUse="schoolwork"
          confirmedBudgetDollars="500"
        />
      </div>,
    );
    assertOneTarget(suggestions, NEEDS_SUGGESTIONS_HEADING_ID);
    expect(suggestions).toContain('action="/checkout/start"');
    expect(suggestions).toContain('name="csrfToken" value="csrf-token"');
    expect(suggestions).toContain('name="productId" value="studybook-14"');
    expect(suggestions).toContain('name="variantId" value="studybook-14-base"');
    expect(suggestions).toContain('name="quantity" value="1"');
    expect(suggestions).toContain("$579.99");
    expect(buttonContents(suggestions)).toContain("Review this purchase for Acer Aspire Go 15, 8 GB LPDDR5, 256 GB PCIe NVMe SSD");
    expect(suggestions.indexOf(`id="${NEEDS_SUGGESTIONS_HEADING_ID}"`)).toBeLessThan(suggestions.indexOf('action="/checkout/start"'));
    const untouchedSuggestions = renderToStaticMarkup(
      <TranslatedAdvisory
        copy={english}
        language="en"
        draft={{ recommendationClaim: "completed", recommendation: null }}
        lines={[purchaseLine]}
      />,
    );
    expect(untouchedSuggestions).not.toContain("tabindex");

    const firstAsk = renderToStaticMarkup(
      <div lang="en">
        <SkipToCurrentStep copy={english} targetId={needsCurrentTargetId("heading")} />
        <h1 id={NEEDS_PAGE_HEADING_ID} tabIndex={-1}>
          {english.pageTitle}
        </h1>
        <NeedsConversation copy={english} language="en" csrfToken="csrf-token" draft={null} mode="first" />
      </div>,
    );
    assertOneTarget(firstAsk, NEEDS_PAGE_HEADING_ID);
    expect(firstAsk).toContain("Skip to the current step");
    expect(firstAsk).toContain('name="shopperText"');
    expect(firstAsk).not.toContain('name="draftId"');
    expect(firstAsk.indexOf('class="skip-link"')).toBeLessThan(firstAsk.indexOf("<form"));

    const needsPage = readFileSync("src/app/[lang]/shop/needs/page.tsx", "utf8");
    const skipAt = needsPage.indexOf("<SkipToCurrentStep");
    expect(skipAt).toBeGreaterThan(needsPage.indexOf("<div lang={language}"));
    expect(skipAt).toBeLessThan(needsPage.indexOf("<h1"));
    expect(skipAt).toBeLessThan(needsPage.indexOf("<NeedsConversation"));
    expect(skipAt).toBeLessThan(needsPage.indexOf("<InterpretedNeedsReview"));
    expect(skipAt).toBeLessThan(needsPage.indexOf("<TranslatedCatalogList"));
    expect(needsPage.match(/tabIndex=\{-1\}/g)).toHaveLength(2);
    expect(needsPage).not.toMatch(/tabIndex=\{[0-9]/);
    expect(needsPage).not.toContain("autofocus");
    expect(needsPage).not.toContain("use client");
    expect(needsPage).toContain("fallback={<p>Loading guided shopping…</p>}");
    expect(needsPage).toContain("restartNeeds");
    expect(needsPage).toContain('headingTabIndex={currentTarget === "suggestions" ? -1 : undefined}');
    expect(needsPage).toContain('headingTabIndex={currentTarget === "review" ? -1 : undefined}');
    expect(needsPage).toContain("reviewRendered: showConfirm,");
    const presentation = readFileSync("src/app/guided-presentation.css", "utf8");
    const focusedSkip = presentation.match(/\.guided-presentation \.skip-link:focus-visible\s*\{([^}]*)\}/);
    expect(focusedSkip?.[1]).toMatch(/position:\s*(?:fixed|absolute)/);
    expect(focusedSkip?.[1]).not.toMatch(/position:\s*static/);
    expect(presentation).not.toMatch(/\.skip-link[^{]*\{[^}]*display:\s*none/);
  });

  it("points the skip link at the review heading when confirmation has no alert or notice", () => {
    const copy = journeyCopy("en");
    const target = selectNeedsCurrentTarget({
      expiredDraft: false,
      validationAlert: false,
      noticeRendered: false,
      reviewRendered: true,
      suggestionsRendered: false,
    });
    expect(target).toBe("review");
    expect(needsCurrentTargetId(target)).toBe(NEEDS_REVIEW_HEADING_ID);
    expect(
      selectNeedsCurrentTarget({
        expiredDraft: false,
        validationAlert: false,
        noticeRendered: true,
        reviewRendered: true,
        suggestionsRendered: false,
      }),
    ).toBe("notice");
    expect(
      selectNeedsCurrentTarget({
        expiredDraft: false,
        validationAlert: false,
        noticeRendered: false,
        reviewRendered: true,
        suggestionsRendered: true,
      }),
    ).toBe("review");

    const reviewDraft = {
      prefilledUse: "schoolwork" as const,
      prefilledBudgetDollars: "500",
      draftId: "draft-review",
      version: 4,
    };
    const markup = renderToStaticMarkup(
      <div lang="en">
        <SkipToCurrentStep copy={copy} targetId={needsCurrentTargetId(target)} />
        <h1 className="text-3xl font-semibold">{copy.pageTitle}</h1>
        <InterpretedNeedsReview
          copy={copy}
          language="en"
          csrfToken="csrf-token"
          draft={reviewDraft}
          headingTabIndex={-1}
        />
      </div>,
    );
    const link = markup.match(/<a\b(?=[^>]*\bclass="skip-link")[^>]*>/g);
    expect(link).toHaveLength(1);
    expect(link?.[0]).toContain(`href="#${NEEDS_REVIEW_HEADING_ID}"`);
    expect(markup.match(new RegExp(`\\bid="${NEEDS_REVIEW_HEADING_ID}"`, "g"))).toHaveLength(1);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(1);
    expect(markup).toMatch(new RegExp(`<h2\\b(?=[^>]*\\bid="${NEEDS_REVIEW_HEADING_ID}")(?=[^>]*\\btabindex="-1")[^>]*>`));
    expect(markup).not.toMatch(/<h1\b[^>]*tabindex=/);
    expect(markup).not.toMatch(/tabindex="[0-9]/);
    expect(markup).toContain(copy.reviewTitle);
    expect(markup).toContain(copy.reviewBody);
    expect(markup).toContain(copy.confirmReview);
    expect(markup).toContain('action="/shop/needs/confirm"');
    expect(markup).toContain('name="draftId" value="draft-review"');
    expect(markup).toContain('name="version" value="4"');
    expect(markup).toContain('name="lang" value="en"');
    expect(markup).toContain('name="csrfToken" value="csrf-token"');
    expect(markup).not.toContain('action="/checkout/start"');
    expect(markup.indexOf('class="skip-link"')).toBeLessThan(markup.indexOf("<form"));

    const unselected = renderToStaticMarkup(
      <InterpretedNeedsReview copy={copy} language="en" csrfToken="csrf-token" draft={reviewDraft} />,
    );
    expect(unselected).toContain(`id="${NEEDS_REVIEW_HEADING_ID}"`);
    expect(unselected).not.toContain("tabindex");
  });
});
