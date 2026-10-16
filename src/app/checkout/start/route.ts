import { handleCheckoutStart } from "@/server/handlers";
import { handlePgCheckoutStart } from "@/server/pg-handlers";
import { withApplication } from "@/server/respond";

export async function POST(request: Request) {
  return withApplication({
    mock: (runtime) => handleCheckoutStart(request, runtime),
    postgres: (services) => handlePgCheckoutStart(request, services),
  });
}
