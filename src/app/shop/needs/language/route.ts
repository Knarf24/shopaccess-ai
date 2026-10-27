import { handleNeedsLanguage } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleNeedsLanguage(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
