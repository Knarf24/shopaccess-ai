import { afterEach, describe, expect, it, vi } from "vitest";

// M2-2: the real side-panel script (extension/panel.mjs) on a minimal page and Chrome stand-in, in the style of the E1
// fake-page tests. Only what panel.mjs touches is modelled. A disabled control cannot take focus, as in a browser.
const ORIGIN = "http://127.0.0.1:3000";
const cleanup: (() => void)[] = [];
const CONTROLS: Record<string, string> = { pair: "button", "cancel-pair": "button", refresh: "button", disconnect: "button", "save-origin": "button", send: "button", origin: "input", text: "textarea" };

type FakeElement = {
  tag: string;
  id?: string;
  textContent: string;
  value: string;
  disabled: boolean;
  hidden?: boolean;
  isConnected: boolean;
  children: FakeElement[];
  onclick: null | (() => unknown);
  onsubmit: null | ((event: { preventDefault(): void }) => unknown);
  focus(): void;
  contains(other: FakeElement): boolean;
  replaceChildren(...children: FakeElement[]): void;
};

function installPage() {
  const elements = new Map<string, FakeElement>();
  const body = { tag: "body" } as unknown as FakeElement;
  const doc = { body, activeElement: body as FakeElement, documentElement: { lang: "en" } } as {
    body: FakeElement;
    activeElement: FakeElement;
    documentElement: { lang: string };
    getElementById(id: string): FakeElement;
    createElement(tag: string): FakeElement;
    querySelectorAll(selector: string): FakeElement[];
  };
  const make = (tag: string, id?: string): FakeElement => {
    const el: FakeElement = {
      tag,
      id,
      textContent: "",
      value: "",
      disabled: false,
      isConnected: true,
      children: [],
      onclick: null,
      onsubmit: null,
      contains(other) {
        const groups: Record<string, string[]> = { "pair-code-box": ["pair-code-heading", "pair-code-visual", "pair-code-spoken", "pair-code-help", "cancel-pair"], conversation: ["heading", "summary", "history", "turn-form", "text", "send"] };
        return other === el || Boolean(other.id && groups[id ?? ""]?.includes(other.id));
      },
      focus() {
        if (!el.disabled) doc.activeElement = el;
      },
      replaceChildren(...children) {
        el.children = children;
      },
    };
    // As in a browser: disabling the focused control moves focus to <body>.
    let disabled = false;
    Object.defineProperty(el, "disabled", {
      get: () => disabled,
      set(value: boolean) {
        disabled = value;
        if (value && doc.activeElement === el) doc.activeElement = doc.body;
      },
    });
    return el;
  };
  doc.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, make(CONTROLS[id] ?? "p", id));
    return elements.get(id)!;
  };
  doc.createElement = (tag) => make(tag);
  doc.querySelectorAll = (selector) => (selector === "button,input,textarea" ? [...elements.values()].filter((el) => ["button", "input", "textarea"].includes(el.tag)) : []);
  const listeners: (() => void)[] = [];
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { addEventListener: (_type: string, fn: () => void) => listeners.push(fn) });
  const unload = () => listeners.forEach((fn) => fn());
  cleanup.push(unload);
  return { doc, el: (id: string) => doc.getElementById(id), unload };
}

function installChrome(sessionValues: Record<string, unknown>) {
  const area = (values: Record<string, unknown>) => ({
    values,
    async get(key: string) {
      return key in values ? { [key]: structuredClone(values[key]) } : {};
    },
    async set(next: Record<string, unknown>) {
      Object.assign(values, structuredClone(next));
    },
    async remove(keys: string | string[]) {
      for (const key of [keys].flat()) delete values[key];
    },
  });
  const session = area({ ...sessionValues });
  const local = area({});
  const tabs: string[] = [];
  vi.stubGlobal("chrome", {
    runtime: { id: "m".repeat(32) },
    storage: { session, local },
    tabs: { create: async ({ url }: { url: string }) => tabs.push(url) },
    permissions: { request: async () => true },
  });
  return { session, local, tabs };
}

