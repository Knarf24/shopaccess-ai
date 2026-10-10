import { handleSessionStart } from "@/server/handlers";
import { withRuntime } from "@/server/respond";

export async function GET(request: Request) {
  return withRuntime((runtime) => handleSessionStart(request, runtime));
}
