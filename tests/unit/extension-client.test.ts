import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  approvalUrl,
  beginPairing,
  createAnnouncer,
  createApi,
  createTurnIds,
  ensureInstallationId,
  matchCodeDisplay,
  normalizeAppOrigin,
  POLL_DELAYS_MS,
  replyAnnouncement,
  runPairingPoll,
} from "../../extension/client.mjs";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import {
  handleExtensionConversation,
  handleExtensionConversationGet,
  handleExtensionPairingExchange,
  handleExtensionPairingStart,
  handleExtensionPairingStatus,
  handleExtensionTurn,
} from "@/server/extension-handlers";
import { handleExtensionPairDecision, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-2 slice 5: the promoted side panel (extension/) against the real handlers, in memory. No browser, no TCP.
const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, "extension", ...parts), "utf8");

function memoryStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(key: string) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(values: Record<string, unknown>) {
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    async remove(keys: string | string[]) {
      for (const key of [keys].flat()) data.delete(key);
    },
  };
}

/** A fetch that dispatches to the extension handlers as Chrome would send it: extension Origin, no cookies. */
function handlerFetch(runtime: Runtime, calls: { method: string; path: string; headers: Headers }[]) {
  return async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    headers.set("origin", EXT);
    calls.push({ method: init.method ?? "GET", path: url.pathname, headers });
    const request = new Request(url, { method: init.method, headers, body: init.body });
    const path = url.pathname.replace("/api/extension/v1", "");
    const status = path.match(/^\/pairings\/([0-9a-f]{64})\/status$/);
    const exchange = path.match(/^\/pairings\/([0-9a-f]{64})\/exchange$/);
    if (path === "/pairings") return handleExtensionPairingStart(request, runtime);
    if (status) return handleExtensionPairingStatus(request, runtime, status[1]);
    if (exchange) return handleExtensionPairingExchange(request, runtime, exchange[1]);
    if (path === "/conversation") return request.method === "GET" ? handleExtensionConversationGet(runtime) : handleExtensionConversation(request, runtime);
    if (path === "/conversation/turns") return handleExtensionTurn(request, runtime);
    return new Response("{}", { status: 404 });
  };
}