type Route = (body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
function installFetch(routes: Record<string, Route>) {
  const calls: { path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: URL, init: RequestInit = {}) => {
    const path = new URL(url).pathname.replace("/api/extension/v1", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    const route = routes[path];
    const answer = route ? await route(body) : { status: 404, body: { ok: false, code: "NOT_FOUND" } };
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  });
  return calls;
}

const ok = (value: unknown) => ({ status: 200, body: { ok: true, value } });
const refused = (status: number, code: string) => ({ status, body: { ok: false, code } });
const view = (turns: { role: string; text: string }[], language = "en") => ({
  draft: { draftId: `nd_${"1".repeat(32)}`, version: turns.length / 2 + 1, language, notice: "review", prefilledUse: "programming", prefilledBudgetDollars: "900", confirmedUse: null, confirmedBudgetDollars: null, recommendationClaim: null },
  conversation: { interfaceLanguage: language, turns },
});
const TWO = [
  { role: "shopper", text: "mostly for programming" },
  { role: "assistant", text: "Check the use and budget, change anything that is wrong, then confirm." },
];
const FOUR = [...TWO, { role: "shopper", text: "thanks" }, { role: "assistant", text: "Check the use and budget, change anything that is wrong, then confirm." }];
const PAIRED = { access: { bearer: "b".repeat(64), grantId: `grt_${"2".repeat(32)}`, expiresAt: Date.now() + 3_600_000, origin: ORIGIN } };

const settled = async (page: ReturnType<typeof installPage>) => {
  for (let i = 0; i < 200 && /Working|Procesando/.test(page.el("status").textContent) ; i++) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 2));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openPanel(routes: Record<string, Route>, sessionValues: Record<string, unknown> = PAIRED) {
  const page = installPage();
  const chromeStub = installChrome(sessionValues);
  const calls = installFetch(routes);
  vi.resetModules();
  await import("../../extension/panel.mjs");
  await settled(page);
  return { page, chrome: chromeStub, calls };
}

const submit = (page: ReturnType<typeof installPage>) => page.el("turn-form").onsubmit!({ preventDefault() {} });

afterEach(() => {
  cleanup.splice(0).forEach(fn => fn());
  vi.unstubAllGlobals();
});

describe("side panel behaviour (extension/panel.mjs)", () => {
  it("after a successful Send, focus is in the Message box, the field is empty and the new reply is announced", async () => {
    let current = view(TWO);
    const { page } = await openPanel({
      "/conversation": () => ok(current),
      "/conversation/turns": () => ok({ failure: null, duplicate: false, ...(current = view(FOUR)) }),
    });
    expect(page.el("history").children.map((li) => li.textContent)).toEqual(["You: mostly for programming", `Assistant: ${TWO[1].text}`]);
    page.el("text").value = "thanks";
    page.el("send").focus();
    submit(page);
    await settled(page);
    expect(page.doc.activeElement).toBe(page.el("text"));
    expect(page.el("text").value).toBe("");
    expect(page.el("history").children).toHaveLength(4);
    await wait(200);
    expect(page.el("announce").textContent).toBe(`Assistant reply 1: ${FOUR[3].text}`);
    expect(page.el("status").textContent).toBe("");
  });

  it("a refused token clears the history, summary and pending announcement, and focus moves to Pair with website", async () => {
    let refuse = false;
    let current = view(TWO);
    const { page, chrome: stub } = await openPanel({
      "/conversation": () => (refuse ? refused(401, "TOKEN_INVALID") : ok(current)),
      "/conversation/turns": () => refused(401, "TOKEN_INVALID"),
    });
    // A new reply arrives (announcement pending), then the next request is refused.
    current = view(FOUR);
    page.el("refresh").onclick!();
    await settled(page);
    page.el("text").value = "are you there";
    page.el("send").focus();
    refuse = true;
    submit(page);
    await settled(page);
    expect(page.el("history").children).toEqual([]);
    expect(page.el("summary").textContent).toBe("");
    expect(page.el("error").textContent).toBe("Connect to your ShopAccess conversation to get started. (TOKEN_INVALID)");
    expect(page.el("status").textContent).toBe("");
    expect(stub.session.values.access).toBeUndefined();
    expect(page.el("send").disabled).toBe(true);
    expect(page.doc.activeElement).toBe(page.el("pair"));
    await wait(250);
    expect(page.el("announce").textContent).toBe("");
  });

  it("a Spanish draft opens the Spanish approval page, even though pairing forgets the local view first", async () => {
    const { page, chrome: stub, calls } = await openPanel({
      "/conversation": () => ok(view(TWO, "es")),
      "/pairings": () => ok({ pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), matchCode: "012345", expiresAt: Date.now() + 300_000 }),
    });
    expect(page.doc.documentElement.lang).toBe("es");
    page.el("pair").onclick!();
    await settled(page);
    page.unload(); // stop the pairing poll timer
    expect(stub.tabs).toHaveLength(1);
    const url = new URL(stub.tabs[0]);
    expect(url.origin + url.pathname).toBe(`${ORIGIN}/extension/pair`);
    expect(url.searchParams.get("pairing")).toBe("c".repeat(64));
    expect(url.searchParams.get("lang")).toBe("es");
    expect(calls.find((c) => c.path === "/pairings")?.body).toMatchObject({ protocolVersion: 1 });
  });

  it("a rate-limited Send keeps the message, explains in the draft's language, and returns focus to Send", async () => {
    const { page } = await openPanel({
      "/conversation": () => ok(view(TWO, "es")),
      "/conversation/turns": () => refused(429, "RATE_LIMITED"),
    });
    page.el("text").value = "otra cosa";
    page.el("send").focus();
    submit(page);
    await settled(page);
    expect(page.el("text").value).toBe("otra cosa");
    expect(page.el("error").textContent).toBe("Demasiados mensajes en el último minuto. Espere y vuelva a enviar; su mensaje se conserva. (RATE_LIMITED)");
    expect(page.el("history").children).toHaveLength(2);
    expect(page.doc.activeElement).toBe(page.el("send"));
  });
});

