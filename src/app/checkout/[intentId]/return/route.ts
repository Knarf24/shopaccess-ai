import { handleSandboxReturn } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** Sandbox return. A browser return does not capture payment. Plain mock and PostgreSQL mode answer 404. */
export async function GET(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => (runtime.paymentMode === "sandbox" ? handleSandboxReturn(request, runtime, intentId) : mockRouteNotFound()),
    postgres: () => mockRouteNotFound(),
  });
}
