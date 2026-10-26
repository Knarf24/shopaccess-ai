import { createHash } from "node:crypto";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { readFileSync } from "node:fs";
import { generateMatchCode, MAX_CODE_ATTEMPTS, pairingCodeDigest, PAIRING_LIFETIME_MS } from "@/lib/session/grants";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { handleExtensionConversation, handleExtensionPairingExchange, handleExtensionPairingStart, handleExtensionPairingStatus } from "@/server/extension-handlers";
import { handleExtensionPairDecision, handleNeedsSession } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// M2-2 finding 3: the six-digit matching code. Approval needs the code from the shopper's own side panel; the code is
// returned only to the panel that started the pairing, never echoed, never put in a URL, and five wrong codes end the
// pairing. Exchange still needs the exchange secret and the verifier. The "attacker" below is a synthetic test client.

const page = vi.hoisted(() => ({ runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(page.cookie ? { cookie: page.cookie } : {}) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () => ({ mode: "mock", runtime: { ok: true, value: page.runtime } }),
}));
const { default: ExtensionPairPage } = await import("@/app/[lang]/extension/pair/page");

const SITE = "https://shop.example.test";
const EXT = `chrome-extension://${"a".repeat(32)}`;
const API = `${SITE}/api/extension/v1`;
const VERIFIER = "f".repeat(64);
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("hex");
const ATTACKER_VERIFIER = "e".repeat(64);
const ATTACKER_CHALLENGE = createHash("sha256").update(ATTACKER_VERIFIER).digest("hex");

function world() {
  const time = createTestClock();
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]), extensionOrigins: new Set([EXT]) }, { clock: time.clock });
  return { time, runtime };
}
async function shopper(runtime: Runtime) {
  const response = await handleNeedsSession(new Request(`${SITE}/session/needs`), runtime);
  const token = response.headers.get("set-cookie")!.split(";")[0].split("=")[1];
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { cookie: `${SESSION_COOKIE_NAME}=${token}`, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}
const api = (path: string, body: unknown) => new Request(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: EXT }, body: JSON.stringify(body) });
const site = (fields: Record<string, string>, cookie: string, origin = SITE) =>
  new Request(`${SITE}/extension/pair/decide`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin, "sec-fetch-site": origin === SITE ? "same-origin" : "cross-site", cookie },
    body: new URLSearchParams(fields).toString(),
  });
type Started = { pairingId: string; exchangeSecret: string; matchCode: string; expiresAt: number };
async function start(runtime: Runtime, installation = "1", challenge = CHALLENGE) {
  const response = await handleExtensionPairingStart(api("/pairings", { protocolVersion: 1, challenge, installationId: `ins_${installation.repeat(32)}` }), runtime);
  return { response, value: (await response.clone().json()).value as Started };
}
const decide = (runtime: Runtime, buyer: { cookie: string; csrfToken: string }, pairingId: string, decision: "approve" | "deny", matchCode?: string) =>
  handleExtensionPairDecision(site({ csrfToken: buyer.csrfToken, pairingId, decision, lang: "en", ...(matchCode === undefined ? {} : { matchCode }) }, buyer.cookie), runtime);
async function statusOf(runtime: Runtime, pairing: Started, time: ReturnType<typeof createTestClock>) {
  time.advance(2_000);
  const response = await handleExtensionPairingStatus(api(`/pairings/${pairing.pairingId}/status`, { exchangeSecret: pairing.exchangeSecret }), runtime, pairing.pairingId);
  return { response, body: await response.json() };
}
const exchange = async (runtime: Runtime, pairing: Started, verifier = VERIFIER, exchangeSecret = pairing.exchangeSecret) => {
  const response = await handleExtensionPairingExchange(api(`/pairings/${pairing.pairingId}/exchange`, { exchangeSecret, verifier }), runtime, pairing.pairingId);
  return { response, body: await response.json() };
};
const read = (runtime: Runtime, bearer: string) => handleExtensionConversation(new Request(`${API}/conversation`, { method: "POST", headers: { origin: EXT, "content-type": "application/json", authorization: `Bearer ${bearer}` }, body: "{}" }), runtime);
const wrong = (code: string) => (code === "999999" ? "000000" : "999999");
/** Starts pairings until one has a code different from `other` (a one-in-a-million collision is retried, not skipped). */
async function startDistinct(runtime: Runtime, other: Started, installation: string, challenge = CHALLENGE) {
  for (let i = 0; i < 5; i++) {
    const started = await start(runtime, installation, challenge);
    if (started.value.matchCode !== other.matchCode) return started.value;
  }
  throw new Error("SYNTHETIC setup: five colliding codes");
}

