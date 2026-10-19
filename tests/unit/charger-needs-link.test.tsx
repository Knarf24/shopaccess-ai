import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { handleNeedsSubmit, handleSessionStart } from "@/server/handlers";
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
const { default: NeedsPage } = await import("@/app/shop/needs/page");

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
const render = async (query: Record<string, string>) =>
  renderToStaticMarkup(<Fragment>{await resolveServer(NeedsPage({ searchParams: Promise.resolve(query) }))}</Fragment>);
const chargerLinks = (html: string) =>
  [...html.matchAll(/<a\b[^>]*href="(\/shop\/chargers[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), label: m[2] }));

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
  expect(response.headers.get("location")).toBe(`/shop/needs?lang=${lang}`);
  expect([...needsDraftsFor(runtime.store).values()].map((d) => d.language)).toEqual([lang]);
}

beforeEach(() => {
  page.runtime = null;
  page.cookie = "";
});

describe("guided needs page: charger information link", () => {
  it("English and Spanish without a saved draft: one link in the URL language", async () => {
    await shopper();
    expect(chargerLinks(await render({ lang: "en" }))).toEqual([{ href: "/shop/chargers?lang=en", label: LABEL.en }]);
    expect(chargerLinks(await render({ lang: "es" }))).toEqual([{ href: "/shop/chargers?lang=es", label: LABEL.es }]);
  });

  it("a saved Spanish draft wins over ?lang=en, and a saved English draft over ?lang=es", async () => {
    const spanish = await shopper();
    await draftIn(spanish.runtime, spanish.csrfToken, "es");
    expect(chargerLinks(await render({ lang: "en" }))).toEqual([{ href: "/shop/chargers?lang=es", label: LABEL.es }]);
    expect(chargerLinks(await render({}))).toEqual([{ href: "/shop/chargers?lang=es", label: LABEL.es }]);

    const english = await shopper();
    await draftIn(english.runtime, english.csrfToken, "en");
    expect(chargerLinks(await render({ lang: "es" }))).toEqual([{ href: "/shop/chargers?lang=en", label: LABEL.en }]);
  });

  it("sits between the purchase-permissions link and the home link, uses prefetch={false} and the charger copy module", async () => {
    await shopper();
    const html = await render({ lang: "en" });
    const permissions = html.indexOf('href="/shop/permissions?lang=en"');
    const chargers = html.indexOf('href="/shop/chargers?lang=en"');
    const home = html.lastIndexOf('href="/"');
    expect(permissions).toBeGreaterThan(-1);
    expect(chargers).toBeGreaterThan(permissions);
    expect(home).toBeGreaterThan(chargers);
    const source = readFileSync(join(process.cwd(), "src/app/shop/needs/page.tsx"), "utf8");
    expect(source).toMatch(/<Link href=\{`\/shop\/chargers\?lang=\$\{language\}`\} prefetch=\{false\} className="underline">\s*\{chargerCopy\(language\)\.needsLink\}\s*<\/Link>/);
  });
});
