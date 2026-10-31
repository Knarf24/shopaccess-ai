import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../../guided-presentation.css";
import "../../../ui-refresh.css";
import { ConfigNotice } from "@/components/ConfigNotice";
import { DeviceProfileForm } from "@/components/DeviceProfileForm";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { guidedSessionEntry } from "@/lib/i18n/language";
import { documentLocale } from "@/lib/i18n/locale-segment";
import { isProfileErrorCode, isProfileResultCode, profileCopy, profileNotice } from "@/lib/i18n/profile-copy";
import type { DeviceProfileDisplay } from "@/types/device-profile";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PageParams = Promise<{ lang: string }>;

const one = (value: string | string[] | undefined, max = 40) => (typeof value === "string" && value.length <= max ? value : "");

function displayOf(profile: { readonly version: number; readonly brand: string | null; readonly model: string | null } | null): DeviceProfileDisplay {
  if (!profile) return { version: 0, brand: "", model: "", brandSaved: false, modelSaved: false };
  return {
    version: profile.version,
    brand: profile.brand ?? "",
    model: profile.model ?? "",
    brandSaved: profile.brand !== null,
    modelSaved: profile.model !== null,
  };
}

/** GET /shop/profile. Rendering does not save. PostgreSQL mode says the feature is unavailable and does not connect. */
async function ProfileContentUnguarded({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  await connection();
  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const language = documentLocale(lang);
  if (!language) notFound();
  const copy = profileCopy(language);
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
  const admissionLocation = protectedAdmissionLocation(runtime.value.admission, cookie, runtime.value.clock().getTime(), language);
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
  const error = one(query.error);
  const result = one(query.result);
  const code = isProfileErrorCode(error) ? error : isProfileResultCode(result) ? result : null;
  return (
    <>
      <DocumentLanguageSync language={language} />
      <DeviceProfileForm language={language} csrfToken={session.csrfToken} profile={displayOf(runtime.value.profiles.read(session.id))} notice={profileNotice(copy, code)} />
      <p className="mt-6">
        <Link href="/shop" prefetch={false}>{copy.backToShop}</Link>
      </p>
    </>
  );
}

async function ProfileContent(props: { params: PageParams; searchParams: SearchParams }) {
  return guardPage(() => ProfileContentUnguarded(props), () => <StoreUnavailable />);
}

export default function ProfilePage({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  return (
    <main className="guided-presentation ui-refresh">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <ProfileContent params={params} searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
