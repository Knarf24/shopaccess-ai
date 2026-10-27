import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsLanguageChoice } from "@/components/mock-journey/NeedsLanguageChoice";
import { handleNeedsLanguage, handleNeedsSession, handleNeedsSubmit, handleNeedsConfirm } from "@/server/handlers";
import { createRuntime } from "@/server/runtime";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { readConversation } from "@/lib/session/conversation";
import { createTestClock, TEST_SESSION_KEY } from "./helpers";

const origin = "https://shop.example.test";
async function fixture() {
  const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([origin]) }, { clock: createTestClock().clock });
  const response = await handleNeedsSession(new Request(origin + "/session/needs"), runtime);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const session = await runtime.sessions.resolve(cookie.split("=")[1]);
  if (!session.ok) throw Error("missing session");
  const post = (path: string, fields: Record<string,string>) => new Request(origin + path, { method: "POST", headers: { origin, cookie, "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" }, body: new URLSearchParams({csrfToken: session.value.csrfToken, ...(path.endsWith("/language") ? {fromLang:"en"} : {}), ...fields}) });
  await handleNeedsSubmit(post("/shop/needs/submit", {lang:"en",use:"schoolwork",budget:"700"}), runtime);
  let draft = needsDraftsFor(runtime.store).get(session.value.id)!;
  await handleNeedsConfirm(post("/shop/needs/confirm",{lang:"en",draftId:draft.draftId,version:String(draft.version),use:"schoolwork",budget:"700"}),runtime);
  draft = needsDraftsFor(runtime.store).get(session.value.id)!;
  return {runtime,post,session:session.value,draft};
}

describe("explicit shopping language choice", () => {
  it("switches the saved interface without changing confirmed needs or conversation words", async () => {
    const f=await fixture(); const before=readConversation(f.runtime.store,f.session.id);
    const response=await handleNeedsLanguage(f.post("/shop/needs/language",{lang:"es",draftId:f.draft.draftId,version:String(f.draft.version)}),f.runtime);
    expect(response.headers.get("location")).toBe("/es/shop/needs");
    const after=needsDraftsFor(f.runtime.store).get(f.session.id)!;
    expect(after).toEqual({...f.draft,language:"es"});
    expect(readConversation(f.runtime.store,f.session.id)?.turns).toEqual(before?.turns);
    expect(readConversation(f.runtime.store,f.session.id)?.interfaceLanguage).toBe("es");
  });
  it("refuses a stale tab and a missing CSRF token without changing the saved language", async () => {
    const f=await fixture();
    const fields={lang:"es",draftId:f.draft.draftId,version:String(f.draft.version+1)};
    expect((await handleNeedsLanguage(f.post("/shop/needs/language",fields),f.runtime)).headers.get("location")).toContain("STALE_DRAFT");
    expect((await handleNeedsLanguage(f.post("/shop/needs/language",{...fields,version:String(f.draft.version),csrfToken:""}),f.runtime)).status).toBe(403);
    expect(needsDraftsFor(f.runtime.store).get(f.session.id)?.language).toBe("en");
  });
  it("renders a native explicit language form bound to the current draft", () => {
    const html=renderToStaticMarkup(<NeedsLanguageChoice language="en" target="es" csrfToken="test" draft={{draftId:"nd_test",version:3}} />);
    expect(html).toContain('action="/shop/needs/language"');
    expect(html).toContain('method="post"');
    expect(html).toContain('value="es"');
    expect(html).toContain("Continuar en español");
  });
  it("does not change language while interpretation is still pending", async () => {
    const f=await fixture();
    needsDraftsFor(f.runtime.store).set(f.session.id,{...f.draft,interpretationPending:true});
    const response=await handleNeedsLanguage(f.post("/shop/needs/language",{lang:"es",draftId:f.draft.draftId,version:String(f.draft.version)}),f.runtime);
    expect(response.headers.get("location")).toContain("STALE_DRAFT");
    expect(needsDraftsFor(f.runtime.store).get(f.session.id)?.language).toBe("en");
  });
});
