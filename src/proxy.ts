import { NextResponse, type NextRequest } from "next/server";
import { legacyLocaleRedirect } from "@/lib/i18n/locale-path";

/**
 * Legacy localized pages only. This file does not read a session, draft, checkout, or store.
 * Non-GET requests and every other path continue unchanged, so a redirect cannot retarget a POST.
 */
export function proxy(request: NextRequest) {
  const target = legacyLocaleRedirect(request.method, request.nextUrl.pathname, request.nextUrl.search);
  if (!target) return NextResponse.next();
  return NextResponse.redirect(new URL(target, request.url), 307);
}

export const config = {
  matcher: [
    { source: "/shop/needs", locale: false },
    { source: "/shop/chargers", locale: false },
    { source: "/shop/permissions", locale: false },
    { source: "/shop/profile", locale: false },
    { source: "/demo/admission", locale: false },
    { source: "/extension/pair", locale: false },
    { source: "/checkout/:intentId", locale: false },
  ],
};
