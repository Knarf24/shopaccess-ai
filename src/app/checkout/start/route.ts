import { handleCheckoutStart } from "@/server/handlers";
import { withApplication, pgCheckoutWithoutPermissions } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleCheckoutStart(request, runtime),
    postgres: async () => pgCheckoutWithoutPermissions(),
  });
}