describe("the matching code is six secure random digits, leading zeros kept", () => {
  it("formats the integer from the secure source as exactly six digits", () => {
    const calls: [number, number][] = [];
    const fake = (value: number) => (min: number, max: number) => (calls.push([min, max]), value);
    expect(generateMatchCode(fake(42))).toBe("000042");
    expect(generateMatchCode(fake(0))).toBe("000000");
    expect(generateMatchCode(fake(999_999))).toBe("999999");
    expect(calls.every(([min, max]) => min === 0 && max === 1_000_000)).toBe(true);
  });
  it("every started pairing gets a six-digit code from the default (crypto randomInt) generator", async () => {
    const { runtime } = world();
    for (let i = 0; i < 20; i++) expect((await start(runtime, String(i % 10))).value.matchCode).toMatch(/^[0-9]{6}$/);
  });
});

describe("the code is returned only in the initiating panel's start response, with no-store", () => {
  it("start returns the code with Cache-Control no-store; status and exchange never return it", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { response, value: pairing } = await start(runtime);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const status = await statusOf(runtime, pairing, time);
    expect(status.response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(status.body)).not.toContain(pairing.matchCode);
    // Only the status field; the server keeps no code to return (only its keyed digest).
    expect(Object.keys(status.body.value)).toEqual(["status"]);
    await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode);
    const exchanged = await exchange(runtime, pairing);
    expect(exchanged.response.status).toBe(200);
    expect(exchanged.response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(exchanged.body)).not.toContain(pairing.matchCode);
    expect(Object.keys(exchanged.body.value).sort()).toEqual(["bearer", "expiresAt", "grantId"]);
    // Saved state: grants keep only digests; neither the code nor its pairing is saved.
    expect(JSON.stringify(runtime.durable.readGrants())).not.toContain(pairing.matchCode);
  });
});

describe("approval is bound to the pending pairing's own code", () => {
  it("positive control: the right code approves, and the panel exchanges and reads", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    const decided = await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode);
    expect(decided.headers.get("location")).toBe("/en/extension/pair?result=approved");
    expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("approved");
    const grant = (await exchange(runtime, pairing)).body.value;
    expect((await read(runtime, grant.bearer)).status).toBe(200);
  });

  it("spaces in the typed code are ignored ('482 913')", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    const spaced = `${pairing.matchCode.slice(0, 3)} ${pairing.matchCode.slice(3)}`;
    expect((await decide(runtime, buyer, pairing.pairingId, "approve", spaced)).headers.get("location")).toBe("/en/extension/pair?result=approved");
  });

  it("a hyphen between the groups is ignored too ('482-913')", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    const hyphenated = `${pairing.matchCode.slice(0, 3)}-${pairing.matchCode.slice(3)}`;
    expect((await decide(runtime, buyer, pairing.pairingId, "approve", hyphenated)).headers.get("location")).toBe("/en/extension/pair?result=approved");
  });

  for (const [label, code] of [
    ["no code", undefined],
    ["an empty code", ""],
    ["five digits", "12345"],
    ["seven digits", "1234567"],
    ["letters", "abcdef"],
  ] as const) {
    it(`${label} does not approve and leaves the pairing pending`, async () => {
      const { runtime, time } = world();
      const buyer = await shopper(runtime);
      const { value: pairing } = await start(runtime);
      const decided = await decide(runtime, buyer, pairing.pairingId, "approve", code);
      expect(decided.headers.get("location")).toBe(`/en/extension/pair?pairing=${pairing.pairingId}&result=code_mismatch`);
      expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("pending");
    });
  }

  it("the right code for a different pairing never approves this one", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: a } = await start(runtime, "1");
    const b = await startDistinct(runtime, a, "2");
    expect((await decide(runtime, buyer, a.pairingId, "approve", b.matchCode)).headers.get("location")).toContain("result=code_mismatch");
    expect((await statusOf(runtime, a, time)).body.value.status).toBe("pending");
  });

  it("deny needs no code", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    expect((await decide(runtime, buyer, pairing.pairingId, "deny")).headers.get("location")).toBe("/en/extension/pair?result=denied");
    expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("denied");
    expect((await exchange(runtime, pairing)).response.status).toBe(409);
  });

  it(`the ${MAX_CODE_ATTEMPTS}th wrong code ends the pairing; the right code is refused afterwards and the panel sees denied`, async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
      expect((await decide(runtime, buyer, pairing.pairingId, "approve", wrong(pairing.matchCode))).headers.get("location"), `attempt ${i}`).toContain("result=code_mismatch");
    }
    expect((await decide(runtime, buyer, pairing.pairingId, "approve", wrong(pairing.matchCode))).headers.get("location")).toBe("/en/extension/pair?result=code_limit");
    expect((await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=failed");
    expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("denied");
    expect((await exchange(runtime, pairing)).response.status).toBe(409);
  });

  it("malformed and empty submissions count as failed attempts too", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    for (const bad of ["", "12", "abcdef", "1234567"]) await decide(runtime, buyer, pairing.pairingId, "approve", bad);
    expect((await decide(runtime, buyer, pairing.pairingId, "approve")).headers.get("location")).toBe("/en/extension/pair?result=code_limit");
    expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("denied");
  });

  it("one wrong code fewer than the limit, then the right code, still approves (positive control for the limit)", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) await decide(runtime, buyer, pairing.pairingId, "approve", wrong(pairing.matchCode));
    expect((await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=approved");
  });

  it("replay: after approval the same code is refused, and an expired pairing's code is refused", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode);
    expect((await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=failed");
    const { value: later } = await start(runtime, "2");
    time.advance(PAIRING_LIFETIME_MS);
    expect((await decide(runtime, buyer, later.pairingId, "approve", later.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=failed");
  });

  it("exchange still needs the exchange secret and the verifier after a correct code", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    await decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode);
    expect((await exchange(runtime, pairing, ATTACKER_VERIFIER)).body.code).toBe("VERIFIER_INVALID");
    const { value: other } = await start(runtime, "3");
    expect((await exchange(runtime, pairing, VERIFIER, other.exchangeSecret)).response.status).toBe(404);
  });
});

