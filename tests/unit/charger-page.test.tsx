import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { createRuntime, type Runtime } from "@/server/runtime";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

// F03 information slice: the charger page, rendered as Next would render it for one request. Mock mode uses a real
// in-memory runtime; PostgreSQL mode must not ask for its services. No session, profile, provider or extension is used.
const page = vi.hoisted(() => ({ mode: "mock" as "mock" | "postgres", runtime: null as unknown, servicesCalls: 0 }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/runtime-access")>()),
  openApplication: async () =>
    page.mode === "mock"
      ? { mode: "mock", runtime: { ok: true, value: page.runtime } }
      : {
          mode: "postgres",
          runtime: {
            services: async () => {
              page.servicesCalls += 1;
              return null;
            },
          },
        },
}));
const { default: ChargersPage } = await import("@/app/[lang]/shop/chargers/page");

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
const render = async (query: Record<string, string> = {}) =>
  renderToStaticMarkup(<Fragment>{await resolveServer(ChargersPage({ params: Promise.resolve({ lang: query.lang === "es" ? "es" : "en" }), searchParams: Promise.resolve(query) }))}</Fragment>);
const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => ENTITIES[entity]).replace(/\s+/g, " ");
const rows = (html: string) => [...html.matchAll(/<tr\b[^>]*data-configuration="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => ({ id: m[1], text: text(m[2]) }));
const links = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

function mockWorld(): Runtime {
  const time = createTestClock("2026-10-18T12:00:00.000Z");
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins(["https://shop.example.test"]) }, { clock: time.clock });
  page.runtime = runtime;
  return runtime;
}

const EN = {
  heading: "Charger information for your Mac",
  affiliation: "ShopAccess is not affiliated with Apple.",
  infoOnly: "These chargers are not sold here.",
  documented: "Apple lists this adapter and cable for this Mac.",
  fastConfig: "Apple's fast-charge list includes this exact adapter and cable for this Mac, which shows that this configuration charges it.",
  unsupportedStart: "Not supported in this configuration",
  gapUsbC: "Not established: the captured Apple specifications for this Mac document a MagSafe 2 power port and do not address charging through a USB-C charge cable.",
  gapMagSafe: "Not established: this Mac's documented power port is MagSafe 2 and this cable ends in MagSafe 3; the captured sources do not say whether they fit.",
  wattageOnly: "This compares wattage only; it does not show that this configuration charges this Mac.",
  fastDocumented: "Apple lists this configuration for fast charging.",
  fastNot: "Apple's captured fast-charge list does not include this configuration.",
  cableSold: "Charging cable sold separately.",
  unidentified: "That does not identify one Mac model in this comparison.",
};

beforeEach(() => {
  page.mode = "mock";
  page.runtime = null;
  page.servicesCalls = 0;
});

