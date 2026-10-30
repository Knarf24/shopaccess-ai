import type { ReactNode } from "react";
import { AdvisoryRecommendations } from "@/components/AdvisoryRecommendations";
import { AiCompatibilityDisclosure } from "@/components/AiCompatibilityDisclosure";
import { ExternalProductCard } from "@/components/ExternalProductCard";
import { PreferencesForm } from "@/components/PreferencesForm";
import { ReadinessPanel } from "@/components/ReadinessPanel";
import { formatUsd } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { type PermissionRefusalCode } from "@/lib/i18n/permission-copy";
import { PermissionRefusal } from "@/components/PermissionRefusal";
import { USE_LABELS, type ShopperPreferences, type ShoppingView } from "@/server/shopping";

export const SHOP_ALERT_ID = "shop-alert";
export const SHOP_STEP_HEADING_ID = "demo-heading";

/** The skip link's target: a refusal or error when one is shown, otherwise the demo-store list, where a quote is requested. */
export function shopCurrentTargetId(state: { readonly error: string | null; readonly refusal: PermissionRefusalCode | null }): string {
  return state.refusal || state.error ? SHOP_ALERT_ID : SHOP_STEP_HEADING_ID;
}

/**
 * The recommendations as shown in both modes: the same markup, whichever catalog the view was built on. The skip link
 * (M2-3) is its first focusable element; a session notice, when there is one, follows it.
 */
export function ShopListing({
  view,
  preferences,
  csrfToken,
  error,
  refusal,
  sessionNotice = null,
}: {
  view: ShoppingView;
  preferences: ShopperPreferences;
  csrfToken: string;
  error: string | null;
  refusal: PermissionRefusalCode | null;
  sessionNotice?: ReactNode;
}) {
  return (
    <>
      <a className="skip-link" href={`#${shopCurrentTargetId({ error, refusal })}`}>
        {journeyCopy("en").skipToCurrentStep}
      </a>
      {sessionNotice}
      {refusal ? <PermissionRefusal language="en" code={refusal} id={SHOP_ALERT_ID} /> : null}
      {error ? <p id={SHOP_ALERT_ID} tabIndex={-1} role="alert" className="rounded border-2 border-red-700 p-3">{error}</p> : null}
      <p>
        Showing demo laptops for <strong>{USE_LABELS[preferences.use]}</strong> with a budget of{" "}
        <strong>{formatUsd(preferences.budgetCents)}</strong>.
      </p>
      <PreferencesForm use={preferences.use} budget={preferences.budgetDollars} />
      {view.recommendations !== undefined ? (
        <>
          {view.suggestionSource === "model" ? <p>{journeyCopy("en").suggestionSourceModel}</p> : null}
          {view.suggestionSource === "fallback" ? <p>{journeyCopy("en").suggestionSourceFallback}</p> : null}
          <AdvisoryRecommendations message={view.assistantMessage} recommendations={view.recommendations} />
        </>
      ) : view.assistantMessage ? (
        <p className="text-sm">
          <span className="font-medium">Assistant (local mock, advisory only): </span>
          {view.assistantMessage}
        </p>
      ) : null}

      <section aria-labelledby={SHOP_STEP_HEADING_ID} className="flex flex-col gap-4">
        <h2 id={SHOP_STEP_HEADING_ID} tabIndex={-1} className="text-2xl font-semibold">
          Explore laptops
        </h2>
        <p className="text-sm">
          Sold by {view.merchantName}. {journeyCopy("en").catalogNotice}
        </p>
        <ul className="flex flex-col gap-4">
          {view.variants.map(({ product, variant, assessment, aiHardware, aiContext, explanation, quotable }) => (
            <li key={variant.variantId} className="flex flex-col gap-3 rounded-lg border border-zinc-400 p-4">
              <h3 className="text-lg font-semibold">
                {product.title} — {variant.label}
              </h3>
              <p>
                Fixed demo price {formatUsd(variant.unitAmountCents)} USD · {variant.specs.cpu} · {variant.specs.screenInches} inch ·{" "}
                {variant.specs.weightKg} kg
              </p>
              <ReadinessPanel
                assessment={assessment}
                explanation={explanation?.explanation ?? null}
                explanationLabel={view.explanationLabel}
              />
                {aiContext === false ? null : <AiCompatibilityDisclosure assessment={aiHardware} language="en" />}
              {quotable ? (
                <form method="post" action="/checkout/start">
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <input type="hidden" name="productId" value={product.productId} />
                  <input type="hidden" name="variantId" value={variant.variantId} />
                  <input type="hidden" name="quantity" value="1" />
                  <input type="hidden" name="use" value={preferences.use} />
                  <input type="hidden" name="budget" value={preferences.budgetDollars} />
                  <button type="submit" className="rounded bg-blue-800 px-4 py-2 font-medium text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
                    Get a demo quote for {product.title}, {variant.label}
                  </button>
                </form>
              ) : (
                <p className="text-sm">Not available, so it cannot be quoted.</p>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="external-heading" className="flex flex-col gap-4 border-t-4 border-zinc-500 pt-6">
        <h2 id="external-heading" className="text-2xl font-semibold">
          Found elsewhere (external sellers, mock data)
        </h2>
        <p className="text-sm">
          These listings come from other sellers and are not part of the demo store. Their details are unverified and they cannot be
          bought or quoted here.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          {view.external.map((product) => (
            <ExternalProductCard key={product.externalId} product={product} />
          ))}
        </div>
      </section>
    </>
  );
}