describe("concurrent decisions cannot bypass the limit or approve twice", () => {
  it("eight simultaneous wrong codes count exactly five attempts; the pairing ends once (under the 10-per-minute confirmation limit)", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    const results = await Promise.all(Array.from({ length: 8 }, () => decide(runtime, buyer, pairing.pairingId, "approve", wrong(pairing.matchCode))));
    const locations = results.map((r) => r.headers.get("location") ?? "");
    expect(locations.filter((l) => l.includes("result=code_mismatch"))).toHaveLength(MAX_CODE_ATTEMPTS - 1);
    expect(locations.filter((l) => l.endsWith("result=code_limit"))).toHaveLength(1);
    expect(locations.filter((l) => l.endsWith("result=failed"))).toHaveLength(8 - MAX_CODE_ATTEMPTS);
    expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("denied");
  });

  it("two simultaneous correct submissions approve once; one exchange succeeds and a replay is refused", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    const results = await Promise.all([1, 2].map(() => decide(runtime, buyer, pairing.pairingId, "approve", pairing.matchCode)));
    const locations = results.map((r) => r.headers.get("location"));
    expect(locations.filter((l) => l?.endsWith("result=approved"))).toHaveLength(1);
    expect(locations.filter((l) => l?.endsWith("result=failed"))).toHaveLength(1);
    expect((await exchange(runtime, pairing)).response.status).toBe(200);
    expect((await exchange(runtime, pairing)).response.status).not.toBe(200);
  });
});

describe("attack regression (SYNTHETIC attacker client with an allowed Origin)", () => {
  it("a shopper who enters their own panel's code on the attacker's link approves nothing; the attacker cannot exchange", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: attacker } = await start(runtime, "9", ATTACKER_CHALLENGE);
    const own = await startDistinct(runtime, attacker, "1");
    expect((await decide(runtime, buyer, attacker.pairingId, "approve", own.matchCode)).headers.get("location")).toContain("result=code_mismatch");
    expect((await statusOf(runtime, attacker, time)).body.value.status).toBe("pending");
    expect((await exchange(runtime, attacker, ATTACKER_VERIFIER)).body.code).toBe("PAIRING_NOT_APPROVED");
    // Positive control: the shopper's own pairing with its own code approves and works.
    expect((await decide(runtime, buyer, own.pairingId, "approve", own.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=approved");
    const grant = (await exchange(runtime, own)).body.value;
    expect((await read(runtime, grant.bearer)).status).toBe(200);
  });

  it("a shopper with no panel pairing has no code to enter, so the attacker's link cannot be approved by guessing within the limit", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: attacker } = await start(runtime, "9", ATTACKER_CHALLENGE);
    for (const guess of ["123456", "000000", "111111", "654321", "999999"].filter((g) => g !== attacker.matchCode).slice(0, MAX_CODE_ATTEMPTS)) {
      await decide(runtime, buyer, attacker.pairingId, "approve", guess);
    }
    expect((await statusOf(runtime, attacker, time)).body.value.status).toBe("denied");
    expect((await exchange(runtime, attacker, ATTACKER_VERIFIER)).body.code).toBe("PAIRING_NOT_APPROVED");
  });

  it("documented limit: if the attacker persuades the shopper to type the attacker's code, approval succeeds (not all phishing is prevented)", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: attacker } = await start(runtime, "9", ATTACKER_CHALLENGE);
    expect((await decide(runtime, buyer, attacker.pairingId, "approve", attacker.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=approved");
  });
});

