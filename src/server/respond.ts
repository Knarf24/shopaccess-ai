import { toPublicError, type PublicErrorCode } from "@/lib/security/errors";
import { randomIdGenerator } from "@/lib/shared/ids";
import { isPersistenceUnavailable } from "@/lib/session/durable";
import type { PgServices } from "./pg-runtime";
import type { Application, Runtime } from "./runtime";
import { runtimeOf } from "./runtime";
import { openRuntime } from "./runtime-access";

/** Runs a handler with the process runtime, or fails closed when configuration is missing or invalid. */
export async function withRuntime(handler: (runtime: Runtime) => Promise<Response>): Promise<Response> {
  const access = await openRuntime();
  if (access.status !== "ready") return refuseWithoutRuntime("UNAVAILABLE");
  return withMockRuntime(access.application, handler);
}

/**
 * Runs a mock handler. A blocked snapshot gate refuses before the handler runs, so no provider call starts; a save
 * refused while the handler runs becomes the same public UNAVAILABLE (HTTP 503, no-store, no Set-Cookie).
 */
export async function withMockRuntime(application: Application, handler: (runtime: Runtime) => Promise<Response>): Promise<Response> {
  const runtime = runtimeOf(application);
  if (!runtime.ok) {
    return Response.json(
      { error: { code: "NOT_CONFIGURED", message: "The demonstration is not configured. See README.md." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  if (!runtime.value.durable.available()) return refuseWithoutRuntime("UNAVAILABLE");
  try {
    return await handler(runtime.value);
  } catch (error) {
    if (isPersistenceUnavailable(error)) return refuseWithoutRuntime("UNAVAILABLE");
    throw error;
  }
}

/** The one generic refusal of a route that has no runtime to take an id from. Fixed text and a new request id. */
function refuseWithoutRuntime(code: PublicErrorCode): Response {
  const error = toPublicError(code, randomIdGenerator("event"));
  return Response.json(error.body, { status: error.status, headers: { "cache-control": "no-store" } });
}

/**
 * M2-3: PostgreSQL mode has no F07 purchase-permission enforcement, so every checkout step there refuses (fail closed).
 * There is no fallback to an unprotected checkout. The PostgreSQL checkout handlers stay unchanged and unreachable from
 * routes until equivalent enforcement exists (docs/m2-3-plan.md §11).
 */
export async function pgCheckoutWithoutPermissions(): Promise<Response> {
  const error = toPublicError("UNAVAILABLE", randomIdGenerator("event"));
  const body = { error: { ...error.body.error, message: "Checkout is turned off in PostgreSQL mode: purchase permissions are not enforced there." } };
  return Response.json(body, { status: error.status, headers: { "cache-control": "no-store" } });
}

/** Device profiles exist only in the mock snapshot. PostgreSQL mode refuses them and does not connect. */
export async function pgDeviceProfileUnavailable(): Promise<Response> {
  const error = toPublicError("UNAVAILABLE", randomIdGenerator("event"));
  const body = { error: { ...error.body.error, message: "Device profiles are unavailable in PostgreSQL mode." } };
  return Response.json(body, { status: error.status, headers: { "cache-control": "no-store" } });
}

/** M2-3: purchase permissions exist only in the mock; PostgreSQL mode refuses them explicitly (fail closed), not 404. */
export async function pgPermissionsUnavailable(): Promise<Response> {
  const error = toPublicError("UNAVAILABLE", randomIdGenerator("event"));
  const body = { error: { ...error.body.error, message: "Purchase permissions are unavailable in PostgreSQL mode." } };
  return Response.json(body, { status: error.status, headers: { "cache-control": "no-store" } });
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
  const access = await openRuntime();
  if (access.status !== "ready") return refuseWithoutRuntime("UNAVAILABLE");
  const application = access.application;
  if (application.mode === "mock") return withMockRuntime(application, handlers.mock);
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
