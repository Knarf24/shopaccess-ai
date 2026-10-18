import { handleSimulate } from "@/server/handlers";
import { withApplication, pgCheckoutWithoutPermissions } from "@/server/respond";

export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => handleSimulate(request, runtime, intentId),
    // The simulated payment lifecycle belongs to the mock alone; PostgreSQL checkout is refused (M2-3, no F07 there).
    postgres: async () => pgCheckoutWithoutPermissions(),
  });
}
