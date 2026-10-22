import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { readConversation } from "@/lib/session/conversation";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { SESSION_IDLE_TIMEOUT_MS } from "@/lib/session/service";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import { needsDraftsFor } from "@/lib/session/store";
import {
  ADMISSION_COOKIE_NAME,
  ADMISSION_LABEL,
  ADMISSION_LIFETIME_MS,
  CSRF_COOKIE_NAME,
  CSRF_LABEL,
  CSRF_LIFETIME_MS,
  handleDemoAdmissionLogout,
  issuePurposeCookie,
  type DemoAdmission,
} from "@/server/demo-admission";
import { handleExtensionConversation, handleExtensionPairingExchange, handleExtensionPairingStart, handleExtensionPairingStatus, handleExtensionTurn } from "@/server/extension-handlers";
import { handleExtensionPairDecision, handleExtensionRevoke, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-2 slice 6: restart, logout, idle and admission expiry through the real handlers (docs/m2-2-plan.md §5 items 1, 3, 5, 8).
const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const API = `${SITE}/api/extension/v1`;
const VERIFIER = "f".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");
const EMPTY: PublishedBody = { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] };
const config = { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) };

/** A fake foundation store whose published body outlives each runtime, as the snapshot file does across a restart. */
function snapshotDisk() {
  let published = structuredClone(EMPTY);
  const store: FoundationStore = {
    readPublished: () => ({ status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } }),
    async commit(body: unknown): Promise<CommitResult> {
      published = structuredClone(body) as PublishedBody;
      return { status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: structuredClone(published) } };
    },
  };
  return { store, published: () => published };
}

async function boot(disk: ReturnType<typeof snapshotDisk>, time: ReturnType<typeof createTestClock>, admission?: DemoAdmission): Promise<Runtime> {
  const opened = await recoverStateGate(disk.store, time.clock());
  if (opened.status !== "ready") throw new Error("recovery");
  return createRuntime(config, { clock: time.clock, gate: opened.gate, admission });
}

