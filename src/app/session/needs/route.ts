import { handleNeedsSession } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** Mock only. The destination is fixed inside the handler. PostgreSQL mode answers not found. */
export async function GET(request: Request) {
  return withApplication({
    mock: (runtime) => handleNeedsSession(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
