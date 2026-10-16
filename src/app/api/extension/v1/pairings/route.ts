import { extensionPreflight } from "@/server/extension-guard";
import { handleExtensionPairingStart } from "@/server/extension-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";
import { openApplication } from "@/server/runtime-access";

/** M2-2 extension API: start a pairing. Mock only; PostgreSQL mode answers not found. */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handleExtensionPairingStart(request, runtime), postgres: async () => mockRouteNotFound() });
}

export async function OPTIONS(request: Request) {
  const application = await openApplication();
  if (application === "unavailable" || application.mode !== "mock" || !application.runtime.ok) return mockRouteNotFound();
  return extensionPreflight(request, application.runtime.value.extensionOrigins, ["POST"]);
}