describe("finding 3: the pairing code in the side panel", () => {
  const PENDING = { pairing: { pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), matchCode: "012345", expiresAt: Date.now() + 300_000, verifier: "e".repeat(64), polls: 0 } };
  const START = () => ok({ pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), matchCode: "012345", expiresAt: Date.now() + 300_000 });

  it("Pair shows the code in two groups for sight and digit by digit for screen readers, kept only in session storage", async () => {
    const { page, chrome: stub, calls } = await openPanel({ "/conversation": () => ok(view(TWO)), "/pairings": START });
    expect(page.el("pair-code-box").hidden).not.toBe(false);
    page.el("pair").onclick!();
    await settled(page);
    page.unload();
    expect(page.el("pair-code-box").hidden).toBe(false);
    expect(page.el("pair-code-visual").textContent).toBe("012 345");
    expect(page.el("pair-code-spoken").textContent).toBe("0 1 2 3 4 5");
    expect(page.el("pair-code-help").textContent).toContain("only on the ShopAccess approval page that this panel opened");
    expect(page.el("status").textContent).toContain("enter the pairing code shown below");
    expect(JSON.stringify(stub.local.values)).not.toContain("012345");
    expect((stub.session.values.pairing as { matchCode: string }).matchCode).toBe("012345");
    expect(stub.tabs[0]).not.toContain("012345");
    for (const call of calls) expect(JSON.stringify(call.body ?? null)).not.toContain("012345");
  });

  it("Forget local pairing hides and clears the code and removes the pending pairing", async () => {
    const { page, chrome: stub } = await openPanel({ "/conversation": () => ok(view(TWO)), "/pairings": START });
    page.el("pair").onclick!();
    await settled(page);
    page.el("disconnect").onclick!();
    await settled(page);
    page.unload();
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(page.el("pair-code-visual").textContent).toBe("");
    expect(page.el("pair-code-spoken").textContent).toBe("");
    expect(stub.session.values.pairing).toBeUndefined();
  });

  it("reopening the panel during a pending pairing shows that pairing's code again", async () => {
    const { page } = await openPanel({}, PENDING);
    page.unload();
    expect(page.el("pair-code-box").hidden).toBe(false);
    expect(page.el("pair-code-visual").textContent).toBe("012 345");
  });

  it("a start response without a valid code opens no approval page and shows no code", async () => {
    const { page, chrome: stub } = await openPanel({
      "/conversation": () => ok(view(TWO)),
      "/pairings": () => ok({ pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), expiresAt: Date.now() + 300_000 }),
    });
    page.el("pair").onclick!();
    await settled(page);
    page.unload();
    expect(stub.tabs).toHaveLength(0);
    expect(page.el("pair-code-box").hidden).not.toBe(false);
    expect(stub.session.values.pairing).toBeUndefined();
    expect(page.el("error").textContent).toContain("BAD_RESPONSE");
  });
});

