// ============================================================================
// mcp — pure argument validation/normalization helpers (W039).
//
// The repo's discipline (events/goals/actions validation.ts): arguments
// cross small, explicit, side-effect-free guards before any domain call,
// and fail with typed errors that name the tool and the field. Every
// helper here is pure — the unit tests cover them without a database.
//
// These guards intentionally duplicate only the SHAPE rules (types,
// enums, uuid form, integer bounds) so malformed tool arguments surface
// as `invalid_arguments` at the MCP boundary; semantic validation
// (existence, cross-references, domain rules) stays with the owning
// module and surfaces as `domain_error` with the module's code
// preserved.
// ============================================================================

import { McpToolError } from './errors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

/** Shared list-limit bounds (the modules' canonical 1..500). */
export const MIN_LIST_LIMIT = 1;
export const MAX_LIST_LIMIT = 500;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Raw tool arguments must be a JSON object. */
export function requireArgsObject(raw: unknown, tool: string): Record<string, unknown> {
  if (!isPlainObject(raw)) {
    throw new McpToolError('invalid_arguments', `'${tool}' arguments must be a JSON object`);
  }
  return raw;
}

/** Unknown keys are rejected — clients cannot smuggle extra fields. */
export function rejectUnknownKeys(
  args: Record<string, unknown>,
  allowed: readonly string[],
  tool: string,
): void {
  for (const key of Object.keys(args)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new McpToolError(
        'invalid_arguments',
        `'${tool}' does not accept argument '${key}' (allowed: ${allowed.join(', ') || '(none)'})`,
      );
    }
  }
}

function optional(args: Record<string, unknown>, key: string): unknown {
  const value = args[key];
  return value === undefined || value === null ? undefined : value;
}

/** Optional string argument (trimmed; null/undefined → undefined). */
export function optionalString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  maxLength: number,
): string | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new McpToolError('invalid_arguments', `'${tool}' argument '${key}' must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxLength) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument '${key}' must be at most ${maxLength} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}

/** Required non-empty string argument. */
export function requireString(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  maxLength: number,
): string {
  const value = optionalString(args, key, tool, maxLength);
  if (value === undefined) {
    throw new McpToolError('invalid_arguments', `'${tool}' requires a non-empty '${key}' string`);
  }
  return value;
}

/** Optional enum argument validated against a closed vocabulary. */
export function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  tool: string,
): T | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument '${key}' must be one of ${values.join(', ')} (got '${String(value)}')`,
    );
  }
  return value as T;
}

/** Required enum argument. */
export function requireEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  tool: string,
): T {
  const value = optionalEnum(args, key, values, tool);
  if (value === undefined) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' requires '${key}' to be one of ${values.join(', ')}`,
    );
  }
  return value;
}

/** Optional uuid argument. */
export function optionalUuid(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new McpToolError('invalid_arguments', `'${tool}' argument '${key}' must be a uuid`);
  }
  return value;
}

/** Required uuid argument. */
export function requireUuid(args: Record<string, unknown>, key: string, tool: string): string {
  const value = optionalUuid(args, key, tool);
  if (value === undefined) {
    throw new McpToolError('invalid_arguments', `'${tool}' requires a uuid '${key}'`);
  }
  return value;
}

/** Optional integer argument with bounds. */
export function optionalInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  min: number,
  max: number,
): number | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new McpToolError('invalid_arguments', `'${tool}' argument '${key}' must be an integer`);
  }
  if (value < min || value > max) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument '${key}' must be between ${min} and ${max} (got ${value})`,
    );
  }
  return value;
}

/** Optional ISO-8601 instant argument (explicit offset required). */
export function optionalIsoInstant(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): string | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !ISO_INSTANT_PATTERN.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument '${key}' must be a strict ISO 8601 timestamp with explicit offset, e.g. 2026-09-14T12:30:00Z`,
    );
  }
  return value;
}

/** Optional number in [0, 1]. */
export function optionalUnitInterval(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument '${key}' must be a number in [0, 1] (got ${String(value)})`,
    );
  }
  return value;
}

/** Optional list-limit argument (the canonical 1..500 across modules). */
export function optionalListLimit(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number | undefined {
  return optionalInt(args, key, tool, MIN_LIST_LIMIT, MAX_LIST_LIMIT);
}

/** Required positive-integer amount (integer minor units, §8 conventions). */
export function requirePositiveInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number {
  const value = optionalInt(args, key, tool, 1, Number.MAX_SAFE_INTEGER);
  if (value === undefined) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' requires a positive integer '${key}'`,
    );
  }
  return value;
}

/** Required non-negative integer (minor units; 0 = none). */
export function requireNonNegativeInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number {
  const value = optionalInt(args, key, tool, 0, Number.MAX_SAFE_INTEGER);
  if (value === undefined) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' requires a non-negative integer '${key}'`,
    );
  }
  return value;
}

/** Required number in [0, 1] (epistemic confidence / information value). */
export function requireUnitInterval(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number {
  const value = optionalUnitInterval(args, key, tool);
  if (value === undefined) {
    throw new McpToolError('invalid_arguments', `'${tool}' requires a number in [0, 1] '${key}'`);
  }
  return value;
}

/** ISO 4217-style currency code (3 uppercase letters). */
export function requireCurrency(args: Record<string, unknown>, key: string, tool: string): string {
  const value = requireString(args, key, tool, 8);
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument '${key}' must be a 3-letter uppercase currency code (got '${value}')`,
    );
  }
  return value;
}

/** The gated tools' reserved `idempotencyKey` argument (actions vocabulary). */
export function optionalIdempotencyKey(
  args: Record<string, unknown>,
  tool: string,
): string | null {
  const value = optionalString(args, 'idempotencyKey', tool, 200);
  if (value === undefined) return null;
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new McpToolError(
      'invalid_arguments',
      `'${tool}' argument 'idempotencyKey' must match ${IDEMPOTENCY_KEY_PATTERN.source}`,
    );
  }
  return value;
}

/** Optional non-empty string → string | null (tri-state argument). */
export function optionalTextOrNull(
  args: Record<string, unknown>,
  key: string,
  tool: string,
  maxLength: number,
): string | null {
  return optionalString(args, key, tool, maxLength) ?? null;
}

/** Optional JSON value argument (must be a JSON-safe non-null value). */
export function optionalJsonValue(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): unknown | undefined {
  const value = optional(args, key);
  if (value === undefined) return undefined;
  try {
    JSON.stringify(value);
  } catch {
    throw new McpToolError('invalid_arguments', `'${tool}' argument '${key}' must be JSON-serializable`);
  }
  return value;
}
