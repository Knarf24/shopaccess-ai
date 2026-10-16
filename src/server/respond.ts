import { toPublicError, type PublicErrorCode } from "@/lib/security/errors";
import { randomIdGenerator } from "@/lib/shared/ids";
import type { PgServices } from "./pg-runtime";
import type { Runtime } from "./runtime";
import { getApplication, getRuntime } from "./runtime";

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

/** The one generic refusal of a route that has no runtime to take an id from. Fixed text and a new request id. */
function refuseWithoutRuntime(code: PublicErrorCode): Response {
  const error = toPublicError(code, randomIdGenerator("event"));
  return Response.json(error.body, { status: error.status, headers: { "cache-control": "no-store" } });
}

/** A route that exists only in PostgreSQL mode: in the mock it is "not found", as it was before the route existed. */
export async function mockRouteNotFound(): Promise<Response> {
  return refuseWithoutRuntime("NOT_FOUND");
}

export interface ModeHandlers {
  /** The mock, exactly as before. */
  readonly mock: (runtime: Runtime) => Promise<Response>;
  /** PostgreSQL mode. Called only while the runtime is ready. */
  readonly postgres: (services: PgServices) => Promise<Response>;
}

/**
 * Runs the handler of the mode this process serves. The mode never changes while the process runs, and there is no
 * route from PostgreSQL mode to the mock: when the PostgreSQL runtime is not available the answer is the generic
 * "not available" refusal, with no business data.
 */
export async function withApplication(handlers: ModeHandlers): Promise<Response> {
  const application = getApplication();
  if (application.mode === "mock") return withRuntime(handlers.mock);
  if (application.mode === "invalid") {
    return Response.json(
      { error: { code: "NOT_CONFIGURED", message: "The demonstration is not configured. See README.md." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  const services = await application.runtime.services();
  if (!services) return refuseWithoutRuntime("UNAVAILABLE");
  try {
    return await handlers.postgres(services);
  } catch {
    // Nothing of the error reaches the client. The handlers classify what they expect; this is the last line.
    return refuseWithoutRuntime("INTERNAL_ERROR");
  }
}
