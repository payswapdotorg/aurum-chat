// Pure validation/normalization logic of the vertical-kits module (no
// database, no clock, no network). Everything a caller may put into this
// module's operations crosses these guards first; the SQL CHECK
// constraints in migrations/001 mirror the load-bearing rules as defense
// in depth.
//
// Deliberately strict about unknown keys (the house pattern): a caller
// can never smuggle `id`, `tenantId`, timestamps, gate records, digests
// or grant state into records — identity, tenancy and the lifecycle
// links are minted by the system from validated cross-module state.

import type { TenantContext } from '@/infra/tenant';
import { VerticalKitsError } from './errors';
import { digestKitManifest } from './digest';
import {
  capabilityDeclarationProblemsForKit,
  agentDefinitionProblemsForKit,
  extensionDefinitionProblemsForKit,
  integrationReferenceProblems,
  manifestShapeProblems,
  schemaHintProblemsForKit,
  verifyKitManifest,
} from './verification';
import type {
  GetInstallationQuery,
  GetKitVersionQuery,
  KitCapabilityDeclaration,
  KitInstallationStatus,
  KitTaskContext,
  ListKitInstallationsQuery,
  ListKitVersionsQuery,
  VerticalKitManifest,
} from './types';
import {
  isKitInstallationState,
  isKitInstallationTransition,
} from './lifecycle';

// ---------------------------------------------------------------------------
// Vocabularies (mirror the migration CHECKs)
// ---------------------------------------------------------------------------

export const KIT_INSTALLATION_INVOCATION_OUTCOMES = ['allowed', 'denied'] as const;
export const KIT_INVOCATION_BASES = [
  'kit-grant',
  'grant-missing',
  'installation-inactive',
] as const;
export const KIT_GRANT_STATUSES = ['active', 'revoked'] as const;
export const KIT_RECEIPT_STATUSES = ['accepted', 'rejected', 'failed'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MIN_TASK_DESCRIPTION_LENGTH = 1;
export const MAX_TASK_DESCRIPTION_LENGTH = 2000;
export const MAX_REQUESTED_FOR_LENGTH = 200;
export const MAX_TARGET_LENGTH = 200;
export const MAX_CAPABILITY_KEY_LENGTH = 128;
export const MAX_JUSTIFICATION_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_REMOVAL_REASON_LENGTH = 2000;
export const MAX_RECEIPT_ID_LENGTH = 200;
export const MAX_RECEIPT_DETAIL_LENGTH = 500;
export const MAX_EDGE_ID_LENGTH = 200;
/** Canonical payload size cap (256 KiB — modest jsonb). */
export const MAX_VALUE_BYTES = 262_144;
/** The manifest size cap (a kit is a declaration, not a data dump). */
export const MAX_MANIFEST_BYTES = 2_097_152; // 2 MiB

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPABILITY_KEY_PATTERN = /^(read|write)\.[A-Za-z0-9][A-Za-z0-9._-]{1,126}$/;
const INTEGRATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// ---------------------------------------------------------------------------
// Context guard
// ---------------------------------------------------------------------------

export function assertVerticalKitsTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    !UUID_PATTERN.test(ctx.tenantId) ||
    typeof ctx.principalId !== 'string' ||
    !UUID_PATTERN.test(ctx.principalId) ||
    !Array.isArray(ctx.authority)
  ) {
    throw new VerticalKitsError(
      'invalid_context',
      'a valid TenantContext (tenantId, principalId, authority) is required',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared small guards
// ---------------------------------------------------------------------------

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new VerticalKitsError(
      'invalid_input',
      `${field} must be a string of ${min}..${max} chars`,
    );
  }
  return value;
}

function optionalText(
  value: unknown,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > max) {
    throw new VerticalKitsError(
      'invalid_input',
      `${field} must be a string of 1..${max} chars when present`,
    );
  }
  return value;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VerticalKitsError('invalid_input', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw new VerticalKitsError('invalid_input', `${field} must be a uuid`);
  }
  return value;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new VerticalKitsError(
        'invalid_input',
        `unknown key '${key}' — allowed keys: ${allowed.join(', ')}`,
      );
    }
  }
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

