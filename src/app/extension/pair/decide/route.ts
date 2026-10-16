import { handleExtensionPairDecision } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** M2-2: the website approves or denies an extension pairing for its own session. Mock only. */
export async function POST(request: Request) {
  return withApplication({ mock: (runtime) => handleExtensionPairDecision(request, runtime), postgres: async () => mockRouteNotFound() });
}
