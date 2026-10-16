import { handleExtensionRevoke } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** M2-2: the website revokes one paired side panel of its own session. Mock only. */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handleExtensionRevoke(request, runtime), postgres: async () => mockRouteNotFound() });
}
