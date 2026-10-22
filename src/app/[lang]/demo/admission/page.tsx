import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ConfigNotice } from "@/components/ConfigNotice";
import "../../../guided-presentation.css";
import { documentLocale } from "@/lib/i18n/locale-segment";
import { admissionScreen } from "@/server/demo-admission";
import { AdmissionScreen } from "./admission-screen";
import { runtimeOf } from "@/server/runtime";
import { guardPage, openApplication } from "@/server/runtime-access";
import { StoreUnavailable } from "@/components/StoreUnavailable";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type PageParams = Promise<{ lang: string }>;

export default function DemoAdmissionPage({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  return (
    <Suspense fallback={<p>Loading the demonstration…</p>}>
      <AdmissionContent params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function AdmissionContentUnguarded({ params, searchParams }: { params: PageParams; searchParams: SearchParams }) {
  await connection();
  const opened = await openApplication();
  if (opened === "unavailable") return <StoreUnavailable />;
  const application = opened;
  if (application.mode === "postgres") notFound();
  if (application.mode === "invalid") return <ConfigNotice errors={["SHOPACCESS_PERSISTENCE_MODE"]} />;
  const runtime = runtimeOf(application);
  if (!runtime.ok) return <ConfigNotice errors={runtime.error} />;

  const [{ lang }, query] = await Promise.all([params, searchParams]);
  const language = documentLocale(lang);
  if (!language) notFound();
  const model = admissionScreen(
    runtime.value.admission,
    (await headers()).get("cookie"),
    runtime.value.clock().getTime(),
    language,
    typeof query.notice === "string" ? query.notice : undefined,
  );
  if (model === "not-found") notFound();
  return <AdmissionScreen model={model} />;
}

/** A save refused while rendering shows the unavailable notice, never a partial or success view. */
async function AdmissionContent(props: Parameters<typeof AdmissionContentUnguarded>[0]) {
  return guardPage(() => AdmissionContentUnguarded(props), () => <StoreUnavailable />);
}
