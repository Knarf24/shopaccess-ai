import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openFoundationStore } from "@/lib/session/snapshot-store";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { createRuntime } from "@/server/runtime";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { handleNeedsSubmit, handleChargerControl, handlePermissionCreate, handleCheckoutStart } from "@/server/handlers";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { needsDraftsFor } from "@/lib/session/store";
import { chargerTracksOf } from "@/lib/session/charger-clarification";
import { startCheckoutWithQuote } from "@/lib/checkout/service";
import { prepareConfirmation, confirmPurchaseSummary } from "@/lib/confirmation/confirmation";
import { dispatchOrderCreate, recordBuyerReturn, verifyApproval, dispatchCapture } from "@/lib/payment/orchestrator";
import { CHARGER_PRODUCT_ID, CHARGER_VARIANT_ID } from "@/lib/catalog/charger-purchase";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";
const SITE = "https://shop.example.test";
const paths: string[] = [];
afterEach(() => { paths.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const item = { productId: CHARGER_PRODUCT_ID, variantId: CHARGER_VARIANT_ID, quantity: 1 };
async function world() {
 const dir = fs.mkdtempSync(join(tmpdir(), "sa-charger-purchase-")); fs.rmdirSync(dir);
 const key = `${dir}.key`; fs.writeFileSync(key, "disposable-test-key", { mode: 0o600 }); paths.push(dir, key);
 const opened = await openFoundationStore(dir, new Uint8Array(), { initializeEmpty: { keyFile: key }, format8TestStore: true });
 if (opened.status !== "ready") throw Error("store");
 const time = createTestClock(); const gate = await recoverStateGate(opened.value, time.clock()); if (gate.status !== "ready") throw Error("gate");
 const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock, gate: gate.gate, chargerBudgetTestStore: true });
 const issued = await runtime.sessions.establish(null); if (!issued.ok) throw Error("session");
 const session = issued.value.session;
 const post = (path: string, fields: Record<string,string>) => new Request(SITE + path, { method: "POST", headers: { origin: SITE, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${issued.value.issuedToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ lang: "en", csrfToken: session.csrfToken, ...fields }) });
 await handleNeedsSubmit(post("/shop/needs/submit", { shopperText: "I need a charger for Mac14,2" }), runtime);
 const control = async (fields: Record<string,string>) => {
   const draft = needsDraftsFor(runtime.store).get(session.id)!; const track = chargerTracksOf(runtime.store).get(session.id)!;
   return handleChargerControl(post("/shop/needs/charger-control", { draftId: draft.draftId, revision: String(track.revision), ...fields }), runtime);
 };
 await control({ action: "confirm" }); await control({ action: "propose_budget", dollars: "59" }); await control({ action: "confirm_budget" });
 return { runtime, session, post, control, time };
}
async function permit(w: Awaited<ReturnType<typeof world>>) {
 return handlePermissionCreate(w.post("/shop/permissions/create", { item: `${item.productId}:${item.variantId}`, quantity: "1", total: "59.00", expiry: "1h" }), w.runtime);
}
it("completes an explicitly permitted mock adapter purchase", async () => {
 const w = await world(); expect(w.runtime.catalog.revision).toBe(3);
 expect(chargerTracksOf(w.runtime.store).get(w.session.id)?.budget?.confirmedCents).toBe(5900);
 expect((await startCheckoutWithQuote(w.runtime.checkout, w.session.id, item)).ok).toBe(false);
 expect((await permit(w)).headers.get("location")).toContain("result=created");
 const response = await handleCheckoutStart(w.post("/checkout/start", { ...item, quantity: "1" }), w.runtime);
 const id = response.headers.get("location")!.split("/").pop()!;
 const intent = await w.runtime.store.findIntent(id); expect(intent).not.toBeNull(); if (!intent) return;
 const quote = await w.runtime.store.findQuote(intent.snapshot.context.quoteId!); expect(quote?.totalCents).toBe(5900); if (!quote) return;
 const challenge = await prepareConfirmation(w.runtime.checkout, w.session.id, quote.quoteId); expect(challenge.ok).toBe(true); if (!challenge.ok) return;
 const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
 expect((await confirmPurchaseSummary(w.runtime.checkout, w.session.id, { confirmationId, nonce, quoteId, quoteDigest })).ok).toBe(true);
 expect((await dispatchOrderCreate(w.runtime.payment, id)).ok).toBe(true);
 const orderId = (await w.runtime.store.findIntent(id))!.snapshot.context.providerOrderId!;
 w.runtime.provider.simulateBuyerApproval(orderId); await recordBuyerReturn(w.runtime.payment, w.session.id, id);
 expect((await verifyApproval(w.runtime.payment, id)).ok).toBe(true);
 expect((await dispatchCapture(w.runtime.payment, id)).ok).toBe(true);
 expect((await w.runtime.store.findIntent(id))!.snapshot.state).toBe("CAPTURED_VERIFIED");
 expect(w.runtime.permissions.list(w.session.id, w.runtime.clock())[0].state).toBe("consumed");
});
it.each(["budget", "device"])("refuses an old checkout after changing %s", async change => {
 const w = await world(); await permit(w);
 const started = await startCheckoutWithQuote(w.runtime.checkout, w.session.id, item); expect(started.ok).toBe(true); if (!started.ok) return;
 await w.control(change === "budget" ? { action: "propose_budget", dollars: "60" } : { action: "change" });
 expect((await prepareConfirmation(w.runtime.checkout, w.session.id, started.value.quote.quoteId)).ok).toBe(false);
 expect((await startCheckoutWithQuote(w.runtime.checkout, w.session.id, item)).ok).toBe(false);
});
async function approved(w: Awaited<ReturnType<typeof world>>) {
 await permit(w); const started = await startCheckoutWithQuote(w.runtime.checkout, w.session.id, item); if (!started.ok) throw Error(started.error);
 const c = await prepareConfirmation(w.runtime.checkout, w.session.id, started.value.quote.quoteId); if (!c.ok) throw Error(c.error);
 const { confirmationId, nonce, quoteId, quoteDigest } = c.value;
 const confirmed = await confirmPurchaseSummary(w.runtime.checkout, w.session.id, { confirmationId, nonce, quoteId, quoteDigest }); if (!confirmed.ok) throw Error(confirmed.error);
 const id = started.value.intent.id;
 const created = await dispatchOrderCreate(w.runtime.payment, id); if (!created.ok) throw Error("order");
 w.runtime.provider.simulateBuyerApproval((await w.runtime.store.findIntent(id))!.snapshot.context.providerOrderId!);
 await recordBuyerReturn(w.runtime.payment, w.session.id, id); await verifyApproval(w.runtime.payment, id);
 return id;
}
it("does not capture after a later budget edit and reconfirmation", async () => {
 const w = await world(); const id = await approved(w);
 await w.control({ action: "propose_budget", dollars: "60" }); await w.control({ action: "confirm_budget" });
 expect((await dispatchCapture(w.runtime.payment, id)).ok).toBe(false);
 expect((await w.runtime.store.findIntent(id))!.snapshot.state).toBe("APPROVED_VERIFIED");
 expect(w.runtime.permissions.list(w.session.id, w.runtime.clock())[0].state).toBe("reserved");
});
it("does not accept an expired charger draft", async () => {
 const w = await world(); await permit(w);
 const drafts = needsDraftsFor(w.runtime.store);
 drafts.set(w.session.id, { ...drafts.get(w.session.id)!, expiresAtMs: w.runtime.clock().getTime() - 1 });
 expect((await startCheckoutWithQuote(w.runtime.checkout, w.session.id, item)).ok).toBe(false);
});
it("keeps the ordinary in-memory catalog unchanged", () => {
 const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { chargerBudgetTestStore: true });
 expect(runtime.catalog.revision).toBe(2);
 expect(runtime.catalog.products.some(p => p.productId === CHARGER_PRODUCT_ID)).toBe(false);
});
import { readConversation } from "@/lib/session/conversation";
it("does not append comparison messages for budget-only actions", async () => {
 const w = await world();
 expect(readConversation(w.runtime.store, w.session.id)!.turns.filter(t => t.role === "assistant" && t.text === "charger_shown")).toHaveLength(1);
 await w.control({ action: "propose_budget", dollars: "60" }); await w.control({ action: "confirm_budget" });
 expect(readConversation(w.runtime.store, w.session.id)!.turns.filter(t => t.role === "assistant" && t.text === "charger_shown")).toHaveLength(1);
});
