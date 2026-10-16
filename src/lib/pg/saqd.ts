import { createHash } from "node:crypto";

/**
 * SAQD-1 quote digest (specification 5.1), in TypeScript.
 *
 * VERIFICATION ONLY. The database computes the digest of every quote it stores
 * (migration 0008, `shopaccess_api.quote_digest_saqd1`), and that digest is the
 * authoritative one. This module exists so that the three vectors of
 * specification 15.2 can be checked on both sides (PGT-73a). Nothing in the
 * running application imports it, and it never decides anything.
 *
 * Encoding: ASCII "SAQD"; version byte 0x01; a 2-byte big-endian field count
 * (19); then 19 fields, each one type byte, a 4-byte big-endian length and the
 * bytes of the field. Type 0x01 is ASCII text. Type 0x02 is an 8-byte
 * big-endian two's-complement integer. The digest is SHA-256 over those bytes,
 * in lowercase hex.
 *
 * This module holds no statement text and reads no environment variable.
 */

/** The 19 fields of SAQD-1, in the order they are encoded. */
export interface Saqd1Fields {
  readonly quoteId: string;
  readonly ownerId: string;
  readonly intentId: string;
  readonly purchaseGroupId: string;
  readonly merchantId: string;
  readonly productId: string;
  readonly variantId: string;
  /** The variant's catalog revision (A-7). */
  readonly catalogRevision: number;
  readonly quantity: number;
  readonly unitAmountCents: number;
  readonly subtotalCents: number;
  readonly discountCents: number;
  readonly taxCents: number;
  readonly shippingCents: number;
  readonly totalCents: number;
  readonly currency: string;
  readonly assumptionsCode: string;
  /** Microseconds since the Unix epoch, UTC. A bigint: a JavaScript Date cannot hold microseconds. */
  readonly createdAtMicros: bigint;
  /** Microseconds since the Unix epoch, UTC. */
  readonly expiresAtMicros: bigint;
}

export const SAQD1_FIELD_COUNT = 19;

const TEXT_FIELD = 0x01;
const INTEGER_FIELD = 0x02;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

function fieldHeader(type: number, length: number): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(length, 1);
  return header;
}

function textField(name: string, value: string): Buffer {
  if (typeof value !== "string" || !PRINTABLE_ASCII.test(value)) throw new TypeError(`SAQD-1 field ${name} is not printable ASCII text`);
  const bytes = Buffer.from(value, "ascii");
  return Buffer.concat([fieldHeader(TEXT_FIELD, bytes.length), bytes]);
}

function integerField(name: string, value: number | bigint): Buffer {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new TypeError(`SAQD-1 field ${name} is not a safe integer`);
  if (typeof value !== "number" && typeof value !== "bigint") throw new TypeError(`SAQD-1 field ${name} is not an integer`);
  const wide = BigInt(value);
  if (wide < INT64_MIN || wide > INT64_MAX) throw new TypeError(`SAQD-1 field ${name} does not fit 64 bits`);
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(wide, 0);
  return Buffer.concat([fieldHeader(INTEGER_FIELD, bytes.length), bytes]);
}

/** The exact bytes SAQD-1 hashes. Throws on a field that cannot be encoded; never guesses. */
export function encodeSaqd1(fields: Saqd1Fields): Buffer {
  const encoded: Buffer[] = [
    textField("quoteId", fields.quoteId),
    textField("ownerId", fields.ownerId),
    textField("intentId", fields.intentId),
    textField("purchaseGroupId", fields.purchaseGroupId),
    textField("merchantId", fields.merchantId),
    textField("productId", fields.productId),
    textField("variantId", fields.variantId),
    integerField("catalogRevision", fields.catalogRevision),
    integerField("quantity", fields.quantity),
    integerField("unitAmountCents", fields.unitAmountCents),
    integerField("subtotalCents", fields.subtotalCents),
    integerField("discountCents", fields.discountCents),
    integerField("taxCents", fields.taxCents),
    integerField("shippingCents", fields.shippingCents),
    integerField("totalCents", fields.totalCents),
    textField("currency", fields.currency),
    textField("assumptionsCode", fields.assumptionsCode),
    integerField("createdAtMicros", fields.createdAtMicros),
    integerField("expiresAtMicros", fields.expiresAtMicros),
  ];
  if (encoded.length !== SAQD1_FIELD_COUNT) throw new Error("SAQD-1 encodes exactly 19 fields");
  const prefix = Buffer.alloc(7);
  prefix.write("SAQD", 0, "ascii");
  prefix.writeUInt8(0x01, 4);
  prefix.writeUInt16BE(SAQD1_FIELD_COUNT, 5);
  return Buffer.concat([prefix, ...encoded]);
}

/** SHA-256 over the SAQD-1 bytes, in lowercase hex. */
export function saqd1Digest(fields: Saqd1Fields): string {
  const bytes = encodeSaqd1(fields);
  return createHash("sha256").update(bytes).digest("hex");
}
