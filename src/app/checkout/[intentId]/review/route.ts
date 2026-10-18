import { mockRouteNotFound, withApplication, pgCheckoutWithoutPermissions } from "@/server/respond";

/**
 * PostgreSQL mode only: "Review again". M2-3: refused while PostgreSQL mode has no F07 purchase-permission enforcement
 * (fail closed). The mock has no such route.
 */
export async function POST() {
  return withApplication({
    mock: () => mockRouteNotFound(),
    postgres: async () => pgCheckoutWithoutPermissions(),
  });
}
