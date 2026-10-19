import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import type { CommitResult, FoundationStore, PublishedBody } from "@/lib/session/snapshot-store";
import { extensionPreflight } from "@/server/extension-guard";
import { handleExtensionConversation, handleExtensionPairingExchange, handleExtensionPairingStart, handleExtensionPairingStatus } from "@/server/extension-handlers";
import { handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { withMockRuntime } from "@/server/respond";
import { createRuntime, type Application, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-2 slice 2: the extension API and its request policy (docs/m2-2-plan.md §3.1, §3.4).
const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT = `chrome-extension://${"b".repeat(32)}`;
const INSTALL = `ins_${"1".repeat(32)}`;
const API = `${SITE}/api/extension/v1`;
const VERIFIER = "f".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");

function world(extensionOrigins: string[] = [EXT]) {
  const time = createTestClock();
  const runtime = createRuntime(
    { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), ...(extensionOrigins.length ? { extensionOrigins: new Set(extensionOrigins) } : {}) },
    { clock: time.clock },
  );
  return { time, runtime };
}

async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

const json = (path: string, body: unknown, headers: Record<string, string> = { origin: EXT }) =>
  new Request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const read = (headers: Record<string, string>, path = "/conversation") => new Request(`${API}${path}`, { method: "GET", headers });

async function pairedBearer(runtime: Runtime, sessionId: string) {
  const started = await (await handleExtensionPairingStart(json("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: INSTALL }), runtime)).json();
  const approved = runtime.pairing.approve({ pairingId: started.value.pairingId, sessionId, deny: false, boundMs: null }, runtime.clock().getTime());
  expect(approved.ok).toBe(true);
  const status = await (await handleExtensionPairingStatus(json(`/pairings/${started.value.pairingId}/status`, { exchangeSecret: started.value.exchangeSecret }), runtime, started.value.pairingId)).json();
  expect(status.value.status).toBe("approved");
  const exchanged = await handleExtensionPairingExchange(json(`/pairings/${started.value.pairingId}/exchange`, { exchangeSecret: started.value.exchangeSecret, verifier: VERIFIER }), runtime, started.value.pairingId);
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()).value as { bearer: string; grantId: string; expiresAt: number };
}

describe("extension API", () => {
  it("is not found when no extension origin is configured", async () => {
    const { runtime } = world([]);
    for (const response of [
      await handleExtensionPairingStart(json("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: INSTALL }), runtime),
      await handleExtensionConversation(read({ origin: EXT }), runtime),
      extensionPreflight(new Request(`${API}/pairings`, { method: "OPTIONS", headers: { origin: EXT } }), runtime.extensionOrigins, ["POST"]),
    ]) expect(response.status).toBe(404);
  });

  it("starts a pairing only from an allowed extension origin with a well-formed body", async () => {
    const { runtime } = world();
    const good = { protocolVersion: 1, challenge: CHALLENGE, installationId: INSTALL };
    expect((await handleExtensionPairingStart(json("/pairings", good, { origin: OTHER_EXT }), runtime)).status).toBe(403);
    expect((await handleExtensionPairingStart(json("/pairings", good, { origin: SITE }), runtime)).status).toBe(403);
    expect((await handleExtensionPairingStart(json("/pairings", good, {}), runtime)).status).toBe(403);
    expect((await handleExtensionPairingStart(json("/pairings", { ...good, extra: 1 }), runtime)).status).toBe(400);
    expect((await handleExtensionPairingStart(json("/pairings", { ...good, protocolVersion: 2 }), runtime)).status).toBe(400);
    const ok = await handleExtensionPairingStart(json("/pairings", good), runtime);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe(EXT);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("set-cookie")).toBeNull();
  });

  it("reads the shared conversation with a paired token, from the extension origin or the reviewed originless read", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    await handleNeedsSubmit(
      new Request(`${SITE}/shop/needs/submit`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie: buyer.cookie }, body: new URLSearchParams({ lang: "es", shopperText: "", use: "schoolwork", budget: "700", csrfToken: buyer.csrfToken }).toString() }),
      runtime,
    );
    const { bearer } = await pairedBearer(runtime, buyer.sessionId);
    const withOrigin = await handleExtensionConversation(read({ origin: EXT, authorization: `Bearer ${bearer}` }), runtime);
    expect(withOrigin.status).toBe(200);
    expect(withOrigin.headers.get("access-control-allow-origin")).toBe(EXT);
    const view = (await withOrigin.json()).value;
    expect(view.draft).toMatchObject({ language: "es", prefilledUse: "schoolwork", prefilledBudgetDollars: "700" });
    expect(view.conversation.interfaceLanguage).toBe("es");
    expect(JSON.stringify(view)).not.toMatch(/unitAmountCents|quote|price/i);
    const originless = await handleExtensionConversation(read({ "sec-fetch-site": "none", authorization: `Bearer ${bearer}` }), runtime);
    expect(originless.status).toBe(200);
    expect(originless.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses every originless request except the conversation read with Sec-Fetch-Site none and a valid token", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { bearer } = await pairedBearer(runtime, buyer.sessionId);
    const auth = { authorization: `Bearer ${bearer}` };
    for (const site of [undefined, "cross-site", "same-site", "same-origin", "NONE"]) {
      const headers: Record<string, string> = { ...auth };
      if (site !== undefined) headers["sec-fetch-site"] = site;
      const response = await handleExtensionConversation(read(headers), runtime);
      expect(response.status, String(site)).toBe(403);
    }
    for (const origin of ["null", "", SITE, OTHER_EXT]) {
      expect((await handleExtensionConversation(read({ ...auth, origin, "sec-fetch-site": "none" }), runtime)).status, origin).toBe(403);
    }
    expect((await handleExtensionConversation(read({ ...auth, "sec-fetch-site": "none" }, "/conversation/"), runtime)).status).toBe(403);
    const pairingId = "a".repeat(64);
    for (const response of [
      await handleExtensionPairingStart(json("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: INSTALL }, { "sec-fetch-site": "none" }), runtime),
      await handleExtensionPairingStatus(json(`/pairings/${pairingId}/status`, { exchangeSecret: "b".repeat(64) }, { "sec-fetch-site": "none" }), runtime, pairingId),
      await handleExtensionPairingExchange(json(`/pairings/${pairingId}/exchange`, { exchangeSecret: "b".repeat(64), verifier: VERIFIER }, { "sec-fetch-site": "none" }), runtime, pairingId),
    ]) expect(response.status).toBe(403);
    expect(extensionPreflight(new Request(`${API}/conversation`, { method: "OPTIONS" }), runtime.extensionOrigins, ["GET"]).status).toBe(403);
    expect(extensionPreflight(new Request(`${API}/conversation`, { method: "OPTIONS", headers: { origin: OTHER_EXT } }), runtime.extensionOrigins, ["GET"]).status).toBe(403);
    const preflight = extensionPreflight(new Request(`${API}/conversation`, { method: "OPTIONS", headers: { origin: EXT } }), runtime.extensionOrigins, ["GET"]);
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(EXT);
  });

  it("refuses missing, malformed, foreign, revoked and expired tokens, and gives a website cookie no authority", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { bearer, grantId, expiresAt } = await pairedBearer(runtime, buyer.sessionId);
    const ask = (headers: Record<string, string>) => handleExtensionConversation(read({ origin: EXT, ...headers }), runtime);
    expect((await ask({})).status).toBe(401);
    expect((await ask({ cookie: buyer.cookie })).status).toBe(401);
    expect((await ask({ authorization: "Bearer xyz" })).status).toBe(401);
    expect((await ask({ authorization: `Bearer ${"0".repeat(64)}` })).status).toBe(401);
    expect((await handleExtensionConversation(read({ origin: OTHER_EXT, authorization: `Bearer ${bearer}` }), world([EXT, OTHER_EXT]).runtime)).status).toBe(401);
    expect((await ask({ authorization: `Bearer ${bearer}` })).status).toBe(200);
    expect(await runtime.pairing.revoke(buyer.sessionId, grantId, runtime.clock())).toBe("revoked");
    expect((await ask({ authorization: `Bearer ${bearer}` })).status).toBe(401);
    const second = await pairedBearer(runtime, buyer.sessionId);
    time.advance(second.expiresAt - runtime.clock().getTime());
    expect((await ask({ authorization: `Bearer ${second.bearer}` })).status).toBe(401);
    expect(expiresAt).toBeGreaterThan(0);
  });

  it("answers 503 and publishes no grant when the exchange cannot be saved", async () => {
    let refuse = false;
    let published: PublishedBody | null = null;
    const store: FoundationStore = {
      readPublished: () => ({ status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: { allocation: { windowStartedAt: null, count: 0 }, admissionLogin: { windowStartedAt: null, count: 0 }, sessions: [], drafts: [], conversations: [], selections: [], grants: [], permissions: [], profiles: [], profileRevisions: [], chargerTracks: [] } } }),
      async commit(body: unknown): Promise<CommitResult> {
        if (refuse) return { status: "unavailable", outcome: "definite" };
        published = structuredClone(body) as PublishedBody;
        return { status: "ready", value: { format: 3, identity: "0".repeat(64), sha256: "0".repeat(64), body: published } };
      },
    };
    const time = createTestClock();
    const opened = await recoverStateGate(store, time.clock());
    if (opened.status !== "ready") throw new Error();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock, gate: opened.gate });
    const application: Application = { mode: "mock", runtime: { ok: true, value: runtime } };
    const buyer = await shopper(runtime);
    const started = await (await handleExtensionPairingStart(json("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: INSTALL }), runtime)).json();
    runtime.pairing.approve({ pairingId: started.value.pairingId, sessionId: buyer.sessionId, deny: false, boundMs: null }, runtime.clock().getTime());
    refuse = true;
    const response = await withMockRuntime(application, (rt) =>
      handleExtensionPairingExchange(json(`/pairings/${started.value.pairingId}/exchange`, { exchangeSecret: started.value.exchangeSecret, verifier: VERIFIER }), rt, started.value.pairingId),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect((published as PublishedBody | null)?.grants ?? []).toEqual([]);
  });
});
