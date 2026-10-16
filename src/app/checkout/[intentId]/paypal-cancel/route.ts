import { handleSandboxPaypalCancel } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** Sandbox cancel page. It does not cancel by itself. Plain mock and PostgreSQL mode answer 404. */
export async function GET(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => (runtime.paymentMode === "sandbox" ? handleSandboxPaypalCancel(request, runtime, intentId) : mockRouteNotFound()),
    postgres: () => mockRouteNotFound(),
  });
}
