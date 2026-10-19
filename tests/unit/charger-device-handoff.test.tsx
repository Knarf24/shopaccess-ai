import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { readConversation } from "@/lib/session/conversation";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { extensionConversationView } from "@/server/extension-handlers";
import { handleNeedsSubmit, handleSessionStart } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// F03 device hand-off (owner-approved): the guided needs page offers a native GET form that sends only the chosen exact
// model and the journey's language to the existing charger page. Nothing is chosen for the shopper, nothing is saved,
// and no profile, provider, conversation or extension state is touched. Mock mode, real in-memory runtime.
const ORIGIN = "https://shop.example.test";
const page = vi.hoisted(() => ({ runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: page.cookie }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () => ({ mode: "mock", runtime: { ok: true, value: page.runtime } }),
}));
const { default: NeedsPage } = await import("@/app/shop/needs/page");
const { default: ChargersPage } = await import("@/app/shop/chargers/page");

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
const renderNeeds = async (query: Record<string, string>) =>
  renderToStaticMarkup(<Fragment>{await resolveServer(NeedsPage({ searchParams: Promise.resolve(query) }))}</Fragment>);
const renderChargers = async (query: Record<string, string>) =>
  renderToStaticMarkup(<Fragment>{await resolveServer(ChargersPage({ searchParams: Promise.resolve(query) }))}</Fragment>);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]).replace(/\s+/g, " ");

const COPY = {
  en: { label: "Which Mac is this for?", placeholder: "Choose an exact model", button: "Show charger information for this Mac", link: "Explore charger information" },
  es: { label: "¿Para qué Mac es?", placeholder: "Elija un modelo exacto", button: "Mostrar información de cargadores para este Mac", link: "Consultar información sobre cargadores" },
};

/** The hand-off form: the one GET form on the needs page whose action is the charger page. */
function handoff(html: string) {
  const form = html.match(/<form\b[^>]*action="\/shop\/chargers"[^>]*>[\s\S]*?<\/form>/)?.[0] ?? "";
  const open = form.match(/<form\b[^>]*>/)?.[0] ?? "";
  return {
    form,
    method: open.match(/\smethod="([^"]*)"/)?.[1] ?? null,
    hidden: [...form.matchAll(/<input\b[^>]*type="hidden"[^>]*>/g)].map((m) => ({ name: m[0].match(/name="([^"]*)"/)?.[1], value: m[0].match(/value="([^"]*)"/)?.[1] })),
    options: [...form.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)].map((m) => ({ value: m[1].match(/value="([^"]*)"/)?.[1] ?? null, selected: /\sselected=""/.test(m[1]), text: m[2] })),
    selectName: form.match(/<select\b[^>]*name="([^"]*)"/)?.[1] ?? null,
    labelFor: form.match(/<label\b[^>]*for="([^"]*)"[^>]*>([^<]*)<\/label>/)?.slice(1) ?? [],
    selectId: form.match(/<select\b[^>]*id="([^"]*)"/)?.[1] ?? null,
    button: text(form.match(/<button\b[^>]*>([\s\S]*?)<\/button>/)?.[1] ?? "").trim(),
    textInputs: (form.match(/<input\b[^>]*type="text"/g) ?? []).length,
  };
}

