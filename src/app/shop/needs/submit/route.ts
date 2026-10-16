import { handleNeedsSubmit } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleNeedsSubmit(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
