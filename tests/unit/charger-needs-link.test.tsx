import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderWithAppRouter as renderToStaticMarkup } from "./router-render";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { handleChargerControl, handleNeedsSubmit, handleSessionStart } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// F03 discoverability: the guided needs page links to the charger information page in the journey's language. The
// saved draft's language wins over a URL `lang`, as for the rest of the page. Mock mode, real in-memory runtime.
const ORIGIN = "https://shop.example.test";
const page = vi.hoisted(() => ({ runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: page.cookie }) }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () => ({ mode: "mock", runtime: { ok: true, value: page.runtime } }),
}));
const { default: NeedsPage } = await import("@/app/[lang]/shop/needs/page");

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
const render = async (query: Record<string, string>, pathLang: "en" | "es" = query.lang === "es" ? "es" : "en"): Promise<string> => {
  try {
    return renderToStaticMarkup(<Fragment>{await resolveServer(NeedsPage({ params: Promise.resolve({ lang: pathLang }), searchParams: Promise.resolve(query) }))}</Fragment>);
  } catch (error) {
    const url = isRedirectError(error) ? getURLFromRedirectError(error) : null;
    const next = url?.startsWith("/es/") ? "es" : url?.startsWith("/en/") ? "en" : null;
    if (!next || next === pathLang) throw error;
    return render(query, next);
  }
};
const chargerLinks = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="(\/(?:en|es)\/shop\/chargers[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), label: m[2] }));

const LABEL = { en: "Explore charger information", es: "Consultar información sobre cargadores" };

