import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChargerPurchaseCard } from "@/components/mock-journey/ChargerPurchaseCard";
it.each(["en", "es"] as const)("shows one clear permission action and cable disclosure in %s", language => {
 const html = renderToStaticMarkup(<ChargerPurchaseCard language={language} csrfToken="csrf" permitted={false} />);
 expect(html).toContain("$59.00"); expect(html).toContain(language === "en" ? "Cable sold separately" : "El cable se vende por separado");
 expect(html).toContain(`/${language}/shop/permissions?`); expect(html).not.toContain('action="/checkout/start"');
});
it("offers a CSRF-protected review only after permission", () => {
 const html = renderToStaticMarkup(<ChargerPurchaseCard language="en" csrfToken="csrf" permitted />);
 expect(html).toContain('action="/checkout/start"'); expect(html).toContain('name="csrfToken" value="csrf"'); expect(html).toContain('name="quantity" value="1"');
});