describe("side panel client against the M2-2 API", () => {
  it("pairs through the website, reads the conversation and sends a turn, with no cookies and no redirects", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock });
    const created = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
    const token = created.headers.get("set-cookie")!.split(";")[0].split("=")[1];
    const resolved = await runtime.sessions.resolve(token);
    if (!resolved.ok) throw new Error("session");
    const cookie = `${SESSION_COOKIE_NAME}=${token}`;
    const form = (path: string, fields: Record<string, string>) =>
      new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie }, body: new URLSearchParams({ ...fields, csrfToken: resolved.value.csrfToken }).toString() });
    await handleNeedsSubmit(form("/shop/needs/submit", { lang: "en", shopperText: "", use: "schoolwork", budget: "500" }), runtime);

    const calls: { method: string; path: string; headers: Headers }[] = [];
    const local = memoryStorage();
    const session = memoryStorage();
    let access: { bearer: string } | null = null;
    const api = createApi({ origin: SITE, bearer: () => access?.bearer ?? null, fetchImpl: handlerFetch(runtime, calls) as typeof fetch });

    const installationId = await ensureInstallationId(local);
    expect(installationId).toMatch(/^ins_[0-9a-f]{32}$/);
    expect(await ensureInstallationId(local)).toBe(installationId);

    const pairing = await beginPairing({ api, session, installationId });
    expect(session.data.get("pairing")).toMatchObject({ pairingId: pairing.pairingId, polls: 0 });
    const url = new URL(approvalUrl(SITE, pairing.pairingId, "es"));
    expect(url.pathname).toBe("/extension/pair");
    expect(url.searchParams.get("lang")).toBe("es");

    const poll = () =>
      runPairingPoll({
        pairing,
        active: () => true,
        status: (p: typeof pairing) => api(`/pairings/${p.pairingId}/status`, { exchangeSecret: p.exchangeSecret }),
        exchange: (p: typeof pairing) => api(`/pairings/${p.pairingId}/exchange`, { exchangeSecret: p.exchangeSecret, verifier: p.verifier }),
        store: async (value: { bearer: string }) => {
          access = value;
        },
      });
    expect(await poll()).toBe("pending");
    await handleExtensionPairDecision(form("/extension/pair/decide", { pairingId: pairing.pairingId, matchCode: pairing.matchCode, decision: "approve", lang: "en" }), runtime);
    time.advance(5000);
    expect(await poll()).toBe("paired");
    expect(access).not.toBeNull();

    const view = await api("/conversation", {});
    expect(view.draft.version).toBeGreaterThan(0);
    const ids = createTurnIds();
    const id = ids.idFor(view.draft.draftId, view.draft.version, "for programming please");
    const next = await api("/conversation/turns", { draftId: view.draft.draftId, version: view.draft.version, shopperText: "for programming please", clientRequestId: id });
    expect(next.conversation.turns.map((t: { text: string }) => t.text)).toContain("for programming please");
    expect(needsDraftsFor(runtime.store).get(resolved.value.id)!.version).toBe(view.draft.version + 1);
    expect(JSON.stringify(next)).not.toMatch(/price|Cents|quote|checkout/i);

    for (const call of calls) {
      expect(call.headers.get("cookie")).toBeNull();
      expect(call.headers.get("origin")).toBe(EXT);
    }
  });

  it("a 401 drops the stored credential through onUnauthorized and throws the server code", async () => {
    let dropped = 0;
    const api = createApi({
      origin: SITE,
      bearer: () => "0".repeat(64),
      fetchImpl: (async () => Response.json({ ok: false, code: "TOKEN_INVALID" }, { status: 401 })) as unknown as typeof fetch,
      onUnauthorized: async () => {
        dropped += 1;
      },
    });
    await expect(api("/conversation", {})).rejects.toThrow("TOKEN_INVALID");
    expect(dropped).toBe(1);
  });

  it("accepts only an exact loopback-HTTP or HTTPS origin", () => {
    expect(normalizeAppOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(normalizeAppOrigin(" https://shop.example.test/ ")).toBe("https://shop.example.test");
    for (const bad of ["http://localhost:3000", "http://shop.example.test", "https://shop.example.test/path", "https://u:p@shop.example.test", "https://shop.example.test/?x=1", "javascript:alert(1)", "https://intranet", 42, ""])
      expect(normalizeAppOrigin(bad as string)).toBeNull();
  });

  it("polls at most ten times within the five-minute pairing", () => {
    expect(POLL_DELAYS_MS).toHaveLength(10);
    expect(POLL_DELAYS_MS.every((ms: number) => ms >= 2000)).toBe(true);
    expect(POLL_DELAYS_MS.reduce((a: number, b: number) => a + b, 0)).toBeLessThan(300_000);
  });

  it("keeps one client request id for a retry of the same message, and a new one otherwise", () => {
    let n = 0;
    const ids = createTurnIds(() => `request-${++n}`);
    const first = ids.idFor("nd_x", 2, "hello");
    expect(ids.idFor("nd_x", 2, "hello")).toBe(first);
    expect(ids.idFor("nd_x", 3, "hello")).not.toBe(first);
    ids.settled();
    expect(ids.idFor("nd_x", 3, "hello")).toBe("request-3");
  });

  it("announces only a newly arrived assistant line on the same draft, numbered by the caller", () => {
    const view = (draftId: string, turns: { role: string; text: string }[], language = "en") => ({ draft: { draftId }, conversation: { interfaceLanguage: language, turns } });
    const prev = view("nd_1", [{ role: "shopper", text: "a" }, { role: "assistant", text: "b" }]);
    const next = view("nd_1", [...prev.conversation.turns, { role: "shopper", text: "c" }, { role: "assistant", text: "d" }]);
    expect(replyAnnouncement(null, next, 1)).toBeNull();
    expect(replyAnnouncement(prev, structuredClone(prev), 1)).toBeNull();
    expect(replyAnnouncement(prev, next, 2)).toBe("Assistant reply 2: d");
    expect(replyAnnouncement(prev, { ...next, conversation: { ...next.conversation, interfaceLanguage: "es" } }, 2)).toBe("Respuesta del asistente 2: d");
    expect(replyAnnouncement(prev, view("nd_2", next.conversation.turns), 2)).toBeNull();
    expect(replyAnnouncement(prev, view("nd_1", [...prev.conversation.turns, { role: "shopper", text: "c" }]), 2)).toBeNull();

    const region = { textContent: "old" };
    const timers = new Map<number, () => void>();
    let t = 0;
    const announcer = createAnnouncer(region, { schedule: ((fn: () => void) => (timers.set(++t, fn), t)) as never, cancel: ((id: number) => timers.delete(id)) as never });
    announcer.say("first");
    announcer.say("second");
    expect(timers.size).toBe(1);
    for (const fn of timers.values()) fn();
    expect(region.textContent).toBe("second");
  });
});

