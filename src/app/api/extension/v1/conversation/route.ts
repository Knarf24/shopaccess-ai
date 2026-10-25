import { extensionPreflight } from "@/server/extension-guard";
import { handleExtensionConversation, handleExtensionConversationGet } from "@/server/extension-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";
import { openApplication } from "@/server/runtime-access";

/**
 * M2-2 extension API: the shared conversation (read). A POST with an empty JSON body, so that the extension's Origin is
 * always sent; GET is retired (405, Allow: POST). Mock only; PostgreSQL mode answers not found.
 */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handleExtensionConversation(request, runtime), postgres: async () => mockRouteNotFound() });
}

export async function GET() {
  return withApplication({ mock: async (runtime) => handleExtensionConversationGet(runtime), postgres: async () => mockRouteNotFound() });
}

export async function OPTIONS(request: Request) {
  const application = await openApplication();
  if (application === "unavailable" || application.mode !== "mock" || !application.runtime.ok) return mockRouteNotFound();
  return extensionPreflight(request, application.runtime.value.extensionOrigins, ["POST"]);
}