describe("charger information page: selection", () => {
  it("without a selection: the form, the affiliation note and no results; skip link targets the heading", async () => {
    mockWorld();
    const html = await render();
    const visible = text(html);
    for (const line of [EN.heading, EN.affiliation, EN.infoOnly]) expect(visible, line).toContain(line);
    const form = html.match(/<form\b[^>]*>/)?.[0] ?? "";
    expect(form).toContain('action="/en/shop/chargers"');
    expect(form).toContain('method="get"');
    expect(html).toContain('<label for="charger-device">');
    expect(html).toContain('<select id="charger-device" name="device"');
    expect(html).toContain('<label for="charger-identifier">');
    expect(html).toMatch(/<input[^>]*id="charger-identifier"[^>]*name="identifier"/);
    const options = [...html.matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([
      ["", "Choose a model"],
      ["Mac14,2", "MacBook Air (M2, 2022) — Mac14,2"],
      ["MacBookPro12,1", "MacBook Pro (Retina, 13-inch, Early 2015) — MacBookPro12,1"],
    ]);
    expect(rows(html)).toEqual([]);
    expect(html.indexOf('class="skip-link"')).toBeLessThan(html.indexOf("<select"));
    expect(html).toContain('href="#charger-heading"');
    expect(html).not.toMatch(/autofocus|tabindex="[1-9]/i);
    expect(links(html)).toEqual(expect.arrayContaining(["https://support.apple.com/en-us/102869", "https://support.apple.com/en-us/108052"]));
  });

  it("a description that is not an exact model identifier is not identified, and shows no results", async () => {
    mockWorld();
    for (const identifier of ["MacBook Pro 2019", "MacBook Air M2", "Mac14"]) {
      const html = await render({ identifier });
      expect(text(html), identifier).toContain(EN.unidentified);
      expect(rows(html), identifier).toEqual([]);
      expect(html, identifier).toMatch(/role="alert"/);
    }
  });
});

describe("charger information page: results", () => {
  it("MacBook Air (M2, 2022): four configurations, each with three separate claims and its sources", async () => {
    mockWorld();
    const html = await render({ device: "Mac14,2" });
    const found = rows(html);
    expect(found.map((r) => r.id)).toEqual(["A2743:usb-c-to-magsafe-3", "A2743:usb-c-charge-cable", "A2452:usb-c-to-magsafe-3", "A2452:usb-c-charge-cable"]);
    for (const row of found.slice(0, 2)) {
      expect(row.text, row.id).toContain(EN.documented);
      expect(row.text, row.id).toContain("70W is at or above the wattage of the adapter Apple included (30W or 35W, depending on configuration).");
      expect(row.text, row.id).toContain(EN.fastDocumented);
    }
    for (const row of found.slice(2)) {
      expect(row.text, row.id).toContain(EN.fastConfig);
      expect(row.text, row.id).toContain("140W is at or above the wattage of the adapter Apple included (30W or 35W, depending on configuration).");
    }
    expect(text(html)).toContain(EN.cableSold);
    expect(text(html).toLowerCase()).not.toMatch(/apple tested this|tested on this mac|tested with this mac/);
    expect(links(html)).toEqual(
      expect.arrayContaining([
        "https://support.apple.com/en-us/109509",
        "https://support.apple.com/en-us/111867",
        "https://support.apple.com/en-us/102378",
        "https://www.apple.com/shop/product/mxn53am/a/70w-usb-c-power-adapter",
        "https://www.apple.com/shop/product/mw2m3am/a/140w-usb-c-power-adapter",
      ]),
    );
    expect(text(html)).toContain("Accessed 2026-10-18");
    expect(html).toContain('href="#charger-results-heading"');
  });

  it("MacBook Pro (Retina, 13-inch, Early 2015): every configuration unknown with its specific gap; wattage and fast charging evaluated on their own", async () => {
    mockWorld();
    const html = await render({ device: "MacBookPro12,1" });
    const found = Object.fromEntries(rows(html).map((r) => [r.id, r.text]));
    for (const charger of ["A2743", "A2452"]) {
      const usbC = found[`${charger}:usb-c-charge-cable`] ?? "";
      const magSafe = found[`${charger}:usb-c-to-magsafe-3`] ?? "";
      expect(usbC, charger).toContain(EN.gapUsbC);
      expect(magSafe, charger).toContain(EN.gapMagSafe);
      for (const row of [usbC, magSafe]) {
        expect(row, charger).not.toContain(EN.unsupportedStart);
        expect(row, charger).toContain(EN.wattageOnly);
        expect(row, charger).toContain(EN.fastNot);
        expect(row, charger).not.toContain("Not applicable");
      }
    }
    expect(found["A2743:usb-c-charge-cable"]).toContain("70W is at or above the wattage of the adapter Apple included (60W).");
    expect(found["A2452:usb-c-to-magsafe-3"]).toContain("140W is at or above the wattage of the adapter Apple included (60W).");
    // The gap explanation never says or implies that this Mac has a USB-C port.
    expect(text(html)).not.toMatch(/this Mac(?:'s)? (?:has|have) (?:a )?USB-C|USB-C port on this Mac/i);
    expect(links(html)).toContain("https://support.apple.com/en-us/111959");
  });

  it("the model identifier selects the same results as the list", async () => {
    mockWorld();
    const byList = rows(await render({ device: "Mac14,2" }));
    const byIdentifier = rows(await render({ identifier: "mac14,2" }));
    expect(byList).toHaveLength(4);
    expect(byIdentifier).toEqual(byList);
  });
});

describe("charger information page: Spanish", () => {
  it("is marked Spanish, with Apple names marked English and a link to the English page", async () => {
    mockWorld();
    const html = await render({ lang: "es", device: "Mac14,2" });
    expect(html).toMatch(/<div lang="es"/);
    const visible = text(html);
    for (const line of [
      "Información de cargadores para su Mac",
      "ShopAccess no está afiliado con Apple.",
      "Apple indica este adaptador y este cable para este Mac.",
      "Apple indica esta configuración para la carga rápida.",
      "Consultado el 2026-10-18",
    ]) {
      expect(visible, line).toContain(line);
    }
    expect(html).toContain('<span lang="en">MacBook Air (M2, 2022)</span>');
    expect(html).toContain('<span lang="en">Apple 70W USB-C Power Adapter (Model A2743)</span>');
    expect(links(html)).toContain("/en/shop/chargers?device=Mac14%2C2");
    expect(visible).not.toContain(EN.documented);
  });
});

describe("charger information page: boundaries", () => {
  it("claims nothing beyond the evidence, in either language", async () => {
    mockWorld();
    const queries: Array<Record<string, string>> = [{}, { device: "Mac14,2" }, { device: "MacBookPro12,1" }, { lang: "es", device: "Mac14,2" }, { lang: "es", device: "MacBookPro12,1" }];
    for (const query of queries) {
      const html = await render(query);
      // Each device query must render its results, so this guard reads real claims, not an empty page.
      expect(rows(html).length, JSON.stringify(query)).toBe("device" in query ? 4 : 0);
      expect(text(html), JSON.stringify(query)).toMatch(/Apple/);
      const visible = text(html).toLowerCase();
      for (const phrase of ["full performance", "guarantee", "same speed", "compatible with all", "rendimiento completo", "garantiza", "misma velocidad", "buy now", "add to cart", "comprar"]) {
        expect(visible, `${JSON.stringify(query)} ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("reads no profile and calls no AI provider, and its modules import no profile, provider, extension or payment code", async () => {
    const runtime = mockWorld();
    const read = vi.spyOn(runtime.profiles, "read");
    const ai = [vi.spyOn(runtime.ai, "interpretNeeds"), vi.spyOn(runtime.ai, "suggestProducts"), vi.spyOn(runtime.ai, "explainAssessment")];
    await render({ device: "Mac14,2" });
    await render({ lang: "es", device: "MacBookPro12,1" });
    expect(read).not.toHaveBeenCalled();
    for (const spy of ai) expect(spy).not.toHaveBeenCalled();
    for (const file of ["src/app/[lang]/shop/chargers/page.tsx", "src/components/ChargerInformation.tsx", "src/lib/compatibility/rules.ts", "src/lib/compatibility/evidence.ts", "src/lib/i18n/charger-copy.ts"]) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/from "@\/(lib\/profile|lib\/providers|server\/extension|lib\/payment|lib\/permissions|lib\/checkout)/);
      expect(source, file).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("PostgreSQL mode: says the page is unavailable without asking for database services", async () => {
    page.mode = "postgres";
    const html = await render({ device: "Mac14,2" });
    expect(text(html)).toContain("Charger information is not available in this mode.");
    expect(rows(html)).toEqual([]);
    expect(page.servicesCalls).toBe(0);
  });
});

// Shared disclaimer (owner correction after r2): neutral in both languages and on both devices. It must not say or imply
// that every displayed configuration is Apple-listed (the 2015 model's configurations are not).
describe("charger information page: shared disclaimer", () => {
  const DISCLAIMER = {
    en: "Each result states what the captured Apple sources support. An unknown result is not a compatibility recommendation. An Apple-listed configuration is not necessarily one Apple tested on this exact model.",
    es: "Cada resultado indica lo que respaldan las fuentes de Apple capturadas. Un resultado desconocido no es una recomendación de compatibilidad. Una configuración que Apple indica no es necesariamente una que Apple haya probado con este modelo exacto.",
  };
  const FOOTNOTE = {
    en: "The adapters' model numbers come from Apple's test footnotes, which describe tests on other Mac models.",
    es: "Los números de modelo de los adaptadores proceden de las notas de prueba de Apple, que describen pruebas con otros modelos de Mac.",
  };
  const OLD = ["These are configurations Apple lists", "Estas son configuraciones que Apple indica", "not tests of these configurations on this Mac", "no pruebas de estas configuraciones con este Mac"];

  for (const lang of ["en", "es"] as const) {
    for (const device of ["Mac14,2", "MacBookPro12,1"]) {
      it(`${lang} ${device}: the neutral disclaimer and the model-number footnote, once each, with no claim that every row is Apple-listed`, async () => {
        mockWorld();
        const html = await render({ lang, device });
        const visible = text(html);
        expect(rows(html), `${lang} ${device}`).toHaveLength(4);
        expect(visible.split(DISCLAIMER[lang]).length - 1, `${lang} ${device}`).toBe(1);
        expect(visible.split(FOOTNOTE[lang]).length - 1, `${lang} ${device}`).toBe(1);
        for (const old of OLD) expect(visible, `${lang} ${device} ${old}`).not.toContain(old);
        // The disclaimer is in the page's language, not marked as another language.
        const paragraph = html.match(/<p\b([^>]*)>([^<]*)<\/p>/g)?.find((p) => p.includes(DISCLAIMER[lang].slice(0, 30))) ?? "";
        expect(paragraph, `${lang} ${device}`).not.toMatch(/\slang="/);
      });
    }
  }
});

// Cable-rating disclosure (owner addition): only the MacBook Air (M2, 2022) + 140W + USB-C charge cable row says that
// Apple's list names a USB-C charge cable without a power rating. No rating is stated or invented.
describe("charger information page: cable-rating qualification", () => {
  const NOTE = {
    en: "Apple lists a USB-C charge cable for this configuration, but the captured source does not specify its required power rating. This result does not establish that every USB-C cable is suitable.",
    es: "Apple indica un cable de carga USB-C para esta configuración, pero la fuente capturada no especifica la potencia nominal que requiere. Este resultado no establece que cualquier cable USB-C sea adecuado.",
  };
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: shown on the Air + 140W + USB-C charge cable row only, and on no 2015 row`, async () => {
      mockWorld();
      const air = Object.fromEntries(rows(await render({ lang, device: "Mac14,2" })).map((r) => [r.id, r.text]));
      expect(Object.keys(air)).toHaveLength(4);
      for (const [id, rowText] of Object.entries(air)) {
        expect(rowText.split(NOTE[lang]).length - 1, `${lang} ${id}`).toBe(id === "A2452:usb-c-charge-cable" ? 1 : 0);
      }
      for (const row of rows(await render({ lang, device: "MacBookPro12,1" }))) expect(row.text, `${lang} ${row.id}`).not.toContain(NOTE[lang]);
      // No rating is given anywhere on the page.
      expect(text(await render({ lang, device: "Mac14,2" }))).not.toMatch(/\d+\s?W (?:USB-C )?(?:charge )?cable|cable de \d+\s?W/i);
    });
  }
});

// Control visibility (run 5 browser finding: the identifier field had no visible boundary). Both form controls carry the
// same component-scoped classes as PreferencesForm: a zinc-500 border on a white fill. Labels and native controls stay.
describe("charger information page: form control styling", () => {
  const CONTROL_CLASSES = "rounded border border-zinc-500 bg-white px-2 py-2 text-black";
  for (const lang of ["en", "es"] as const) {
    it(`${lang}: the model select and identifier field have a visible border and white fill, and keep their labels`, async () => {
      mockWorld();
      const html = await render({ lang });
      const select = html.match(/<select\b[^>]*id="charger-device"[^>]*>/)?.[0] ?? "";
      const input = html.match(/<input\b[^>]*id="charger-identifier"[^>]*>/)?.[0] ?? "";
      expect(select, "select").toContain(`class="${CONTROL_CLASSES}"`);
      expect(input, "input").toContain(`class="${CONTROL_CLASSES}"`);
      expect(input).toContain('type="text"');
      expect(html).toContain('<label for="charger-device">');
      expect(html).toContain('<label for="charger-identifier">');
    });
  }
});