describe("extension package", () => {
  it("MV3 with sidePanel and storage only, no install-time host access and no external connections", () => {
    const manifest = JSON.parse(read("manifest.json"));
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["sidePanel", "storage"]);
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(["http://127.0.0.1/*", "https://*/*"]);
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.content_scripts).toBeUndefined();
  });

  it("the panel has one polite atomic announcement region, keeps the bearer in session storage, and has no purchase action", () => {
    const html = read("panel.html");
    const regions = html.match(/<p id="announce"[^>]*>/g) ?? [];
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatch(/role="status"/);
    expect(regions[0]).toMatch(/aria-live="polite"/);
    expect(regions[0]).toMatch(/aria-atomic="true"/);
    const panel = read("panel.mjs");
    expect(panel).toMatch(/session\.set\(\{ access: stored \}\)/);
    expect(panel).not.toMatch(/local\.set\(\{ access/);
    const paths = [...panel.matchAll(/call\(`?'?([^`',)]+)/g)].map((m) => m[1]).sort();
    expect(paths).toEqual(["/conversation", "/conversation/turns", "/pairings/${p.pairingId}/exchange", "/pairings/${p.pairingId}/status"].sort());
    expect(read("client.mjs")).toMatch(/credentials: 'omit'/);
  });
});

/** A runtime with one website session, for the finding-3 tests below. */
async function codeWorld() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock });
  const created = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = created.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const resolved = await runtime.sessions.resolve(token);
  if (!resolved.ok) throw new Error("session");
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const form = (path: string, fields: Record<string, string>) =>
    new Request(`${SITE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: SITE, "sec-fetch-site": "same-origin", cookie }, body: new URLSearchParams({ ...fields, csrfToken: resolved.value.csrfToken }).toString() });
  return { time, runtime, form };
}

describe("finding 3: the matching code on the extension side", () => {
  it("shows six digits in two groups and reads them one at a time, keeping leading zeros", () => {
    expect(matchCodeDisplay("012345")).toEqual({ visual: "012 345", spoken: "0 1 2 3 4 5" });
    expect(matchCodeDisplay("000000")).toEqual({ visual: "000 000", spoken: "0 0 0 0 0 0" });
    for (const bad of [undefined, null, "", "12345", "1234567", "12a456", 123456]) expect(matchCodeDisplay(bad as never), String(bad)).toBeNull();
  });

  it("keeps the code from the start response only in session storage, and never sends it to status or exchange", async () => {
    const { runtime, time, form } = await codeWorld();
    const local = memoryStorage();
    const session = memoryStorage();
    const bodies: string[] = [];
    const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
      if (init.body) bodies.push(String(init.body));
      return handlerFetch(runtime, [])(input, init);
    }) as typeof fetch;
    const api = createApi({ origin: SITE, bearer: () => null, fetchImpl });
    const pairing = await beginPairing({ api, session, installationId: await ensureInstallationId(local) });
    expect(pairing.matchCode).toMatch(/^[0-9]{6}$/);
    expect((session.data.get("pairing") as { matchCode: string }).matchCode).toBe(pairing.matchCode);
    expect(JSON.stringify([...local.data.values()])).not.toContain(pairing.matchCode);
    await handleExtensionPairDecision(form("/extension/pair/decide", { pairingId: pairing.pairingId, matchCode: pairing.matchCode, decision: "approve", lang: "en" }), runtime);
    time.advance(5_000);
    await api(`/pairings/${pairing.pairingId}/status`, { exchangeSecret: pairing.exchangeSecret });
    await api(`/pairings/${pairing.pairingId}/exchange`, { exchangeSecret: pairing.exchangeSecret, verifier: pairing.verifier });
    expect(bodies).toHaveLength(3);
    for (const body of bodies) expect(JSON.parse(body)).not.toHaveProperty("matchCode");
  });

  it("refuses a start response without a valid code and stores nothing", async () => {
    const session = memoryStorage();
    for (const matchCode of [undefined, "12345", "abcdef", 12345]) {
      const api = (async () => ({ pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), expiresAt: Date.now() + 300_000, ...(matchCode === undefined ? {} : { matchCode }) })) as never;
      await expect(beginPairing({ api, session, installationId: `ins_${"1".repeat(32)}` }), String(matchCode)).rejects.toThrow("BAD_RESPONSE");
      expect(session.data.has("pairing")).toBe(false);
    }
  });
});
