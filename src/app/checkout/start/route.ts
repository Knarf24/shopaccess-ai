import { handleCheckoutStart } from "@/server/handlers";
import { withRuntime } from "@/server/respond";

export async function POST(request: Request) {
  return withRuntime((runtime) => handleCheckoutStart(request, runtime));
}
