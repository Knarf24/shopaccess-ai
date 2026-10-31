import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import "./guided-presentation.css";
import "./ui-refresh.css";

// This page bypasses both root layouts, so it supplies its own <html>, system fonts and styles.
const SYSTEM_FONTS = {
  "--font-geist-sans": "Arial, Helvetica, sans-serif",
  "--font-geist-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as CSSProperties;

export const metadata: Metadata = { title: "Page not found | ShopAccess AI" };

/** The language of an unmatched address is unknown, so the message is shown in English and Spanish. */
export default function GlobalNotFound() {
  return (
    <html lang="en" style={SYSTEM_FONTS} className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <main className="guided-presentation ui-refresh">
          <div className="presentation-column presentation-column-narrow not-found">
            <p className="gate-brand">ShopAccess AI</p>
            <section aria-labelledby="not-found-en" className="not-found-card">
              <h1 id="not-found-en" className="text-3xl font-semibold">This page was not found</h1>
              <p>The address may be wrong, or the page may have moved. ShopAccess AI is an evaluation demonstration with a simulated store.</p>
              <p><Link href="/">Back to the start</Link></p>
            </section>
            <section aria-labelledby="not-found-es" lang="es" className="not-found-card">
              <h2 id="not-found-es" className="text-2xl font-semibold">No se encontró esta página</h2>
              <p>Puede que la dirección sea incorrecta o que la página se haya movido. ShopAccess AI es una demostración de evaluación con una tienda simulada.</p>
              <p><Link href="/">Volver al inicio</Link></p>
            </section>
          </div>
        </main>
      </body>
    </html>
  );
}
