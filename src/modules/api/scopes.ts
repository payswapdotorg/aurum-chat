// The api module's capability-scope vocabulary (W038 — Public API).
//
// The public API is CAPABILITY-oriented (lock 31): every route names the
// capability scope a key must hold, and every key names exactly the
// capabilities it was granted — a tenant can hand an integration a
// read-only window into goals without letting it request investigations or
// touch approvals. Scopes are granted at key issuance and checked at the
// HTTP boundary; they sit ON TOP of (never instead of) the authority
// claims and membership checks the delegated contracts already enforce
// (lock 32: tenant-scoped, permission-checked, audited).
//
// Authority claims (the TenantContext vocabulary the domain modules gate
// on — 'actions:approve', 'actions:administer', 'agents:administer') may be
// granted to a key from the CLOSED list below, so a key can act at the
// authority level its operations require without any way to mint
// unrestricted claims ('organizations:provision' & co. are deliberately
// absent: platform claims must never ride a tenant API key).

import { ApiError } from './errors';

/**
 * The closed capability-scope vocabulary of the v1 public API.
 * KEEP IN SYNC with the scopes CHECK constraint in
 * src/modules/api/migrations/001-api-keys.sql.
 */
export const API_SCOPES = [
  'goals:read',
  'missions:read',
  'missions:write',
  'epistemics:read',
  'knowledge:read',
  'evidence:read',
  'capabilities:read',
  'agents:read',
  'approvals:read',
  'approvals:write',
  'webhooks:manage',
  'api:administer',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const API_SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === 'string' && API_SCOPE_SET.has(value);
}

/**
 * The closed authority-claim vocabulary an API key may carry downstream.
 * KEEP IN SYNC with the authority CHECK constraint in
 * src/modules/api/migrations/001-api-keys.sql.
 */
export const API_KEY_AUTHORITY_CLAIMS = [
  'api:administer',
  'actions:approve',
  'actions:administer',
  'agents:administer',
] as const;

export type ApiKeyAuthorityClaim = (typeof API_KEY_AUTHORITY_CLAIMS)[number];

const API_KEY_AUTHORITY_SET: ReadonlySet<string> = new Set(API_KEY_AUTHORITY_CLAIMS);

export function isApiKeyAuthorityClaim(value: unknown): value is ApiKeyAuthorityClaim {
  return typeof value === 'string' && API_KEY_AUTHORITY_SET.has(value);
}

function uniqueStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') return null;
    if (seen.has(item)) return null;
    seen.add(item);
  }
  return [...seen];
}

/**
 * Validate a requested scope grant: a non-empty array of known scopes,
 * without duplicates. Throws `invalid_input` otherwise.
 */
export function parseScopeGrant(value: unknown): ApiScope[] {
  const items = uniqueStrings(value);
  if (items === null || items.length === 0) {
    throw new ApiError('invalid_input', 'scopes must be a non-empty array of unique strings');
  }
  for (const item of items) {
    if (!isApiScope(item)) {
      throw new ApiError('invalid_input', `unknown api scope '${item}'`);
    }
  }
  return items as ApiScope[];
}

/**
 * Validate a requested authority-claim grant: an array (possibly empty) of
 * known claims, without duplicates. Throws `invalid_input` otherwise.
 */
export function parseAuthorityGrant(value: unknown): ApiKeyAuthorityClaim[] {
  if (value === undefined || value === null) return [];
  const items = uniqueStrings(value);
  if (items === null) {
    throw new ApiError('invalid_input', 'authority must be an array of unique claims');
  }
  for (const item of items) {
    if (!isApiKeyAuthorityClaim(item)) {
      throw new ApiError(
        'invalid_input',
        `authority claim '${item}' is not grantable to an api key`,
      );
    }
  }
  return items as ApiKeyAuthorityClaim[];
}

/** Does a key's scope grant cover `scope`? */
export function hasScope(granted: readonly string[], scope: string): boolean {
  return granted.includes(scope);
}
