import { z } from "zod";
import { err, ok, type Result } from "../shared/result";

export const MAX_SHOPPER_MESSAGE_CHARS = 2000;
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export const ShopperMessageSchema = z.string().trim().min(1).max(MAX_SHOPPER_MESSAGE_CHARS);

export type BodyRejection = "BODY_TOO_LARGE" | "BODY_NOT_JSON";

/** Reads a request body while enforcing a byte limit on the actual stream, not just on the declared Content-Length. */
async function readLimitedText(request: Request, maxBytes: number): Promise<Result<string, "BODY_TOO_LARGE" | "BODY_MISSING">> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return err("BODY_TOO_LARGE");
  if (!request.body) return err("BODY_MISSING");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return err("BODY_TOO_LARGE");
    }
    chunks.push(value);
  }
  return ok(Buffer.concat(chunks).toString("utf8"));
}

export async function readLimitedJson(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<Result<unknown, BodyRejection>> {
  const text = await readLimitedText(request, maxBytes);
  if (!text.ok) return err(text.error === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "BODY_NOT_JSON");
  try {
    return ok(JSON.parse(text.value));
  } catch {
    return err("BODY_NOT_JSON");
  }
}

/** Reads a URL-encoded HTML form body with the same size limit. Other content types are rejected. */
export async function readLimitedForm(request: Request, maxBytes = MAX_JSON_BODY_BYTES): Promise<Result<URLSearchParams, "BODY_TOO_LARGE" | "BODY_NOT_FORM">> {
  const contentType = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/x-www-form-urlencoded") return err("BODY_NOT_FORM");
  const text = await readLimitedText(request, maxBytes);
  if (!text.ok) return err(text.error === "BODY_TOO_LARGE" ? "BODY_TOO_LARGE" : "BODY_NOT_FORM");
  return ok(new URLSearchParams(text.value));
}
