import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_NONCE_LABEL,
  confirmationNonceDigest,
  confirmationNonceMessage,
  deriveConfirmationNonce,
  isCanonicalConfirmationNonce,
} from "@/lib/pg/confirmation-nonce";

// PGT-228, TypeScript side. Database-free: nothing here connects to PostgreSQL or executes SQL.
//
// The four vectors are fixed. They were calculated outside this project with standard-library HMAC, SHA-256 and
// base64 functions, and calculated a second time independently; both calculations agreed on every message, HMAC,
// nonce and digest before these values were written here. They are the oracle: if this module does not reproduce one
// of them, the module is wrong, and the expected value is not changed to fit. They say nothing about whether a
// database run works; the database side of PGT-228 hashes the same four nonces (tests/db/confirmation-functions.test.ts).

const keyOf = (first: number): Uint8Array => Uint8Array.from({ length: 32 }, (_, index) => first + index);
const KEY_00_1F = keyOf(0x00);
const KEY_20_3F = keyOf(0x20);

const OWNER = `own_${"2".repeat(32)}`;
const CHALLENGE_5 = `cf_${"5".repeat(32)}`;
const CHALLENGE_6 = `cf_${"6".repeat(32)}`;
// The SAQD-1 digests of vectors V1 and V3 (specification 15.2), used here only as 64 hex characters.
const DIGEST_V1 = "cbb8289475d0e6784dae938e4038a5fd54dbb423d350adf3f4fbebf7b4cde944";
const DIGEST_V3 = "1eebb6d9507c3efdb5e094cad29230150dca6c834c7d20a5f8022d20be13d693";

const MESSAGE_N1 =
  "73686f706163636573732e636f6e6669726d6174696f6e2e76310063665f3535353535353535353535353535353535353535353535353535353535353535006f776e5f32323232323232323232323232323232323232323232323232323232323232320063626238323839343735643065363738346461653933386534303338613566643534646262343233643335306164663366346662656266376234636465393434";
const MESSAGE_N3 =
  "73686f706163636573732e636f6e6669726d6174696f6e2e76310063665f3636363636363636363636363636363636363636363636363636363636363636006f776e5f32323232323232323232323232323232323232323232323232323232323232320063626238323839343735643065363738346461653933386534303338613566643534646262343233643335306164663366346662656266376234636465393434";
const MESSAGE_N4 =
  "73686f706163636573732e636f6e6669726d6174696f6e2e76310063665f3535353535353535353535353535353535353535353535353535353535353535006f776e5f32323232323232323232323232323232323232323232323232323232323232320031656562623664393530376333656664623565303934636164323932333031353064636136633833346337643230613566383032326432306265313364363933";

const VECTORS = [
  {
    name: "N1",
    key: KEY_00_1F,
    input: { challengeId: CHALLENGE_5, ownerId: OWNER, quoteDigest: DIGEST_V1 },
    message: MESSAGE_N1,
    hmac: "b3a603c80e7656243140e3eaf3dc2a84096a48b25e23ec4b92b90b90c5afe2e9",
    nonce: "s6YDyA52ViQxQOPq89wqhAlqSLJeI-xLkrkLkMWv4uk",
    digest: "2fffb9607e72006eba685e7ddac819d13bec2c94a5c1182610e2db0d80577d6f",
  },
  {
    name: "N2",
    key: KEY_20_3F,
    input: { challengeId: CHALLENGE_5, ownerId: OWNER, quoteDigest: DIGEST_V1 },
    message: MESSAGE_N1,
    hmac: "ec88ab5c88bb74e32b198c00bffdc8d2aaf95ef73d1146f4f9b0fcffc99460ce",
    nonce: "7IirXIi7dOMrGYwAv_3I0qr5Xvc9EUb0-bD8_8mUYM4",
    digest: "143c49a989609bee83eeecc39619f5134a5005d01043aa8b3b366f21f87eb3c0",
  },
  {
    name: "N3",
    key: KEY_00_1F,
    input: { challengeId: CHALLENGE_6, ownerId: OWNER, quoteDigest: DIGEST_V1 },
    message: MESSAGE_N3,
    hmac: "0a82c05ca0cccb9eb16ba9d34189b26f064a9c7b1369a1e0a00e4bf38de7038d",
    nonce: "CoLAXKDMy56xa6nTQYmybwZKnHsTaaHgoA5L843nA40",
    digest: "ec6af46bc975178a0317ffcf6c7c3aa7fb9cd138a058f21c62dac5ea104fa412",
  },
  {
    name: "N4",
    key: KEY_00_1F,
    input: { challengeId: CHALLENGE_5, ownerId: OWNER, quoteDigest: DIGEST_V3 },
    message: MESSAGE_N4,
    hmac: "805620934d8d699f9e6f66d520754b0b4e120db2e6f3a3fe5a4d20eb665ccdcb",
    nonce: "gFYgk02NaZ-eb2bVIHVLC04SDbLm86P-Wk0g62Zczcs",
    digest: "f81b260f570657ef3ca1815da045acc92c47e05ab193ce7aa321dc727e953b0f",
  },
] as const;