async function shopper(): Promise<{ runtime: Runtime; sessionId: string; csrfToken: string }> {
  const time = createTestClock("2026-10-19T12:00:00.000Z");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  page.runtime = runtime;
  const started = await handleSessionStart(new Request(`${ORIGIN}/session/start?use=schoolwork&budget=600`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  page.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { runtime, sessionId: session.value.id, csrfToken: session.value.csrfToken };
}

async function draftIn(runtime: Runtime, csrfToken: string, lang: "en" | "es", shopperText = "") {
  const response = await handleNeedsSubmit(
    new Request(`${ORIGIN}/shop/needs/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
      body: new URLSearchParams({ lang, shopperText, use: "schoolwork", budget: "600", csrfToken }).toString(),
    }),
    runtime,
  );
  expect(response.headers.get("location")).toMatch(new RegExp(`^/shop/needs\\?lang=${lang}`));
}

/** Everything the hand-off must leave untouched for this session. */
function state(runtime: Runtime, sessionId: string) {
  return structuredClone({
    draft: needsDraftsFor(runtime.store).get(sessionId) ?? null,
    conversation: readConversation(runtime.store, sessionId),
    profiles: runtime.durable.readProfiles(),
    permissions: runtime.durable.readPermissions(),
    grants: runtime.durable.readGrants(),
    extension: extensionConversationView(runtime, sessionId),
  });
}

beforeEach(() => {
  page.runtime = null;
  page.cookie = "";
});

describe("guided needs page: device hand-off form", () => {
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: a native GET form to /shop/chargers with the journey language, only the curated models, and the empty placeholder selected`, async () => {
      await shopper();
      const html = await renderNeeds({ lang });
      const form = handoff(html);
      expect(form.form, "form present").not.toBe("");
      expect(form.method).toBe("get");
      expect(form.hidden).toEqual([{ name: "lang", value: lang }]);
      expect(form.selectName).toBe("device");
      expect(form.labelFor).toEqual([form.selectId, COPY[lang].label]);
      expect(form.options).toEqual([
        { value: "", selected: true, text: COPY[lang].placeholder },
        { value: "Mac14,2", selected: false, text: "MacBook Air (M2, 2022) — Mac14,2" },
        { value: "MacBookPro12,1", selected: false, text: "MacBook Pro (Retina, 13-inch, Early 2015) — MacBookPro12,1" },
      ]);
      expect(form.button).toBe(COPY[lang].button);
      // No free-text identification on the needs page; the existing link stays.
      expect(form.textInputs).toBe(0);
      expect(html).toContain(`href="/shop/chargers?lang=${lang}"`);
      expect(text(html)).toContain(COPY[lang].link);
    });
  }

  it("a saved draft's language wins over a conflicting ?lang, for the hidden field and the labels", async () => {
    const spanish = await shopper();
    await draftIn(spanish.runtime, spanish.csrfToken, "es");
    const es = handoff(await renderNeeds({ lang: "en" }));
    expect(es.hidden).toEqual([{ name: "lang", value: "es" }]);
    expect(es.button).toBe(COPY.es.button);

    const english = await shopper();
    await draftIn(english.runtime, english.csrfToken, "en");
    const en = handoff(await renderNeeds({ lang: "es" }));
    expect(en.hidden).toEqual([{ name: "lang", value: "en" }]);
    expect(en.button).toBe(COPY.en.button);
  });

  it("nothing is chosen for the shopper: not from needs text naming a model, a saved profile, or a device in the URL", async () => {
    const { runtime, sessionId, csrfToken } = await shopper();
    await draftIn(runtime, csrfToken, "en", "I need a charger for my MacBook Air M2 Mac14,2");
    const saved = await runtime.profiles.save(sessionId, { version: 0, brand: { consent: true, text: "Apple" }, model: { consent: true, text: "MacBook Air (M2, 2022)" } });
    expect(saved.ok).toBe(true);
    const read = vi.spyOn(runtime.profiles, "read");
    const queries: Array<Record<string, string>> = [{ lang: "en" }, { lang: "en", device: "Mac14,2" }, { lang: "en", identifier: "Mac14,2" }];
    for (const query of queries) {
      const options = handoff(await renderNeeds(query)).options;
      expect(options.filter((o) => o.selected).map((o) => o.value), JSON.stringify(query)).toEqual([""]);
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe("charger page reached through the hand-off", () => {
  it("the form's query shows that model's results in the journey language", async () => {
    await shopper();
    const html = await renderChargers({ lang: "es", device: "Mac14,2" });
    expect(html).toMatch(/<div lang="es"/);
    expect([...html.matchAll(/data-configuration="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "A2743:usb-c-to-magsafe-3",
      "A2743:usb-c-charge-cable",
      "A2452:usb-c-to-magsafe-3",
      "A2452:usb-c-charge-cable",
    ]);
  });

  it("an empty choice shows no results and no alert; unknown or prototype-named identifiers stay unidentified", async () => {
    await shopper();
    const empty = await renderChargers({ lang: "en", device: "" });
    expect(empty).not.toMatch(/data-configuration=/);
    expect(empty).not.toMatch(/role="alert"/);
    for (const device of ["MacBookPro15,4", "Mac14", "__proto__", "constructor", "toString", "MacBook Air"]) {
      const html = await renderChargers({ lang: "en", device });
      expect(html, device).not.toMatch(/data-configuration=/);
      expect(text(html), device).toContain("That does not identify one Mac model in this comparison.");
    }
  });

  it("opening the needs page and the hand-off target changes no draft, conversation, profile, permission, grant or extension view, and calls no provider", async () => {
    const { runtime, sessionId, csrfToken } = await shopper();
    await draftIn(runtime, csrfToken, "es");
    const before = state(runtime, sessionId);
    const calls = [
      vi.spyOn(runtime.ai, "interpretNeeds"),
      vi.spyOn(runtime.ai, "suggestProducts"),
      vi.spyOn(runtime.ai, "explainAssessment"),
      vi.spyOn(runtime.channel3, "read"),
    ];
    const read = vi.spyOn(runtime.profiles, "read");
    await renderNeeds({ lang: "es" });
    const afterNeeds = calls.map((spy) => spy.mock.calls.length);
    const targets: Array<Record<string, string>> = [{ lang: "es", device: "Mac14,2" }, { lang: "es", device: "MacBookPro12,1" }, { lang: "es", device: "__proto__" }];
    for (const query of targets) await renderChargers(query);
    expect(state(runtime, sessionId)).toEqual(before);
    // The charger page adds no provider or listing call beyond what the needs page itself already makes.
    expect(calls.map((spy) => spy.mock.calls.length)).toEqual(afterNeeds);
    expect(calls.slice(0, 3).map((spy) => spy.mock.calls.length)).toEqual([0, 0, 0]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("hand-off boundaries in source", () => {
  it("is server-rendered and imports no profile, provider, extension, payment, checkout or session-state module", () => {
    const source = readFileSync(join(process.cwd(), "src/components/ChargerDeviceHandoff.tsx"), "utf8");
    expect(source).not.toMatch(/^\s*["']use client["']/m);
    expect(source).not.toMatch(/from "@\/(lib\/profile|lib\/providers|server\/extension|lib\/payment|lib\/permissions|lib\/checkout|lib\/session)/);
    const needs = readFileSync(join(process.cwd(), "src/app/shop/needs/page.tsx"), "utf8");
    expect(needs).toMatch(/<ChargerDeviceHandoff language=\{language\} \/>/);
  });
});