// ---------------------------------------------------------------------------
// Task context (the W083 shape)
// ---------------------------------------------------------------------------

export function validateTaskContext(value: unknown, field: string): KitTaskContext {
  const record = requireObject(value, field);
  const description = requireString(
    record.description,
    `${field}.description`,
    MIN_TASK_DESCRIPTION_LENGTH,
    MAX_TASK_DESCRIPTION_LENGTH,
  );
  let requestedFor: string | null = null;
  if (record.requestedFor !== undefined && record.requestedFor !== null) {
    requestedFor = requireString(
      record.requestedFor,
      `${field}.requestedFor`,
      1,
      MAX_REQUESTED_FOR_LENGTH,
    );
  }
  return { description, requestedFor };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export interface ValidatedRegisterKitVersionInput {
  manifest: VerticalKitManifest;
  digest: string;
}

export function validateRegisterKitVersionInput(
  value: unknown,
): ValidatedRegisterKitVersionInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['manifest']);
  if (record.manifest === undefined) {
    throw new VerticalKitsError('invalid_input', 'input.manifest is required');
  }
  const manifest = record.manifest;
  const serialized = JSON.stringify(manifest);
  if (serialized === undefined || byteLength(serialized) > MAX_MANIFEST_BYTES) {
    throw new VerticalKitsError(
      'invalid_input',
      `the manifest must be plain JSON of at most ${MAX_MANIFEST_BYTES} bytes`,
    );
  }
  // Registration-time verification: a manifest failing ANY deterministic
  // check is refused storage (the marketplace's AUTOMATED_VERIFICATION
  // discipline folded into registration — kits are first-party content,
  // not third-party submissions awaiting review).
  const problems = [
    ...manifestShapeProblems(manifest),
    ...capabilityDeclarationProblemsForKit(
      (manifest as Record<string, unknown>).requiredCapabilities,
    ),
    ...extensionDefinitionProblemsForKit(
      (manifest as Record<string, unknown>).extensionDefinitions,
    ),
    ...agentDefinitionProblemsForKit((manifest as Record<string, unknown>).agentDefinitions),
    ...integrationReferenceProblems(
      (manifest as Record<string, unknown>).edgeIntegrations,
      (manifest as Record<string, unknown>).requiredCapabilities,
      (manifest as Record<string, unknown>).dataSchemaHints,
    ),
    ...schemaHintProblemsForKit((manifest as Record<string, unknown>).dataSchemaHints),
  ];
  if (problems.length > 0) {
    throw new VerticalKitsError(
      'kit_verification_failed',
      `the kit manifest failed deterministic verification: ${problems.slice(0, 5).join('; ')}`,
    );
  }
  const outcome = verifyKitManifest(manifest, null);
  if (outcome.outcome !== 'verified') {
    throw new VerticalKitsError(
      'kit_verification_failed',
      `the kit manifest failed deterministic verification: ${outcome.summary}`,
    );
  }
  return {
    manifest: manifest as VerticalKitManifest,
    digest: digestKitManifest(manifest),
  };
}

// ---------------------------------------------------------------------------
// Install / lifecycle inputs
// ---------------------------------------------------------------------------

export interface ValidatedInstallKitInput {
  kitKey: string;
  version: string;
  justification: string | null;
}

export function validateInstallKitInput(value: unknown): ValidatedInstallKitInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['kitKey', 'version', 'justification']);
  const kitKey = requireString(record.kitKey, 'input.kitKey', 3, 128);
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(kitKey)) {
    throw new VerticalKitsError(
      'invalid_input',
      'input.kitKey must be a lowercase slug of 3..128 chars',
    );
  }
  const version = requireString(record.version, 'input.version', 5, 32);
  if (!SEMVER_PATTERN.test(version)) {
    throw new VerticalKitsError(
      'invalid_input',
      'input.version must be a release semver MAJOR.MINOR.PATCH',
    );
  }
  return {
    kitKey,
    version,
    justification: optionalText(record.justification, 'input.justification', MAX_JUSTIFICATION_LENGTH),
  };
}

