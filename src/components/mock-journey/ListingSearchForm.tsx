"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type Ref } from "react";
import type { JourneyLanguage } from "@/lib/i18n/language";

/** Mirrors the route's already-resolved language to the document and restores the English shell on route exit. */
export function syncDocumentLanguage(root: { lang: string }, language: JourneyLanguage): () => void {
  const previous = root.lang;
  root.lang = language;
  return () => {
    if (root.lang === language) root.lang = previous || "en";
  };
}

/** Client-side bridge only: the server-rendered route remains the source of the language value. */
export function DocumentLanguageSync({ language }: { readonly language: JourneyLanguage }) {
  useLayoutEffect(() => syncDocumentLanguage(document.documentElement, language), [language]);
  return null;
}

/**
 * Native POST to the listings route. Without JavaScript the browser submits
 * this form as written. With JavaScript the same fields are submitted after
 * the pending update has been committed and the browser has had a chance to
 * render it. That chance is not proof the shopper saw the status. A second
 * submit is ignored until the first one settles.
 */
export function ListingSearchForm({
  label,
  pendingMessage,
  errorMessage,
  language,
  csrfToken,
  draftId,
  version,
  action,
}: {
  readonly label: string;
  readonly pendingMessage: string;
  readonly errorMessage: string;
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly draftId: string;
  readonly version: number;
  /** Test-only delayed action. Production omits it and posts the form. */
  readonly action?: (formData: FormData) => void | Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const lock = useRef(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasPending = useRef(false);
  const resumeNativeSubmit = useRef<(() => void) | null>(null);

  useEffect(() => {
    const restore = () => {
      releaseListingSearch(lock, setPending);
      const resume = resumeNativeSubmit.current;
      resumeNativeSubmit.current = null;
      resume?.();
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);

  useEffect(() => {
    if (!pending || resumeNativeSubmit.current === null) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const resume = resumeNativeSubmit.current;
        resumeNativeSubmit.current = null;
        resume?.();
      });
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== 0) cancelAnimationFrame(second);
    };
  }, [pending]);

  useEffect(() => {
    if (wasPending.current && !pending) buttonRef.current?.focus();
    wasPending.current = pending;
  }, [pending]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (lock.current) {
      event.preventDefault();
      return;
    }
    setSubmitError(null);
    const form = event.currentTarget;
    void settleListingSearch(event, {
      action: action ? () => action(new FormData(form)) : undefined,
      submitForm: () => form.submit(),
      lock,
      setPending,
      afterPendingCommit: action
        ? undefined
        : () =>
            new Promise<void>((resolve) => {
              resumeNativeSubmit.current = resolve;
            }),
    }).catch(() => {
      setSubmitError(errorMessage);
      releaseListingSearch(lock, setPending);
    });
  }

  return (
    <ListingSearchFormView
      label={label}
      pendingMessage={pendingMessage}
      errorMessage={submitError}
      language={language}
      csrfToken={csrfToken}
      draftId={draftId}
      version={version}
      pending={pending}
      buttonRef={buttonRef}
      onSubmit={onSubmit}
    />
  );
}

export function ListingSearchFormView({
  label,
  pendingMessage,
  errorMessage,
  language,
  csrfToken,
  draftId,
  version,
  pending,
  buttonRef,
  onSubmit,
}: {
  readonly label: string;
  readonly pendingMessage: string;
  readonly errorMessage: string | null;
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly draftId: string;
  readonly version: number;
  readonly pending: boolean;
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form method="post" action="/shop/needs/listings" className="journey-form" onSubmit={onSubmit}>
      <input type="hidden" name="csrfToken" value={csrfToken} />
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="version" value={String(version)} />
      <input type="hidden" name="lang" value={language} />
      {pending ? <p role="status">{pendingMessage}</p> : null}
      {errorMessage !== null ? <p role="alert">{errorMessage}</p> : null}
      <button ref={buttonRef} type="submit" className="rounded bg-blue-800 px-4 py-2 font-medium text-white" disabled={pending}>
        {label}
      </button>
    </form>
  );
}

export function releaseListingSearch(lock: { current: boolean }, setPending: (pending: boolean) => void): void {
  lock.current = false;
  setPending(false);
}

/**
 * Takes the one-submit lock and either runs a supplied action or waits until
 * `afterPendingCommit` resolves. The caller resolves that after the pending
 * update is committed and after yielding frames so the browser can paint.
 * Resolving it does not establish that the status was visible.
 */
export async function settleListingSearch(
  event: { preventDefault(): void },
  options: {
    readonly action?: () => void | Promise<void>;
    readonly submitForm?: () => void;
    readonly lock: { current: boolean };
    readonly setPending: (pending: boolean) => void;
    readonly afterPendingCommit?: () => Promise<void>;
  },
): Promise<void> {
  if (options.lock.current) {
    event.preventDefault();
    return;
  }
  options.lock.current = true;
  event.preventDefault();
  options.setPending(true);
  if (options.action) {
    try {
      await options.action();
    } finally {
      releaseListingSearch(options.lock, options.setPending);
    }
    return;
  }
  try {
    await options.afterPendingCommit?.();
    if (!options.lock.current) return;
    options.submitForm?.();
  } catch (error) {
    releaseListingSearch(options.lock, options.setPending);
    throw error;
  }
}
