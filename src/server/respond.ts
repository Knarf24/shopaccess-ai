import type { Runtime } from "./runtime";
import { getRuntime } from "./runtime";

/** Runs a handler with the process runtime, or fails closed when configuration is missing or invalid. */
export async function withRuntime(handler: (runtime: Runtime) => Promise<Response>): Promise<Response> {
  const runtime = getRuntime();
  if (!runtime.ok) {
    return Response.json(
      { error: { code: "NOT_CONFIGURED", message: "The demonstration is not configured. See README.md." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return handler(runtime.value);
}