export interface ValidatedDecideKitReviewInput {
  installationId: string;
  decision: 'approve' | 'reject';
  note: string | null;
}

export function validateDecideKitReviewInput(value: unknown): ValidatedDecideKitReviewInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['installationId', 'decision', 'note']);
  const installationId = requireUuid(record.installationId, 'input.installationId');
  if (record.decision !== 'approve' && record.decision !== 'reject') {
    throw new VerticalKitsError(
      'invalid_input',
      "input.decision must be 'approve' or 'reject'",
    );
  }
  return {
    installationId,
    decision: record.decision,
    note: optionalText(record.note, 'input.note', MAX_NOTE_LENGTH),
  };
}

export interface ValidatedInstallationTargetInput {
  installationId: string;
}

export function validateInstallationTargetInput(
  value: unknown,
): ValidatedInstallationTargetInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['installationId']);
  return { installationId: requireUuid(record.installationId, 'input.installationId') };
}

export interface ValidatedSuspendedRemovalInput {
  installationId: string;
  reason: string | null;
}

export function validateSuspendedRemovalInput(
  value: unknown,
): ValidatedSuspendedRemovalInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['installationId', 'reason']);
  return {
    installationId: requireUuid(record.installationId, 'input.installationId'),
    reason: optionalText(record.reason, 'input.reason', MAX_REMOVAL_REASON_LENGTH),
  };
}

// ---------------------------------------------------------------------------
// Runtime inputs
// ---------------------------------------------------------------------------

export interface ValidatedInvokeKitCapabilityInput {
  installationId: string;
  capabilityKey: string;
  taskContext: KitTaskContext;
}

export function validateInvokeKitCapabilityInput(
  value: unknown,
): ValidatedInvokeKitCapabilityInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['installationId', 'capabilityKey', 'taskContext']);
  const installationId = requireUuid(record.installationId, 'input.installationId');
  const capabilityKey = requireString(
    record.capabilityKey,
    'input.capabilityKey',
    3,
    MAX_CAPABILITY_KEY_LENGTH,
  );
  if (!CAPABILITY_KEY_PATTERN.test(capabilityKey)) {
    throw new VerticalKitsError(
      'invalid_input',
      'input.capabilityKey must match read.<subject> or write.<subject>',
    );
  }
  return {
    installationId,
    capabilityKey,
    taskContext: validateTaskContext(record.taskContext, 'input.taskContext'),
  };
}

export interface ValidatedInspectKitIntegrationInput {
  installationId: string;
  integrationKey: string;
  target: string;
  taskContext: KitTaskContext;
}

export function validateInspectKitIntegrationInput(
  value: unknown,
): ValidatedInspectKitIntegrationInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['installationId', 'integrationKey', 'target', 'taskContext']);
  const installationId = requireUuid(record.installationId, 'input.installationId');
  const integrationKey = requireString(
    record.integrationKey,
    'input.integrationKey',
    1,
    64,
  );
  if (!INTEGRATION_KEY_PATTERN.test(integrationKey)) {
    throw new VerticalKitsError(
      'invalid_input',
      'input.integrationKey must be a slug of 1..64 chars',
    );
  }
  const target = requireString(record.target, 'input.target', 1, MAX_TARGET_LENGTH);
  const taskContext = validateTaskContext(record.taskContext, 'input.taskContext');
  return { installationId, integrationKey, target, taskContext };
}

export interface ValidatedExecuteKitIntegrationInput {
  installationId: string;
  integrationKey: string;
  target: string;
  payload: Record<string, unknown>;
  taskContext: KitTaskContext;
}

