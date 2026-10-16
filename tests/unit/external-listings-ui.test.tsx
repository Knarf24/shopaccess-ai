import { readFileSync } from "node:fs";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ExternalListings } from "@/components/mock-journey/ExternalListings";
import { ListingSearchForm } from "@/components/mock-journey/ListingSearchForm";
import { TranslatedAdvisory } from "@/components/mock-journey/TranslatedAdvisory";
import { TranslatedCatalogList } from "@/components/mock-journey/TranslatedCatalogList";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import type { AdvisoryAiProvider } from "@/lib/providers/ai";
import { SESSION_COOKIE_NAME } from "@/lib/session/cookie";
import { parseTrustedOrigins } from "@/lib/session/request-guard";
import { needsDraftsFor } from "@/lib/session/store";
import { handleNeedsConfirm, handleNeedsSession, handleNeedsSubmit } from "@/server/handlers";
import { createRuntime, type Runtime } from "@/server/runtime";
import { loadNeedsJourney } from "@/server/shopping";
import { TEST_SESSION_KEY, createTestClock } from "./helpers";

const ORIGIN = "https://shop.example.test";

function post(path: string, fields: Record<string, string>, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "sec-fetch-site": "same-origin", cookie },
    body: new URLSearchParams(fields).toString(),
  });
}

async function confirmedShopper(runtime: Runtime, budget: string, use = "schoolwork") {
  const time = createTestClock();
  void time;
  const started = await handleNeedsSession(new Request(`${ORIGIN}/session/needs`), runtime);
  const token = started.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
  const session = await runtime.sessions.resolve(token);
  if (!session.ok) throw new Error("session missing");
  const cookie = `${SESSION_COOKIE_NAME}=${token}`;
  await handleNeedsSubmit(post("/shop/needs/submit", { lang: "en", shopperText: "", use, budget, csrfToken: session.value.csrfToken }, cookie), runtime);
  const draft = needsDraftsFor(runtime.store).get(session.value.id);
  if (!draft) throw new Error("draft missing");
  await handleNeedsConfirm(
    post("/shop/needs/confirm", { lang: "en", draftId: draft.draftId, version: String(draft.version), use, budget, csrfToken: session.value.csrfToken }, cookie),
    runtime,
  );
  return session.value;
}

