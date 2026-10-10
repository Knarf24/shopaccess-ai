export const PUBLIC_ERROR_CODES = [
  "BAD_REQUEST",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type PublicErrorCode = (typeof PUBLIC_ERROR_CODES)[number];

const PUBLIC_MESSAGES: Record<PublicErrorCode, string> = {
  BAD_REQUEST: "The request could not be processed.",
  FORBIDDEN: "This action is not allowed.",
  NOT_FOUND: "The requested item was not found.",
  CONFLICT: "This action has already been completed or is no longer available.",
  PAYLOAD_TOO_LARGE: "The request is too large.",
  RATE_LIMITED: "Too many requests. Please wait and try again.",
  UNAVAILABLE: "The service is busy. Please try again later.",
  INTERNAL_ERROR: "Something went wrong. Please try again.",
};

const STATUS: Record<PublicErrorCode, number> = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export interface PublicError {
  readonly status: number;
  readonly body: { readonly error: { readonly code: PublicErrorCode; readonly message: string; readonly requestId: string } };
}

/**
 * The only way an error reaches a client. The body is built from a fixed
 * message table; nothing from the underlying error (message, stack, SQL,
 * configuration) is ever copied into it.
 */
export function toPublicError(code: PublicErrorCode, requestId: string): PublicError {
  const safeRequestId = /^[A-Za-z0-9_-]{1,64}$/.test(requestId) ? requestId : "unavailable";
  return { status: STATUS[code], body: { error: { code, message: PUBLIC_MESSAGES[code], requestId: safeRequestId } } };
}

/** Maps any thrown value to a generic internal error. */
export function publicErrorFromUnknown(_error: unknown, requestId: string): PublicError {
  return toPublicError("INTERNAL_ERROR", requestId);
}
