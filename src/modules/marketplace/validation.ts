// Pure validation/normalization logic of the marketplace module (no
// database). Everything a caller may put into a package, a transition or
// a query crosses these guards first; the SQL CHECK constraints in
// migrations/001-marketplace-packages.sql mirror the load-bearing rules
// as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `state`, `vendorTenant`, `vendorPrincipal`, `createdAt` or
// `updatedAt` into an input — a package's identity, governed lifecycle
// state, vendor provenance and commit times are minted by the system
// (catalog records are auditable, and audit fields are not
// caller-forgeable). There is also deliberately NO edit input at all: a
// package payload is immutable from creation (a changed artifact is a
// NEW version, the extensions module's manifest discipline).
//
// The agent-package payload is validated against the agents module's
// EXPORTED closed vocabularies and bounds (runtime providers, permission
// scopes, role/instructions ceilings) — the marketplace never invents
// its own provider or scope names. Permission lists are normalized the
// way the agents module normalizes grants: non-empty, closed
// vocabulary, deduplicated, canonical §20 order, so equal payloads
// always serialize identically (determinism).

import type { TenantContext } from '@/infra/tenant';
import {
  AGENT_PERMISSION_SCOPES,
  isAgentPermissionScope,
  isAgentRuntimeProvider,
  MAX_INSTRUCTIONS_CHARS,
  MAX_PERMISSIONS,
  MAX_ROLE_CHARS,
  type AgentPermissionScope,
  type AgentRuntimeProvider,
} from '@/modules/agents/contract';
import { isSemver, parseSemver, type SemverParts } from '@/modules/extensions/contract';
import { MarketplaceError } from './errors';
import type { MarketplacePackageKind } from './types';
import type { MarketplacePackageState } from './lifecycle';
import {
  isMarketplacePackageState,
  MARKETPLACE_PACKAGE_STATES,
} from './lifecycle';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const MARKETPLACE_PACKAGE_KINDS = ['extension', 'agent'] as const;

