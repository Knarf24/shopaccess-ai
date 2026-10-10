import { z } from "zod";
import { SESSION_TOKEN_PATTERN } from "../session/token";

export const REDACTED = "[REDACTED]";
const MAX_DETAIL_STRING_LENGTH = 256;
const MAX_DETAIL_KEYS = 24;

/** Keys whose values are never written to the audit log, whatever they contain. */
const SENSITIVE_KEY = /token|secret|password|passwd|authorization|cookie|nonce|csrf|credential|api[-_]?key|client[-_]?id|card|cvv|email|phone|address|message|prompt/i;
/** Values that look like bearer material even under an innocent key. */
const SENSITIVE_VALUE = /^(?:bearer\s|basic\s)|^[A-Za-z0-9_-]{40,}$|^[0-9a-f]{48,}$/i;

export const AuditEventInputSchema = z.strictObject({
  eventId: z.string().min(1).max(64),
  eventType: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  occurredAt: z.iso.datetime(),
  actor: z.string().regex(/^[a-z_]{2,32}$/),
  /** Internal session row ID. Never the session token or its digest. */
  sessionId: z.string().regex(/^ses_[0-9a-f]{32}$/).nullable(),
  checkoutIntentId: z.string().max(64).nullable(),
  operationId: z.string().max(64).nullable(),
  detail: z.record(z.string(), z.unknown()),
});

export type AuditDetailValue = string | number | boolean | null;

export interface AuditEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly actor: string;
  readonly sessionId: string | null;
  readonly checkoutIntentId: string | null;
  readonly operationId: string | null;
  readonly detail: Readonly<Record<string, AuditDetailValue>>;
}

function sanitizeValue(key: string, value: unknown): AuditDetailValue {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    if (SESSION_TOKEN_PATTERN.test(value) || SENSITIVE_VALUE.test(value)) return REDACTED;
    return value.length > MAX_DETAIL_STRING_LENGTH ? `${value.slice(0, MAX_DETAIL_STRING_LENGTH)}…` : value;
  }
  // Nested structures are not written: they are the easiest place for raw payloads to hide.
  return REDACTED;
}

/**
 * Produces the only shape that may be written to the audit log. Detail is
 * flattened to scalar values; sensitive keys and token-like values are redacted.
 */
export function sanitizeAuditEvent(input: unknown): AuditEvent {
  const parsed = AuditEventInputSchema.parse(input);
  const detail: Record<string, AuditDetailValue> = {};
  for (const key of Object.keys(parsed.detail).sort().slice(0, MAX_DETAIL_KEYS)) {
    detail[key.slice(0, 64)] = sanitizeValue(key, parsed.detail[key]);
  }
  return Object.freeze({ ...parsed, detail: Object.freeze(detail) });
}

/** Append-only by construction: there is no update or delete operation. */
export interface AuditLog {
  append(event: unknown): Promise<AuditEvent>;
}

/**
 * In-memory log for tests and the local mock. It offers append only, but it
 * keeps just the most recent `maxEvents` entries so a long-running mock does
 * not grow without limit. A real audit store must be durable and must apply a
 * reviewed retention policy instead of dropping entries like this.
 */
export class InMemoryAuditLog implements AuditLog {
  private events: AuditEvent[] = [];
  private readonly eventIds = new Set<string>();

  constructor(private readonly maxEvents = 5000) {}

  async append(event: unknown): Promise<AuditEvent> {
    const sanitized = sanitizeAuditEvent(event);
    if (this.eventIds.has(sanitized.eventId)) throw new Error("Duplicate audit event id");
    this.events.push(sanitized);
    this.eventIds.add(sanitized.eventId);
    while (this.events.length > this.maxEvents) this.eventIds.delete(this.events.shift()!.eventId);
    return sanitized;
  }

  list(): readonly AuditEvent[] {
    return [...this.events];
  }
}
