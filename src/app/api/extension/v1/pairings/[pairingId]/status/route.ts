import { extensionPreflight } from "@/server/extension-guard";
import { handleExtensionPairingStatus } from "@/server/extension-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";
import { openApplication } from "@/server/runtime-access";

/** M2-2 extension API: pairing status. Mock only; PostgreSQL mode answers not found. */
export async function POST(request: Request, context: { params: Promise<{ pairingId: string }> }) {
  const { pairingId } = await context.params;
  return withApplication({ mock: (runtime) => handleExtensionPairingStatus(request, runtime, pairingId), postgres: async () => mockRouteNotFound() });
}

export async function OPTIONS(request: Request) {
  const application = await openApplication();
  if (application === "unavailable" || application.mode !== "mock" || !application.runtime.ok) return mockRouteNotFound();
  return extensionPreflight(request, application.runtime.value.extensionOrigins, ["POST"]);
}