export function validateExecuteKitIntegrationInput(
  value: unknown,
): ValidatedExecuteKitIntegrationInput {
  const record = requireObject(value, 'input');
  rejectUnknownKeys(record, ['installationId', 'integrationKey', 'target', 'payload', 'taskContext']);
  const base = validateInspectKitIntegrationInput({
    installationId: record.installationId,
    integrationKey: record.integrationKey,
    target: record.target,
    taskContext: record.taskContext,
  });
  const payload = requireObject(record.payload, 'input.payload');
  const serialized = JSON.stringify(payload);
  if (serialized === undefined || byteLength(serialized) > MAX_VALUE_BYTES) {
    throw new VerticalKitsError(
      'invalid_input',
      `input.payload must be a plain JSON object of at most ${MAX_VALUE_BYTES} bytes`,
    );
  }
  return {
    installationId: base.installationId,
    integrationKey: base.integrationKey,
    target: base.target,
    payload,
    taskContext: base.taskContext,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export function validateGetKitVersionQuery(value: unknown): GetKitVersionQuery {
  const record = requireObject(value, 'query');
  rejectUnknownKeys(record, ['kitVersionId']);
  return { kitVersionId: requireUuid(record.kitVersionId, 'query.kitVersionId') };
}

export function validateListKitVersionsQuery(value: unknown): ListKitVersionsQuery {
  const record = requireObject(value, 'query');
  rejectUnknownKeys(record, ['kitKey']);
  if (record.kitKey === undefined || record.kitKey === null) return { kitKey: null };
  const kitKey = requireString(record.kitKey, 'query.kitKey', 3, 128);
  if (!/^[a-z0-9][a-z0-9-]{2,127}$/.test(kitKey)) {
    throw new VerticalKitsError(
      'invalid_query',
      'query.kitKey must be a lowercase slug of 3..128 chars',
    );
  }
  return { kitKey };
}

export function validateGetInstallationQuery(value: unknown): GetInstallationQuery {
  const record = requireObject(value, 'query');
  rejectUnknownKeys(record, ['installationId']);
  return { installationId: requireUuid(record.installationId, 'query.installationId') };
}

export function validateListKitInstallationsQuery(
  value: unknown,
): ListKitInstallationsQuery {
  const record = requireObject(value, 'query');
  rejectUnknownKeys(record, ['status']);
  if (record.status === undefined || record.status === null) return { status: null };
  if (!isKitInstallationState(record.status)) {
    throw new VerticalKitsError(
      'invalid_query',
      `query.status must be one of the installation lifecycle states`,
    );
  }
  return { status: record.status as KitInstallationStatus };
}

export function validateListInstallationRecordsQuery(
  value: unknown,
): { installationId: string; limit: number } {
  const record = requireObject(value, 'query');
  rejectUnknownKeys(record, ['installationId', 'limit']);
  const installationId = requireUuid(record.installationId, 'query.installationId');
  let limit = DEFAULT_LIST_LIMIT;
  if (record.limit !== undefined && record.limit !== null) {
    if (
      typeof record.limit !== 'number' ||
      !Number.isInteger(record.limit) ||
      record.limit < 1 ||
      record.limit > MAX_LIST_LIMIT
    ) {
      throw new VerticalKitsError(
        'invalid_query',
        `query.limit must be an integer of 1..${MAX_LIST_LIMIT}`,
      );
    }
    limit = record.limit;
  }
  return { installationId, limit };
}

// ---------------------------------------------------------------------------
// Storage guards (used when reading rows back)
// ---------------------------------------------------------------------------

export function requireInstallationStatus(value: unknown, where: string): KitInstallationStatus {
  if (!isKitInstallationState(value)) {
    throw new VerticalKitsError('invalid_input', `the stored installation status at ${where} is non-canonical`);
  }
  return value;
}

export function requireTransition(value: unknown): string {
  if (!isKitInstallationTransition(value)) {
    throw new VerticalKitsError('invalid_input', `non-canonical transition '${String(value)}'`);
  }
  return value;
}

/** Parse a semver into numeric parts (null when malformed). */
export function parseKitSemver(value: string): { major: number; minor: number; patch: number } | null {
  if (!SEMVER_PATTERN.test(value)) return null;
  const [major, minor, patch] = value.split('.').map(Number) as [number, number, number];
  return { major, minor, patch };
}

/** The required-capability snapshot read back from storage. */
export function requireCapabilityList(value: unknown): KitCapabilityDeclaration[] {
  if (!Array.isArray(value)) {
    throw new VerticalKitsError('invalid_input', 'the stored capability list is non-canonical');
  }
  return value as KitCapabilityDeclaration[];
}
