import { handleConfirm } from "@/server/handlers";
import { withApplication, pgCheckoutWithoutPermissions } from "@/server/respond";

export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => handleConfirm(request, runtime, intentId),
    postgres: async () => pgCheckoutWithoutPermissions(),
  });
}
