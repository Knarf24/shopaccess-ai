import { createHash, createHmac } from "node:crypto";

/**
 * Confirmation nonce of a challenge (specification 5.3 and 19.16), in TypeScript.
 *
 * NOT WIRED IN. Nothing in the running application imports this module. It
 * exists so that the derivation is written down once, with fixed vectors
 * (tests/unit/pg-confirmation-nonce.test.ts), before any request handler uses it.
 *
 * Derivation:
 *
 *   nonce = base64url_unpadded(HMAC-SHA-256(key,
 *             ASCII("shopaccess.confirmation.v1")
 *             || 0x00 || ASCII(challenge id)
 *             || 0x00 || ASCII(owner id)
 *             || 0x00 || ASCII(quote digest)))
 *
 * The message is 164 bytes, the output 32 bytes, the nonce 43 characters. The
 * database stores only the lowercase hex SHA-256 of those 43 ASCII characters,
 * and the version of the key.
 *
 * The key is given by the caller, as bytes. This module reads no environment
 * variable, loads no key material, holds no statement text and contacts
 * nothing. What a nonce does not prove: that a person made a gesture. Whoever
 * holds the key can derive it (specification 3.4, D-57).
 */

export const CONFIRMATION_NONCE_LABEL = "shopaccess.confirmation.v1";
export const CONFIRMATION_NONCE_MIN_KEY_BYTES = 32;
export const CONFIRMATION_NONCE_LENGTH = 43;

const CHALLENGE_ID = /^cf_[0-9a-f]{32}$/;
const OWNER_ID = /^own_[0-9a-f]{32}$/;
const QUOTE_DIGEST = /^[0-9a-f]{64}$/;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;
const SEPARATOR = Buffer.from([0x00]);

export interface ConfirmationNonceInput {
  readonly challengeId: string;
  readonly ownerId: string;
  readonly quoteDigest: string;
}

function requireKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.length < CONFIRMATION_NONCE_MIN_KEY_BYTES) {
    throw new TypeError("The confirmation nonce key must be at least 32 bytes");
  }
  return Buffer.from(key);
}

/** The exact bytes that are keyed. Throws on a field that is not in its canonical form; never repairs one. */
export function confirmationNonceMessage(input: ConfirmationNonceInput): Buffer {
  if (typeof input.challengeId !== "string" || !CHALLENGE_ID.test(input.challengeId)) throw new TypeError("The challenge id is not cf_ and 32 lowercase hex characters");
  if (typeof input.ownerId !== "string" || !OWNER_ID.test(input.ownerId)) throw new TypeError("The owner id is not own_ and 32 lowercase hex characters");
  if (typeof input.quoteDigest !== "string" || !QUOTE_DIGEST.test(input.quoteDigest)) throw new TypeError("The quote digest is not 64 lowercase hex characters");
  return Buffer.concat([
    Buffer.from(CONFIRMATION_NONCE_LABEL, "ascii"),
    SEPARATOR,
    Buffer.from(input.challengeId, "ascii"),
    SEPARATOR,
    Buffer.from(input.ownerId, "ascii"),
    SEPARATOR,
    Buffer.from(input.quoteDigest, "ascii"),
  ]);
}

/** The nonce of one challenge under one key: 43 base64url characters, without padding. */
export function deriveConfirmationNonce(key: Uint8Array, input: ConfirmationNonceInput): string {
  const message = confirmationNonceMessage(input);
  const mac = createHmac("sha256", requireKey(key)).update(message).digest();
  return mac.toString("base64url");
}

/**
 * True when the text is the canonical encoding of 32 bytes: 43 characters of the base64url alphabet, with no
 * padding, that decode to 32 bytes and encode back to the same text. The alphabet and the length alone are not
 * enough: the last character carries only four bits, so only sixteen characters can stand there.
 */
export function isCanonicalConfirmationNonce(nonce: unknown): nonce is string {
  if (typeof nonce !== "string" || !BASE64URL_43.test(nonce)) return false;
  const bytes = Buffer.from(nonce, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === nonce;
}

/** What the database stores: the lowercase hex SHA-256 of the 43 ASCII characters of the nonce. */
export function confirmationNonceDigest(nonce: string): string {
  if (!isCanonicalConfirmationNonce(nonce)) throw new TypeError("The confirmation nonce is not 43 canonical base64url characters");
  const characters = Buffer.from(nonce, "ascii");
  return createHash("sha256").update(characters).digest("hex");
}
