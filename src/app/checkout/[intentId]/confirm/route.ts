import { handleConfirm } from "@/server/handlers";
import { withRuntime } from "@/server/respond";

export async function POST(request: Request, context: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await context.params;
  return withRuntime((runtime) => handleConfirm(request, runtime, intentId));
}
