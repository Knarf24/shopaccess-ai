import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "../globals.css";

/**
 * System fonts only: nothing is fetched or bundled. `globals.css` reads these two custom properties for its sans
 * and monospace font families, so they are still defined here, on the same element as before. The sans stack is
 * the one the stylesheet already gives the page body.
 */
const SYSTEM_FONTS = {
  "--font-geist-sans": "Arial, Helvetica, sans-serif",
  "--font-geist-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as CSSProperties;

export const metadata: Metadata = {
  title: "ShopAccess AI",
  description: "An inclusive shopping assistant demo with a simulated Sandbox catalog.",
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" style={SYSTEM_FONTS} className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
