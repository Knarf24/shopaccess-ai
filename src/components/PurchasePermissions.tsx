import { formatUsd, permissionCopy, type PermissionFormCode, type ShownState } from "@/lib/i18n/permission-copy";
import type { JourneyLanguage } from "@/lib/i18n/language";
import { FocusOnArrival } from "./FocusOnArrival";

/**
 * The purchase-permissions page body (M2-3 slice 3). Pure: everything it shows is passed in. Native form controls only,
 * each with a visible label; errors are linked to their field; no disabled controls (a permission that cannot be revoked
 * simply has no Revoke button). After a result (created, revoked or an error) focus moves to the result message, and after
 * Review to the review heading (owner decision, October 17); otherwise focus is left where the browser puts it.
 */
export const PERMISSION_RESULT_ID = "permission-result";
export const PERMISSIONS_HEADING_ID = "permissions-heading";
export const PERMISSION_REVIEW_HEADING_ID = "permission-review-heading";

/** Where focus goes when the page arrives: the result message, else the review heading, else nowhere. */
export function permissionArrivalTarget(result: PermissionResult, review: PermissionReview | null): string | null {
  if (result) return PERMISSION_RESULT_ID;
  if (review) return PERMISSION_REVIEW_HEADING_ID;
  return null;
}

export interface CatalogChoice {
  readonly value: string;
  readonly label: string;
  readonly seller: string;
  readonly maxQuantity: number;
}

export interface ShownPermission {
  /** Sent back only as the Revoke form's hidden value; never shown. */
  readonly permissionId: string;
  readonly product: string;
  readonly variant: string;
  readonly seller: string;
  readonly maxQuantity: number;
  readonly maxTotalCents: number;
  readonly expiresAt: Date;
  readonly state: ShownState;
  readonly revocable: boolean;
}

export interface PermissionReview {
  readonly item: string;
  readonly seller: string;
  readonly product: string;
  readonly variant: string;
  readonly maxQuantity: number;
  readonly maxTotalCents: number;
  readonly total: string;
  readonly quantity: string;
  readonly expiry: string;
  readonly endsAt: Date;
}

export type PermissionResult =
  | { readonly kind: "created" | "revoked" }
  | { readonly kind: "error"; readonly code: PermissionFormCode; readonly field: "item" | "quantity" | "total" | "expiry" | null }
  | null;

export const utcTime = (date: Date) => `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`;

