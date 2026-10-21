import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import "../../guided-presentation.css";
import { ConfigNotice } from "@/components/ConfigNotice";
import { DeviceProfileForm } from "@/components/DeviceProfileForm";
import { DocumentLanguageSync } from "@/components/mock-journey/ListingSearchForm";
import { StoreUnavailable } from "@/components/StoreUnavailable";
import { allowlistedJourneyLanguage, guidedSessionEntry } from "@/lib/i18n/language";
import { isProfileErrorCode, isProfileResultCode, profileCopy, profileNotice } from "@/lib/i18n/profile-copy";
import type { DeviceProfileDisplay } from "@/types/device-profile";
import { protectedAdmissionLocation } from "@/server/demo-admission";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { resolvePageSession } from "@/server/views";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

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
async function ProfileContentUnguarded({ searchParams }: { searchParams: SearchParams }) {
  await connection();
  const query = await searchParams;
  const language = allowlistedJourneyLanguage(one(query.lang, 8));
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
        <a href="/shop">{copy.backToShop}</a>
      </p>
    </>
  );
}

async function ProfileContent(props: { searchParams: SearchParams }) {
  return guardPage(() => ProfileContentUnguarded(props), () => <StoreUnavailable />);
}

export default function ProfilePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="guided-presentation">
      <div className="presentation-column">
        <Suspense fallback={<p>Loading…</p>}>
          <ProfileContent searchParams={searchParams} />
        </Suspense>
      </div>
    </main>
  );
}
