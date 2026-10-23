import type { JourneyLanguage } from "./language";

const DESCRIPTIONS: Record<JourneyLanguage, string> = {
  en: "An inclusive laptop-shopping assistant demo with a demo catalog.",
  es: "Una demostración de un asistente inclusivo para comprar portátiles, con un catálogo de demostración.",
};

/** Page title and description for a document language. The catalog is a demo catalog in every payment mode. */
export function siteMetadata(language: JourneyLanguage): { title: string; description: string } {
  return { title: "ShopAccess AI", description: DESCRIPTIONS[language] };
}
