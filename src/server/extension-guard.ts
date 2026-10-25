/**
 * Request policy for /api/extension/v1 (M2-2, docs/m2-2-plan.md §3.1 and §3.4). Separate from the website guard:
 * cookies give no authority here, and responses are never cached.
 *
 * - No allowed extension origins configured: every extension route is "not found".
 * - Every request must carry an Origin that is exactly one of the allowed extension origins; an absent Origin is refused.
 *   The earlier originless conversation-read rule (GET with `Sec-Fetch-Site: none`) is retired: the panel now reads with a
 *   POST, which always carries its Origin, and a token is always checked against the extension that paired it.
 *   An Origin is not authentication: a non-browser client holding a stolen token can still claim an allowed Origin.
 */

const MAX_BODY_BYTES = 16_384;

export type ExtensionGuard = { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly response: Response };

export function extensionJson(body: unknown, status: number, origin: string | null): Response {
  const headers: Record<string, string> = { "cache-control": "no-store", vary: "Origin" };
  if (origin !== null) headers["access-control-allow-origin"] = origin;
  return Response.json(body, { status, headers });
}

export function refuseExtension(code: string, status: number, origin: string | null = null): Response {
  return extensionJson({ ok: false, code }, status, origin);
}

export function guardExtensionRequest(request: Request, allowed: ReadonlySet<string>): ExtensionGuard {
  if (allowed.size === 0) return { ok: false, response: refuseExtension("NOT_FOUND", 404) };
  const origin = request.headers.get("origin");
  if (origin === null || !allowed.has(origin)) return { ok: false, response: refuseExtension("ORIGIN_DENIED", 403) };
  return { ok: true, origin };
}

/** CORS preflight for an allowed extension origin only. */
export function extensionPreflight(request: Request, allowed: ReadonlySet<string>, methods: readonly string[]): Response {
  if (allowed.size === 0) return refuseExtension("NOT_FOUND", 404);
  const origin = request.headers.get("origin");
  if (origin === null || !allowed.has(origin)) return refuseExtension("ORIGIN_DENIED", 403);
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": methods.join(", "),
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "60",
      "cache-control": "no-store",
      vary: "Origin",
    },
  });
}

export function bearerOf(request: Request): string | null {
  const match = request.headers.get("authorization")?.match(/^Bearer ([0-9a-f]{64})$/);
  return match?.[1] ?? null;
}

/** A JSON object with exactly `keys`, at most 16 KiB. Null otherwise. */
export async function readExtensionJson(request: Request, keys: readonly string[]): Promise<Record<string, unknown> | null> {
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "")) return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const present = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (present.length !== expected.length || present.some((key, index) => key !== expected[index])) return null;
  return record;
}
