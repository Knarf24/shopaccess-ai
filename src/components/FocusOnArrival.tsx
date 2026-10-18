"use client";

import { useEffect } from "react";

/** Focuses the element with this id, if it is on the page. Returns whether it was found. */
export function focusArrivalTarget(doc: Pick<Document, "getElementById">, targetId: string): boolean {
  const target = doc.getElementById(targetId);
  if (!target) return false;
  target.focus();
  return true;
}

/**
 * After a full-page form result (M2-3 owner decision, October 17), moves keyboard focus once to the element that reports
 * it, so a keyboard user continues from there. The target carries tabIndex={-1} and a visible focus outline. Renders
 * nothing. Whether a screen reader announces the target on arrival is unverified until the VM check.
 */
export function FocusOnArrival({ targetId }: { readonly targetId: string }) {
  useEffect(() => {
    focusArrivalTarget(document, targetId);
  }, [targetId]);
  return null;
}
