import { timingSafeEqual } from "node:crypto";
import { toPublicError } from "@/lib/security/errors";
import { readLimitedForm } from "@/lib/security/limits";
import { readSessionCookie, serializeClearedSessionCookie } from "@/lib/session/cookie";
import { checkRequestProvenance } from "@/lib/session/request-guard";
import { parseSessionKey } from "@/lib/session/token";
import { constantTimeEqual, hmacSha256Hex, randomTokenBase64Url } from "@/lib/shared/crypto";
import { admissionCopy, type AdmissionCopy } from "@/lib/i18n/demo-copy";
import { allowlistedJourneyLanguage, type JourneyLanguage } from "@/lib/i18n/language";
import type { Runtime } from "./runtime";

/**
 * Process-local demonstration admission. This is not the shared rate-limit store:
 * the attempt window lives on one runtime and is lost when that process stops.
 */
export const ADMISSION_COOKIE_NAME = "__Host-shopaccess_demo_admission";
export const CSRF_COOKIE_NAME = "__Host-shopaccess_demo_csrf";
export const ADMISSION_LABEL = "shopaccess.demo-admission.v1";
export const CSRF_LABEL = "shopaccess.demo-csrf.v1";
export const CSRF_LIFETIME_MS = 600_000;
export const ADMISSION_LIFETIME_MS = 28_800_000;
export const LOGIN_WINDOW_MS = 900_000;
export const LOGIN_ATTEMPT_LIMIT = 5;
export const PASSPHRASE_MIN_BYTES = 20;
export const PASSPHRASE_MAX_BYTES = 128;

const COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";
const COOKIE_VALUE = /^v1\.[1-9][0-9]{0,14}\.[A-Za-z0-9_-]{43}\.[0-9a-f]{64}$/;

export interface LoginAttempts {
  windowStartedAt: number | null;
  count: number;
}

export type DemoAdmission =
  | { readonly mode: "off" }
  | { readonly mode: "closed" }
  | { readonly mode: "on"; readonly key: Buffer; readonly passphrase: string; readonly attempts: LoginAttempts };

export type AdmissionScreenModel =
  | { readonly kind: "closed"; readonly language: JourneyLanguage; readonly copy: AdmissionCopy }
  | { readonly kind: "bootstrap"; readonly language: JourneyLanguage; readonly copy: AdmissionCopy }
  | { readonly kind: "login"; readonly language: JourneyLanguage; readonly copy: AdmissionCopy; readonly csrf: string; readonly notice: "rejected" | "retry" | null }
  | { readonly kind: "logout"; readonly language: JourneyLanguage; readonly copy: AdmissionCopy; readonly csrf: string };

/**
 * Exact `development` with the variable omitted keeps the current local flow.
 * Exact `test` with the variable omitted stays off so the database-free unit
 * runner keeps building the mock application. Production, an unset NODE_ENV,
 * and every invalid setting fail closed. A valid `on` still requires its own
 * key and passphrase; the key must not be the session key.
 */
export function resolveDemoAdmission(env: Readonly<Record<string, string | undefined>>, sessionKey: Buffer): DemoAdmission {
  const setting = env.SHOPACCESS_DEMO_ADMISSION;
  if (setting === undefined && (env.NODE_ENV === "development" || env.NODE_ENV === "test")) return { mode: "off" };
  if (setting === "on") {
    const key = parseAdmissionKey(env.SHOPACCESS_DEMO_ADMISSION_KEY, sessionKey);
    const passphrase = parsePassphrase(env.SHOPACCESS_DEMO_PASSPHRASE);
    if (key && passphrase) return { mode: "on", key, passphrase, attempts: { windowStartedAt: null, count: 0 } };
  }
  return { mode: "closed" };
}

function parseAdmissionKey(value: string | undefined, sessionKey: Buffer): Buffer | null {
  const parsed = parseSessionKey(value);
  if (!parsed.ok) return null;
  const key = parsed.value;
  if (key.length === sessionKey.length && timingSafeEqual(key, sessionKey)) return null;
  return key;
}

function parsePassphrase(value: string | undefined): string | null {
  if (value === undefined) return null;
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < PASSPHRASE_MIN_BYTES || bytes.length > PASSPHRASE_MAX_BYTES) return null;
  for (const byte of bytes) {
    if (byte <= 0x1f || byte === 0x7f) return null;
  }
  return value;
}