describe("finding 3: every pairing end state hides the code (review fix)", () => {
  const pending = (expiresAt: number) => ({ pairing: { pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), matchCode: "012345", expiresAt, verifier: "e".repeat(64), polls: 0 } });
  const STATUS = `/pairings/${"c".repeat(64)}/status`;
  const EXCHANGE = `/pairings/${"c".repeat(64)}/exchange`;
  async function afterFirstPoll(routes: Record<string, Route>, expiresAt = Date.now() + 300_000) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      const opened = await openPanel(routes, pending(expiresAt));
      expect(opened.page.el("pair-code-box").hidden).toBe(false);
      await vi.advanceTimersByTimeAsync(5_100);
      await settled(opened.page);
      opened.page.unload();
      return opened;
    } finally {
      vi.useRealTimers();
    }
  }

  it("paired: the code is hidden and the pending pairing removed", async () => {
    const { page, chrome: stub } = await afterFirstPoll({
      [STATUS]: () => ok({ status: "approved" }),
      [EXCHANGE]: () => ok({ bearer: "b".repeat(64), grantId: `grt_${"2".repeat(32)}`, expiresAt: Date.now() + 3_600_000 }),
      "/conversation": () => ok(view(TWO)),
    });
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(page.el("pair-code-visual").textContent).toBe("");
    expect(stub.session.values.pairing).toBeUndefined();
  });

  it("denied: the code is hidden", async () => {
    const { page } = await afterFirstPoll({ [STATUS]: () => ok({ status: "denied" }) });
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(page.el("error").textContent).toBe("Pairing was denied on the website.");
  });

  it("stopped (a refused status check): the code is hidden", async () => {
    const { page } = await afterFirstPoll({ [STATUS]: () => refused(404, "PAIRING_UNKNOWN") });
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(page.el("error").textContent).toBe("Pairing stopped. Start again.");
  });

  it("expired: the code is hidden", async () => {
    const { page } = await afterFirstPoll({ [STATUS]: () => ok({ status: "pending" }) }, Date.now() + 1_000);
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(page.el("status").textContent).toBe("Pairing expired. Start again.");
  });

  it("a failed approval-tab open abandons the pairing and hides the code", async () => {
    const { page, chrome: stub } = await openPanel({ "/conversation": () => ok(view(TWO)), "/pairings": () => ok({ pairingId: "c".repeat(64), exchangeSecret: "d".repeat(64), matchCode: "012345", expiresAt: Date.now() + 300_000 }) });
    (globalThis as unknown as { chrome: { tabs: { create: () => Promise<never> } } }).chrome.tabs.create = async () => {
      throw new Error("TAB_FAILED");
    };
    page.el("pair").onclick!();
    await settled(page);
    page.unload();
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(stub.session.values.pairing).toBeUndefined();
  });
});


