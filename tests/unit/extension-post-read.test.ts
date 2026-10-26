import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createApi } from "../../extension/client.mjs";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { readConversation } from "@/lib/session/conversation";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import {
  handleExtensionConversation,
  handleExtensionConversationGet,
  handleExtensionPairingExchange,
  handleExtensionPairingStart,
  handleExtensionTurn,
} from "@/server/extension-handlers";
import { handleExtensionPairDecision, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// Extension finding: the originless conversation read is retired. Every extension request needs an allowed Origin, the
// read is a side-effect-free POST with an exact `{}` body, GET answers 405 (Allow: POST), and every token is checked against
// the extension that paired it. Website sessions, pairing (with its code), token lifetime and revocation are unchanged.

const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const OTHER_EXT = `chrome-extension://${"b".repeat(32)}`;
const API = `${SITE}/api/extension/v1`;
const VERIFIER = "f".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");

function world(extensionOrigins: string[] = [EXT, OTHER_EXT]) {
  const time = createTestClock();
  const runtime = createRuntime(
    { sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), ...(extensionOrigins.length ? { extensionOrigins: new Set(extensionOrigins) } : {}) },
    { clock: time.clock },
  );
  return { time, runtime };
}
async function shopper(runtime: Runtime) {
  const created = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = created.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const form = (path: string, fields: Record<string, string>) =>
    new Request(`${SITE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie },
      body: new URLSearchParams({ ...fields, csrfToken: session.value.csrfToken }).toString(),
    });
  await handleNeedsSubmit(form("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "600" }), runtime);
  return { cookie, form, sessionId: session.value.id };
}
const apiJson = (path: string, body: unknown, origin: string | null = EXT) =>
  new Request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
/** Pairs `origin`'s extension with the shopper's session (typed code included) and returns its bearer. */
async function pair(runtime: Runtime, buyer: Awaited<ReturnType<typeof shopper>>, origin = EXT, installation = "1") {
  const started = (await (await handleExtensionPairingStart(apiJson("/pairings", { protocolVersion: 1, challenge: CHALLENGE, installationId: `ins_${installation.repeat(32)}` }, origin), runtime)).json()).value;
  await handleExtensionPairDecision(buyer.form("/extension/pair/decide", { pairingId: started.pairingId, matchCode: started.matchCode, decision: "approve", lang: "en" }), runtime);
  const exchanged = await handleExtensionPairingExchange(apiJson(`/pairings/${started.pairingId}/exchange`, { exchangeSecret: started.exchangeSecret, verifier: VERIFIER }, origin), runtime, started.pairingId);
  return (await exchanged.json()).value.bearer as string;
}
const read = (bearer: string | null, init: { origin?: string | null; body?: string; contentType?: string | null; cookie?: string; site?: string } = {}) => {
  const headers: Record<string, string> = {};
  const origin = init.origin === undefined ? EXT : init.origin;
  if (origin) headers.origin = origin;
  if (init.contentType !== null) headers["content-type"] = init.contentType ?? "application/json";
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (init.cookie) headers.cookie = init.cookie;
  if (init.site) headers["sec-fetch-site"] = init.site;
  return new Request(`${API}/conversation`, { method: "POST", headers, body: init.body ?? "{}" });
};

describe("GET /conversation is retired", () => {
  it("answers 405 with Allow: POST and no-store, reading nothing", () => {
    const { runtime } = world();
    const response = handleExtensionConversationGet(runtime);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("stays 'not found' when no extension origin is configured, like every extension route", () => {
    expect(handleExtensionConversationGet(world([]).runtime).status).toBe(404);
  });
  it("the route exports POST for the read, GET only for the 405, and a POST preflight", () => {
    const route = readFileSync("src/app/api/extension/v1/conversation/route.ts", "utf8");
    expect(route).toMatch(/export async function POST\(request: Request\) \{\s*return withApplication\(\{ mock: \(runtime\) => handleExtensionConversation\(request, runtime\)/);
    expect(route).toMatch(/export async function GET\(\) \{\s*return withApplication\(\{ mock: async \(runtime\) => handleExtensionConversationGet\(runtime\)/);
    expect(route).toContain('extensionOrigins, ["POST"]');
  });
});

describe("every extension request needs an allowed Origin (no originless read)", () => {
  it("positive control: the POST read with the pairing extension's Origin returns the same view shape, no-store, with CORS for that origin", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const bearer = await pair(runtime, buyer);
    const response = await handleExtensionConversation(read(bearer), runtime);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe(EXT);
    const view = (await response.json()).value;
    expect(Object.keys(view).sort()).toEqual(["conversation", "draft"]);
    expect(Object.keys(view.draft).sort()).toEqual(
      ["confirmedBudgetDollars", "confirmedUse", "draftId", "language", "notice", "prefilledBudgetDollars", "prefilledUse", "recommendationClaim", "version"].sort(),
    );
    expect(view.draft).toMatchObject({ prefilledUse: "schoolwork", prefilledBudgetDollars: "600" });
  });

  it("an originless read is refused for every Sec-Fetch-Site value, even with a valid token, with no CORS header", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const bearer = await pair(runtime, buyer);
    for (const site of [undefined, "none", "NONE", "same-origin", "same-site", "cross-site"]) {
      const response = await handleExtensionConversation(read(bearer, { origin: null, site }), runtime);
      expect(response.status, String(site)).toBe(403);
      expect((await response.json()).code).toBe("ORIGIN_DENIED");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const origin of ["null", SITE, "chrome-extension://" + "c".repeat(32)]) expect((await handleExtensionConversation(read(bearer, { origin }), runtime)).status, origin).toBe(403);
  });

  it("an originless turn is refused (unchanged)", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const bearer = await pair(runtime, buyer);
    const turn = new Request(`${API}/conversation/turns`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearer}`, "sec-fetch-site": "none" }, body: "{}" });
    expect((await handleExtensionTurn(turn, runtime)).status).toBe(403);
  });
});

