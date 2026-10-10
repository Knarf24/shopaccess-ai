import type { IdGenerator } from "../shared/ids";

export type OperationType = "ORDER_CREATE" | "CAPTURE";

/**
 * PENDING            recorded, never dispatched
 * DISPATCHING        claimed; a provider request may be in progress
 * UNKNOWN            a request may have reached the provider; outcome not known
 * READBACK_CLEARED   provider readback found no trace; the same request may be resent
 * PENDING_PROVIDER   provider accepted the capture but has not completed it
 * SUCCEEDED / DECLINED / REJECTED   provider-confirmed outcomes
 * CONFLICT           provider evidence contradicts the authorized quote or order; never retried automatically
 */
export type OperationState =
  | "PENDING"
  | "DISPATCHING"
  | "UNKNOWN"
  | "READBACK_CLEARED"
  | "PENDING_PROVIDER"
  | "SUCCEEDED"
  | "DECLINED"
  | "REJECTED"
  | "CONFLICT";

export interface PaymentOperation {
  /** Stable logical operation ID. */
  readonly id: string;
  readonly checkoutIntentId: string;
  readonly type: OperationType;
  /** 1 for the first logical operation of this type; a new capture after a decline gets the next number. */
  readonly sequence: number;
  /** Stable idempotency ID sent to the provider on every attempt of this logical operation. */
  readonly providerRequestId: string;
  readonly payloadDigest: string;
  readonly state: OperationState;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly attemptCount: number;
  readonly providerReference: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EnsureOperationInput {
  readonly checkoutIntentId: string;
  readonly type: OperationType;
  readonly sequence: number;
  readonly payloadDigest: string;
  readonly now: Date;
}

export type EnsureOperationResult =
  | { readonly ok: true; readonly operation: PaymentOperation; readonly created: boolean }
  | { readonly ok: false; readonly error: "PAYLOAD_MISMATCH" };

export type OperationOutcome =
  | { readonly state: "SUCCEEDED" | "PENDING_PROVIDER"; readonly providerReference: string }
  | { readonly state: "DECLINED" | "REJECTED" | "UNKNOWN" | "READBACK_CLEARED" | "CONFLICT" };

/**
 * Durable operation ledger. Every mutation is a guarded compare-and-set, so the
 * same interface maps onto single SQL statements in PostgreSQL.
 */
export interface OperationLedger {
  /** Idempotent: one row per (intent, type, sequence). */
  ensureOperation(input: EnsureOperationInput): Promise<EnsureOperationResult>;
  find(operationId: string): Promise<PaymentOperation | null>;
  listForIntent(checkoutIntentId: string, type: OperationType): Promise<readonly PaymentOperation[]>;
  /** Claim for sending. Only PENDING or READBACK_CLEARED operations with no live lease qualify. */
  claimForDispatch(operationId: string, workerId: string, now: Date, leaseMs: number): Promise<PaymentOperation | null>;
  /**
   * Claim an operation whose outcome needs checking: UNKNOWN, PENDING_PROVIDER,
   * READBACK_CLEARED, or DISPATCHING with an expired lease (a crashed worker).
   * A crashed DISPATCHING operation becomes UNKNOWN; it is never assumed unsent.
   */
  claimForRecovery(operationId: string, workerId: string, now: Date, leaseMs: number): Promise<PaymentOperation | null>;
  /** Record an outcome and release the lease. Only the current lease owner may do this. */
  recordOutcome(operationId: string, workerId: string, outcome: OperationOutcome, now: Date): Promise<PaymentOperation | null>;
  /** Operations a recovery worker should look at. */
  listRecoverable(now: Date): Promise<readonly PaymentOperation[]>;
  /**
   * LOCAL MOCK ONLY. Removes every operation whose checkout intent no longer
   * exists and returns the removed operations. Idempotent. A real ledger must
   * never drop operations like this, least of all unknown or pending ones.
   */
  deleteOrphans(intentExists: (checkoutIntentId: string) => Promise<boolean>): Promise<PaymentOperation[]>;
}

const RECOVERABLE: readonly OperationState[] = ["UNKNOWN", "PENDING_PROVIDER", "READBACK_CLEARED"];

/** Single-process ledger for tests and the mock milestone. */
export class InMemoryOperationLedger implements OperationLedger {
  private readonly operations = new Map<string, PaymentOperation>();

  constructor(private readonly ids: IdGenerator) {}