describe("chat-first panel and automatic reads", () => {
  it("opens disconnected with one connect action and keeps conversation hidden", async () => {
    const { page, calls } = await openPanel({}, {});
    expect(page.el("welcome").hidden).toBe(false);
    expect(page.el("pair").hidden).toBe(false);
    expect(page.el("pair").textContent).toBe("Connect to ShopAccess");
    expect(page.el("conversation").hidden).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it("restores an existing connection directly into chat", async () => {
    const { page, calls } = await openPanel({ "/conversation": () => ok(view(TWO)) });
    expect(page.el("welcome").hidden).toBe(true);
    expect(page.el("pair").hidden).toBe(true);
    expect(page.el("conversation").hidden).toBe(false);
    expect(page.el("connection-state").textContent).toBe("Connected");
    expect(calls).toEqual([{ path: "/conversation", body: {} }]);
  });
  it("refreshes automatically without clearing an unsent message or moving focus", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      let current=view(TWO);
      const { page, calls }=await openPanel({ "/conversation":()=>ok(current) });
      page.el("text").value="still typing"; page.el("text").focus(); current=view(FOUR);
      await vi.advanceTimersByTimeAsync(15_300);
      expect(calls.filter(c=>c.path==="/conversation")).toHaveLength(2);
      expect(page.el("text").value).toBe("still typing");
      expect(page.doc.activeElement).toBe(page.el("text"));
      expect(page.el("history").children).toHaveLength(4);
      const nodes=[...page.el("history").children];
      await vi.advanceTimersByTimeAsync(15_100);
      expect(page.el("history").children).toEqual(nodes);
      expect(page.el("history").children[0]).toBe(nodes[0]);
      page.unload();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls.filter(c=>c.path==="/conversation")).toHaveLength(3);
    } finally { cleanup.splice(0).forEach(fn=>fn()); vi.useRealTimers(); }
  });
  it("a delayed automatic response cannot restore conversation after disconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
    try {
      let reads=0; let release!: (value: ReturnType<typeof ok>)=>void;
      const { page, chrome: stub }=await openPanel({ "/conversation":()=> ++reads===1 ? ok(view(TWO)) : new Promise(resolve=>{release=resolve;}) });
      await vi.advanceTimersByTimeAsync(15_010);
      page.el("disconnect").onclick!(); await settled(page);
      release(ok(view(FOUR))); await vi.advanceTimersByTimeAsync(50);
      expect(page.el("history").children).toEqual([]);
      expect(page.el("conversation").hidden).toBe(true);
      expect(page.el("pair").hidden).toBe(false);
      expect(stub.session.values.access).toBeUndefined();
    } finally { cleanup.splice(0).forEach(fn=>fn()); vi.useRealTimers(); }
  });
  it("does not briefly show an already expired pending code on reopen", async () => {
    const { page, chrome: stub }=await openPanel({}, { pairing: { pairingId:"c".repeat(64),exchangeSecret:"d".repeat(64),matchCode:"012345",expiresAt:Date.now()-1,verifier:"e".repeat(64),polls:0 } });
    expect(page.el("pair-code-box").hidden).toBe(true);
    expect(page.el("pair-code-visual").textContent).toBe("");
    expect(stub.session.values.pairing).toBeUndefined();
    expect(page.el("pair").hidden).toBe(false);
  });
  it("forgets expired stored access without sending its token", async () => {
    const { page, calls, chrome: stub }=await openPanel({}, { access: { ...PAIRED.access, expiresAt:Date.now()-1 } });
    expect(calls).toHaveLength(0); expect(stub.session.values.access).toBeUndefined();
    expect(page.el("conversation").hidden).toBe(true);
  });
});

it("background token refusal restores focused chat to the Connect action", async () => {
 vi.useFakeTimers({ toFake:["setTimeout","clearTimeout","Date"], shouldAdvanceTime:true });
 try {
  let reads=0; const {page}=await openPanel({"/conversation":()=>++reads===1 ? ok(view(TWO)) : refused(401,"TOKEN_INVALID")});
  page.el("text").focus(); await vi.advanceTimersByTimeAsync(15_100);
  expect(page.el("conversation").hidden).toBe(true); expect(page.doc.activeElement).toBe(page.el("pair"));
 } finally { cleanup.splice(0).forEach(fn=>fn()); vi.useRealTimers(); }
});
it.each(["approved","denied"])("moves focus out of the pairing code after %s", async status=>{
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"],shouldAdvanceTime:true});
 try {
  const {page}=await openPanel({
   ["/pairings/"+"c".repeat(64)+"/status"]:()=>ok({status}),
   ["/pairings/"+"c".repeat(64)+"/exchange"]:()=>ok({bearer:"b".repeat(64),grantId:"grt_"+"2".repeat(32),expiresAt:Date.now()+3_600_000}),
   "/conversation":()=>ok(view(TWO)),
  },{pairing:{pairingId:"c".repeat(64),exchangeSecret:"d".repeat(64),matchCode:"012345",expiresAt:Date.now()+300_000,verifier:"e".repeat(64),polls:0}});
  page.el("pair-code-heading").focus(); await vi.advanceTimersByTimeAsync(5_200);
  expect(page.el("pair-code-box").hidden).toBe(true);
  expect(page.doc.activeElement).toBe(page.el(status==="approved" ? "heading" : "pair"));
 } finally {cleanup.splice(0).forEach(fn=>fn());vi.useRealTimers();}
});