export function PurchasePermissions({
  language,
  csrfToken,
  skipLabel,
  choices,
  permissions,
  result,
  review,
  entered,
}: {
  readonly language: JourneyLanguage;
  readonly csrfToken: string;
  readonly skipLabel: string;
  readonly choices: readonly CatalogChoice[];
  readonly permissions: readonly ShownPermission[];
  readonly result: PermissionResult;
  readonly review: PermissionReview | null;
  /** What the shopper entered, echoed back after a review or a refused create. */
  readonly entered: { readonly item: string; readonly quantity: string; readonly total: string; readonly expiry: string };
}) {
  const copy = permissionCopy(language);
  // Catalog names are English. On a Spanish page they are marked English where the markup allows (finding 8); a native
  // <option> holds plain text mixing the name with the Spanish seller label, so the item choices are left unmarked.
  const englishName = (name: string) => (language === "en" ? name : <span lang="en">{name}</span>);
  const fieldError = (field: "item" | "quantity" | "total" | "expiry") => (result?.kind === "error" && result.field === field ? result.code : null);
  const describedBy = (...ids: (string | null)[]) => ids.filter(Boolean).join(" ") || undefined;
  const maxQuantity = Math.max(1, ...choices.map((choice) => choice.maxQuantity));
  const quantityChoices = Array.from({ length: maxQuantity }, (_, index) => String(index + 1));
  const arrival = permissionArrivalTarget(result, review);
  const target = arrival ?? PERMISSIONS_HEADING_ID;
  const resultText =
    result?.kind === "created" ? copy.created : result?.kind === "revoked" ? copy.revoked : result?.kind === "error" ? copy.formErrors[result.code] : null;

  return (
    <div lang={language} className="flex flex-col gap-6">
      <a className="skip-link" href={`#${target}`}>
        {skipLabel}
      </a>
      {arrival ? <FocusOnArrival targetId={arrival} /> : null}
      <h1 id={PERMISSIONS_HEADING_ID} tabIndex={-1} className="text-3xl font-semibold">
        {copy.pageTitle}
      </h1>
      {resultText ? (
        <p id={PERMISSION_RESULT_ID} tabIndex={-1} role={result?.kind === "error" ? "alert" : "status"}>
          {resultText}
        </p>
      ) : null}
      <p>{copy.intro}</p>
      <p>{copy.stillConfirm}</p>

      {review ? (
        <section aria-labelledby={PERMISSION_REVIEW_HEADING_ID} className="flex flex-col gap-3">
          <h2 id={PERMISSION_REVIEW_HEADING_ID} tabIndex={-1} className="text-xl font-semibold">
            {copy.reviewHeading}
          </h2>
          <p>{copy.reviewIntro}</p>
          <dl>
            <dt>{copy.field.seller}</dt>
            <dd>{review.seller}</dd>
            <dt>{copy.field.product}</dt>
            <dd>{englishName(review.product)}</dd>
            <dt>{copy.field.variant}</dt>
            <dd>{englishName(review.variant)}</dd>
            <dt>{copy.field.quantity}</dt>
            <dd>{review.maxQuantity}</dd>
            <dt>{copy.field.total}</dt>
            <dd>{formatUsd(review.maxTotalCents)}</dd>
            <dt>{copy.field.currency}</dt>
            <dd>USD</dd>
            <dt>{copy.field.ends}</dt>
            <dd>
              {utcTime(review.endsAt)}. {copy.endsAtCreation}
            </dd>
          </dl>
          <form method="post" action="/shop/permissions/create">
            <input type="hidden" name="csrfToken" value={csrfToken} />
            <input type="hidden" name="lang" value={language} />
            <input type="hidden" name="item" value={review.item} />
            <input type="hidden" name="quantity" value={review.quantity} />
            <input type="hidden" name="total" value={review.total} />
            <input type="hidden" name="expiry" value={review.expiry} />
            <button type="submit">{copy.createButton}</button>
          </form>
          <p>
            <a href={`/${language}/shop/permissions?${new URLSearchParams({ item: review.item, quantity: review.quantity, total: review.total, expiry: review.expiry }).toString()}`}>
              {copy.changeLink}
            </a>
          </p>
        </section>
      ) : null}

      <section aria-labelledby="permission-create-heading" className="flex flex-col gap-3">
        <h2 id="permission-create-heading" className="text-xl font-semibold">
          {copy.createHeading}
        </h2>
        {/* GET: reviewing changes nothing. Creation is the separate POST above, after the shopper has seen the summary. */}
        <form method="get" action={`/${language}/shop/permissions`} className="flex flex-col gap-3">
          <input type="hidden" name="review" value="1" />
          <label htmlFor="permission-item">{copy.itemLabel}</label>
          <select id="permission-item" name="item" defaultValue={entered.item} aria-describedby={describedBy("permission-item-hint", fieldError("item") && "permission-item-error")} aria-invalid={fieldError("item") ? true : undefined}>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label} ({choice.seller})
              </option>
            ))}
          </select>
          <p id="permission-item-hint">{copy.itemHint}</p>
          {fieldError("item") ? <p id="permission-item-error">{copy.formErrors[fieldError("item")!]}</p> : null}

          <label htmlFor="permission-quantity">{copy.quantityLabel}</label>
          <select id="permission-quantity" name="quantity" defaultValue={entered.quantity || "1"} aria-describedby={describedBy(fieldError("quantity") && "permission-quantity-error")} aria-invalid={fieldError("quantity") ? true : undefined}>
            {quantityChoices.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {fieldError("quantity") ? <p id="permission-quantity-error">{copy.formErrors[fieldError("quantity")!]}</p> : null}

          <label htmlFor="permission-total">{copy.totalLabel}</label>
          <input
            id="permission-total"
            name="total"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            maxLength={10}
            defaultValue={entered.total}
            aria-describedby={describedBy("permission-total-hint", fieldError("total") && "permission-total-error")}
            aria-invalid={fieldError("total") ? true : undefined}
          />
          <p id="permission-total-hint">{copy.totalHint}</p>
          {fieldError("total") ? <p id="permission-total-error">{copy.formErrors[fieldError("total")!]}</p> : null}

          <fieldset aria-describedby={describedBy(fieldError("expiry") && "permission-expiry-error")}>
            <legend>{copy.expiryLegend}</legend>
            {(["15m", "1h", "session"] as const).map((choice) => (
              <div key={choice}>
                <input type="radio" id={`permission-expiry-${choice}`} name="expiry" value={choice} defaultChecked={(entered.expiry || "1h") === choice} />
                <label htmlFor={`permission-expiry-${choice}`}>{copy.expiryChoices[choice]}</label>
              </div>
            ))}
          </fieldset>
          {fieldError("expiry") ? <p id="permission-expiry-error">{copy.formErrors[fieldError("expiry")!]}</p> : null}

          <button type="submit">{copy.reviewButton}</button>
        </form>
      </section>

      <section aria-labelledby="permission-list-heading" className="flex flex-col gap-3">
        <h2 id="permission-list-heading" className="text-xl font-semibold">
          {copy.listHeading}
        </h2>
        {permissions.length === 0 ? <p>{copy.listEmpty}</p> : null}
        <ul className="flex flex-col gap-4">
          {permissions.map((permission, index) => (
            <li key={permission.permissionId}>
              <p id={`permission-item-name-${index}`}>
                <strong>
                  {englishName(permission.product)} — {englishName(permission.variant)}
                </strong>
              </p>
              <p>
                {copy.field.seller}: {permission.seller}. {copy.field.quantity}: {permission.maxQuantity}. {copy.field.total}: {formatUsd(permission.maxTotalCents)} USD.{" "}
                {copy.field.ends}: {utcTime(permission.expiresAt)}.
              </p>
              <p>{copy.states[permission.state]}</p>
              {copy.stateHelp[permission.state] ? <p>{copy.stateHelp[permission.state]}</p> : null}
              {permission.revocable ? (
                <form method="post" action="/shop/permissions/revoke">
                  <input type="hidden" name="csrfToken" value={csrfToken} />
                  <input type="hidden" name="lang" value={language} />
                  <input type="hidden" name="permissionId" value={permission.permissionId} />
                  <button type="submit" aria-describedby={`permission-item-name-${index}`}>
                    {copy.revoke}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
