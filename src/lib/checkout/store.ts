import type { PaymentSnapshot, TransitionRecord } from "../payment/state-machine";
import type { Quote } from "../quote/quote";
import { deleteNeedsDrafts } from "../session/store";

export interface CheckoutIntentRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly snapshot: PaymentSnapshot;
  readonly createdAt: string;
  /** Mock journey language. Absent from quotes, digests, nonces, and payment state. */
  readonly interfaceLanguage?: "en" | "es";
}

export interface ConfirmationSummary {
  readonly merchantName: string;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly quantity: number;
  readonly currency: "USD";
  readonly totalCents: number;
}

export interface ConfirmationRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly checkoutIntentId: string;
  readonly quoteId: string;
  readonly quoteDigest: string;
  /** Exactly what the shopper was shown. */
  readonly summary: ConfirmationSummary;
  /** SHA-256 of the single-use nonce; the raw nonce is never stored. */
  readonly nonceDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

/** Synchronous answer to "is this session live right now?". Single-process mock only. */
export type SessionLivenessCheck = (sessionId: string) => boolean;

export interface CheckoutStartCommit {
  readonly intent: CheckoutIntentRecord;
  /** Transitions already applied to reach `intent.snapshot`, in order. */
  readonly transitions: readonly TransitionRecord[];
  readonly quote: Quote | null;
}

/** What the provider reported, kept apart from local workflow state. */
export interface ProviderObservation {
  readonly id: string;
  readonly checkoutIntentId: string;
  readonly operationId: string | null;
  readonly source: "provider_response" | "provider_readback" | "provider_observation";
  readonly subject: "ORDER" | "CAPTURE";
  readonly providerOrderId: string | null;
  readonly providerCaptureId: string | null;
  /** Provider-reported status, or NOT_FOUND / UNAVAILABLE for readbacks. */
  readonly observedStatus: string;
  /** Set when the evidence was rejected: why, and what the provider actually reported. */
  readonly conflict: string | null;
  readonly reportedAmountCents: number | null;
  readonly reportedCurrency: string | null;
  readonly observedAt: string;
}

/**
 * Persistence boundary for checkout data. `...ForSession` lookups are the only
 * ones request handlers may use: they return null for objects owned by another
 * session, exactly as if the object did not exist. The unscoped lookups are for
 * trusted server-side workers that act on an intent they already own.
 */
export interface CheckoutRepository {
  transaction<T>(work: () => Promise<T>): Promise<T>;

  /**
   * The ONLY way a checkout intent is created. In one atomic step it decides
   * that the owning session is still live and, only then, stores the intent
   * together with its initial transition history and quote (when given).
   * Returns false, storing nothing at all, if the session is not live.
   *
   * `sessionIsLive` must be evaluated atomically with the writes: session
   * reclamation must not be able to run between the decision and the insert.
   */
  commitCheckoutStart(commit: CheckoutStartCommit, sessionIsLive: SessionLivenessCheck): Promise<boolean>;
  findIntentForSession(sessionId: string, intentId: string): Promise<CheckoutIntentRecord | null>;
  findIntent(intentId: string): Promise<CheckoutIntentRecord | null>;
  /** Compare-and-set on the row version. Returns false if another writer got there first. */
  applyTransition(intentId: string, expectedVersion: number, snapshot: PaymentSnapshot, record: TransitionRecord): Promise<boolean>;
  listTransitions(intentId: string): Promise<readonly TransitionRecord[]>;

  insertQuote(quote: Quote): Promise<void>;
  findQuoteForSession(sessionId: string, quoteId: string): Promise<Quote | null>;
  findQuote(quoteId: string): Promise<Quote | null>;

  /**
   * Makes `record` THE confirmation challenge for its quote, atomically
   * discarding any earlier unconsumed challenge for that quote. There is never
   * more than one challenge record per quote. Returns false, changing nothing,
   * if the quote's challenge has already been consumed.
   */
  replaceActiveConfirmation(record: ConfirmationRecord): Promise<boolean>;
  /** The single challenge record for a quote (active, expired or consumed), if the session owns it. */
  findConfirmationForQuote(sessionId: string, quoteId: string): Promise<ConfirmationRecord | null>;
  findConfirmationForSession(sessionId: string, confirmationId: string): Promise<ConfirmationRecord | null>;
  /** Reclaims challenges that expired without being used. Consumed ones are kept as the record of consent. */
  purgeExpiredConfirmations(now: Date): Promise<number>;
  /** Atomically marks a confirmation used. Returns false if it was already consumed. */
  consumeConfirmation(confirmationId: string, consumedAt: string): Promise<boolean>;

