import { handleChargerControl } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleChargerControl(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
