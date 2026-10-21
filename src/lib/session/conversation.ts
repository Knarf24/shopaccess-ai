import type { JourneyLanguage } from "@/lib/i18n/language";
import type { NeedsNotice } from "@/lib/i18n/needs-notice";
import type { ChargerLine } from "./charger-clarification";
import type { IntendedUse } from "@/lib/readiness/engine";
import type { ConversationTurn } from "@/types/conversation-turn";

export type { ConversationTurn } from "@/types/conversation-turn";

/**
 * Process-local conversation for one needs draft. It is not a NeedsDraft field and it is not
 * written into a session snapshot. It resets when the process restarts.
 * `interfaceLanguage` is fixed when the draft's conversation starts. This increment does not
 * switch it.
 */

export interface ConversationState {
  readonly draftId: string;
  readonly interfaceLanguage: JourneyLanguage;
  readonly turns: readonly ConversationTurn[];
}

/** Shopper and assistant lines kept for one draft. Older lines are dropped. */
export const MAX_CONVERSATION_TURNS = 8;

/**
 * Per-store state is attached to the store object under global symbols, as needs drafts are (store.ts). A module-level
 * WeakMap is not enough: the Next.js server can load this module more than once (one copy per route bundle), and each
 * copy would see an empty map for the same store. The runtime's save could then miss a line a route had just recorded.
 */
const CONVERSATIONS = Symbol.for("shopaccess.conversations");
const PURCHASE_EPOCHS = Symbol.for("shopaccess.purchaseEpochs");
const CLOSED_SELECTIONS = Symbol.for("shopaccess.closedSelections");
const CHECKOUT_EPOCHS = Symbol.for("shopaccess.checkoutEpochs");

function slot<T>(store: object, key: symbol, create: () => T): T {
  const host = store as Record<symbol, T | undefined>;
  let found = host[key];
  if (found === undefined) {
    found = create();
    host[key] = found;
  }
  return found;
}

function conversationMap(store: object): Map<string, ConversationState> {
  return slot(store, CONVERSATIONS, () => new Map<string, ConversationState>());
}

function epochMap(store: object): Map<string, number> {
  return slot(store, PURCHASE_EPOCHS, () => new Map<string, number>());
}

function checkoutMap(store: object): Map<string, { readonly sessionId: string; readonly epoch: number }> {
  return slot(store, CHECKOUT_EPOCHS, () => new Map<string, { readonly sessionId: string; readonly epoch: number }>());
}

export function readConversation(store: object, sessionId: string): ConversationState | null {
  return conversationMap(store).get(sessionId) ?? null;
}

/** Conversation and needs-bound selection state of one host, as the snapshot runtime persists it. */
export interface SessionConversationState {
  readonly conversations: ReadonlyMap<string, ConversationState>;
  readonly selections: ReadonlyMap<string, { readonly epoch: number; readonly closed: boolean }>;
}

export function conversationStateOf(store: object): SessionConversationState {
  const epochs = epochMap(store);
  const closed = closedSet(store);
  const selections = new Map<string, { epoch: number; closed: boolean }>();
  for (const sessionId of new Set([...epochs.keys(), ...closed])) selections.set(sessionId, { epoch: epochs.get(sessionId) ?? 0, closed: closed.has(sessionId) });
  return { conversations: new Map(conversationMap(store)), selections };
}

/**
 * Replaces the persisted conversation and selection state of one host. Checkout epochs per intent are not part of it:
 * they stay process-local because checkout intents are memory-only and do not survive a restart.
 */
export function replaceConversationState(store: object, state: SessionConversationState): void {
  const conversations = conversationMap(store);
  conversations.clear();
  for (const [sessionId, conversation] of state.conversations) conversations.set(sessionId, conversation);
  const epochs = epochMap(store);
  const closed = closedSet(store);
  epochs.clear();
  closed.clear();
  for (const [sessionId, selection] of state.selections) {
    if (selection.epoch !== 0) epochs.set(sessionId, selection.epoch);
    if (selection.closed) closed.add(sessionId);
  }
}