describe("a token is always bound to the extension that paired it", () => {
  it("a token minted for extension A reads from A, and is refused from B (both allowed)", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const bearerA = await pair(runtime, buyer, EXT, "1");
    expect((await handleExtensionConversation(read(bearerA, { origin: EXT }), runtime)).status).toBe(200);
    const fromB = await handleExtensionConversation(read(bearerA, { origin: OTHER_EXT }), runtime);
    expect(fromB.status).toBe(401);
    expect((await fromB.json()).code).toBe("TOKEN_INVALID");
    const turnFromB = new Request(`${API}/conversation/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: OTHER_EXT, authorization: `Bearer ${bearerA}` },
      body: JSON.stringify({ draftId: "nd_" + "1".repeat(32), version: 1, shopperText: "hello", clientRequestId: "r".repeat(16) }),
    });
    expect((await handleExtensionTurn(turnFromB, runtime)).status).toBe(401);
    // Positive control for B: its own pairing works from B.
    const bearerB = await pair(runtime, buyer, OTHER_EXT, "2");
    expect((await handleExtensionConversation(read(bearerB, { origin: OTHER_EXT }), runtime)).status).toBe(200);
  });
});

describe("the read body must be exactly {}", () => {
  for (const [label, init] of [
    ["an extra key", { body: '{"x":1}' }],
    ["not JSON", { body: "not json" }],
    ["an array", { body: "[]" }],
    ["an empty body", { body: "" }],
    ["text/plain", { contentType: "text/plain" }],
    ["no content type", { contentType: null }],
    ["an oversized body", { body: `{"pad":"${"x".repeat(17_000)}"}` }],
  ] as const) {
    it(`${label} is refused (400 BAD_REQUEST)`, async () => {
      const { runtime } = world();
      const buyer = await shopper(runtime);
      const bearer = await pair(runtime, buyer);
      const response = await handleExtensionConversation(read(bearer, init), runtime);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("BAD_REQUEST");
    });
  }
  it("a refused token is reported before the body is read (no information about the body path)", async () => {
    const { runtime } = world();
    expect((await handleExtensionConversation(read("0".repeat(64), { body: "not json" }), runtime)).status).toBe(401);
  });
});

describe("website sessions give no authority on the extension read", () => {
  it("a website session cookie without a bearer is refused; with the website's Origin it is refused before any token check", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    expect((await handleExtensionConversation(read(null, { cookie: buyer.cookie }), runtime)).status).toBe(401);
    expect((await handleExtensionConversation(read(null, { cookie: buyer.cookie, origin: SITE, site: "same-origin" }), runtime)).status).toBe(403);
  });
});

describe("the POST read is side-effect free", () => {
  it("repeated reads change no draft, conversation, grant or session idle time, and use none of the shared 20-per-minute message allowance", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const bearer = await pair(runtime, buyer);
    const sessionId = buyer.sessionId;
    // liveUntil reflects the session's lastSeenAt (idle expiry), read without touching it.
    const state = () =>
      JSON.stringify({
        drafts: [...needsDraftsFor(runtime.store).entries()],
        conversation: readConversation(runtime.store, sessionId),
        grants: runtime.durable.readGrants(),
        liveUntil: runtime.durable.sessionStore.liveUntil(sessionId, 60_000),
      });
    expect(readConversation(runtime.store, sessionId)).not.toBeNull();
    const before = state();
    time.advance(30_000); // a read that refreshed the session's idle time would now move liveUntil
    for (let i = 0; i < 25; i++) expect((await handleExtensionConversation(read(bearer), runtime)).status).toBe(200);
    expect(state()).toBe(before);
    // The allowance is untouched: a turn after 25 reads is accepted.
    const view = (await (await handleExtensionConversation(read(bearer), runtime)).json()).value;
    const turn = new Request(`${API}/conversation/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: EXT, authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ draftId: view.draft.draftId, version: view.draft.version, shopperText: "mostly for schoolwork", clientRequestId: "a1b2c3d4e5f6a7b8" }),
    });
    expect((await handleExtensionTurn(turn, runtime)).status).toBe(200);
    // Negative control: the snapshot does detect a real change (the turn wrote to the conversation).
    expect(state()).not.toBe(before);
  });

  it("negative control: a website request that refreshes the session's idle time is visible to the same detector", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const before = runtime.durable.sessionStore.liveUntil(buyer.sessionId, 60_000);
    time.advance(30_000);
    await runtime.sessions.resolve(buyer.cookie.split("=")[1]!);
    expect(runtime.durable.sessionStore.liveUntil(buyer.sessionId, 60_000)).not.toBe(before);
  });
});