async function shopper(): Promise<{ runtime: Runtime; csrfToken: string }> {
  const time = createTestClock("2026-10-18T12:00:00.000Z");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
  page.runtime = runtime;
  const started = await handleSessionStart(new Request(`${ORIGIN}/session/start?use=schoolwork&budget=600`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  page.cookie = `${SESSION_COOKIE_NAME}=${token}`;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session");
  return { runtime, csrfToken: session.value.csrfToken };
}

/** Saves a needs draft in `lang` through the real submit handler. */
async function draftIn(runtime: Runtime, csrfToken: string, lang: "en" | "es") {
  const response = await handleNeedsSubmit(
    new Request(`${ORIGIN}/shop/needs/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
      body: new URLSearchParams({ lang, shopperText: "", use: "schoolwork", budget: "600", csrfToken }).toString(),
    }),
    runtime,
  );
  expect(response.headers.get("location")).toBe(`/${lang}/shop/needs`);
  expect([...needsDraftsFor(runtime.store).values()].map((d) => d.language)).toEqual([lang]);
}

beforeEach(() => {
  page.runtime = null;
  page.cookie = "";
});

describe("guided needs page: charger information link", () => {
  it("offers explicit Spanish entry for an existing English draft without changing it on GET", async () => {
    const current = await shopper();
    await draftIn(current.runtime, current.csrfToken, "en");
    const html = await render({ started: "1" }, "es");
    expect(html).toContain("Continuar en español");
    expect(html).toContain('action="/shop/needs/language"');
    expect([...needsDraftsFor(current.runtime.store).values()][0].language).toBe("en");
  });
  it("English and Spanish without a saved draft: one link in the URL language", async () => {
    await shopper();
    expect(chargerLinks(await render({ lang: "en" }))).toEqual([{ href: "/en/shop/chargers", label: LABEL.en }]);
    expect(chargerLinks(await render({ lang: "es" }))).toEqual([{ href: "/es/shop/chargers", label: LABEL.es }]);
  });

  it("a saved Spanish draft wins over ?lang=en, and a saved English draft over ?lang=es", async () => {
    const spanish = await shopper();
    await draftIn(spanish.runtime, spanish.csrfToken, "es");
    expect(chargerLinks(await render({ lang: "en" }))).toEqual([{ href: "/es/shop/chargers", label: LABEL.es }]);
    expect(chargerLinks(await render({}))).toEqual([{ href: "/es/shop/chargers", label: LABEL.es }]);

    const english = await shopper();
    await draftIn(english.runtime, english.csrfToken, "en");
    expect(chargerLinks(await render({ lang: "es" }))).toEqual([{ href: "/en/shop/chargers", label: LABEL.en }]);
  });

  it("sits between the purchase-permissions link and the home link, uses prefetch={false} and the charger copy module", async () => {
    await shopper();
    const html = await render({ lang: "en" });
    const permissions = html.indexOf('href="/en/shop/permissions"');
    const chargers = html.indexOf('href="/en/shop/chargers"');
    const home = html.lastIndexOf('href="/"');
    expect(permissions).toBeGreaterThan(-1);
    expect(chargers).toBeGreaterThan(permissions);
    expect(home).toBeGreaterThan(chargers);
    const source = readFileSync(join(process.cwd(), "src/app/[lang]/shop/needs/page.tsx"), "utf8");
    expect(source).toMatch(/<Link href=\{`\/\$\{language\}\/shop\/chargers`\} prefetch=\{false\} className="underline">\s*\{chargerCopy\(language\)\.needsLink\}\s*<\/Link>/);
  });

  it("renders the saved-language charger clarification, website controls and confirmed information comparison", async () => {
    const buyer = await shopper();
    await draftIn(buyer.runtime, buyer.csrfToken, "es");
    const draft = [...needsDraftsFor(buyer.runtime.store).values()][0]!;
    const submit = (fields: Record<string, string>) => new Request(`${ORIGIN}/shop/needs/submit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
      body: new URLSearchParams({ ...fields, csrfToken: buyer.csrfToken }).toString(),
    });
    await handleNeedsSubmit(submit({ lang: "es", draftId: draft.draftId, version: String(draft.version), shopperText: "Charger for my laptop", use: "schoolwork", budget: "600" }), buyer.runtime);
    const awaiting = await render({ lang: "en" });
    expect(awaiting).toContain("¿Para qué modelo exacto de Mac es este cargador?");
    expect(awaiting).toContain('action="/shop/needs/charger-control"');
    expect(awaiting).toContain('id="charger-conversation-model"');
    expect(awaiting).not.toContain('name="use"');

    const updated = [...needsDraftsFor(buyer.runtime.store).values()][0]!;
    const control = (fields: Record<string, string>) => new Request(`${ORIGIN}/shop/needs/charger-control`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
      body: new URLSearchParams({ ...fields, lang: "en", draftId: updated.draftId, csrfToken: buyer.csrfToken }).toString(),
    });
    await handleChargerControl(control({ revision: "1", action: "choose_model", device: "Mac14,2" }), buyer.runtime);
    const candidate = await render({ lang: "en" });
    expect(candidate).toContain("Modelo seleccionado:");
    expect(candidate).toContain('lang="en">MacBook Air (M2, 2022) (Mac14,2)</span>');
    expect(candidate).toContain("Confirme en este sitio web");
    expect(candidate).toContain("Responda con el identificador exacto del modelo de Mac o elija un modelo abajo");
    expect(candidate).not.toContain("no queda confirmada hasta que confirmes el resumen");

    await handleChargerControl(control({ revision: "2", action: "confirm" }), buyer.runtime);
    const confirmed = await render({ lang: "en" });
    expect(confirmed).toContain('data-configuration="A2452:usb-c-charge-cable"');
    expect(confirmed).toContain("Esta página solo da información");
    expect(confirmed).not.toContain("Assessment summary");
    expect(confirmed).toContain("Confirme el modelo en este sitio web");
    expect(confirmed).not.toContain("confirmes el resumen");
  });

  it("replaces charger clarification wording in English but retains laptop clarification copy", async () => {
    const buyer = await shopper();
    const charger = await handleNeedsSubmit(
      new Request(`${ORIGIN}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
        body: new URLSearchParams({ lang: "en", shopperText: "Charger for my laptop", csrfToken: buyer.csrfToken }).toString(),
      }),
      buyer.runtime,
    );
    expect(charger.status).toBe(303);
    const chargerMarkup = await render({ lang: "en" });
    expect(chargerMarkup).toContain("Reply with the exact Mac model identifier or choose a model below");
    expect(chargerMarkup).toContain("Confirm the model on this website");
    expect(chargerMarkup).not.toContain("A reply or a choice is not confirmed until you confirm the summary");

    const laptopBuyer = await shopper();
    await handleNeedsSubmit(
      new Request(`${ORIGIN}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
        body: new URLSearchParams({ lang: "en", shopperText: "I need a laptop for school", csrfToken: laptopBuyer.csrfToken }).toString(),
      }),
      laptopBuyer.runtime,
    );
    const laptopMarkup = await render({ lang: "en" });
    expect(laptopMarkup).toContain("A reply or a choice is not confirmed until you confirm the summary");
    expect(laptopMarkup).not.toContain("Reply with the exact Mac model identifier");
  });

  it.each([
    { language: "en" as const, text: "I need a laptop and a charger", label: "Which task should we work on now", laptop: "Continue laptop shopping", charger: "Continue charger information" },
    { language: "es" as const, text: "Necesito una laptop y un cargador", label: "¿Qué tarea quiere continuar ahora", laptop: "Continuar con la búsqueda de un portátil", charger: "Continuar con la información de cargadores" },
  ])("renders localized task-choice website controls in $language", async ({ language, text, label, laptop, charger }) => {
    const buyer = await shopper();
    const response = await handleNeedsSubmit(
      new Request(`${ORIGIN}/shop/needs/submit`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: page.cookie },
        body: new URLSearchParams({ lang: language, shopperText: text, csrfToken: buyer.csrfToken }).toString(),
      }),
      buyer.runtime,
    );
    expect(response.status).toBe(303);
    const markup = await render({ lang: language });
    expect(markup).toContain(label);
    expect(markup).toContain(laptop);
    expect(markup).toContain(charger);
    expect(markup.indexOf(label)).toBeLessThan(markup.indexOf(laptop));
    expect(markup.indexOf(laptop)).toBeLessThan(markup.indexOf('id="shopper-reply"'));
    expect(markup).toContain('action="/shop/needs/charger-control"');
    expect(markup).not.toContain("Confirm your laptop requirements");
  });
});
