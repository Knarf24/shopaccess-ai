import { handleSandboxCapture } from "@/server/handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** Sandbox capture. Plain mock and PostgreSQL mode answer 404. */
export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => (runtime.paymentMode === "sandbox" ? handleSandboxCapture(request, runtime, intentId) : mockRouteNotFound()),
    postgres: () => mockRouteNotFound(),
  });
}
