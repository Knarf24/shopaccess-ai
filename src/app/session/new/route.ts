import { handlePgSessionNew } from "@/server/pg-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** PostgreSQL mode only: the explicit start of a new session in place of a credential that cannot be used. */
export async function POST(request: Request) {
  return withApplication({
    mock: () => mockRouteNotFound(),
    postgres: (services) => handlePgSessionNew(request, services),
  });
}
