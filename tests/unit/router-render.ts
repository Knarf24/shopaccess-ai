import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

/** Server-markup tests provide the same router context that Next supplies to client children. */
export function renderWithAppRouter(children: ReactNode): string {
  const router = { bfcacheId: "unit-test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, async prefetch() {} };
  return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router }, children));
}
