import type { CSSProperties } from "react";
import type { Metadata } from "next";
import "./globals.css";
import "./guided-presentation.css";
import "./ui-refresh.css";
import { NotFoundContent } from "@/components/NotFoundContent";

// This page bypasses both root layouts, so it supplies its own <html>, system fonts and styles.
const SYSTEM_FONTS = {
  "--font-geist-sans": "Arial, Helvetica, sans-serif",
  "--font-geist-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as CSSProperties;

export const metadata: Metadata = { title: "Page not found | ShopAccess AI" };

/** Unmatched URLs. A notFound() thrown inside a route uses the not-found.tsx beside each root layout instead. */
export default function GlobalNotFound() {
  return (
    <html lang="en" style={SYSTEM_FONTS} className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <NotFoundContent />
      </body>
    </html>
  );
}
