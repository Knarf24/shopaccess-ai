import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../guided-presentation.css";
import { ConfigNotice } from "@/components/ConfigNotice";
import { PurchasePermissions, type CatalogChoice, type PermissionResult, type PermissionReview, type ShownPermission } from "@/components/PurchasePermissions";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { findMerchantVariant } from "@/lib/catalog/merchant-catalog";
import { journeyCopy } from "@/lib/i18n/demo-copy";
import { allowlistedJourneyLanguage, guidedSessionEntry } from "@/lib/i18n/language";
import { isPermissionFormCode, permissionCopy } from "@/lib/i18n/permission-copy";
import { sellerName } from "@/lib/i18n/seller-name";
import { resolveExpiry } from "@/lib/permissions/model";
import { admissionExpiryMs, protectedAdmissionLocation } from "@/server/demo-admission";
import { fieldOf, parsePermissionForm } from "@/server/permission-form";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** A short query value, or "". Echoed values are only ever shown back in form fields. */
const one = (value: string | string[] | undefined, max = 80) => (typeof value === "string" && value.length <= max ? value : "");

/**
 * GET /shop/permissions (M2-3 slice 3). Shows and creates F07 purchase permissions for this browser's live website
 * session. Rendering (including the review of a draft) changes nothing; creating and revoking are CSRF-protected POSTs.
 * PostgreSQL mode: the feature is unavailable there and says so.
 */
async function PermissionsContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const query = await searchParams;
  const language = allowlistedJourneyLanguage(one(query.lang));
  const copy = permissionCopy(language);
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  if (opened.mode === "postgres") {
    return (
      <div lang={language}>
        <DocumentLanguageSync language={language} />
        <h1 className="text-3xl font-semibold">{copy.pageTitle}</h1>
        <p role="alert">{copy.unavailablePostgres}</p>
      </div>
    );
  }
  if (opened.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(opened);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;
  const cookie = (await headers()).get("cookie");
  const nowMs = runtime.value.clock().getTime();
  const admissionLocation = protectedAdmissionLocation(runtime.value.admission, cookie, nowMs, language);
  if (admissionLocation) redirect(admissionLocation);
  const session = await resolvePageSession(runtime.value);
  if (!session) {
    return (
      <div lang={language} className="flex flex-col gap-4">
        <DocumentLanguageSync language={language} />
        <h1 className="text-3xl font-semibold">{copy.pageTitle}</h1>
        <p>{copy.noSession}</p>
        <p>
          <a href={guidedSessionEntry(language)}>{copy.startShopping}</a>
        </p>
      </div>
    );
  }

  const { catalog } = runtime.value;
  const choices: CatalogChoice[] = catalog.products.flatMap((product) =>
    product.variants
      .filter((variant) => variant.availability === "IN_STOCK")
      .map((variant) => ({ value: `${product.productId}:${variant.variantId}`, label: `${product.title} — ${variant.label}`, seller: sellerName(catalog.merchant.displayName, language), maxQuantity: variant.maxQuantityPerOrder })),
  );
  const now = runtime.value.clock();
  const permissions: ShownPermission[] = runtime.value.permissions.list(session.id, now).map((view) => {
    const entry = findMerchantVariant(catalog, view.productId, view.variantId);
    return {
      permissionId: view.permissionId,
      product: entry?.product.title ?? view.productId,
      variant: entry?.variant.label ?? view.variantId,
      seller: sellerName(catalog.merchant.displayName, language),
      maxQuantity: view.maxQuantity,
      maxTotalCents: view.maxTotalCents,
      expiresAt: view.expiresAt,
      state: view.state,
      // The server decides again on revoke; the button is offered only where revoking is meaningful.
      revocable: view.live && (view.state === "active" || view.state === "reserved"),
    };
  });

  const values = { item: one(query.item), quantity: one(query.quantity, 3), total: one(query.total, 12), expiry: one(query.expiry, 8) };
  const errorCode = one(query.error, 40);
  const outcome = one(query.result, 10);
  let result: PermissionResult =
    outcome === "created" || outcome === "revoked"
      ? { kind: outcome }
      : isPermissionFormCode(errorCode)
        ? { kind: "error", code: errorCode, field: fieldOf(errorCode) }
        : null;

  let review: PermissionReview | null = null;
  if (one(query.review) === "1" && !result) {
    const parsed = parsePermissionForm(values, catalog);
    if (!parsed.ok) result = { kind: "error", code: parsed.code, field: parsed.field };
    else {
      const entry = findMerchantVariant(catalog, parsed.value.productId, parsed.value.variantId)!;
      const sessionEnd = runtime.value.durable.sessionStore.absoluteExpiryOf(session.id)?.getTime() ?? nowMs;
      const endsAt = new Date(resolveExpiry(parsed.value.expiry, nowMs, sessionEnd, admissionExpiryMs(runtime.value.admission, cookie, nowMs)));
      review = {
        item: values.item,
        seller: sellerName(catalog.merchant.displayName, language),
        product: entry.product.title,
        variant: entry.variant.label,
        maxQuantity: parsed.value.maxQuantity,
        maxTotalCents: parsed.value.maxTotalCents,
        quantity: values.quantity,
        total: values.total,
        expiry: values.expiry,
        endsAt,
      };
    }
  }

  return (
    <>
      <DocumentLanguageSync language={language} />
      <PurchasePermissions
        language={language}
        csrfToken={session.csrfToken}
        skipLabel={journeyCopy(language).skipToCurrentStep}
        choices={choices}
        permissions={permissions}
        result={result}
        review={review}
        entered={values}
      />
      <p className="mt-6">
        <a href={`/shop/needs?lang=${language}`}>{copy.backToShopping}</a>
      </p>
    </>
  );
}

async function PermissionsContent(props: { searchParams: SearchParams }) {
  return guardPage(() => PermissionsContentUnguarded(props), () => <StoreUnavailable />);
}

export default function PermissionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <PermissionsContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
