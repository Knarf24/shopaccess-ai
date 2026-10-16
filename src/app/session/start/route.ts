import { handleSessionStart } from "@/server/handlers";
import { handlePgSessionStart } from "@/server/pg-handlers";
import { withApplication } from "@/server/respond";

export async function GET(request: Request) {
  return withApplication({
    mock: (runtime) => handleSessionStart(request, runtime),
    postgres: (services) => handlePgSessionStart(request, services),
  });
}