  appendObservation(observation: ProviderObservation): Promise<void>;
  listObservations(intentId: string): Promise<readonly ProviderObservation[]>;

  /** Whether a checkout intent with this ID is currently stored. */
  hasIntent(intentId: string): Promise<boolean>;
  /**
   * LOCAL MOCK ONLY. Removes every checkout record owned by the given sessions:
   * intents, transition history, quotes, confirmation challenges and provider
   * observations. Other sessions' records are untouched. Idempotent. Returns
   * the IDs of the intents removed. Real payment records must never be removed
   * like this; they need a separately designed durable retention policy.
   */
  deleteForSessions(sessionIds: readonly string[]): Promise<string[]>;
}

/**
 * Single-process implementation for tests and the mock milestone. Each method
 * checks and writes synchronously, so compare-and-set semantics hold between
 * awaits. `transaction` only tracks boundaries (there is no rollback); it lets
 * tests prove that provider calls happen outside a transaction.
 */
export class InMemoryCheckoutStore implements CheckoutRepository {
  private readonly intents = new Map<string, CheckoutIntentRecord>();
  private readonly transitions = new Map<string, TransitionRecord[]>();
  private readonly quotes = new Map<string, Quote>();
  /** Keyed by quote ID: one challenge record per quote, by construction. */
  private readonly confirmations = new Map<string, ConfirmationRecord>();
  private observations: ProviderObservation[] = [];
  private transactionDepth = 0;