/** Counts one verification. A full window refuses the attempt even when the passphrase matches. */
export function countLoginAttempt(attempts: LoginAttempts, nowMs: number): boolean {
  if (attempts.windowStartedAt === null || nowMs >= attempts.windowStartedAt + LOGIN_WINDOW_MS) {
    attempts.windowStartedAt = nowMs;
    attempts.count = 0;
  }
  attempts.count += 1;
  return attempts.count <= LOGIN_ATTEMPT_LIMIT;
}

export function readPurposeCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const values: string[] = [];
  for (const part of cookieHeader.split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    if (trimmed.slice(0, separator) === name) values.push(trimmed.slice(separator + 1));
  }
  return values.length === 1 ? values[0] : null;
}

export function issuePurposeCookie(key: Buffer, nowMs: number, lifetimeMs: number, label: string): { value: string; maxAgeSeconds: number } {
  const expiry = nowMs + lifetimeMs;
  const nonce = randomTokenBase64Url(32);
  const payload = `v1.${expiry}.${nonce}`;
  const mac = hmacSha256Hex(key, label, payload);
  return { value: `${payload}.${mac}`, maxAgeSeconds: Math.floor(lifetimeMs / 1000) };
}

/** Accepts only this purpose's label. A cookie signed for the other purpose fails here. */
export function verifyPurposeCookie(value: string, key: Buffer, nowMs: number, lifetimeMs: number, label: string): boolean {
  if (!COOKIE_VALUE.test(value)) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [, expiryText, nonce, mac] = parts;
  const expected = hmacSha256Hex(key, label, `v1.${expiryText}.${nonce}`);
  if (!constantTimeEqual(mac, expected)) return false;
  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry)) return false;
  return nowMs < expiry && expiry <= nowMs + lifetimeMs;
}