async function shopper(runtime: Runtime, extraCookie = "") {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`, extraCookie ? { headers: { cookie: extraCookie } } : {}), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  const cookie = [`${SESSION_COOKIE_NAME}=${token}`, extraCookie].filter(Boolean).join("; ");
  return { cookie, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

const site = (path: string, fields: Record<string, string>, cookie: string) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie }, body: new URLSearchParams(fields).toString() });
const api = (path: string, body: unknown, bearer?: string) =>
  new Request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: EXT, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) });
const read = (runtime: Runtime, bearer: string) => handleExtensionConversation(new Request(`${API}/conversation`, { headers: { origin: EXT, authorization: `Bearer ${bearer}` } }), runtime);

async function start(runtime: Runtime, installation: string) {
  const response = await handleExtensionPairingStart(api("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: `ins_${installation.repeat(32)}` }), runtime);
  return (await response.json()).value as { pairingId: string; exchangeSecret: string };
}

async function pairVia(runtime: Runtime, buyer: { cookie: string; csrfToken: string }, installation: string) {
  const pairing = await start(runtime, installation);
  await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, buyer.cookie), runtime);
  const response = await handleExtensionPairingExchange(api(`/pairings/${pairing.pairingId}/exchange`, { exchangeSecret: pairing.exchangeSecret, verifier: VERIFIER }), runtime, pairing.pairingId);
  return (await response.json()).value as { bearer: string; grantId: string; expiresAt: number };
}

describe("extension grants across a restart (snapshot mode)", () => {
  it("grants and the conversation survive; a revoked grant stays revoked; a pending pairing is dropped", async () => {
    const disk = snapshotDisk();
    const time = createTestClock();
    const before = await boot(disk, time);
    const buyer = await shopper(before);
    await handleNeedsSubmit(site("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "500", csrfToken: buyer.csrfToken }, buyer.cookie), before);
    const kept = await pairVia(before, buyer, "1");
    const revoked = await pairVia(before, buyer, "2");
    const draft = needsDraftsFor(before.store).get(buyer.sessionId)!;
    const turn = await handleExtensionTurn(api("/conversation/turns", { draftId: draft.draftId, version: draft.version, shopperText: "for programming please", clientRequestId: "req-restart-1" }, kept.bearer), before);
    expect(turn.status).toBe(200);
    const revokeResponse = await handleExtensionRevoke(site("/extension/revoke", { csrfToken: buyer.csrfToken, grantId: revoked.grantId, lang: "en" }, buyer.cookie), before);
    expect(revokeResponse.headers.get("location")).toContain(`revoked=${revoked.grantId.slice(4, 12)}`);
    // Durable before reported: the published body already lacks the revoked grant.
    expect(disk.published().grants.map((g) => g.grantId)).toEqual([kept.grantId]);
    const pending = await start(before, "3");

    time.advance(60_000);
    const after = await boot(disk, time);
    const restored = await read(after, kept.bearer);
    expect(restored.status).toBe(200);
    expect((await restored.json()).value.conversation.turns.map((t: { text: string }) => t.text)).toContain("for programming please");
    expect(readConversation(after.store, buyer.sessionId)?.turns.map((t) => t.text)).toContain("for programming please");
    expect((await read(after, revoked.bearer)).status).toBe(401);
    const status = await handleExtensionPairingStatus(api(`/pairings/${pending.pairingId}/status`, { exchangeSecret: pending.exchangeSecret }), after, pending.pairingId);
    expect(status.status).toBe(404);
    expect((await status.json()).code).toBe("PAIRING_UNKNOWN");
    expect(JSON.stringify(disk.published())).not.toContain(kept.bearer);
  });
});

describe("grant end by session and admission", () => {
  const admissionKey = randomBytes(32);
  const admission = (): DemoAdmission => ({ mode: "on", key: admissionKey, passphrase: "a synthetic passphrase for tests", attempts: { windowStartedAt: null, count: 0 } });

  it("with admission on, approval without the admission cookie redirects to admission and decides nothing", async () => {
    const time = createTestClock();
    const runtime = await boot(snapshotDisk(), time, admission());
    const admitted = `${ADMISSION_COOKIE_NAME}=${issuePurposeCookie(admissionKey, time.clock().getTime(), ADMISSION_LIFETIME_MS, ADMISSION_LABEL).value}`;
    const buyer = await shopper(runtime, admitted);
    const pairing = await start(runtime, "1");
    const sessionOnly = buyer.cookie.split("; ")[0];
    const response = await handleExtensionPairDecision(site("/extension/pair/decide", { csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, decision: "approve", lang: "en" }, sessionOnly), runtime);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toMatch(/^\/en\/demo\/admission/);
    const status = await handleExtensionPairingStatus(api(`/pairings/${pairing.pairingId}/status`, { exchangeSecret: pairing.exchangeSecret }), runtime, pairing.pairingId);
    expect((await status.json()).value.status).toBe("pending");
  });

  it("logout revokes the session's grants durably, and the panel's next request is TOKEN_INVALID", async () => {
    const disk = snapshotDisk();
    const time = createTestClock();
    const runtime = await boot(disk, time, admission());
    const now = time.clock().getTime();
    const admitted = `${ADMISSION_COOKIE_NAME}=${issuePurposeCookie(admissionKey, now, ADMISSION_LIFETIME_MS, ADMISSION_LABEL).value}`;
    const csrf = issuePurposeCookie(admissionKey, now, CSRF_LIFETIME_MS, CSRF_LABEL).value;
    const buyer = await shopper(runtime, `${admitted}; ${CSRF_COOKIE_NAME}=${csrf}`);
    const grant = await pairVia(runtime, buyer, "1");
    expect((await read(runtime, grant.bearer)).status).toBe(200);
    expect(disk.published().grants).toHaveLength(1);

    await handleDemoAdmissionLogout(site("/demo/admission/logout", { lang: "en", demoCsrf: csrf }, buyer.cookie), runtime);
    // Durable before reported: the session and its grant are both revoked in the published body.
    expect(disk.published().grants.map((g) => g.revokedAt)).toEqual([time.clock().toISOString()]);
    const refused = await read(runtime, grant.bearer);
    expect(refused.status).toBe(401);
    expect((await refused.json()).code).toBe("TOKEN_INVALID");
  });

  it("an idle session refuses its grant, and a grant ends no later than the admission cookie", async () => {
    const time = createTestClock();
    const runtime = await boot(snapshotDisk(), time);
    const buyer = await shopper(runtime);
    const grant = await pairVia(runtime, buyer, "1");
    time.advance(SESSION_IDLE_TIMEOUT_MS - 3_600_000 + 1);
    expect((await read(runtime, grant.bearer)).status).toBe(401);

    const timeB = createTestClock();
    const runtimeB = await boot(snapshotDisk(), timeB, admission());
    const nowB = timeB.clock().getTime();
    // An admission cookie with ten minutes left.
    const admitted = `${ADMISSION_COOKIE_NAME}=${issuePurposeCookie(admissionKey, nowB - ADMISSION_LIFETIME_MS + 600_000, ADMISSION_LIFETIME_MS, ADMISSION_LABEL).value}`;
    const buyerB = await shopper(runtimeB, admitted);
    const grantB = await pairVia(runtimeB, buyerB, "1");
    expect(grantB.expiresAt).toBe(nowB + 600_000);
    timeB.advance(599_000);
    expect((await read(runtimeB, grantB.bearer)).status).toBe(200);
    timeB.advance(1_000);
    expect((await read(runtimeB, grantB.bearer)).status).toBe(401);
  });
});
