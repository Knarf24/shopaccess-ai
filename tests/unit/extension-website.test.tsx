import { createHash, randomBytes } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { needsCurrentTargetId, selectNeedsCurrentTarget } from "@/app/shop/needs/page";
import { PAIRED_ACCESS_RESULT_ID, PairedAccess } from "@/components/PairedAccess";
import { revocationMessage } from "@/lib/i18n/extension-copy";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { ADMISSION_COOKIE_NAME, ADMISSION_LABEL, ADMISSION_LIFETIME_MS, admissionExpiryMs, issuePurposeCookie, type DemoAdmission } from "@/server/demo-admission";
import { handleExtensionConversation, handleExtensionPairingExchange, handleExtensionPairingStart, handleExtensionPairingStatus } from "@/server/extension-handlers";
import { handleExtensionPairDecision, handleExtensionRevoke, handleNeedsSession } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-2 slice 4: the website side of pairing (docs/m2-2-plan.md §3.2 and §5).
const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const API = `${SITE}/api/extension/v1`;
const VERIFIER = "f".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");

function runtimeWith(extensionOrigins: ReadonlySet<string> = new Set([EXT]), admission?: DemoAdmission) {
  const time = createTestClock();
  return createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins }, { clock: time.clock, admission });
}

async function shopper(runtime: Runtime, admissionCookie?: string) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`, admissionCookie ? { headers: { cookie: admissionCookie } } : {}), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

const site = (path: string, fields: Record<string, string>, cookie: string, origin = SITE) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": origin === SITE ? "same-origin" : "cross-site", cookie }, body: new URLSearchParams(fields).toString() });
const api = (path: string, body: unknown) => new Request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: EXT }, body: JSON.stringify(body) });

async function startPairing(runtime: Runtime, installation = "1") {
  const response = await handleExtensionPairingStart(api("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: `ins_${installation.repeat(32)}` }), runtime);
  return (await response.json()).value as { pairingId: string; exchangeSecret: string };
}

async function status(runtime: Runtime, pairing: { pairingId: string; exchangeSecret: string }) {
  const response = await handleExtensionPairingStatus(api(`/pairings/${pairing.pairingId}/status`, { exchangeSecret: pairing.exchangeSecret }), runtime, pairing.pairingId);
  return (await response.json()).value?.status as string | undefined;
}

async function exchange(runtime: Runtime, pairing: { pairingId: string; exchangeSecret: string }) {
  const response = await handleExtensionPairingExchange(api(`/pairings/${pairing.pairingId}/exchange`, { exchangeSecret: pairing.exchangeSecret, verifier: VERIFIER }), runtime, pairing.pairingId);
  return (await response.json()).value as { bearer: string; grantId: string; expiresAt: number };
}

const read = (runtime: Runtime, bearer: string) => handleExtensionConversation(new Request(`${API}/conversation`, { headers: { origin: EXT, authorization: `Bearer ${bearer}` } }), runtime);

describe("pairing approval on the website", () => {
  it("approve: the decision redirects with the result, and the panel then exchanges and reads", async () => {
    const runtime = runtimeWith();
    const buyer = await shopper(runtime);
    const pairing = await startPairing(runtime);
    const decided = await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "es" }, buyer.cookie), runtime);
    expect(decided.status).toBe(303);
    expect(decided.headers.get("location")).toBe("/extension/pair?lang=es&result=approved");
    expect(await status(runtime, pairing)).toBe("approved");
    const grant = await exchange(runtime, pairing);
    expect((await read(runtime, grant.bearer)).status).toBe(200);
  });

  it("deny: the pairing reports denied and cannot be exchanged", async () => {
    const runtime = runtimeWith();
    const buyer = await shopper(runtime);
    const pairing = await startPairing(runtime);
    const decided = await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "deny", lang: "en" }, buyer.cookie), runtime);
    expect(decided.headers.get("location")).toBe("/extension/pair?lang=en&result=denied");
    expect(await status(runtime, pairing)).toBe("denied");
    expect(await exchange(runtime, pairing)).toBeUndefined();
  });

  it("a missing CSRF token, a foreign origin or no session decides nothing", async () => {
    const runtime = runtimeWith();
    const buyer = await shopper(runtime);
    const pairing = await startPairing(runtime);
    const attempts = [
      site("/extension/pair/decide", { pairingId: pairing.pairingId, decision: "approve", lang: "en" }, buyer.cookie),
      site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, buyer.cookie, "https://evil.example.test"),
      site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, ""),
    ];
    for (const attempt of attempts) {
      const response = await handleExtensionPairDecision(attempt, runtime);
      expect(response.headers.get("location") ?? "").not.toContain("result=approved");
    }
    expect(await status(runtime, pairing)).toBe("pending");
  });

  it("an unknown or malformed pairing reports failed", async () => {
    const runtime = runtimeWith();
    const buyer = await shopper(runtime);
    for (const pairingId of ["0".repeat(64), "not-a-pairing"]) {
      const response = await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId, decision: "approve", lang: "en" }, buyer.cookie), runtime);
      expect(response.headers.get("location")).toBe("/extension/pair?lang=en&result=failed");
    }
  });

  it("with no extension origins configured, the website routes are not found", async () => {
    const runtime = runtimeWith(new Set());
    const buyer = await shopper(runtime);
    const decide = await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: "0".repeat(64), decision: "approve", lang: "en" }, buyer.cookie), runtime);
    const revoke = await handleExtensionRevoke(site("/extension/revoke", { csrfToken: buyer.csrfToken, grantId: `grt_${"0".repeat(32)}`, lang: "en" }, buyer.cookie), runtime);
    expect(decide.status).toBe(404);
    expect(revoke.status).toBe(404);
  });

  it("with admission on, the grant ends no later than the admission cookie", async () => {
    const admissionKey = randomBytes(32);
    const admission: DemoAdmission = { mode: "on", key: admissionKey, passphrase: "a synthetic passphrase for tests", attempts: { windowStartedAt: null, count: 0 } };
    const runtime = runtimeWith(new Set([EXT]), admission);
    const nowMs = runtime.clock().getTime();
    const issued = issuePurposeCookie(admissionKey, nowMs - ADMISSION_LIFETIME_MS + 600_000, ADMISSION_LIFETIME_MS, ADMISSION_LABEL);
    const admissionCookie = `${ADMISSION_COOKIE_NAME}=${issued.value}`;
    expect(admissionExpiryMs(admission, admissionCookie, nowMs)).toBe(nowMs + 600_000);
    expect(admissionExpiryMs({ mode: "off" }, admissionCookie, nowMs)).toBeNull();
    expect(admissionExpiryMs(admission, `${ADMISSION_COOKIE_NAME}=v1.1.x.y`, nowMs)).toBeNull();

    const buyer = await shopper(runtime, admissionCookie);
    const pairing = await startPairing(runtime);
    const decided = await handleExtensionPairDecision(
      site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, `${buyer.cookie}; ${admissionCookie}`),
      runtime,
    );
    expect(decided.headers.get("location")).toBe("/extension/pair?lang=en&result=approved");
    const grant = await exchange(runtime, pairing);
    expect(grant.expiresAt).toBeLessThanOrEqual(nowMs + 600_000);
  });
});

describe("paired access and revocation", () => {
  it("revokes one grant, reports its label and the remaining count, and the revoked panel is refused", async () => {
    const runtime = runtimeWith();
    const buyer = await shopper(runtime);
    const grants = [];
    for (const installation of ["1", "2"]) {
      const pairing = await startPairing(runtime, installation);
      await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, buyer.cookie), runtime);
      grants.push(await exchange(runtime, pairing));
    }
    expect(runtime.pairing.list(buyer.sessionId, runtime.clock())).toHaveLength(2);
    const [first, second] = grants;
    const revoked = await handleExtensionRevoke(site("/extension/revoke", { csrfToken: buyer.csrfToken, grantId: first.grantId, lang: "en" }, buyer.cookie), runtime);
    expect(revoked.status).toBe(303);
    expect(revoked.headers.get("location")).toBe(`/shop/needs?lang=en&revoked=${first.grantId.slice(4, 12)}`);
    expect((await read(runtime, first.bearer)).status).toBe(401);
    expect((await read(runtime, second.bearer)).status).toBe(200);
    expect(runtime.pairing.list(buyer.sessionId, runtime.clock()).map((g) => g.grantId)).toEqual([second.grantId]);
  });

  it("another session cannot revoke a grant it does not own, and a missing CSRF token revokes nothing", async () => {
    const runtime = runtimeWith();
    const owner = await shopper(runtime);
    const other = await shopper(runtime);
    const pairing = await startPairing(runtime);
    await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: owner.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, owner.cookie), runtime);
    const grant = await exchange(runtime, pairing);
    const foreign = await handleExtensionRevoke(site("/extension/revoke", { csrfToken: other.csrfToken, grantId: grant.grantId, lang: "en" }, other.cookie), runtime);
    expect(foreign.headers.get("location")).not.toContain("revoked=");
    await handleExtensionRevoke(site("/extension/revoke", { grantId: grant.grantId, lang: "en" }, owner.cookie), runtime);
    expect((await read(runtime, grant.bearer)).status).toBe(200);
  });

  it("after a revoke, the skip-to-current-step link targets the revocation result (browser finding: focus was lost)", () => {
    const base = { expiredDraft: false, validationAlert: false, noticeRendered: true, reviewRendered: true, suggestionsRendered: true };
    expect(selectNeedsCurrentTarget({ ...base, revocationRendered: true })).toBe("revoked");
    expect(needsCurrentTargetId("revoked")).toBe(PAIRED_ACCESS_RESULT_ID);
    expect(selectNeedsCurrentTarget({ ...base, validationAlert: true, revocationRendered: true })).toBe("alert");
    expect(selectNeedsCurrentTarget({ ...base, revocationRendered: false })).toBe("notice");
  });

  it("the revocation message names the pairing and the remaining count, in English and Spanish", () => {
    expect(revocationMessage("en", "0123abcd", 0)).toBe("Access revoked for pairing 0123abcd. That pairing can no longer read or change this conversation. No paired access remains.");
    expect(revocationMessage("en", "0123abcd", 1)).toContain("1 other pairing remains active.");
    expect(revocationMessage("en", "0123abcd", 2)).toContain("2 other pairings remain active.");
    expect(revocationMessage("es", "0123abcd", 0)).toBe("Acceso revocado para el vínculo 0123abcd. Ese vínculo ya no puede leer ni cambiar esta conversación. No queda ningún vínculo activo.");
    expect(revocationMessage("es", "0123abcd", 2)).toContain("Quedan 2 otros vínculos activos.");
    expect(revocationMessage("en", "<script>", 0)).toBeNull();
    expect(revocationMessage("en", null, 0)).toBeNull();
  });

  it("the Paired access list gives each grant its own labelled Revoke button inside a CSRF form", () => {
    const expiresAt = new Date("2026-10-16T18:30:00Z");
    const html = renderToStaticMarkup(
      <PairedAccess
        language="en"
        csrfToken="csrf-test"
        grants={[{ grantId: `grt_${"ab".repeat(16)}`, label: "abababab", createdAt: new Date(expiresAt.getTime() - 3_600_000), expiresAt }]}
        revokedLabel="0123abcd"
      />,
    );
    expect(html).toContain('id="paired-access-heading"');
    expect(html).toContain('action="/extension/revoke"');
    expect(html).toContain('name="csrfToken" value="csrf-test"');
    expect(html).toContain("Revoke pairing abababab");
    expect(html).toContain("Paired 17:30 UTC. Ends 18:30 UTC.");
    expect(html).toMatch(/role="status" id="paired-access-result" tabindex="-1">Access revoked for pairing 0123abcd\./);
    const empty = renderToStaticMarkup(<PairedAccess language="es" csrfToken="c" grants={[]} revokedLabel={null} />);
    expect(empty).toContain("No hay ningún panel lateral vinculado a esta sesión.");
    expect(empty).not.toContain("<form");
  });
});