it("does not steal Settings focus while background credential removal is pending", async () => {
 vi.useFakeTimers({toFake:["setTimeout","clearTimeout","Date"],shouldAdvanceTime:true});
 try {
  let reads=0;const {page,chrome:stub}=await openPanel({"/conversation":()=>++reads===1?ok(view(TWO)):refused(401,"TOKEN_INVALID")});
  let release!:()=>void;const remove=stub.session.remove.bind(stub.session);
  stub.session.remove=async keys=>{await new Promise<void>(resolve=>{release=resolve;});await remove(keys);};
  page.el("text").focus();await vi.advanceTimersByTimeAsync(15_010);
  page.el("settings-label").focus();release();await vi.advanceTimersByTimeAsync(50);
  expect(page.el("conversation").hidden).toBe(true);
  expect(page.doc.activeElement).toBe(page.el("settings-label"));
 } finally {cleanup.splice(0).forEach(fn=>fn());vi.useRealTimers();}
});

it("cancelling pending connection clears the code and focuses Connect", async () => {
 const {page,chrome:stub}=await openPanel({}, {pairing:{pairingId:"c".repeat(64),exchangeSecret:"d".repeat(64),matchCode:"012345",expiresAt:Date.now()+300_000,verifier:"e".repeat(64),polls:0}});
 page.el("cancel-pair").focus();page.el("cancel-pair").onclick!();await settled(page);
 expect(page.el("pair-code-box").hidden).toBe(true);expect(stub.session.values.pairing).toBeUndefined();
 expect(page.doc.activeElement).toBe(page.el("pair"));
});

it('Enter sends once; Shift+Enter and input composition keep editing', async () => {
  const {page,calls}=await openPanel({'/conversation':()=>ok(view(TWO)),'/conversation/turns':()=>ok(view(FOUR))});
  const form=page.el('turn-form') as FakeElement & {requestSubmit:()=>void};
  form.requestSubmit=()=>{submit(page);};
  const field=page.el('text') as FakeElement & {onkeydown:(e:{key:string;shiftKey?:boolean;isComposing?:boolean;keyCode?:number;preventDefault:()=>void})=>void};
  field.value='thanks';const preventDefault=vi.fn();
  field.onkeydown({key:'Enter',shiftKey:true,preventDefault});
  field.onkeydown({key:'Enter',isComposing:true,preventDefault});
  field.onkeydown({key:'Enter',keyCode:229,preventDefault});
  expect(preventDefault).not.toHaveBeenCalled();
  expect(calls.filter(c=>c.path==='/conversation/turns')).toHaveLength(0);
  field.onkeydown({key:'Enter',preventDefault});
  field.onkeydown({key:'Enter',preventDefault});
  await settled(page);
  expect(calls.filter(c=>c.path==='/conversation/turns')).toHaveLength(1);
  expect(field.value).toBe('');
});

it('shows a pending bubble during Send and keeps the draft text on failure',async()=>{
 let release!:(value:ReturnType<typeof refused>)=>void;
 const {page}=await openPanel({'/conversation':()=>ok(view(TWO)),'/conversation/turns':()=>new Promise(resolve=>{release=resolve;})});
 page.el('text').value='Please compare';submit(page);await wait(5);
 expect(page.el('pending-message').hidden).toBe(false);
 expect(page.el('pending-message').textContent).toContain('Please compare');
 expect(page.el('pending-message').textContent).toContain('Sending');
 release(refused(429,'RATE_LIMITED'));await settled(page);
 expect(page.el('pending-message').hidden).toBe(true);
 expect(page.el('text').value).toBe('Please compare');
 expect(page.el('history').children).toHaveLength(2);
});