describe("the decision needs an explicit POST with a session and CSRF; the code never appears in a URL", () => {
  it("a missing CSRF token, a foreign origin or no session decides nothing, even with the right code", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    for (const request of [
      site({ pairingId: pairing.pairingId, matchCode: pairing.matchCode, decision: "approve", lang: "en" }, buyer.cookie),
      site({ csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, matchCode: pairing.matchCode, decision: "approve", lang: "en" }, buyer.cookie, "https://evil.example"),
      site({ csrfToken: buyer.csrfToken, pairingId: pairing.pairingId, matchCode: pairing.matchCode, decision: "approve", lang: "en" }, ""),
    ]) {
      await handleExtensionPairDecision(request, runtime);
    }
    expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("pending");
  });

  it("no redirect for approve, mismatch, limit or deny contains the code", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: a } = await start(runtime, "1");
    const { value: b } = await start(runtime, "2");
    const { value: c } = await start(runtime, "3");
    const locations: string[] = [];
    locations.push((await decide(runtime, buyer, a.pairingId, "approve", a.matchCode)).headers.get("location")!);
    for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) locations.push((await decide(runtime, buyer, b.pairingId, "approve", wrong(b.matchCode))).headers.get("location")!);
    locations.push((await decide(runtime, buyer, c.pairingId, "deny", c.matchCode)).headers.get("location")!);
    for (const location of locations) for (const code of [a.matchCode, b.matchCode, wrong(b.matchCode), c.matchCode]) expect(location, location).not.toContain(code);
  });
});

async function resolveServer(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServer));
  if (!isValidElement(node)) return node;
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (typeof element.type === "function" && element.type.constructor.name === "AsyncFunction") {
    return resolveServer(await (element.type as (props: unknown) => Promise<ReactNode>)(element.props));
  }
  if (element.props.children === undefined) return element;
  const children = element.props.children;
  const resolved = Array.isArray(children) ? await Promise.all(children.map(resolveServer)) : [await resolveServer(children)];
  return cloneElement(element, undefined, ...resolved);
}
const renderPage = async (lang: "en" | "es", query: Record<string, string>) =>
  renderToStaticMarkup(<Fragment>{await resolveServer(ExtensionPairPage({ params: Promise.resolve({ lang }), searchParams: Promise.resolve(query) }))}</Fragment>);

