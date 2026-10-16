import { handleSandboxCancel } from "@/server/handlers";
import { mockRouteNotFound, withApplication, pgCheckoutWithoutPermissions } from "@/server/respond";

/** PostgreSQL checkout is refused (M2-3, no F07 enforcement there). Plain mock keeps the simulation step. Sandbox mode cancels before capture. */
export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => (runtime.paymentMode === "sandbox" ? handleSandboxCancel(request, runtime, intentId) : mockRouteNotFound()),
    postgres: async () => pgCheckoutWithoutPermissions(),
  });
}
