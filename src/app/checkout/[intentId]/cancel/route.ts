import { handleSandboxCancel } from "@/server/handlers";
import { handlePgCancel } from "@/server/pg-handlers";
import { mockRouteNotFound, withApplication } from "@/server/respond";

/** PostgreSQL cancel is unchanged. Plain mock keeps the simulation step. Sandbox mode cancels before capture. */
export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withApplication({
    mock: (runtime) => (runtime.paymentMode === "sandbox" ? handleSandboxCancel(request, runtime, intentId) : mockRouteNotFound()),
    postgres: (services) => handlePgCancel(request, services, intentId),
  });
}