describe("the approval page (rendered)", () => {
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: opening the link shows a labelled code field and warning, never a code, and decides nothing`, async () => {
      const { runtime, time } = world();
      const buyer = await shopper(runtime);
      const { value: pairing } = await start(runtime);
      page.runtime = runtime;
      page.cookie = buyer.cookie;
      const html = await renderPage(lang, { pairing: pairing.pairingId });
      expect(html).toContain('class="pairing-card"');
      expect(html).toContain('class="pairing-actions"');
      const approve = html.match(/<button[^>]*value="approve"[^>]*>/)?.[0] ?? "";
      expect(approve).toContain('class="pairing-primary"');
      expect(approve).toContain('name="decision"');
      expect(html).toMatch(/<label for="pair-code">/);
      const input = html.match(/<input id="pair-code"[^>]*>/)?.[0] ?? "";
      for (const attribute of ['name="matchCode"', 'type="text"', 'inputMode="numeric"', 'autoComplete="off"', 'maxLength="7"']) expect(input, attribute).toContain(attribute);
      expect(html).toContain('aria-describedby="pair-code-hint pair-code-warning"');
      expect(html).not.toMatch(/\brequired\b/);
      expect(html).toContain(lang === "en" ? "Enter only the code from your own ShopAccess side panel." : "Escriba solo el código de su propio panel lateral de ShopAccess.");
      expect(html).not.toContain(pairing.matchCode);
      expect(html).not.toMatch(/prevent(s)? (all )?phishing|impide (todo )?phishing/i);
      expect((await statusOf(runtime, pairing, time)).body.value.status).toBe("pending");
    });
  }

  it("a mismatch keeps the form with an announced alert and marks the field invalid", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    page.runtime = runtime;
    page.cookie = buyer.cookie;
    const html = await renderPage("en", { pairing: pairing.pairingId, result: "code_mismatch" });
    expect(html).toMatch(/<p role="alert" id="pair-code-mismatch" tabindex="-1" autofocus="">That code does not match this pairing request\./);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="pair-code-mismatch pair-code-hint pair-code-warning"');
    expect(html).not.toContain(pairing.matchCode);
  });

  it("approval shows a generic success message without any code; the limit message is an alert", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    page.runtime = runtime;
    page.cookie = buyer.cookie;
    const approved = await renderPage("en", { result: "approved" });
    expect(approved).toContain("Access allowed. Return to your side panel; it connects within a few seconds.");
    expect(approved).not.toMatch(/[0-9]{3} ?[0-9]{3}/);
    expect(await renderPage("es", { result: "code_limit" })).toMatch(/<p role="alert" id="pair-result" tabindex="-1" autofocus="">Demasiados códigos incorrectos\./);
  });
});

describe("review fixes (independent review round 1)", () => {
  it("the keyed digest is bound to the pairing ID: the same code gives a different digest for another pairing", () => {
    const key = Buffer.alloc(32, 7);
    const a = pairingCodeDigest(key, "a".repeat(64), "042424");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(pairingCodeDigest(key, "b".repeat(64), "042424")).not.toBe(a);
    expect(pairingCodeDigest(key, "a".repeat(64), "042425")).not.toBe(a);
    expect(pairingCodeDigest(Buffer.alloc(32, 8), "a".repeat(64), "042424")).not.toBe(a);
    expect(readFileSync("src/lib/session/grants.ts", "utf8")).toContain("const digestCode = (pairingId: string, code: string) => pairingCodeDigest(deps.key, pairingId, code);");
  });

  it("a correct code at the session's limit of waiting panels keeps the pairing pending, burns no attempt, and approves later", async () => {
    const { runtime, time } = world();
    const buyer = await shopper(runtime);
    const waiting: Started[] = [];
    for (const installation of ["1", "2", "3"]) {
      const { value } = await start(runtime, installation);
      await decide(runtime, buyer, value.pairingId, "approve", value.matchCode);
      waiting.push(value);
    }
    const { value: fourth } = await start(runtime, "4");
    // Four wrong codes first: if the session-limit refusal burned an attempt, the later correct code would hit the limit of five.
    for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) await decide(runtime, buyer, fourth.pairingId, "approve", wrong(fourth.matchCode));
    const limited = await decide(runtime, buyer, fourth.pairingId, "approve", fourth.matchCode);
    expect(limited.headers.get("location")).toBe(`/en/extension/pair?pairing=${fourth.pairingId}&result=pair_limit`);
    expect(limited.headers.get("location")).not.toContain(fourth.matchCode);
    expect((await statusOf(runtime, fourth, time)).body.value.status).toBe("pending");
    expect((await exchange(runtime, waiting[0]!)).response.status).toBe(200);
    expect((await decide(runtime, buyer, fourth.pairingId, "approve", fourth.matchCode)).headers.get("location")).toBe("/en/extension/pair?result=approved");
  });

  it("the page announces the session-limit message on the same pairing's form, and moves focus to every result and alert", async () => {
    const { runtime } = world();
    const buyer = await shopper(runtime);
    const { value: pairing } = await start(runtime);
    page.runtime = runtime;
    page.cookie = buyer.cookie;
    const html = await renderPage("en", { pairing: pairing.pairingId, result: "pair_limit" });
    expect(html).toMatch(/<p role="alert" id="pair-code-mismatch" tabindex="-1" autofocus="">The code matches, but three side panels are already waiting/);
    expect(html).toContain('name="matchCode"');
    expect(html).not.toContain('aria-invalid="true"');
    // Focus moves on load through server-rendered autofocus (no client module; SEC-01 unchanged).
    expect(html).toMatch(/<p role="alert" id="pair-code-mismatch" tabindex="-1" autofocus="">/);
    expect(await renderPage("en", { result: "approved" })).toMatch(/<p role="status" id="pair-result" tabindex="-1" autofocus="">/);
    expect(await renderPage("en", { result: "code_limit" })).toMatch(/<p role="alert" id="pair-result" tabindex="-1" autofocus="">/);
    expect((await renderPage("es", { pairing: pairing.pairingId })).includes("Tras 5 códigos incorrectos, esta solicitud se cancela.")).toBe(true);
  });
});