describe("the side-panel client reads with POST {}", () => {
  it("createApi sends POST, the exact body {}, Authorization, no cookies and no redirects for the read", async () => {
    const seen: { method?: string; body?: unknown; credentials?: string; redirect?: string; headers?: Record<string, string> }[] = [];
    const fetchImpl = (async (_url: URL, init: RequestInit) => {
      seen.push({ method: init.method, body: init.body, credentials: init.credentials, redirect: init.redirect, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ ok: true, value: {} }), { status: 200 });
    }) as typeof fetch;
    const api = createApi({ origin: "http://127.0.0.1:3000", bearer: () => "b".repeat(64), fetchImpl });
    await api("/conversation", {});
    expect(seen[0]).toMatchObject({ method: "POST", body: "{}", credentials: "omit", redirect: "error" });
    expect(seen[0]!.headers).toMatchObject({ "content-type": "application/json", authorization: `Bearer ${"b".repeat(64)}` });
  });
  it("the panel's refresh calls the read with a body (POST), never a bare GET", () => {
    const panel = readFileSync("extension/panel.mjs", "utf8");
    expect(panel).toContain("const next = await call('/conversation', {});");
    expect(panel).not.toMatch(/call\('\/conversation'\)/);
    expect(JSON.parse(readFileSync("extension/manifest.json", "utf8")).version).toBe("0.5.0");
  });
});
