import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function randomTokenBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Keyed digest with a domain-separation label so one key can serve several purposes. */
export function hmacSha256Hex(key: Buffer, label: string, data: string): string {
  return createHmac("sha256", key).update(label, "utf8").update("\0").update(data, "utf8").digest("hex");
}

/** Constant-time string comparison that does not leak length differences. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a, "utf8").digest();
  const right = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(left, right);
}
