import { describe, expect, it } from "vitest";
import { encodeSaqd1, saqd1Digest, SAQD1_FIELD_COUNT, type Saqd1Fields } from "@/lib/pg/saqd";

// PGT-73a, TypeScript side. Database-free: nothing here connects to PostgreSQL or executes SQL.
//
// The three expected digests are the ones stated in specification 15.2. They are fixed: if this encoder does not
// reproduce one of them, the encoder (or the expansion of the inputs) is wrong, and the expected value is not changed
// to fit. The database side of PGT-73a computes the same three with shopaccess_api.quote_digest_saqd1 from the same
// inputs (tests/db/checkout-functions.test.ts).

const EXPECTED = {
  V1: "cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944",
  V2: "1763b05d5e4118f0d7dfac99e0f57c61e80eddbe02f52166e1c79fbddfe4b39c",
  V3: "1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693",
} as const;

// Stated in specification 15.2 for all three vectors.
const COMMON = {
  ownerId: `own_${"2".repeat(32)}`,
  intentId: `ci_${"3".repeat(32)}`,
  purchaseGroupId: `pur_${"4".repeat(32)}`,
  merchantId: "dmm_shopaccessdemo",
  productId: "dmp_codebook15",
  variantId: "dmv_codebook15a",
  catalogRevision: 1,
  discountCents: 0,
  taxCents: 0,
  shippingCents: 0,
  currency: "USD",
  assumptionsCode: "SANDBOX_ZERO_TAX_SHIPPING_DISCOUNT_V1",
  createdAtMicros: BigInt("1791460800000000"),
  expiresAtMicros: BigInt("1791461700000000"),
} as const;

// "amounts 79900" is read as unit amount, subtotal and total (a reconstruction; see the expansion in 15.2).
const V1: Saqd1Fields = { ...COMMON, quoteId: `qt_${"1".repeat(32)}`, quantity: 1, unitAmountCents: 79900, subtotalCents: 79900, totalCents: 79900 };
// The unit amount of V2 is not stated; 79900 follows from quantity 2 and subtotal 159800 (a reconstruction).
const V2: Saqd1Fields = { ...COMMON, quoteId: `qt_${"a".repeat(32)}`, quantity: 2, unitAmountCents: 79900, subtotalCents: 159800, totalCents: 159800 };
// "as V1 with amounts 79901", read as unit amount, subtotal and total (a reconstruction).
const V3: Saqd1Fields = { ...V1, unitAmountCents: 79901, subtotalCents: 79901, totalCents: 79901 };

describe("SAQD-1 in TypeScript (PGT-73a): verification only, never authoritative", () => {
  it("reproduces the three digests of specification 15.2", () => {
    expect(saqd1Digest(V1)).toBe(EXPECTED.V1);
    expect(saqd1Digest(V2)).toBe(EXPECTED.V2);
    expect(saqd1Digest(V3)).toBe(EXPECTED.V3);
  });

  it("encodes the prefix, nineteen fields and the stated lengths: 411 bytes for each vector", () => {
    for (const fields of [V1, V2, V3]) expect(encodeSaqd1(fields)).toHaveLength(411);
    const bytes = encodeSaqd1(V1);
    // "SAQD", version 01, field count 0013.
    expect(bytes.subarray(0, 7).toString("hex")).toBe("53415144010013");
    expect(SAQD1_FIELD_COUNT).toBe(19);
    // The first field: type 01, length 35, the quote ID.
    expect(bytes.subarray(7, 12).toString("hex")).toBe("0100000023");
    expect(bytes.subarray(12, 47).toString("ascii")).toBe(V1.quoteId);
    // The last field: type 02, length 8, the expiry in microseconds, big-endian.
    expect(bytes.subarray(411 - 13, 411 - 8).toString("hex")).toBe("0200000008");
    expect(bytes.readBigInt64BE(411 - 8)).toBe(V1.expiresAtMicros);
    // The two times are the stated instants: 2026-10-08T12:00:00Z and fifteen minutes later.
    expect(Number(V1.createdAtMicros / BigInt(1000))).toBe(Date.parse("2026-10-08T12:00:00.000Z"));
    expect(V1.expiresAtMicros - V1.createdAtMicros).toBe(BigInt(15 * 60 * 1_000_000));
  });

  it("changes with every field: no field is left out of the digest", () => {
    const base = saqd1Digest(V1);
    const changed: Saqd1Fields[] = [
      { ...V1, quoteId: `qt_${"9".repeat(32)}` },
      { ...V1, ownerId: `own_${"9".repeat(32)}` },
      { ...V1, intentId: `ci_${"9".repeat(32)}` },
      { ...V1, purchaseGroupId: `pur_${"9".repeat(32)}` },
      { ...V1, merchantId: "dmm_anothermerchant" },
      { ...V1, productId: "dmp_anotherproduct" },
      { ...V1, variantId: "dmv_anothervariant" },
      { ...V1, catalogRevision: 2 },
      { ...V1, quantity: 2 },
      { ...V1, unitAmountCents: 79899 },
      { ...V1, subtotalCents: 79899 },
      { ...V1, discountCents: 1 },
      { ...V1, taxCents: 1 },
      { ...V1, shippingCents: 1 },
      { ...V1, totalCents: 79899 },
      { ...V1, currency: "EUR" },
      { ...V1, assumptionsCode: "ANOTHER_ASSUMPTIONS_CODE" },
      { ...V1, createdAtMicros: V1.createdAtMicros + BigInt(1) },
      { ...V1, expiresAtMicros: V1.expiresAtMicros + BigInt(1) },
    ];
    expect(changed).toHaveLength(SAQD1_FIELD_COUNT);
    const digests = changed.map((fields) => saqd1Digest(fields));
    expect(digests.every((digest) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
    expect(new Set([base, ...digests]).size).toBe(SAQD1_FIELD_COUNT + 1);
  });

  it("refuses a field it cannot encode exactly, instead of guessing", () => {
    expect(() => saqd1Digest({ ...V1, quoteId: "qt_café" })).toThrow(TypeError);
    expect(() => saqd1Digest({ ...V1, quantity: 1.5 })).toThrow(TypeError);
    expect(() => saqd1Digest({ ...V1, unitAmountCents: Number.MAX_SAFE_INTEGER + 2 })).toThrow(TypeError);
    expect(() => saqd1Digest({ ...V1, createdAtMicros: BigInt(2) ** BigInt(63) })).toThrow(TypeError);
    expect(() => saqd1Digest({ ...V1, currency: undefined as unknown as string })).toThrow(TypeError);
  });
});