describe("external listing and suggestion labels", () => {
  it("renders a server status while listings are pending in English and Spanish", () => {
    // Markup only. This does not show that a browser or a screen reader announced the status.
    for (const language of ["en", "es"] as const) {
      const copy = journeyCopy(language);
      const markup = renderToStaticMarkup(
        <ExternalListings
          copy={copy}
          language={language}
          csrfToken="csrf-token"
          draftId={"nd_" + "ab".repeat(16)}
          version={1}
          notice={null}
          listings={null}
          pending
        />,
      );
      expect(markup).toContain('role="status"');
      expect(markup).toContain(copy.listingsPending);
      expect(markup).not.toContain('role="alert"');
      expect(markup).toContain('type="submit"');
    }
  });

  it("blocks a second submit while pending and posts the native form once", async () => {
    // The pending node is in the mounted tree before the native submit runs.
    // This does not show that a browser painted it or that a screen reader announced it.
    const formSource = readFileSync("src/components/mock-journey/ListingSearchForm.tsx", "utf8");
    expect(formSource).toContain("settleListingSearch");
    expect(formSource).toContain('method="post"');
    expect(formSource).toContain('action="/shop/needs/listings"');
    expect(formSource).not.toMatch(/\bfetch\s*\(|requestAnimationFrame\(\(\) => resolve\(\)\)/);
    const copy = journeyCopy("en");
    const harness = await mountListingSearchForm(copy);
    expect(harness.formAttributes()).toMatchObject({ method: "post", action: "/shop/needs/listings" });
    expect(harness.hiddenFields()).toMatchObject({
      csrfToken: "csrf-token",
      draftId: "nd_" + "ab".repeat(16),
      version: "1",
      lang: "en",
    });
    expect(harness.statusText()).toBeNull();
    expect(harness.buttonDisabled()).toBe(false);
    await harness.submit();
    await harness.submit();
    expect(harness.statusText()).toBe(copy.listingsPending);
    expect(harness.buttonDisabled()).toBe(true);
    expect(harness.nativeSubmits).toBe(0);
    await harness.flushFrame();
    expect(harness.nativeSubmits).toBe(0);
    await harness.flushFrame();
    expect(harness.nativeSubmits).toBe(1);
    expect(harness.statusText()).toBe(copy.listingsPending);
    await harness.flushFrame();
    expect(harness.nativeSubmits).toBe(1);
    await harness.restore();
  });

  it("restores the form and shows the localized error when native submission throws", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      for (const language of ["en", "es"] as const) {
        const copy = journeyCopy(language);
        const harness = await mountListingSearchForm(copy, language);
        harness.failNativeSubmit();
        await harness.submit();
        expect(harness.statusText()).toBe(copy.listingsPending);
        expect(harness.alertText()).toBeNull();
        await harness.flushFrame();
        await harness.flushFrame();
        expect(harness.nativeSubmits).toBe(1);
        expect(harness.statusText()).toBeNull();
        expect(harness.alertText()).toBe(copy.listingsSubmitError);
        expect(harness.buttonDisabled()).toBe(false);
        expect(unhandled).toEqual([]);
        harness.allowNativeSubmit();
        await harness.submit();
        expect(harness.statusText()).toBe(copy.listingsPending);
        expect(harness.alertText()).toBeNull();
        await harness.flushFrame();
        await harness.flushFrame();
        expect(harness.nativeSubmits).toBe(2);
        await harness.restore();
      }
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it("restores the usable button when pageshow arrives before the native submit", async () => {
    const copy = journeyCopy("en");
    const harness = await mountListingSearchForm(copy);
    await harness.submit();
    expect(harness.statusText()).toBe(copy.listingsPending);
    expect(harness.buttonDisabled()).toBe(true);
    await harness.pageShow();
    expect(harness.statusText()).toBeNull();
    expect(harness.buttonDisabled()).toBe(false);
    await harness.flushFrame();
    await harness.flushFrame();
    expect(harness.nativeSubmits).toBe(0);
    await harness.restore();
  });

  it("renders the explicit search, indicative price, and both languages without an image", () => {
    const listing = {
      externalId: "ext_abc",
      title: "Example Laptop",
      sellerLabel: null,
      indicativePriceCents: 1999,
      url: "https://shop.example/buy",
      retrievedAt: "2026-10-15T16:00:00.000Z",
    };
    for (const language of ["en", "es"] as const) {
      const copy = journeyCopy(language);
      const markup = renderToStaticMarkup(
        <ExternalListings
          copy={copy}
          language={language}
          csrfToken="csrf-token"
          draftId={"nd_" + "ab".repeat(16)}
          version={2}
          notice="unavailable"
          listings={[listing]}
        />,
      );
      expect(markup).toContain('action="/shop/needs/listings"');
      expect(markup).toContain('type="submit"');
      expect(markup).toContain(copy.searchListings);
      expect(markup).toContain('role="alert"');
      expect(markup).toContain(copy.listingsUnavailable);
      expect(markup).toContain(copy.indicativePrice);
      expect(markup).toContain(copy.sellerUnknown);
      expect(markup).toContain(copy.availabilityUnverified);
      expect(markup).toContain(copy.suitabilityUnverified);
      expect(markup).toContain('dateTime="2026-10-15T16:00:00.000Z"');
      expect(markup).toContain('rel="noopener noreferrer nofollow"');
      expect(markup).not.toContain("<img");
      expect(markup).not.toContain("suitable");
      expect(markup).not.toContain("in stock");
    }
  });

  it("labels the stored producer, including a mock fallback, and the other eligible laptops", async () => {
    const time = createTestClock();
    const runtime = createRuntime({ sessionKey: TEST_SESSION_KEY, trustedOrigins: parseTrustedOrigins([ORIGIN]) }, { clock: time.clock });
    const session = await confirmedShopper(runtime, "580");
    const journey = await loadNeedsJourney(runtime, session);
    const english = journeyCopy("en");
    const markup = renderToStaticMarkup(
      <TranslatedAdvisory
        copy={english}
        language="en"
        draft={journey.draft!}
        lines={journey.lines}
        suggestionSource={journey.suggestionSource}
        eligibleVariantIds={journey.lines.filter((line) => line.status === "READY" || line.status === "READY_WITH_CAVEATS").map((line) => line.variantId)}
      />,
    );
    expect(journey.suggestionSource).toBe("mock");
    expect(markup).toContain(english.suggestionSourceMock);
    expect(markup).toContain(english.suggestedLabel);
    expect(markup).not.toContain(english.suggestionSourceModel);

    const fallback = {
      ...runtime,
      advisory: "external" as const,
      ai: {
        ...runtime.ai,
        suggestionSource: "mock" as const,
      },
    };
    const fallbackSession = await confirmedShopper(fallback, "900", "programming");
    const fallbackJourney = await loadNeedsJourney(fallback, fallbackSession);
    expect(fallbackJourney.suggestionSource).toBe("mock");

    const model: AdvisoryAiProvider = {
      ...runtime.ai,
      suggestionSource: "model",
      async suggestProducts() {
        return {
          message: "Two choices.",
          references: [
            { productId: "dmp_aspirego15", variantId: "dmv_aspirego15" },
            { productId: "dmp_aspire14ai", variantId: "dmv_aspire14ai" },
          ],
        };
      },
    };
    const modelRuntime = { ...runtime, ai: model };
    const modelSession = await confirmedShopper(modelRuntime, "900", "programming");
    const modelJourney = await loadNeedsJourney(modelRuntime, modelSession);
    expect(modelJourney.suggestionSource).toBe("model");
    const eligible = modelJourney.lines.filter((line) => (line.status === "READY" || line.status === "READY_WITH_CAVEATS") && line.unitAmountCents <= 90000);
    const catalog = renderToStaticMarkup(
      <TranslatedCatalogList
        copy={english}
        language="en"
        csrfToken="csrf-token"
        lines={eligible}
        confirmedUse="programming"
        confirmedBudgetDollars="900"
        labelChoices
        suggestedVariantIds={modelJourney.draft?.recommendation?.recommendations.map((item) => item.variantId) ?? []}
      />,
    );
    expect(catalog.match(/Suggested/g)?.length).toBe(2);
    expect(catalog).not.toContain(english.otherChoiceLabel);

    const none = {
      ...runtime,
      ai: {
        ...runtime.ai,
        suggestionSource: "model" as const,
        async suggestProducts() {
          return { message: "None.", references: [] };
        },
      },
    };
    const noneSession = await confirmedShopper(none, "900", "programming");
    const noneJourney = await loadNeedsJourney(none, noneSession);
    const other = renderToStaticMarkup(
      <TranslatedCatalogList
        copy={english}
        language="en"
        csrfToken="csrf-token"
        lines={noneJourney.lines.filter((line) => (line.status === "READY" || line.status === "READY_WITH_CAVEATS") && line.unitAmountCents <= 90000)}
        excludedLines={noneJourney.lines.filter((line) => line.unitAmountCents > 90000)}
        confirmedUse="programming"
        confirmedBudgetDollars="900"
        labelChoices={noneJourney.draft?.recommendationClaim === "completed"}
        suggestedVariantIds={[]}
      />,
    );
    expect(other).toContain(english.otherChoiceLabel);
    expect(other).not.toContain(`>${english.suggestedLabel}<`);
    expect(other).not.toContain(english.otherChoiceLabel + english.excludedHeading);
  });
});

type MiniEvent = {
  type: string;
  target: MiniNode;
  srcElement: MiniNode;
  bubbles: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
  submitter: MiniNode | null;
  timeStamp: number;
};

type MiniNode = {
  nodeType: number;
  nodeName: string;
  tagName: string;
  childNodes: MiniNode[];
  parentNode: MiniNode | null;
  ownerDocument: MiniNode | null;
  activeElement?: MiniNode | null;
  textContent: string;
  attributes: Record<string, string>;
  disabled: boolean;
  value: string;
  name: string;
  method: string;
  action: string;
  style: Record<string, string>;
  className: string;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  hasAttribute(name: string): boolean;
  appendChild(child: MiniNode): MiniNode;
  removeChild(child: MiniNode): MiniNode;
  insertBefore(child: MiniNode, before: MiniNode | null): MiniNode;
  addEventListener(type: string, fn: (event: MiniEvent) => void, options?: boolean | { capture?: boolean }): void;
  removeEventListener(type: string, fn: (event: MiniEvent) => void): void;
  focus(): void;
  blur(): void;
  submit(): void;
};

type MiniListener = { type: string; fn: (event: MiniEvent) => void; capture: boolean };

async function mountListingSearchForm(copy: ReturnType<typeof journeyCopy>, language: "en" | "es" = "en") {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    Element: globalThis.Element,
    Node: globalThis.Node,
    HTMLIFrameElement: globalThis.HTMLIFrameElement,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    actEnvironment: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const listeners = new WeakMap<object, MiniListener[]>();
  const addListener = (target: object, type: string, fn: (event: MiniEvent) => void, options?: boolean | { capture?: boolean }) => {
    const capture = options === true || (typeof options === "object" && options?.capture === true);
    const list = listeners.get(target) ?? [];
    list.push({ type, fn, capture });
    listeners.set(target, list);
  };
  const removeListener = (target: object, type: string, fn: (event: MiniEvent) => void) => {
    listeners.set(target, (listeners.get(target) ?? []).filter((item) => item.type !== type || item.fn !== fn));
  };
  let nativeSubmits = 0;
  let nativeImpl = () => {
    nativeSubmits += 1;
  };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frames.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    frames.delete(id);
  };
  const el = (tag: string): MiniNode => {
    const node = {
      nodeType: 1,
      nodeName: tag.toUpperCase(),
      tagName: tag.toUpperCase(),
      childNodes: [] as MiniNode[],
      parentNode: null as MiniNode | null,
      ownerDocument: null as MiniNode | null,
      textContent: "",
      attributes: {} as Record<string, string>,
      disabled: false,
      value: "",
      name: "",
      method: "",
      action: "",
      style: {},
      className: "",
      setAttribute(name: string, value: string) {
        this.attributes[name] = String(value);
        if (name === "value") this.value = String(value);
        if (name === "name") this.name = String(value);
        if (name === "method") this.method = String(value);
        if (name === "action") this.action = String(value);
        if (name === "disabled") this.disabled = true;
      },
      getAttribute(name: string) {
        return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
      },
      removeAttribute(name: string) {
        delete this.attributes[name];
        if (name === "disabled") this.disabled = false;
      },
      hasAttribute(name: string) {
        return Object.hasOwn(this.attributes, name);
      },
      appendChild(child: MiniNode) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
      },
      removeChild(child: MiniNode) {
        const index = this.childNodes.indexOf(child);
        if (index >= 0) this.childNodes.splice(index, 1);
        child.parentNode = null;
        return child;
      },
      insertBefore(child: MiniNode, before: MiniNode | null) {
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        const index = before ? this.childNodes.indexOf(before) : -1;
        if (index < 0) this.childNodes.push(child);
        else this.childNodes.splice(index, 0, child);
        return child;
      },
      addEventListener(type: string, fn: (event: MiniEvent) => void, options?: boolean | { capture?: boolean }) {
        addListener(this, type, fn, options);
      },
      removeEventListener(type: string, fn: (event: MiniEvent) => void) {
        removeListener(this, type, fn);
      },
      focus() {
        if (this.ownerDocument) this.ownerDocument.activeElement = this;
      },
      blur() {},
      submit() {
        if (this.nodeName === "FORM") nativeImpl();
      },
    };
    return node;
  };
  const document = el("#document");
  document.nodeType = 9;
  document.nodeName = "#document";
  const documentApi = Object.assign(document, {
    activeElement: null as MiniNode | null,
    defaultView: null as object | null,
    documentElement: null as MiniNode | null,
    body: null as MiniNode | null,
    head: null as MiniNode | null,
    createElement(tag: string) {
      const node = el(tag);
      node.ownerDocument = document;
      return node;
    },
    createElementNS(_namespace: string, tag: string) {
      return this.createElement(tag);
    },
    createTextNode(text: string) {
      const node = el("#text");
      node.nodeType = 3;
      node.nodeName = "#text";
      node.textContent = String(text);
      node.ownerDocument = document;
      return node;
    },
    createComment(text: string) {
      const node = el("#comment");
      node.nodeType = 8;
      node.textContent = String(text);
      node.ownerDocument = document;
      return node;
    },
  });
  documentApi.documentElement = documentApi.createElement("html");
  documentApi.head = documentApi.createElement("head");
  documentApi.body = documentApi.createElement("body");
  documentApi.documentElement.appendChild(documentApi.head);
  documentApi.documentElement.appendChild(documentApi.body);
  const windowStub = {
    document: documentApi,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Element: function Element() {},
    Node: function Node() {},
    getSelection() {
      return null;
    },
    addEventListener(type: string, fn: (event: MiniEvent) => void, options?: boolean | { capture?: boolean }) {
      addListener(windowStub, type, fn, options);
    },
    removeEventListener(type: string, fn: (event: MiniEvent) => void) {
      removeListener(windowStub, type, fn);
    },
    requestAnimationFrame,
    cancelAnimationFrame,
  };
  documentApi.defaultView = windowStub;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    document: documentApi,
    window: windowStub,
    HTMLElement: windowStub.HTMLElement,
    Element: windowStub.Element,
    Node: windowStub.Node,
    HTMLIFrameElement: windowStub.HTMLIFrameElement,
    requestAnimationFrame,
    cancelAnimationFrame,
  });
  const container = documentApi.createElement("div");
  documentApi.body.appendChild(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as never);
  await act(async () => {
    root.render(
      <ListingSearchForm
        label={copy.searchListings}
        pendingMessage={copy.listingsPending}
        errorMessage={copy.listingsSubmitError}
        language={language}
        csrfToken="csrf-token"
        draftId={"nd_" + "ab".repeat(16)}
        version={1}
      />,
    );
  });

  const nodeText = (node: MiniNode): string => {
    if (node.nodeType === 3 || node.childNodes.length === 0) return node.textContent;
    return node.childNodes.map(nodeText).join("");
  };
  const walk = (node: MiniNode, visit: (item: MiniNode) => void) => {
    visit(node);
    for (const child of node.childNodes) walk(child, visit);
  };
  const form = () => container.childNodes[0]!;
  const byRole = (role: string) => {
    let found: MiniNode | null = null;
    walk(container, (node) => {
      if (node.getAttribute("role") === role) found = node;
    });
    return found ? nodeText(found) : null;
  };
  const button = (): MiniNode => {
    const nodes: MiniNode[] = [];
    walk(form(), (node) => {
      if (node.nodeName === "BUTTON") nodes.push(node);
    });
    const found = nodes[0];
    if (!found) throw new Error("submit button missing");
    return found;
  };

  return {
    get nativeSubmits() {
      return nativeSubmits;
    },
    formAttributes() {
      const node = form();
      return { method: node.getAttribute("method") ?? node.method, action: node.getAttribute("action") ?? node.action };
    },
    hiddenFields() {
      const fields: Record<string, string> = {};
      walk(form(), (node) => {
        if (node.nodeName !== "INPUT") return;
        const name = node.getAttribute("name") ?? node.name;
        if (name) fields[name] = node.getAttribute("value") ?? node.value;
      });
      return fields;
    },
    statusText: () => byRole("status"),
    alertText: () => byRole("alert"),
    buttonDisabled: () => button().disabled || button().getAttribute("disabled") !== null,
    async submit() {
      const node = form();
      const event: MiniEvent = {
        type: "submit",
        target: node,
        srcElement: node,
        bubbles: true,
        cancelable: true,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        submitter: button(),
        timeStamp: 1,
      };
      const bubble = (listeners.get(container) ?? []).filter((item) => item.type === "submit" && !item.capture);
      await act(async () => {
        for (const item of bubble) item.fn(event);
      });
    },
    async flushFrame() {
      const batch = [...frames.values()];
      frames.clear();
      await act(async () => {
        for (const callback of batch) callback(0);
      });
    },
    async pageShow() {
      const list = listeners.get(windowStub) ?? [];
      await act(async () => {
        for (const item of list) if (item.type === "pageshow") item.fn({ type: "pageshow" } as MiniEvent);
      });
    },
    failNativeSubmit() {
      nativeImpl = () => {
        nativeSubmits += 1;
        throw new Error("native submit failed");
      };
    },
    allowNativeSubmit() {
      nativeImpl = () => {
        nativeSubmits += 1;
      };
    },
    async restore() {
      await act(async () => {
        root.unmount();
      });
      await new Promise((resolve) => setImmediate(resolve));
      Object.assign(globalThis, {
        document: previous.document,
        window: previous.window,
        HTMLElement: previous.HTMLElement,
        Element: previous.Element,
        Node: previous.Node,
        HTMLIFrameElement: previous.HTMLIFrameElement,
        requestAnimationFrame: previous.requestAnimationFrame,
        cancelAnimationFrame: previous.cancelAnimationFrame,
      });
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment;
    },
  };
}
