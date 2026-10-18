import type { JourneyLanguage } from "@/lib/i18n/language";
import type { ProfileFieldInput, ProfileWrite } from "@/lib/profile/model";

const VERSION = /^(0|[1-9][0-9]{0,8})$/;
const SAVE_FIELDS = new Set(["csrfToken", "lang", "version", "brand", "model", "brandConsent", "modelConsent"]);
const DELETE_FIELDS = new Set(["csrfToken", "lang", "version"]);

export type ProfileForm =
  | { readonly ok: true; readonly language: JourneyLanguage; readonly version: number; readonly write?: ProfileWrite }
  | { readonly ok: false; readonly code: "MALFORMED" };

function counts(form: URLSearchParams): Map<string, number> {
  const seen = new Map<string, number>();
  for (const key of form.keys()) seen.set(key, (seen.get(key) ?? 0) + 1);
  return seen;
}

function once(seen: Map<string, number>, name: string): boolean {
  return seen.get(name) === 1;
}

function languageOf(form: URLSearchParams): JourneyLanguage | null {
  const value = form.get("lang");
  return value === "en" || value === "es" ? value : null;
}

function versionOf(form: URLSearchParams): number | null {
  const value = form.get("version");
  if (value === null || !VERSION.test(value)) return null;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : null;
}

function consent(form: URLSearchParams, name: string, seen: Map<string, number>): boolean | null {
  const count = seen.get(name) ?? 0;
  if (count === 0) return false;
  if (count !== 1 || form.get(name) !== "yes") return null;
  return true;
}

function field(form: URLSearchParams, name: string, consentName: string, seen: Map<string, number>): ProfileFieldInput | null {
  if (!once(seen, name)) return null;
  const agreed = consent(form, consentName, seen);
  if (agreed === null) return null;
  return { consent: agreed, text: form.get(name) ?? "" };
}

function allowlisted(seen: Map<string, number>, allowed: ReadonlySet<string>): boolean {
  for (const key of seen.keys()) if (!allowed.has(key)) return false;
  return true;
}

/** Save form. A repeated name, an unknown name, or a bad version is malformed and is not a profile write. */
export function parseProfileSave(form: URLSearchParams): ProfileForm {
  const seen = counts(form);
  if (!allowlisted(seen, SAVE_FIELDS)) return { ok: false, code: "MALFORMED" };
  if (!once(seen, "csrfToken") || !once(seen, "lang") || !once(seen, "version")) return { ok: false, code: "MALFORMED" };
  const language = languageOf(form);
  const version = versionOf(form);
  const brand = field(form, "brand", "brandConsent", seen);
  const model = field(form, "model", "modelConsent", seen);
  if (!language || version === null || !brand || !model) return { ok: false, code: "MALFORMED" };
  return { ok: true, language, version, write: { version, brand, model } };
}

/** Delete form. Brand, model, and any owner id are rejected. */
export function parseProfileDelete(form: URLSearchParams): ProfileForm {
  const seen = counts(form);
  if (!allowlisted(seen, DELETE_FIELDS)) return { ok: false, code: "MALFORMED" };
  if (!once(seen, "csrfToken") || !once(seen, "lang") || !once(seen, "version")) return { ok: false, code: "MALFORMED" };
  const language = languageOf(form);
  const version = versionOf(form);
  if (!language || version === null) return { ok: false, code: "MALFORMED" };
  return { ok: true, language, version };
}
