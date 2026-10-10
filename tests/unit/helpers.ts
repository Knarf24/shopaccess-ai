import { DEMO_MERCHANT_CATALOG } from "@/lib/catalog/merchant-catalog";
import type { MerchantCatalog } from "@/lib/catalog/schemas";
import { requestQuote, startCheckout, type CheckoutDeps } from "@/lib/checkout/service";
import { InMemoryCheckoutStore } from "@/lib/checkout/store";
import { confirmPurchaseSummary, prepareConfirmation } from "@/lib/confirmation/confirmation";
import { InMemoryOperationLedger } from "@/lib/payment/operations";
import type { PaymentDeps } from "@/lib/payment/orchestrator";
import { MockPaymentProvider } from "@/lib/providers/payment";
import type { Quote } from "@/lib/quote/quote";
import { InMemoryAuditLog } from "@/lib/security/audit";
import { createSequentialIdGenerator } from "@/lib/shared/ids";
import { createSessionService, SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";
import { InMemorySessionStore } from "@/lib/session/store";

export const TEST_SESSION_KEY = Buffer.alloc(32, 7);
export const MINUTE = 60 * 1000;
export const HOUR = 60 * MINUTE;
export const LEASE_MS = 30 * 1000;

export function createTestClock(start = "2026-10-08T12:00:00.000Z") {
  let now = Date.parse(start);
  return {
    clock: () => new Date(now),
    advance(ms: number) {
      now += ms;
    },
  };
}

/** Deep copy so tests can alter catalog data without touching the shared demo catalog. */
export function cloneCatalog(): MerchantCatalog {
  return structuredClone(DEMO_MERCHANT_CATALOG);
}

export function createWorld() {
  const time = createTestClock();
  const ids = createSequentialIdGenerator();
  const sessionStore = new InMemorySessionStore();
  const sessions = createSessionService({ store: sessionStore, key: TEST_SESSION_KEY, clock: time.clock, ids });
  const store = new InMemoryCheckoutStore();
  const ledger = new InMemoryOperationLedger(ids);
  const provider = new MockPaymentProvider();
  const catalog = cloneCatalog();
  const audit = new InMemoryAuditLog();
  const sessionIsLive = (sessionId: string) => sessionStore.isLive(sessionId, time.clock(), SESSION_IDLE_TIMEOUT_MS);
  const checkout: CheckoutDeps = { store, sessionIsLive, catalog, clock: time.clock, ids };
  const payment = (workerId = "worker-a"): PaymentDeps => ({
    store,
    ledger,
    provider,
    catalog,
    audit,
    clock: time.clock,
    ids,
    workerId,
    leaseMs: LEASE_MS,
  });
  return { time, ids, sessionStore, sessions, store, ledger, provider, catalog, audit, checkout, payment };
}

export type World = ReturnType<typeof createWorld>;

export const SAMPLE_REQUEST = { productId: "dmp_codebook15", variantId: "dmv_codebook15a", quantity: 1 };

export async function newSession(world: World) {
  const issued = await world.sessions.establish(null);
  if (!issued.ok) throw new Error(`session refused: ${issued.error.reason}`);
  return { session: issued.value.session, token: issued.value.issuedToken! };
}

export async function quotedIntent(world: World, sessionId: string, request: unknown = SAMPLE_REQUEST) {
  const intent = await startCheckout(world.checkout, sessionId);
  const quote = await requestQuote(world.checkout, sessionId, intent.id, request);
  if (!quote.ok) throw new Error(`quote failed: ${quote.error}`);
  return { intentId: intent.id, quote: quote.value as Quote };
}

export async function confirmedIntent(world: World, sessionId: string) {
  const { intentId, quote } = await quotedIntent(world, sessionId);
  const challenge = await prepareConfirmation(world.checkout, sessionId, quote.quoteId);
  if (!challenge.ok) throw new Error(`prepare failed: ${challenge.error}`);
  const { confirmationId, nonce, quoteId, quoteDigest } = challenge.value;
  const confirmed = await confirmPurchaseSummary(world.checkout, sessionId, { confirmationId, nonce, quoteId, quoteDigest });
  if (!confirmed.ok) throw new Error(`confirm failed: ${confirmed.error}`);
  return { intentId, quote };
}

export async function stateOf(world: World, intentId: string) {
  return (await world.store.findIntent(intentId))!.snapshot.state;
}