  get inTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    this.transactionDepth += 1;
    try {
      return await work();
    } finally {
      this.transactionDepth -= 1;
    }
  }

  // Deliberately contains no `await`. Everything from the liveness decision to the last write runs
  // as one uninterrupted step, so session reclamation (which also removes records without
  // interruption) is either entirely before it or entirely after it:
  //   - before: the session is gone, the check fails, nothing is written;
  //   - after:  the records exist under a session ID that reclamation will delete by owner.
  // All validation happens before the first write, so there are no partial writes.
  async commitCheckoutStart(commit: CheckoutStartCommit, sessionIsLive: SessionLivenessCheck): Promise<boolean> {
    const { intent, transitions, quote } = commit;
    if (this.intents.has(intent.id)) throw new Error("Duplicate checkout intent id");
    if (quote) {
      if (quote.sessionId !== intent.sessionId || quote.checkoutIntentId !== intent.id) throw new Error("Quote does not belong to this checkout");
      if (this.quotes.has(quote.quoteId)) throw new Error("Quotes are immutable and cannot be replaced");
    }
    if (!sessionIsLive(intent.sessionId)) return false;
    this.intents.set(intent.id, intent);
    this.transitions.set(intent.id, [...transitions]);
    if (quote) this.quotes.set(quote.quoteId, quote);
    return true;
  }

  async findIntentForSession(sessionId: string, intentId: string): Promise<CheckoutIntentRecord | null> {
    const record = this.intents.get(intentId);
    return record && record.sessionId === sessionId ? record : null;
  }

  async findIntent(intentId: string): Promise<CheckoutIntentRecord | null> {
    return this.intents.get(intentId) ?? null;
  }

  async applyTransition(intentId: string, expectedVersion: number, snapshot: PaymentSnapshot, record: TransitionRecord): Promise<boolean> {
    const current = this.intents.get(intentId);
    if (!current || current.snapshot.version !== expectedVersion) return false;
    this.intents.set(intentId, { ...current, snapshot });
    this.transitions.get(intentId)?.push(record);
    return true;
  }

  async listTransitions(intentId: string): Promise<readonly TransitionRecord[]> {
    return [...(this.transitions.get(intentId) ?? [])];
  }

  // Child records are only ever stored under a live intent of the same session. If the owning
  // session was reclaimed while a request was in flight, the write is dropped, so cleanup cannot
  // be undone by a straggler and no orphan can be created.
  private ownerIsLive(intentId: string, sessionId?: string): boolean {
    const intent = this.intents.get(intentId);
    return intent !== undefined && (sessionId === undefined || intent.sessionId === sessionId);
  }

  async insertQuote(quote: Quote): Promise<void> {
    if (this.quotes.has(quote.quoteId)) throw new Error("Quotes are immutable and cannot be replaced");
    if (!this.ownerIsLive(quote.checkoutIntentId, quote.sessionId)) return;
    this.quotes.set(quote.quoteId, quote);
  }

  async findQuoteForSession(sessionId: string, quoteId: string): Promise<Quote | null> {
    const quote = this.quotes.get(quoteId);
    return quote && quote.sessionId === sessionId ? quote : null;
  }

  async findQuote(quoteId: string): Promise<Quote | null> {
    return this.quotes.get(quoteId) ?? null;
  }

  async replaceActiveConfirmation(record: ConfirmationRecord): Promise<boolean> {
    const existing = this.confirmations.get(record.quoteId);
    if (existing && existing.consumedAt !== null) return false;
    if (!this.quotes.has(record.quoteId) || !this.ownerIsLive(record.checkoutIntentId, record.sessionId)) return false;
    this.confirmations.set(record.quoteId, record);
    return true;
  }

  async findConfirmationForQuote(sessionId: string, quoteId: string): Promise<ConfirmationRecord | null> {
    const record = this.confirmations.get(quoteId);
    return record && record.sessionId === sessionId ? record : null;
  }

  async findConfirmationForSession(sessionId: string, confirmationId: string): Promise<ConfirmationRecord | null> {
    for (const record of this.confirmations.values()) {
      if (record.id === confirmationId) return record.sessionId === sessionId ? record : null;
    }
    return null;
  }

  async consumeConfirmation(confirmationId: string, consumedAt: string): Promise<boolean> {
    for (const record of this.confirmations.values()) {
      if (record.id !== confirmationId) continue;
      if (record.consumedAt !== null) return false;
      this.confirmations.set(record.quoteId, { ...record, consumedAt });
      return true;
    }
    return false;
  }

  async purgeExpiredConfirmations(now: Date): Promise<number> {
    let removed = 0;
    for (const record of this.confirmations.values()) {
      if (record.consumedAt === null && Date.parse(record.expiresAt) <= now.getTime()) {
        this.confirmations.delete(record.quoteId);
        removed += 1;
      }
    }
    return removed;
  }

  async appendObservation(observation: ProviderObservation): Promise<void> {
    if (!this.ownerIsLive(observation.checkoutIntentId)) return;
    this.observations.push(observation);
  }

  async listObservations(intentId: string): Promise<readonly ProviderObservation[]> {
    return this.observations.filter((observation) => observation.checkoutIntentId === intentId);
  }

  async hasIntent(intentId: string): Promise<boolean> {
    return this.intents.has(intentId);
  }

  // No `await` inside: the whole removal is one uninterrupted step.
  async deleteForSessions(sessionIds: readonly string[]): Promise<string[]> {
    deleteNeedsDrafts(this, sessionIds);
    if (sessionIds.length === 0) return [];
    const owners = new Set(sessionIds);
    const removedIntents: string[] = [];
    for (const intent of this.intents.values()) {
      if (!owners.has(intent.sessionId)) continue;
      this.intents.delete(intent.id);
      this.transitions.delete(intent.id);
      removedIntents.push(intent.id);
    }
    for (const quote of this.quotes.values()) {
      if (owners.has(quote.sessionId)) this.quotes.delete(quote.quoteId);
    }
    for (const confirmation of this.confirmations.values()) {
      if (owners.has(confirmation.sessionId)) this.confirmations.delete(confirmation.quoteId);
    }
    if (removedIntents.length > 0) {
      const gone = new Set(removedIntents);
      this.observations = this.observations.filter((observation) => !gone.has(observation.checkoutIntentId));
    }
    return removedIntents;
  }

  /** Test helper: how many records of each kind are stored. */
  recordCounts(): { intents: number; transitions: number; quotes: number; confirmations: number; observations: number } {
    return {
      intents: this.intents.size,
      transitions: [...this.transitions.values()].reduce((total, list) => total + list.length, 0),
      quotes: this.quotes.size,
      confirmations: this.confirmations.size,
      observations: this.observations.length,
    };
  }

  /** Test helper: number of stored confirmation challenge records. */
  confirmationCount(): number {
    return this.confirmations.size;
  }

  /** Test helper. */
  intentCount(): number {
    return this.intents.size;
  }
}
