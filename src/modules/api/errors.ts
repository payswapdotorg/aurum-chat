// Typed errors of the api module. Consumers catch `ApiError` and branch on
// `code`; messages are for humans/logs, never for control flow.
//
// Every code carries its HTTP status (single source of truth in
// `httpStatusFor`) — the kernel maps this module's errors, and domain
// errors bubbling out of delegated contracts, onto the versioned HTTP
// surface without leaking internals: unknown failures surface as a
// sanitized `internal_error`.

export type ApiErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_body'
  | 'invalid_query'
  | 'unauthenticated'
  | 'missing_scope'
  | 'principal_not_member'
  | 'route_not_found'
  | 'method_not_allowed'
  | 'api_key_not_found'
  | 'webhook_not_found'
  | 'webhook_delivery_not_found'
  | 'event_not_found'
  | 'webhook_conflict'
  | 'provider_unavailable'
  | 'audit_unavailable'
  | 'internal_error';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  invalid_context: 400,
  invalid_input: 400,
  invalid_body: 400,
  invalid_query: 400,
  unauthenticated: 401,
  missing_scope: 403,
  principal_not_member: 403,
  route_not_found: 404,
  method_not_allowed: 405,
  api_key_not_found: 404,
  webhook_not_found: 404,
  webhook_delivery_not_found: 404,
  event_not_found: 404,
  webhook_conflict: 409,
  provider_unavailable: 503,
  audit_unavailable: 500,
  internal_error: 500,
};

/** HTTP status for one of this module's error codes. */
export function httpStatusFor(code: ApiErrorCode): number {
  return STATUS_BY_CODE[code];
}

export class ApiError extends Error {
  public readonly status: number;

  constructor(
    public readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = httpStatusFor(code);
  }
}

/**
 * A domain error bubbling out of a delegated module contract (GoalsError,
 * MissionsError, …), recognized by its string `code` and mapped onto the
 * public status taxonomy. Codes that match none of the patterns are NOT
 * domain-shaped — they surface as `internal_error` (sanitized).
 */
export interface MappedDomainError {
  status: number;
  code: string;
  message: string;
}

export function isDomainErrorCode(code: unknown): code is string {
  return typeof code === 'string' && /^[a-z][a-z0-9_]*$/.test(code);
}

/** Map a delegated contract's error code onto the public HTTP taxonomy. */
export function mapDomainErrorCode(code: string): number | null {
  if (code.endsWith('_not_found')) return 404;
  if (code.startsWith('invalid_')) return 400;
  if (code.endsWith('_conflict')) return 409;
  if (/(forbidden|permission|authority|unauthorized|not_permitted|not_member)/.test(code)) {
    return 403;
  }
  if (code === 'provider_unavailable') return 503;
  return null;
}

/**
 * Interpret a thrown value from a delegated contract. Returns null when the
 * value does not look like a domain error (caller falls back to the
 * sanitized internal error).
 */
export function mapDomainError(error: unknown): MappedDomainError | null {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const code: unknown = (error as { code?: unknown } | null)?.code;
  if (!isDomainErrorCode(code)) return null;
  const status = mapDomainErrorCode(code);
  if (status === null) return null;
  const message = error instanceof Error ? error.message : String(error);
  return { status, code, message };
}
