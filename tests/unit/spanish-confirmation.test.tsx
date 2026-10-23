import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmationSummary } from "@/components/ConfirmationSummary";
import { prepareConfirmation } from "@/lib/confirmation/confirmation";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { createWorld, newSession, quotedIntent } from "./helpers";

async function spanishSummary() {
  const fixture = createWorld();
  const { session } = await newSession(fixture);
  const { quote } = await quotedIntent(fixture, session.id);
  const challenge = await prepareConfirmation(fixture.checkout, session.id, quote.quoteId);
  if (!challenge.ok) throw new Error(challenge.error);
  const html = renderToStaticMarkup(<ConfirmationSummary challenge={challenge.value} csrfToken={session.csrfToken} action="/checkout/confirm" language="es" />);
  return { html, expiresAt: challenge.value.expiresAt };
}

const visibleText = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Spanish purchase-summary confirmation", () => {
  it("has no English duplicate of the explanation", async () => {
    const { html } = await spanishSummary();
    expect(html).toContain(journeyCopy("es").confirmation.explanation);
    expect(html).not.toContain("Confirming does not take payment");
    expect(html).not.toContain("If PayPal checkout is added later");
    // English stays marked only on catalog names.
    expect(html.match(/<span lang="en">/g)?.length).toBe(2);
  });

  it("states the expiry in Spanish with a readable UTC time, keeping the exact time machine-readable", async () => {
    const { html, expiresAt } = await spanishSummary();
    const readable = new Intl.DateTimeFormat("es", { timeZone: "UTC", dateStyle: "long", timeStyle: "short" }).format(new Date(expiresAt));
    expect(html).toContain(`<time dateTime="${expiresAt}">${readable}</time>`);
    expect(visibleText(html)).toContain(`Este resumen vence el ${readable} (UTC); después, o si algo cambia, se le pedirá revisar un resumen nuevo.`);
    expect(visibleText(html)).not.toContain(expiresAt);
  });
});