describe("confirmation nonce in TypeScript (PGT-228): fixed vectors, not wired in", () => {
  it("builds the 164 message bytes of each vector: label, a zero byte, challenge, a zero byte, owner, a zero byte, digest", () => {
    for (const vector of VECTORS) {
      const message = confirmationNonceMessage(vector.input);
      expect(message, vector.name).toHaveLength(164);
      expect(message.toString("hex"), vector.name).toBe(vector.message);
    }
    const message = confirmationNonceMessage(VECTORS[0].input);
    expect(message.subarray(0, 26).toString("ascii")).toBe(CONFIRMATION_NONCE_LABEL);
    expect([message[26], message[62], message[99]]).toEqual([0, 0, 0]);
    expect(message.subarray(27, 62).toString("ascii")).toBe(CHALLENGE_5);
    expect(message.subarray(63, 99).toString("ascii")).toBe(OWNER);
    expect(message.subarray(100).toString("ascii")).toBe(DIGEST_V1);
  });

  it("reproduces the four fixed nonces and their digests", () => {
    for (const vector of VECTORS) {
      const nonce = deriveConfirmationNonce(vector.key, vector.input);
      expect(nonce, vector.name).toBe(vector.nonce);
      expect(Buffer.from(nonce, "base64url").toString("hex"), vector.name).toBe(vector.hmac);
      expect(nonce, vector.name).toHaveLength(43);
      expect(isCanonicalConfirmationNonce(nonce), vector.name).toBe(true);
      expect(confirmationNonceDigest(nonce), vector.name).toBe(vector.digest);
    }
    // A different key, a different challenge and a different quote digest each give a different nonce.
    expect(new Set(VECTORS.map((vector) => vector.nonce)).size).toBe(4);
    expect(new Set(VECTORS.map((vector) => vector.digest)).size).toBe(4);
  });

  it("is deterministic, and depends on every field and on the key", () => {
    const base = deriveConfirmationNonce(KEY_00_1F, VECTORS[0].input);
    expect(deriveConfirmationNonce(KEY_00_1F, { ...VECTORS[0].input })).toBe(base);
    expect(deriveConfirmationNonce(KEY_00_1F, { ...VECTORS[0].input, ownerId: `own_${"3".repeat(32)}` })).not.toBe(base);
    expect(deriveConfirmationNonce(KEY_00_1F, { ...VECTORS[0].input, challengeId: CHALLENGE_6 })).not.toBe(base);
    expect(deriveConfirmationNonce(KEY_00_1F, { ...VECTORS[0].input, quoteDigest: DIGEST_V3 })).not.toBe(base);
    expect(deriveConfirmationNonce(KEY_20_3F, VECTORS[0].input)).not.toBe(base);
    // A longer key is a different key.
    expect(deriveConfirmationNonce(Uint8Array.from([...KEY_00_1F, 0x20]), VECTORS[0].input)).not.toBe(base);
  });

  it("refuses a field that is not in its canonical form, and a key that is too short", () => {
    const input = VECTORS[0].input;
    const refused: Array<[string, () => unknown]> = [
      ["an uppercase challenge id", () => confirmationNonceMessage({ ...input, challengeId: `cf_${"A".repeat(32)}` })],
      ["a short challenge id", () => confirmationNonceMessage({ ...input, challengeId: `cf_${"5".repeat(31)}` })],
      ["a challenge id with a zero byte", () => confirmationNonceMessage({ ...input, challengeId: `cf_${"5".repeat(31)}\0` })],
      ["an intent id in place of a challenge id", () => confirmationNonceMessage({ ...input, challengeId: `ci_${"5".repeat(32)}` })],
      ["an owner id without its prefix", () => confirmationNonceMessage({ ...input, ownerId: "2".repeat(36) })],
      ["an owner id with a trailing space", () => confirmationNonceMessage({ ...input, ownerId: `${OWNER} ` })],
      ["an uppercase quote digest", () => confirmationNonceMessage({ ...input, quoteDigest: DIGEST_V1.toUpperCase() })],
      ["a quote digest of 63 characters", () => confirmationNonceMessage({ ...input, quoteDigest: DIGEST_V1.slice(1) })],
      ["a field that is not text", () => confirmationNonceMessage({ ...input, quoteDigest: undefined as unknown as string })],
      ["a key of 31 bytes", () => deriveConfirmationNonce(KEY_00_1F.subarray(0, 31), input)],
      ["an empty key", () => deriveConfirmationNonce(new Uint8Array(0), input)],
      ["a key that is text", () => deriveConfirmationNonce("0".repeat(64) as unknown as Uint8Array, input)],
    ];
    for (const [label, attempt] of refused) expect(attempt, label).toThrow(TypeError);
  });

  it("accepts only the canonical encoding of 32 bytes as a nonce", () => {
    const nonce = VECTORS[0].nonce;
    expect(isCanonicalConfirmationNonce(nonce)).toBe(true);
    // The last character carries four bits: exactly sixteen characters can stand there.
    const canonicalLast = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"].filter((last) => isCanonicalConfirmationNonce(nonce.slice(0, 42) + last));
    expect(canonicalLast.sort()).toEqual([..."AEIMQUYcgkosw048"].sort());
    const notCanonical: unknown[] = [
      `${nonce.slice(0, 42)}l`, // the same 32 bytes, with unused bits set
      `${nonce}=`, // padded
      nonce.slice(0, 42), // 42 characters
      `${nonce}A`, // 44 characters
      nonce.replace("-", "+"), // the other base64 alphabet
      `${nonce.slice(0, 42)} `,
      "",
      null,
      undefined,
      43,
    ];
    for (const candidate of notCanonical) expect(isCanonicalConfirmationNonce(candidate), String(candidate)).toBe(false);
    expect(() => confirmationNonceDigest(`${nonce.slice(0, 42)}l`)).toThrow(TypeError);
    expect(() => confirmationNonceDigest(`${nonce}=`)).toThrow(TypeError);
  });
});
