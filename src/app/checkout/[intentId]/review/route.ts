import { handlePgReview } from "@/server/pg-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** PostgreSQL mode only: "Review again", the guarded request for a challenge of this checkout. */
export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: () => mockRouteNotFound(),
    postgres: (services) => handlePgReview(request, services, intentId),
  });
}