/** Appends one shopper line and, when present, the notice the server actually stored. */
export function recordConversationTurn(
  store: object,
  sessionId: string,
  input: {
    readonly draftId: string;
    readonly interfaceLanguage: JourneyLanguage;
    readonly shopperText: string;
    readonly assistantNotice: NeedsNotice | ChargerLine | null;
  },
): ConversationState {
  const existing = conversationMap(store).get(sessionId) ?? null;
  const sameDraft = existing !== null && existing.draftId === input.draftId;
  const turns: ConversationTurn[] = sameDraft ? [...existing.turns] : [];
  const shopperText = input.shopperText.trim();
  if (shopperText.length > 0) turns.push({ role: "shopper", text: shopperText });
  if (input.assistantNotice) turns.push({ role: "assistant", text: input.assistantNotice });
  const state: ConversationState = {
    draftId: input.draftId,
    interfaceLanguage: sameDraft ? existing.interfaceLanguage : input.interfaceLanguage,
    turns: turns.slice(-MAX_CONVERSATION_TURNS),
  };
  conversationMap(store).set(sessionId, state);
  return state;
}

export interface FollowUpCandidate {
  readonly prefilledUse: IntendedUse | null;
  readonly prefilledBudgetDollars: string | null;
  readonly notice: NeedsNotice | null;
}

/**
 * Keeps a previous supported use or budget when the new turn does not support a replacement.
 * A malformed, unavailable, or ambiguous turn does not count as a supported change.
 */
export function mergeFollowUpCandidate(
  previous: { readonly prefilledUse: IntendedUse | null; readonly prefilledBudgetDollars: string | null },
  settled: FollowUpCandidate,
): FollowUpCandidate & { readonly supportedChange: boolean } {
  if (settled.notice === "malformed" || settled.notice === "unavailable") {
    return {
      prefilledUse: previous.prefilledUse,
      prefilledBudgetDollars: previous.prefilledBudgetDollars,
      notice: settled.notice,
      supportedChange: false,
    };
  }
  if (settled.notice === "ambiguous") {
    return {
      prefilledUse: settled.prefilledUse ?? previous.prefilledUse,
      prefilledBudgetDollars: previous.prefilledBudgetDollars,
      notice: "ambiguous",
      supportedChange: false,
    };
  }
  const prefilledUse = settled.prefilledUse ?? previous.prefilledUse;
  const prefilledBudgetDollars = settled.prefilledBudgetDollars ?? previous.prefilledBudgetDollars;
  const notice: NeedsNotice | null = prefilledUse === null ? "missing_use" : prefilledBudgetDollars === null ? "missing_budget" : "review";
  return {
    prefilledUse,
    prefilledBudgetDollars,
    notice,
    supportedChange: notice === "review" && (prefilledUse !== previous.prefilledUse || prefilledBudgetDollars !== previous.prefilledBudgetDollars),
  };
}

function closedSet(store: object): Set<string> {
  return slot(store, CLOSED_SELECTIONS, () => new Set<string>());
}

/** Bumps the epoch that needs-bound checkout selections must still match. */
export function invalidatePurchaseSelections(store: object, sessionId: string): void {
  const epochs = epochMap(store);
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
  closedSet(store).add(sessionId);
}

/** A new explicit confirmation may start a checkout again. */
export function reopenPurchaseSelections(store: object, sessionId: string): void {
  closedSet(store).delete(sessionId);
}

/** True until a supported change withdraws the confirmation. */
export function purchaseSelectionsOpen(store: object, sessionId: string): boolean {
  return !closedSet(store).has(sessionId);
}

/** Records the epoch of a checkout that was started from the current needs confirmation. */
export function noteCheckoutSelection(store: object, sessionId: string, intentId: string): void {
  checkoutMap(store).set(intentId, { sessionId, epoch: epochMap(store).get(sessionId) ?? 0 });
}

/**
 * A checkout that was not started from a needs confirmation stays allowed.
 * A noted checkout is allowed only while its epoch is still current.
 */
export function checkoutSelectionCurrent(store: object, sessionId: string, intentId: string): boolean {
  const noted = checkoutMap(store).get(intentId);
  if (!noted) return true;
  if (noted.sessionId !== sessionId) return false;
  return noted.epoch === (epochMap(store).get(sessionId) ?? 0);
}
