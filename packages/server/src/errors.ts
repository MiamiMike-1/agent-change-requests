/** Error reasons from SEP section 10, plus the few this package adds. */
export type ErrorReason =
  | "kind_unsupported"
  | "tests_unsupported"
  | "not_shipped"
  | "rate_limited"
  | "not_found"
  | "terminal_status"
  // Additions:
  | "invalid_params"
  | "unauthenticated"
  | "shared_credential"
  | "invalid_transition";

/** JSON-RPC code the spec uses for every change request error. */
export const INVALID_PARAMS_CODE = -32602;

export class ChangeRequestError extends Error {
  readonly code = INVALID_PARAMS_CODE;
  readonly reason: ErrorReason;
  readonly retryAfterMs?: number;

  constructor(reason: ErrorReason, message: string, options: { retryAfterMs?: number } = {}) {
    super(message);
    this.name = "ChangeRequestError";
    this.reason = reason;
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  /** The `data` member of a JSON-RPC error. */
  get data(): { reason: ErrorReason; retryAfterMs?: number } {
    return this.retryAfterMs === undefined
      ? { reason: this.reason }
      : { reason: this.reason, retryAfterMs: this.retryAfterMs };
  }
}

export function isChangeRequestError(value: unknown): value is ChangeRequestError {
  return value instanceof ChangeRequestError;
}
