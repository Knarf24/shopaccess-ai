import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { documentLocale } from "@/lib/i18n/locale-segment";
import "../globals.css";

const SYSTEM_FONTS = {
  "--font-geist-sans": "Arial, Helvetica, sans-serif",
  "--font-geist-mono": 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
} as CSSProperties;

export const metadata: Metadata = {
  title: "ShopAccess AI",
  description: "An inclusive shopping assistant demo with a simulated Sandbox catalog.",
};

export function generateStaticParams() {
  return [{ lang: "en" }, { lang: "es" }];
}

/**
 * Root layout for `/{lang}`. Only `en` and `es` may be rendered. An unsupported value is not
 * relabeled as English. With Cache Components, a prefix outside `generateStaticParams` is a
 * framework 404 before this layout runs; `notFound()` remains for a value that does arrive.
 */
export default async function LocalizedRootLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ lang: string }>;
}) {
  const locale = documentLocale((await params).lang);
  if (!locale) notFound();
  return (
    <html lang={locale} style={SYSTEM_FONTS} className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
