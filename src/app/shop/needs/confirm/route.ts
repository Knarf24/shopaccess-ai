import { handleNeedsConfirm } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleNeedsConfirm(request, runtime),
    postgres: async () => mockRouteNotFound(),
  });
}
