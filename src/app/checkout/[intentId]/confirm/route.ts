import { handleConfirm } from "@/server/handlers";
import { handlePgConfirm } from "@/server/pg-handlers";
import { withApplication } from "@/server/respond";

export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => handleConfirm(request, runtime, intentId),
    postgres: (services) => handlePgConfirm(request, services, intentId),
  });
}
