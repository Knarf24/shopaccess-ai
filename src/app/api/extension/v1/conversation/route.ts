import { extensionPreflight } from "@/server/extension-guard";
import { handleExtensionConversation } from "@/server/extension-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";
import { openApplication } from "@/server/runtime-access";

/** M2-2 extension API: the shared conversation (read). Mock only; PostgreSQL mode answers not found. */
export async function GET(request: Request) {
  return withApplication({ mock: (runtime) => handleExtensionConversation(request, runtime), postgres: async () => mockRouteNotFound() });
}

export async function OPTIONS(request: Request) {
  const application = await openApplication();
  if (application === "unavailable" || application.mode !== "mock" || !application.runtime.ok) return mockRouteNotFound();
  return extensionPreflight(request, application.runtime.value.extensionOrigins, ["GET"]);
}
