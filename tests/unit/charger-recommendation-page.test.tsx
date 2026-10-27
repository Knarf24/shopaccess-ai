import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderWithAppRouter as renderToStaticMarkup } from "./router-render";
import { afterEach, expect, it, vi } from "vitest";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { openFoundationStore } from "@/lib/session/snapshot-store";
import { recoverStateGate } from "@/lib/session/snapshot-state";
import { createRuntime } from "@/server/runtime";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { handleNeedsSubmit, handleChargerControl } from "@/server/handlers";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { needsDraftsFor } from "@/lib/session/store";
import { chargerTracksOf } from "@/lib/session/charger-clarification";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";
const SITE = "https://shop.example.test";
const paths: string[] = [];
afterEach(() => { paths.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });
const page = vi.hoisted(() => ({ runtime: null as unknown, cookie: "" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ cookie: page.cookie }) }));
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => undefined }));
vi.mock("@/server/runtime-access", async (original) => ({ ...(await original<typeof import("@/server/runtime-access")>()), openApplication: async () => ({ mode: "mock", runtime: { ok: true, value: page.runtime } }) }));
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
const renderNeeds = async (query: Record<string, string>, pathLang: "en" | "es" = query.lang === "es" ? "es" : "en"): Promise<string> => {
  try {
    return renderToStaticMarkup(<Fragment>{await resolveServer(NeedsPage({ params: Promise.resolve({ lang: pathLang }), searchParams: Promise.resolve(query) }))}</Fragment>);
  } catch (error) {
    const url = isRedirectError(error) ? getURLFromRedirectError(error) : null;
    const next = url?.startsWith("/es/") ? "es" : url?.startsWith("/en/") ? "en" : null;
    if (!next || next === pathLang) throw error;
    return renderNeeds(query, next);
  }
};
async function world(language: "en" | "es") {
 const dir = fs.mkdtempSync(join(tmpdir(), "sa-charger-purchase-")); fs.rmdirSync(dir);
 const key = `${dir}.key`; fs.writeFileSync(key, "disposable-test-key", { mode: 0o600 }); paths.push(dir, key);
 const opened = await openFoundationStore(dir, new Uint8Array(), { initializeEmpty: { keyFile: key }, format8TestStore: true });
 if (opened.status !== "ready") throw Error("store");
 const time = createTestClock(); const gate = await recoverStateGate(opened.value, time.clock()); if (gate.status !== "ready") throw Error("gate");
 const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([SITE]) }, { clock: time.clock, gate: gate.gate, chargerBudgetTestStore: true });
 const issued = await runtime.sessions.establish(null); if (!issued.ok) throw Error("session");
 const session = issued.value.session;
 const post = (path: string, fields: Record<string,string>) => new Request(SITE + path, { method: "POST", headers: { origin: SITE, "sec-fetch-site": "same-origin", cookie: `${SESSION_COOKIE_NAME}=${issued.value.issuedToken}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ lang: language, csrfToken: session.csrfToken, ...fields }) });
 await handleNeedsSubmit(post("/shop/needs/submit", { shopperText: "I need a charger for Mac14,2" }), runtime);
 const control = async (fields: Record<string,string>) => {
   const draft = needsDraftsFor(runtime.store).get(session.id)!; const track = chargerTracksOf(runtime.store).get(session.id)!;
   return handleChargerControl(post("/shop/needs/charger-control", { draftId: draft.draftId, revision: String(track.revision), ...fields }), runtime);
 };
 await control({ action: "confirm" }); await control({ action: "propose_budget", dollars: "59" }); await control({ action: "confirm_budget" });
 page.runtime = runtime; page.cookie = `${SESSION_COOKIE_NAME}=${issued.value.issuedToken}`;
 return { runtime, session, post, control, time };
}

it.each(["en", "es"] as const)("renders the eligible recommendation once in the real %s needs page and returns to confirmation after an edit", async language => {
 const w = await world(language);
 const before = structuredClone(w.runtime.durable.readPermissions());
 const html = await renderNeeds({ lang: language });
 expect(html.match(/<h1\b/g)).toHaveLength(1);
 expect(html.match(/class="charger-rec-layout"/g)).toHaveLength(1);
 expect(html.match(/id="charger-budget"/g)).toHaveLength(1);
 expect(html.match(/aria-current="step"/g)).toHaveLength(1);
 expect(html).not.toContain('action="/checkout/start"');
 expect(html).not.toContain('name="action" value="confirm_budget"');
 expect(html).toContain(language === "en" ? "Your recommended adapter" : "Su adaptador recomendado");
 expect(html).toContain('id="guided-page-title"');
 expect(w.runtime.durable.readPermissions()).toEqual(before);
 await w.control({ action: "propose_budget", dollars: "60" });
 const after = await renderNeeds({ lang: language });
 expect(after).not.toContain('class="charger-rec-layout"');
 expect(after).toContain('name="action" value="confirm_budget"');
 expect(after).not.toContain('action="/checkout/start"');
});


it.each(["en", "es"] as const)("passes saved charger facts and prioritized refusal to the %s voice controller", async language => {
 const w=await world(language);
 const findVoice=(node:ReactNode): ReactElement<Record<string,unknown>> | null => {
  if(Array.isArray(node)){for(const child of node){const found=findVoice(child);if(found)return found;}return null;}
  if(!isValidElement(node))return null;
  const element=node as ReactElement<Record<string,unknown>>;
  if(typeof element.type==="function" && element.type.name==="HandsFreeControls")return element;
  return findVoice(element.props.children as ReactNode);
 };
 const tree=await NeedsPage({params:Promise.resolve({lang:language}),searchParams:Promise.resolve({})});
 const voice=findVoice(await resolveServer(tree));expect(voice).not.toBeNull();
 expect(voice!.props.stage).toBe("options");
 expect(voice!.props.charger).toMatchObject({state:"confirmed",deviceId:"Mac14,2",confirmedCents:5900,purchasable:true,permitted:false});
 expect(voice!.props.options).toEqual([expect.objectContaining({title:"Apple 70W USB-C Power Adapter",priceCents:5900})]);
 expect(voice!.props.reply).toContain(language==="en" ? "Cable sold separately" : "El cable se vende por separado");
 const refused=findVoice(await resolveServer(await NeedsPage({params:Promise.resolve({lang:language}),searchParams:Promise.resolve({error:"PERMISSION_REQUIRED"})})));
 expect(refused!.props.notice).toBe(true);expect(refused!.props.reply).toContain(language==="en" ? "permission" : "permiso");
 await w.control({action:"propose_budget",dollars:"50"});
 const edited=findVoice(await resolveServer(await NeedsPage({params:Promise.resolve({lang:language}),searchParams:Promise.resolve({})})));
 expect(edited!.props.stage).toBe("charger");expect(edited!.props.options).toEqual([]);
 expect(edited!.props.reply).toContain("50.00");
});