export function isMarketplacePackageKind(value: unknown): value is MarketplacePackageKind {
  return (
    typeof value === 'string' &&
    (MARKETPLACE_PACKAGE_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

/**
 * Catalog key rule — identical to the extensions module's extension-key
 * rule (the natural default for an ExtensionPackage's catalog key): a
 * lowercase kebab slug, 1..63 characters.
 */
export const PACKAGE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isPackageKey(value: unknown): boolean {
  return typeof value === 'string' && PACKAGE_KEY_PATTERN.test(value);
}

export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 2000;
export const MAX_REVIEW_REASON_CHARS = 2000;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW_DECISIONS = ['approve', 'reject'] as const;
const STATE_FILTER_MAX = 8; // every state at most once

// ---------------------------------------------------------------------------
// Validated shapes (what the service consumes)
// ---------------------------------------------------------------------------

export interface ValidatedCreateExtensionInput {
  kind: 'extension';
  manifestId: string;
  /** null → derive the catalog key from the manifest's extension key. */
  packageKey: string | null;
}

export interface ValidatedCreateAgentInput {
  kind: 'agent';
  packageKey: string;
  version: string;
  versionParts: SemverParts;
  displayName: string;
  description: string | null;
  role: string;
  instructions: string;
  provider: AgentRuntimeProvider;
  permissions: AgentPermissionScope[];
}

export type ValidatedCreateInput = ValidatedCreateExtensionInput | ValidatedCreateAgentInput;

export interface ValidatedPackageIdInput {
  packageId: string;
}

export interface ValidatedReviewInput {
  packageId: string;
  decision: 'approve' | 'reject';
  reason: string | null;
}

export interface ValidatedListPackagesQuery {
  kind: MarketplacePackageKind | null;
  states: MarketplacePackageState[] | null;
  limit: number;
}

export interface ValidatedListKindQuery {
  kind: MarketplacePackageKind | null;
  limit: number;
}

export interface ValidatedEvidenceQuery {
  packageId: string;
  limit: number;
}

// ---------------------------------------------------------------------------
// The guard primitives (the learning module's discipline: each shared
// primitive takes the error factory of its calling context, so a bad
// field reports the operation's own error code)
// ---------------------------------------------------------------------------

type Err = (message: string) => MarketplaceError;

function inputError(message: string): MarketplaceError {
  return new MarketplaceError('invalid_input', message);
}

function queryError(message: string): MarketplaceError {
  return new MarketplaceError('invalid_query', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  err: Err,
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw err(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(value: unknown, field: string, err: Err): string {
  if (typeof value !== 'string') throw err(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw err(`${field} must be a non-empty string`);
  return text;
}

function requireBoundedString(value: unknown, field: string, maxLength: number, err: Err): string {
  const text = requireString(value, field, err);
  if (text.length > maxLength) {
    throw err(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxLength: number, err: Err): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, err);
  if (text.length > maxLength) {
    throw err(`${field} must be at most ${maxLength} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string, err: Err): string {
  const text = requireString(value, field, err);
  if (!UUID_PATTERN.test(text)) {
    throw err(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requirePackageKey(value: unknown, field: string, err: Err): string {
  const text = requireString(value, field, err);
  if (!isPackageKey(text)) {
    throw err(
      `${field} must be a lowercase kebab slug of 1..63 characters (got '${text}')`,
    );
  }
  return text;
}

function requireLimit(value: unknown, err: Err): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw err(`limit must be an integer (got '${String(value)}')`);
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw err(`limit must be between 1 and ${MAX_LIST_LIMIT} (got ${value})`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// TenantContext
// ---------------------------------------------------------------------------

export function assertMarketplaceTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new MarketplaceError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new MarketplaceError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new MarketplaceError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// createPackage
// ---------------------------------------------------------------------------

const CREATE_EXTENSION_KEYS = ['kind', 'manifestId', 'packageKey'] as const;
const CREATE_AGENT_KEYS = [
  'kind',
  'packageKey',
  'version',
  'displayName',
  'description',
  'role',
  'instructions',
  'provider',
  'permissions',
] as const;

/** Normalize an agent package's permission scopes (the agents module's grant normalization). */
function normalizePermissionScopes(value: unknown): AgentPermissionScope[] {
  if (value === undefined || value === null || !Array.isArray(value)) {
    throw inputError('permissions must be an array of permission scopes');
  }
  if (value.length === 0) {
    throw inputError('permissions must contain at least one permission scope');
  }
  if (value.length > MAX_PERMISSIONS) {
    throw inputError(`permissions must contain at most ${MAX_PERMISSIONS} permission scopes`);
  }
  const out: AgentPermissionScope[] = [];
  for (const entry of value) {
    if (!isAgentPermissionScope(entry)) {
      throw inputError(
        `permissions entries must be one of ${AGENT_PERMISSION_SCOPES.join(', ')} (got '${String(entry)}')`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  out.sort((a, b) => AGENT_PERMISSION_SCOPES.indexOf(a) - AGENT_PERMISSION_SCOPES.indexOf(b));
  return out;
}

function validateCreateExtensionInput(
  input: Record<string, unknown>,
): ValidatedCreateExtensionInput {
  rejectUnknownKeys(input, CREATE_EXTENSION_KEYS, 'extension package creation', inputError);
  const manifestId = requireUuid(input.manifestId, 'manifestId', inputError);
  const packageKey =
    input.packageKey === undefined || input.packageKey === null
      ? null
      : requirePackageKey(input.packageKey, 'packageKey', inputError);
  return { kind: 'extension', manifestId, packageKey };
}

function validateCreateAgentInput(input: Record<string, unknown>): ValidatedCreateAgentInput {
  rejectUnknownKeys(input, CREATE_AGENT_KEYS, 'agent package creation', inputError);
  const packageKey = requirePackageKey(input.packageKey, 'packageKey', inputError);
  const version = requireString(input.version, 'version', inputError);
  if (!isSemver(version)) {
    throw inputError(`version must be a release semver MAJOR.MINOR.PATCH (got '${version}')`);
  }
  const versionParts = parseSemver(version);
  if (versionParts === null) {
    throw inputError(`version must be a release semver MAJOR.MINOR.PATCH (got '${version}')`);
  }
  const displayName = requireBoundedString(
    input.displayName,
    'displayName',
    MAX_DISPLAY_NAME_CHARS,
    inputError,
  );
  const description = optionalTrimmed(
    input.description,
    'description',
    MAX_DESCRIPTION_CHARS,
    inputError,
  );
  const role = requireBoundedString(input.role, 'role', MAX_ROLE_CHARS, inputError);
  const instructions = requireBoundedString(
    input.instructions,
    'instructions',
    MAX_INSTRUCTIONS_CHARS,
    inputError,
  );
  const provider = input.provider;
  if (!isAgentRuntimeProvider(provider)) {
    throw inputError(
      `provider must be one of the agents module's canonical runtime providers (got '${String(provider)}')`,
    );
  }
  const permissions = normalizePermissionScopes(input.permissions);
  return {
    kind: 'agent',
    packageKey,
    version,
    versionParts,
    displayName,
    description,
    role,
    instructions,
    provider,
    permissions,
  };
}

/**
 * Validate and normalize a `createPackage` input. The kind discriminates
 * the two shapes; each rejects unknown keys and mints nothing the system
 * owns (state, provenance, timestamps).
 */
export function validateCreatePackageInput(input: unknown): ValidatedCreateInput {
  if (!isPlainObject(input)) {
    throw inputError('input must be an object');
  }
  if (input.kind === 'extension') {
    return validateCreateExtensionInput(input);
  }
  if (input.kind === 'agent') {
    return validateCreateAgentInput(input);
  }
  throw inputError(
    `kind must be one of ${MARKETPLACE_PACKAGE_KINDS.join(', ')} (got '${String(input.kind)}')`,
  );
}

// ---------------------------------------------------------------------------
// The single-package-id operations (submit / verify / publish / installable)
// ---------------------------------------------------------------------------

const PACKAGE_ID_KEYS = ['packageId'] as const;

function validatePackageIdInput(input: unknown): ValidatedPackageIdInput {
  if (!isPlainObject(input)) {
    throw inputError('input must be an object');
  }
  rejectUnknownKeys(input, PACKAGE_ID_KEYS, 'input', inputError);
  return { packageId: requireUuid(input.packageId, 'packageId', inputError) };
}

export function validateSubmitPackageInput(input: unknown): ValidatedPackageIdInput {
  return validatePackageIdInput(input);
}

export function validateRunPackageVerificationInput(input: unknown): ValidatedPackageIdInput {
  return validatePackageIdInput(input);
}

export function validatePublishPackageInput(input: unknown): ValidatedPackageIdInput {
  return validatePackageIdInput(input);
}

export function validateMakePackageInstallableInput(input: unknown): ValidatedPackageIdInput {
  return validatePackageIdInput(input);
}

// ---------------------------------------------------------------------------
// reviewPackage
// ---------------------------------------------------------------------------

const REVIEW_KEYS = ['packageId', 'decision', 'reason'] as const;

export function validateReviewPackageInput(input: unknown): ValidatedReviewInput {
  if (!isPlainObject(input)) {
    throw inputError('input must be an object');
  }
  rejectUnknownKeys(input, REVIEW_KEYS, 'review input', inputError);
  const packageId = requireUuid(input.packageId, 'packageId', inputError);
  const decision = input.decision;
  if (
    typeof decision !== 'string' ||
    !(REVIEW_DECISIONS as readonly string[]).includes(decision)
  ) {
    throw inputError(`decision must be one of ${REVIEW_DECISIONS.join(', ')} (got '${String(decision)}')`);
  }
  const reason = optionalTrimmed(input.reason, 'reason', MAX_REVIEW_REASON_CHARS, inputError);
  if (decision === 'reject' && reason === null) {
    // Terminal transitions record their why (the house rule): a rejection
    // without a reason is not review evidence.
    throw inputError('reason is required when rejecting a package');
  }
  return { packageId, decision: decision as 'approve' | 'reject', reason };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const GET_PACKAGE_KEYS = ['packageId'] as const;

export function validateGetPackageQuery(input: unknown): ValidatedPackageIdInput {
  if (!isPlainObject(input)) {
    throw queryError('query must be an object');
  }
  rejectUnknownKeys(input, GET_PACKAGE_KEYS, 'query', queryError);
  return { packageId: requireUuid(input.packageId, 'packageId', queryError) };
}

export function validateGetPackageVerificationQuery(input: unknown): ValidatedPackageIdInput {
  return validateGetPackageQuery(input);
}

const LIST_PACKAGES_KEYS = ['kind', 'states', 'limit'] as const;

export function validateListPackagesQuery(input: unknown): ValidatedListPackagesQuery {
  if (!isPlainObject(input)) {
    throw queryError('query must be an object');
  }
  rejectUnknownKeys(input, LIST_PACKAGES_KEYS, 'query', queryError);
  let kind: MarketplacePackageKind | null = null;
  if (input.kind !== undefined && input.kind !== null) {
    if (!isMarketplacePackageKind(input.kind)) {
      throw queryError(
        `kind must be one of ${MARKETPLACE_PACKAGE_KINDS.join(', ')} (got '${String(input.kind)}')`,
      );
    }
    kind = input.kind;
  }
  let states: MarketplacePackageState[] | null = null;
  if (input.states !== undefined && input.states !== null) {
    if (!Array.isArray(input.states)) {
      throw queryError('states must be an array of package states');
    }
    if (input.states.length === 0) {
      throw queryError('states must contain at least one package state');
    }
    if (input.states.length > STATE_FILTER_MAX) {
      throw queryError(`states must contain at most ${STATE_FILTER_MAX} package states`);
    }
    const seen = new Set<string>();
    for (const state of input.states) {
      if (!isMarketplacePackageState(state)) {
        throw queryError(
          `states entries must be one of ${MARKETPLACE_PACKAGE_STATES.join(', ')} (got '${String(state)}')`,
        );
      }
      if (seen.has(state)) {
        throw queryError(`states must not repeat '${state}'`);
      }
      seen.add(state);
    }
    states = input.states as MarketplacePackageState[];
  }
  return { kind, states, limit: requireLimit(input.limit, queryError) };
}

const LIST_KIND_KEYS = ['kind', 'limit'] as const;

export function validateListKindQuery(input: unknown): ValidatedListKindQuery {
  if (!isPlainObject(input)) {
    throw queryError('query must be an object');
  }
  rejectUnknownKeys(input, LIST_KIND_KEYS, 'query', queryError);
  let kind: MarketplacePackageKind | null = null;
  if (input.kind !== undefined && input.kind !== null) {
    if (!isMarketplacePackageKind(input.kind)) {
      throw queryError(
        `kind must be one of ${MARKETPLACE_PACKAGE_KINDS.join(', ')} (got '${String(input.kind)}')`,
      );
    }
    kind = input.kind;
  }
  return { kind, limit: requireLimit(input.limit, queryError) };
}

const EVIDENCE_KEYS = ['packageId', 'limit'] as const;

export function validateEvidenceQuery(input: unknown): ValidatedEvidenceQuery {
  if (!isPlainObject(input)) {
    throw queryError('query must be an object');
  }
  rejectUnknownKeys(input, EVIDENCE_KEYS, 'query', queryError);
  return {
    packageId: requireUuid(input.packageId, 'packageId', queryError),
    limit: requireLimit(input.limit, queryError),
  };
}