export function serializePurposeCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; ${COOKIE_ATTRIBUTES}; Max-Age=${maxAgeSeconds}`;
}

export function clearPurposeCookie(name: string): string {
  return `${name}=; ${COOKIE_ATTRIBUTES}; Max-Age=0`;
}

/** Where a protected request goes when it is not admitted. Null means the request may continue. */
export function protectedAdmissionLocation(
  admission: DemoAdmission,
  cookieHeader: string | null | undefined,
  nowMs: number,
  lang: string | null | undefined,
): string | null {
  if (admission.mode === "off") return null;
  const location = `/demo/admission?lang=${allowlistedJourneyLanguage(lang)}`;
  if (admission.mode === "closed") return location;
  const value = readPurposeCookie(cookieHeader, ADMISSION_COOKIE_NAME);
  if (!value || !verifyPurposeCookie(value, admission.key, nowMs, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)) return location;
  return null;
}

/**
 * When the presented admission ends (admission on and the cookie valid), or null when admission is off or invalid.
 * Bounds extension grants (M2-2).
 */
export function admissionExpiryMs(admission: DemoAdmission, cookieHeader: string | null | undefined, nowMs: number): number | null {
  if (admission.mode !== "on") return null;
  const value = readPurposeCookie(cookieHeader, ADMISSION_COOKIE_NAME);
  if (!value || !verifyPurposeCookie(value, admission.key, nowMs, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)) return null;
  const expiry = Number(value.split(".")[1]);
  return Number.isSafeInteger(expiry) ? expiry : null;
}

/** What the admission page may render. The page itself does not set a cookie. */
export function admissionScreen(
  admission: DemoAdmission,
  cookieHeader: string | null | undefined,
  nowMs: number,
  lang: string | null | undefined,
  notice: string | null | undefined,
): AdmissionScreenModel | "not-found" {
  if (admission.mode === "off") return "not-found";
  const language = allowlistedJourneyLanguage(lang);
  const copy = admissionCopy(language);
  if (admission.mode === "closed") return { kind: "closed", language, copy };
  const csrf = readPurposeCookie(cookieHeader, CSRF_COOKIE_NAME);
  const csrfOk = csrf !== null && verifyPurposeCookie(csrf, admission.key, nowMs, CSRF_LIFETIME_MS, CSRF_LABEL);
  if (!csrfOk || csrf === null) return { kind: "bootstrap", language, copy };
  if (protectedAdmissionLocation(admission, cookieHeader, nowMs, lang) === null) return { kind: "logout", language, copy, csrf };
  const shown = notice === "rejected" || notice === "retry" ? notice : null;
  return { kind: "login", language, copy, csrf, notice: shown };
}

function seeOther(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

function notFound(runtime: Runtime): Response {
  const error = toPublicError("NOT_FOUND", runtime.ids("event"));
  return Response.json(error.body, { status: error.status, headers: { "cache-control": "no-store" } });
}

/** POST /demo/admission/submit. Issues the CSRF cookie, then counts a verification only after that cookie matches. */
export async function handleDemoAdmissionSubmit(request: Request, runtime: Runtime): Promise<Response> {
  const admission = runtime.admission;
  if (admission.mode === "off") return notFound(runtime);
  if (admission.mode === "closed") return seeOther("/demo/admission?lang=en");

  const form = await readLimitedForm(request);
  if (!form.ok) return seeOther("/demo/admission?lang=en");
  if (!checkRequestProvenance(request.headers, runtime.trustedOrigins).ok) return seeOther("/demo/admission?lang=en");

  const language = allowlistedJourneyLanguage(form.value.get("lang"));
  const back = `/demo/admission?lang=${language}`;
  const now = runtime.clock().getTime();
  const presented = readPurposeCookie(request.headers.get("cookie"), CSRF_COOKIE_NAME);
  const csrfOk = presented !== null && verifyPurposeCookie(presented, admission.key, now, CSRF_LIFETIME_MS, CSRF_LABEL);
  if (!csrfOk || presented !== form.value.get("demoCsrf")) {
    const issued = issuePurposeCookie(admission.key, now, CSRF_LIFETIME_MS, CSRF_LABEL);
    return seeOther(back, [serializePurposeCookie(CSRF_COOKIE_NAME, issued.value, issued.maxAgeSeconds)]);
  }

  const passphrase = form.value.get("passphrase");
  if (passphrase === null) return seeOther(back);

  // Durable before the passphrase is compared (snapshot mode); in memory as before otherwise.
  const allowed = (await runtime.durable.spendAdmissionAttempt(now, { limit: LOGIN_ATTEMPT_LIMIT, windowMs: LOGIN_WINDOW_MS })).allowed;
  const matches = constantTimeEqual(passphrase, admission.passphrase);
  if (!allowed) return seeOther(`${back}&notice=retry`);
  if (!matches) return seeOther(`${back}&notice=rejected`);

  const issued = issuePurposeCookie(admission.key, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL);
  return seeOther(`/?lang=${language}`, [serializePurposeCookie(ADMISSION_COOKIE_NAME, issued.value, issued.maxAgeSeconds)]);
}

/** POST /demo/admission/logout. Revokes the shopper session only after admission and the matching CSRF token. */
export async function handleDemoAdmissionLogout(request: Request, runtime: Runtime): Promise<Response> {
  const admission = runtime.admission;
  if (admission.mode === "off") return notFound(runtime);
  if (admission.mode === "closed") return seeOther("/demo/admission?lang=en");

  const form = await readLimitedForm(request);
  if (!form.ok) return seeOther("/demo/admission?lang=en");
  if (!checkRequestProvenance(request.headers, runtime.trustedOrigins).ok) return seeOther("/demo/admission?lang=en");

  const language = allowlistedJourneyLanguage(form.value.get("lang"));
  const back = `/demo/admission?lang=${language}`;
  const now = runtime.clock().getTime();
  const csrf = readPurposeCookie(request.headers.get("cookie"), CSRF_COOKIE_NAME);
  if (csrf === null || !verifyPurposeCookie(csrf, admission.key, now, CSRF_LIFETIME_MS, CSRF_LABEL) || csrf !== form.value.get("demoCsrf")) {
    return seeOther(back);
  }
  const admissionCookie = readPurposeCookie(request.headers.get("cookie"), ADMISSION_COOKIE_NAME);
  if (admissionCookie === null || !verifyPurposeCookie(admissionCookie, admission.key, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL)) {
    return seeOther(back);
  }

  const session = await runtime.sessions.resolve(readSessionCookie(request.headers.get("cookie")));
  if (session.ok) await runtime.sessions.revoke(session.value.id);

  return seeOther(back, [clearPurposeCookie(CSRF_COOKIE_NAME), clearPurposeCookie(ADMISSION_COOKIE_NAME), serializeClearedSessionCookie()]);
}
