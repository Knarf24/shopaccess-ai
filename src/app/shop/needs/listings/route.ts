import { handleNeedsListings } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleNeedsListings(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
