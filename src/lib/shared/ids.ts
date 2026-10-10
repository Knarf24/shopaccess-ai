import { randomHex } from "./crypto";

const PREFIXES = {
  session: "ses",
  cart: "ct",
  checkoutIntent: "ci",
  quote: "qt",
  confirmation: "cf",
  operation: "op",
  providerRequest: "rq",
  event: "ev",
  observation: "ob",
} as const;

export type IdKind = keyof typeof PREFIXES;

export const ID_PATTERNS: Record<IdKind, RegExp> = Object.fromEntries(
  Object.entries(PREFIXES).map(([kind, prefix]) => [kind, new RegExp(`^${prefix}_[0-9a-f]{32}$`)]),
) as Record<IdKind, RegExp>;

export type IdGenerator = (kind: IdKind) => string;

export const randomIdGenerator: IdGenerator = (kind) => `${PREFIXES[kind]}_${randomHex(16)}`;

/** Deterministic generator for mocks and tests. Never use for real identifiers. */
export function createSequentialIdGenerator(): IdGenerator {
  let counter = 0;
  return (kind) => {
    counter += 1;
    return `${PREFIXES[kind]}_${counter.toString(16).padStart(32, "0")}`;
  };
}