  private leaseIsFree(operation: PaymentOperation, now: Date): boolean {
    return operation.leaseOwner === null || operation.leaseExpiresAt === null || Date.parse(operation.leaseExpiresAt) <= now.getTime();
  }

  private save(operation: PaymentOperation, changes: Partial<PaymentOperation>, now: Date): PaymentOperation {
    const next = { ...operation, ...changes, version: operation.version + 1, updatedAt: now.toISOString() };
    this.operations.set(next.id, next);
    return next;
  }

  async deleteOrphans(intentExists: (checkoutIntentId: string) => Promise<boolean>): Promise<PaymentOperation[]> {
    const removed: PaymentOperation[] = [];
    for (const operation of [...this.operations.values()]) {
      if (await intentExists(operation.checkoutIntentId)) continue;
      // Delete by identity: the entry may have changed while the check was awaited.
      if (this.operations.delete(operation.id)) removed.push(operation);
    }
    return removed;
  }

  /** Provider request IDs of every operation currently in the ledger. */
  providerRequestIds(): Set<string> {
    return new Set([...this.operations.values()].map((operation) => operation.providerRequestId));
  }

  /** Test helper. */
  operationCount(): number {
    return this.operations.size;
  }

  async ensureOperation(input: EnsureOperationInput): Promise<EnsureOperationResult> {
    for (const existing of this.operations.values()) {
      if (existing.checkoutIntentId === input.checkoutIntentId && existing.type === input.type && existing.sequence === input.sequence) {
        if (existing.payloadDigest !== input.payloadDigest) return { ok: false, error: "PAYLOAD_MISMATCH" };
        return { ok: true, operation: existing, created: false };
      }
    }
    const operation: PaymentOperation = {
      id: this.ids("operation"),
      checkoutIntentId: input.checkoutIntentId,
      type: input.type,
      sequence: input.sequence,
      providerRequestId: this.ids("providerRequest"),
      payloadDigest: input.payloadDigest,
      state: "PENDING",
      leaseOwner: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      providerReference: null,
      version: 1,
      createdAt: input.now.toISOString(),
      updatedAt: input.now.toISOString(),
    };
    this.operations.set(operation.id, operation);
    return { ok: true, operation, created: true };
  }

  async find(operationId: string): Promise<PaymentOperation | null> {
    return this.operations.get(operationId) ?? null;
  }

  async listForIntent(checkoutIntentId: string, type: OperationType): Promise<readonly PaymentOperation[]> {
    return [...this.operations.values()]
      .filter((operation) => operation.checkoutIntentId === checkoutIntentId && operation.type === type)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async claimForDispatch(operationId: string, workerId: string, now: Date, leaseMs: number): Promise<PaymentOperation | null> {
    const operation = this.operations.get(operationId);
    if (!operation || !this.leaseIsFree(operation, now)) return null;
    if (operation.state !== "PENDING" && operation.state !== "READBACK_CLEARED") return null;
    return this.save(
      operation,
      {
        state: "DISPATCHING",
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        attemptCount: operation.attemptCount + 1,
      },
      now,
    );
  }

  async claimForRecovery(operationId: string, workerId: string, now: Date, leaseMs: number): Promise<PaymentOperation | null> {
    const operation = this.operations.get(operationId);
    if (!operation || !this.leaseIsFree(operation, now)) return null;
    const crashedMidDispatch = operation.state === "DISPATCHING" && operation.leaseOwner !== null;
    if (!crashedMidDispatch && !RECOVERABLE.includes(operation.state)) return null;
    return this.save(
      operation,
      {
        state: operation.state === "PENDING_PROVIDER" ? "PENDING_PROVIDER" : "UNKNOWN",
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
      },
      now,
    );
  }

  async recordOutcome(operationId: string, workerId: string, outcome: OperationOutcome, now: Date): Promise<PaymentOperation | null> {
    const operation = this.operations.get(operationId);
    if (!operation || operation.leaseOwner !== workerId) return null;
    if (operation.state !== "DISPATCHING" && operation.state !== "UNKNOWN" && operation.state !== "PENDING_PROVIDER") return null;
    return this.save(
      operation,
      {
        state: outcome.state,
        providerReference: "providerReference" in outcome ? outcome.providerReference : operation.providerReference,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      now,
    );
  }

  async listRecoverable(now: Date): Promise<readonly PaymentOperation[]> {
    return [...this.operations.values()].filter(
      (operation) => this.leaseIsFree(operation, now) && (RECOVERABLE.includes(operation.state) || operation.state === "DISPATCHING"),
    );
  }
}
