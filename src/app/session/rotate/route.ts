import { handlePgSessionRotate } from "@/server/pg-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** PostgreSQL mode only: the one place a session is rotated to the ACTIVE key. */
export async function POST(request: Request) {
  return withApplication({
    mock: () => mockRouteNotFound(),
    postgres: (services) => handlePgSessionRotate(request, services),
  });
}
