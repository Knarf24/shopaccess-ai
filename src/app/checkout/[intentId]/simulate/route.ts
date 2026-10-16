import { handleSimulate } from "@/server/handlers";
import { handlePgSimulate } from "@/server/pg-handlers";
import { withApplication } from "@/server/respond";

export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => handleSimulate(request, runtime, intentId),
    // The simulated payment lifecycle belongs to the mock alone.
    postgres: (services) => handlePgSimulate(request, services),
  });
}
