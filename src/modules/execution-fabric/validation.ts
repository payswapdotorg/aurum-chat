// Pure validation of the execution-fabric module's inputs and queries
// (see contract.ts). No database, no clock, no TenantContext reads — the
// org-lab discipline: everything here is unit-testable without
// infrastructure.
//
// VOCABULARY MIRRORING (the house ruling): the cross-module vocabularies
// this file guards against (the W131 frozen environment kinds, capability
// domains, profile scopes, network-egress declarations, checkpoint
// levels and capture kinds) are mirrored as local constants and
// compiler-pinned to the frozen unions with `satisfies` — drift in the
// owning module fails TYPECHECK here, never runtime. The type-only
// imports keep this file runtime-dependency-free (the services own every
// runtime import).
//
// THE STATE MACHINE lives here too: `fabricLeaseTransitionProblem` is
// THE SINGLE deterministic definition of a legal lifecycle move (the
// taskGraphProblem precedent) — consumed by the service AND exported for
// the unit proofs. The migration's storage guard mirrors it (defense in
// depth); a divergence fails the trigger probe tests, never production.

import type { TenantContext } from '@/infra/tenant';
import type {
  ExecutionAdapterCapabilityDomain,
  ExecutionEnvironmentKind,
  SessionIsolationProperties,
  SessionPersistenceGuarantees,
} from '@/modules/execution/contract';
import { ExecutionFabricError } from './errors';
import type { ExecutionFabricErrorCode } from './errors';
import type {
  ArtifactHandoffDirection,
  EvidenceVerification,
  FabricLeaseEventKind,
  FabricLeaseStatus,
  FabricLeaseTransition,
} from './types';

// ---------------------------------------------------------------------------
// Limits (bounds every input field — the house discipline)
// ---------------------------------------------------------------------------

export const MAX_DEF_KEY_CHARS = 64;
export const MAX_DISPLAY_NAME_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_REASON_CHARS = 512;
export const MAX_DETAIL_CHARS = 512;
export const MAX_PERSISTENT_SCOPE_CHARS = 256;
export const MAX_CREDENTIAL_REF_CHARS = 256;
export const MAX_ARTIFACT_REF_CHARS = 256;
export const MAX_ARTIFACT_KIND_CHARS = 64;
export const MAX_DIGEST_CHARS = 128;
export const MAX_CURSOR_CHARS = 512;
export const MAX_COVERED_EVIDENCE_REFS = 16;
export const MAX_EVIDENCE_REF_CHARS = 256;
export const MIN_LEASE_MINUTES = 1;
export const MAX_LEASE_MINUTES = 1440;
export const DEFAULT_LEASE_MINUTES = 60;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vocabularies (mirrored + compiler-pinned against the W131 frozen
// contracts; see the header note)
// ---------------------------------------------------------------------------

/** The W131 frozen environment kinds, mirrored. */
export const FABRIC_ENVIRONMENT_KINDS = [
  'local',
  'browser',
  'workspace',
  'remote-sandbox',
] as const satisfies readonly ExecutionEnvironmentKind[];

/** The W131 frozen capability domains, mirrored. */
export const FABRIC_CAPABILITY_DOMAINS = [
  'filesystem',
  'commands',
  'network-egress',
  'display',
  'browser-profile',
  'artifact-store',
  'session-persistence',
  'checkpoint',
  'observation-capture',
] as const satisfies readonly ExecutionAdapterCapabilityDomain[];

/** The W131 profile-scope union, mirrored. */
export const FABRIC_PROFILE_SCOPES = [
  'session',
  'task',
  'environment',
] as const satisfies readonly SessionIsolationProperties['profileScope'][];

/** The W131 network-egress union, mirrored. */
export const FABRIC_NETWORK_EGRESS = [
  'disabled',
  'restricted',
  'open',
] as const satisfies readonly SessionIsolationProperties['networkEgress'][];

/** The W131 checkpoint-level union, mirrored. */
export const FABRIC_CHECKPOINT_LEVELS = [
  'none',
  'session',
  'durable-checkpoint',
] as const satisfies readonly SessionPersistenceGuarantees['checkpoint'][];

/** The lease lifecycle (fabric-owned — see types.ts for the composition ruling). */
export const FABRIC_LEASE_STATUSES = [
  'preparing',
  'live',
  'suspended',
  'lost',
  'released',
  'cancelled',
  'failed',
] as const satisfies readonly FabricLeaseStatus[];

/** The terminal subset — no transition leaves these. */
export const FABRIC_LEASE_TERMINAL_STATUSES = [
  'released',
  'cancelled',
  'failed',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset cancel may legally start from (fabric-executed cancellation — see types.ts). */
export const FABRIC_LEASE_CANCELLABLE_STATUSES = [
  'preparing',
  'live',
  'suspended',
  'lost',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset release (the clean close) may legally start from. */
export const FABRIC_LEASE_RELEASABLE_STATUSES = [
  'preparing',
  'live',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset markLost may legally start from (lease death). */
export const FABRIC_LEASE_LOSABLE_STATUSES = [
  'live',
  'suspended',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset recover may legally start from — 'lost' leases are parked, never dead. */
export const FABRIC_LEASE_RECOVERABLE_STATUSES = [
  'lost',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset artifact handoff may be recorded against (in-flight leases). */
export const FABRIC_LEASE_ARTIFACT_SERVABLE_STATUSES = [
  'preparing',
  'live',
  'suspended',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset evidence capture may be recorded against (a session must be observable). */
export const FABRIC_LEASE_EVIDENCE_SERVABLE_STATUSES = [
  'live',
  'suspended',
] as const satisfies readonly FabricLeaseStatus[];

/** The subset checkpoint cutting may be recorded against (the driving worker runs). */
export const FABRIC_LEASE_CHECKPOINT_SERVABLE_STATUSES = [
  'live',
] as const satisfies readonly FabricLeaseStatus[];

/** The evidence-record verification states (the W093 inherited discipline). */
export const FABRIC_EVIDENCE_VERIFICATIONS = [
  'unverified',
  'verified',
  'mismatched',
] as const satisfies readonly EvidenceVerification[];

/** The artifact handoff directions. */
export const FABRIC_ARTIFACT_DIRECTIONS = [
  'in',
  'out',
] as const satisfies readonly ArtifactHandoffDirection[];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIGEST_PATTERN = /^[0-9a-f]{8,128}$/i;

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export function isFabricLeaseStatus(value: unknown): value is FabricLeaseStatus {
  return typeof value === 'string' && (FABRIC_LEASE_STATUSES as readonly string[]).includes(value);
}

export function isTerminalFabricLeaseStatus(value: unknown): value is FabricLeaseStatus {
  return (
    typeof value === 'string' &&
    (FABRIC_LEASE_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isFabricEnvironmentKind(value: unknown): value is ExecutionEnvironmentKind {
  return (
    typeof value === 'string' && (FABRIC_ENVIRONMENT_KINDS as readonly string[]).includes(value)
  );
}

export function isFabricCapabilityDomain(
  value: unknown,
): value is ExecutionAdapterCapabilityDomain {
  return (
    typeof value === 'string' && (FABRIC_CAPABILITY_DOMAINS as readonly string[]).includes(value)
  );
}

export function isFabricProfileScope(
  value: unknown,
): value is SessionIsolationProperties['profileScope'] {
  return typeof value === 'string' && (FABRIC_PROFILE_SCOPES as readonly string[]).includes(value);
}

export function isFabricNetworkEgress(
  value: unknown,
): value is SessionIsolationProperties['networkEgress'] {
  return typeof value === 'string' && (FABRIC_NETWORK_EGRESS as readonly string[]).includes(value);
}

export function isFabricCheckpointLevel(
  value: unknown,
): value is SessionPersistenceGuarantees['checkpoint'] {
  return (
    typeof value === 'string' && (FABRIC_CHECKPOINT_LEVELS as readonly string[]).includes(value)
  );
}

export function isFabricEvidenceVerification(value: unknown): value is EvidenceVerification {
  return (
    typeof value === 'string' &&
    (FABRIC_EVIDENCE_VERIFICATIONS as readonly string[]).includes(value)
  );
}

export function isFabricArtifactDirection(value: unknown): value is ArtifactHandoffDirection {
  return (
    typeof value === 'string' &&
    (FABRIC_ARTIFACT_DIRECTIONS as readonly string[]).includes(value)
  );
}

/** The explicit TenantContext is asserted, never ambient (ADR-0001). */
export function assertExecutionFabricTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    ctx.tenantId.length === 0 ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.length === 0 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new ExecutionFabricError(
      'invalid_context',
      'an explicit TenantContext with tenant and principal is required',
    );
  }
}

// ---------------------------------------------------------------------------
// The lease state machine (THE SINGLE deterministic legality definition)
// ---------------------------------------------------------------------------

/**
 * The lifecycle law: which status each transition may legally start
 * from. Terminal statuses admit nothing; every illegal move returns its
 * deterministic reason (the taskGraphProblem precedent — consumed by the
 * service, exported for the unit proofs, mirrored by the migration's
 * storage guard).
 */
export function fabricLeaseTransitionProblem(
  transition: FabricLeaseTransition,
  from: FabricLeaseStatus,
): string | null {
  const allowed: Record<FabricLeaseTransition, readonly FabricLeaseStatus[]> = {
    prepare: ['preparing'],
    takeover: ['live'],
    handback: ['suspended'],
    markLost: ['live', 'suspended'],
    recover: ['lost'],
    cancel: ['preparing', 'live', 'suspended', 'lost'],
    release: ['preparing', 'live'],
    fail: ['preparing', 'live', 'suspended', 'lost'],
  };
  if ((allowed[transition] as readonly string[]).includes(from)) return null;
  if ((FABRIC_LEASE_TERMINAL_STATUSES as readonly string[]).includes(from)) {
    return `a ${from} lease is terminal — the lifecycle is one-way past ${from}`;
  }
  return `${transition} may not start from a ${from} lease`;
}

// ---------------------------------------------------------------------------
// Input validators (take `unknown`, return the retained Validated* shapes)
// ---------------------------------------------------------------------------

function requireObject(value: unknown, code: ExecutionFabricErrorCode, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ExecutionFabricError(code, `${what} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

/**
 * A string field that may be absent/null (→ null) or present (→ the
 * trimmed value; empty-after-trim reads as null). Returns `undefined`
 * ONLY when the field is present but not a string — the caller's
 * bounded checks then reject it loudly.
 */
function optionalTrimmedString(
  source: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = source[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requireBoundedString(
  source: Record<string, unknown>,
  field: string,
  code: ExecutionFabricErrorCode,
  maxChars: number,
  options: { required: boolean; minChars?: number },
): string | null {
  const value = source[field];
  if (value === undefined || value === null) {
    if (options.required) {
      throw new ExecutionFabricError(code, `${field} is required`);
    }
    return null;
  }
  if (typeof value !== 'string') {
    throw new ExecutionFabricError(code, `${field} must be a string`);
  }
  const trimmed = value.trim();
  const min = options.minChars ?? 1;
  if (trimmed.length < min || trimmed.length > maxChars) {
    throw new ExecutionFabricError(
      code,
      `${field} must be ${min}..${maxChars} characters (after trimming)`,
    );
  }
  return trimmed;
}

function optionalBoundedStringArray(
  value: unknown,
  code: ExecutionFabricErrorCode,
  field: string,
  maxItems: number,
  maxChars: number,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ExecutionFabricError(code, `${field} must be an array of strings`);
  }
  if (value.length > maxItems) {
    throw new ExecutionFabricError(code, `${field} may list at most ${maxItems} entries`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new ExecutionFabricError(code, `${field} entries must be strings`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > maxChars) {
      throw new ExecutionFabricError(
        code,
        `${field} entries must be 1..${maxChars} characters (after trimming)`,
      );
    }
    if (seen.has(trimmed)) {
      throw new ExecutionFabricError(code, `${field} lists '${trimmed}' more than once`);
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function optionalInteger(
  value: unknown,
  code: ExecutionFabricErrorCode,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ExecutionFabricError(code, `${field} must be an integer`);
  }
  if (value < min || value > max) {
    throw new ExecutionFabricError(code, `${field} must be ${min}..${max}`);
  }
  return value;
}

function requireUuid(
  source: Record<string, unknown>,
  field: string,
  code: ExecutionFabricErrorCode,
): string {
  const value = source[field];
  if (!isUuid(value)) {
    throw new ExecutionFabricError(code, `${field} must be a uuid`);
  }
  return value;
}

// --- environment definitions ------------------------------------------------

export interface ValidatedRegisterDefinitionInput {
  defKey: string;
  displayName: string;
  kind: ExecutionEnvironmentKind;
  profileScope: SessionIsolationProperties['profileScope'];
  networkEgress: SessionIsolationProperties['networkEgress'];
  survivesRestart: boolean;
  checkpoint: SessionPersistenceGuarantees['checkpoint'];
  persistentScope: string | null;
  requiredCapabilities: ExecutionAdapterCapabilityDomain[];
  note: string | null;
}

export function validateRegisterEnvironmentDefinitionInput(
  input: unknown,
): ValidatedRegisterDefinitionInput {
  const source = requireObject(input, 'invalid_definition_input', 'registerEnvironmentDefinition input');

  const defKey = requireBoundedString(
    source,
    'defKey',
    'invalid_definition_input',
    MAX_DEF_KEY_CHARS,
    { required: true },
  )!;
  if (!isKey(defKey)) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'defKey must match the slug grammar ^[a-z0-9][a-z0-9-]{0,63}$',
    );
  }
  const displayName = requireBoundedString(
    source,
    'displayName',
    'invalid_definition_input',
    MAX_DISPLAY_NAME_CHARS,
    { required: true },
  )!;
  const kind = source['kind'];
  if (!isFabricEnvironmentKind(kind)) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'kind must be one of the frozen W131 environment kinds: local | browser | workspace | remote-sandbox',
    );
  }
  const profileScope = source['profileScope'];
  if (!isFabricProfileScope(profileScope)) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'profileScope must be session | task | environment (the frozen W131 union)',
    );
  }
  const networkEgress = source['networkEgress'];
  if (!isFabricNetworkEgress(networkEgress)) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'networkEgress must be disabled | restricted | open (the frozen W131 union)',
    );
  }
  const survivesRestart = source['survivesRestart'];
  if (typeof survivesRestart !== 'boolean') {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'survivesRestart must be a boolean (the declared persistence guarantee)',
    );
  }
  const checkpoint = source['checkpoint'];
  if (!isFabricCheckpointLevel(checkpoint)) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'checkpoint must be none | session | durable-checkpoint (the frozen W131 union)',
    );
  }
  const persistentScopeRaw = optionalTrimmedString(source, 'persistentScope');
  if (persistentScopeRaw === undefined) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      'persistentScope must be a string when present',
    );
  }
  if (persistentScopeRaw !== null && persistentScopeRaw.length > MAX_PERSISTENT_SCOPE_CHARS) {
    throw new ExecutionFabricError(
      'invalid_definition_input',
      `persistentScope must be at most ${MAX_PERSISTENT_SCOPE_CHARS} characters`,
    );
  }
  const capabilitiesRaw = source['requiredCapabilities'];
  const capabilityEntries = optionalBoundedStringArray(
    capabilitiesRaw,
    'invalid_definition_input',
    'requiredCapabilities',
    FABRIC_CAPABILITY_DOMAINS.length,
    64,
  );
  const requiredCapabilities: ExecutionAdapterCapabilityDomain[] = [];
  for (const domain of capabilityEntries) {
    if (!isFabricCapabilityDomain(domain)) {
      throw new ExecutionFabricError(
        'invalid_definition_input',
        `requiredCapabilities lists '${domain}' — not one of the frozen W131 capability domains`,
      );
    }
    requiredCapabilities.push(domain);
  }
  const note = requireBoundedString(source, 'note', 'invalid_definition_input', MAX_NOTE_CHARS, {
    required: false,
  });

  return {
    defKey,
    displayName,
    kind,
    profileScope,
    networkEgress,
    survivesRestart,
    checkpoint,
    persistentScope: persistentScopeRaw,
    requiredCapabilities,
    note,
  };
}

export interface ValidatedDefinitionIdInput {
  definitionId: string;
}

export function validateRetireEnvironmentDefinitionInput(
  input: unknown,
): ValidatedDefinitionIdInput {
  const source = requireObject(input, 'invalid_query', 'retireEnvironmentDefinition input');
  return { definitionId: requireUuid(source, 'definitionId', 'invalid_query') };
}

// --- acquisition --------------------------------------------------------------

export interface ValidatedAcquireInput {
  definitionId: string;
  planId: string;
  executionRunId: string;
  credentialRef: string | null;
  leaseMinutes: number;
}

export function validateAcquireFabricLeaseInput(input: unknown): ValidatedAcquireInput {
  const source = requireObject(input, 'invalid_lease_input', 'acquireFabricLease input');
  const definitionId = requireUuid(source, 'definitionId', 'invalid_lease_input');
  const planId = requireUuid(source, 'planId', 'invalid_lease_input');
  const executionRunId = requireUuid(source, 'executionRunId', 'invalid_lease_input');

  const credentialRefRaw = optionalTrimmedString(source, 'credentialRef');
  if (credentialRefRaw === undefined) {
    throw new ExecutionFabricError(
      'invalid_lease_input',
      'credentialRef must be a string when present (an OPAQUE reference — a secret VALUE here is a contract violation)',
    );
  }
  if (credentialRefRaw !== null && credentialRefRaw.length > MAX_CREDENTIAL_REF_CHARS) {
    throw new ExecutionFabricError(
      'invalid_lease_input',
      `credentialRef must be at most ${MAX_CREDENTIAL_REF_CHARS} characters`,
    );
  }
  const leaseMinutes = optionalInteger(
    source['leaseMinutes'],
    'invalid_lease_input',
    'leaseMinutes',
    MIN_LEASE_MINUTES,
    MAX_LEASE_MINUTES,
    DEFAULT_LEASE_MINUTES,
  );

  return {
    definitionId,
    planId,
    executionRunId,
    credentialRef: credentialRefRaw,
    leaseMinutes,
  };
}

// --- lifecycle inputs -----------------------------------------------------------

export interface ValidatedLeaseIdInput {
  leaseId: string;
}

export function validateLeaseIdInput(
  input: unknown,
  code: 'invalid_lifecycle_input' | 'invalid_artifact_input' | 'invalid_evidence_input' | 'invalid_checkpoint_input',
): ValidatedLeaseIdInput {
  const source = requireObject(input, code, 'lease input');
  return { leaseId: requireUuid(source, 'leaseId', code) };
}

export interface ValidatedTakeoverInput {
  leaseId: string;
  reason: string;
  authorityActionRef: string | null;
}

export function validateTakeoverFabricLeaseInput(input: unknown): ValidatedTakeoverInput {
  const source = requireObject(input, 'invalid_lifecycle_input', 'takeoverFabricLease input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_lifecycle_input');
  const reason = requireBoundedString(
    source,
    'reason',
    'invalid_lifecycle_input',
    MAX_REASON_CHARS,
    { required: true },
  )!;
  const authorityActionRefRaw = optionalTrimmedString(source, 'authorityActionRef');
  if (authorityActionRefRaw === undefined) {
    throw new ExecutionFabricError(
      'invalid_lifecycle_input',
      'authorityActionRef must be a string when present (an OPAQUE W009 action reference)',
    );
  }
  if (authorityActionRefRaw !== null && !isUuid(authorityActionRefRaw)) {
    throw new ExecutionFabricError(
      'invalid_lifecycle_input',
      'authorityActionRef must be a uuid (the opaque actions-module reference)',
    );
  }
  return { leaseId, reason, authorityActionRef: authorityActionRefRaw };
}

export interface ValidatedHandbackInput {
  leaseId: string;
  note: string | null;
}

export function validateHandbackFabricLeaseInput(input: unknown): ValidatedHandbackInput {
  const source = requireObject(input, 'invalid_lifecycle_input', 'handbackFabricLease input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_lifecycle_input');
  const note = requireBoundedString(source, 'note', 'invalid_lifecycle_input', MAX_NOTE_CHARS, {
    required: false,
  });
  return { leaseId, note };
}

export interface ValidatedDetailInput {
  leaseId: string;
  detail: string;
}

export function validateMarkFabricLeaseLostInput(input: unknown): ValidatedDetailInput {
  const source = requireObject(input, 'invalid_lifecycle_input', 'markFabricLeaseLost input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_lifecycle_input');
  const detail = requireBoundedString(
    source,
    'detail',
    'invalid_lifecycle_input',
    MAX_DETAIL_CHARS,
    { required: true },
  )!;
  return { leaseId, detail };
}

export interface ValidatedReasonInput {
  leaseId: string;
  reason: string;
}

export function validateCancelFabricLeaseInput(input: unknown): ValidatedReasonInput {
  const source = requireObject(input, 'invalid_lifecycle_input', 'cancelFabricLease input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_lifecycle_input');
  const reason = requireBoundedString(
    source,
    'reason',
    'invalid_lifecycle_input',
    MAX_REASON_CHARS,
    { required: true },
  )!;
  return { leaseId, reason };
}

export function validateReleaseFabricLeaseInput(input: unknown): ValidatedReasonInput {
  const source = requireObject(input, 'invalid_lifecycle_input', 'releaseFabricLease input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_lifecycle_input');
  const reason = requireBoundedString(
    source,
    'reason',
    'invalid_lifecycle_input',
    MAX_REASON_CHARS,
    { required: true },
  )!;
  return { leaseId, reason };
}

export function validateFailFabricLeaseInput(input: unknown): ValidatedDetailInput {
  const source = requireObject(input, 'invalid_lifecycle_input', 'failFabricLease input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_lifecycle_input');
  const detail = requireBoundedString(
    source,
    'detail',
    'invalid_lifecycle_input',
    MAX_DETAIL_CHARS,
    { required: true },
  )!;
  return { leaseId, detail };
}

// --- artifact / evidence / checkpoint inputs ------------------------------------

export interface ValidatedArtifactInput {
  leaseId: string;
  direction: ArtifactHandoffDirection;
  artifactRef: string;
  artifactKind: string;
  digest: string | null;
}

export function validateRecordArtifactHandoffInput(input: unknown): ValidatedArtifactInput {
  const source = requireObject(input, 'invalid_artifact_input', 'recordArtifactHandoff input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_artifact_input');
  const direction = source['direction'];
  if (!isFabricArtifactDirection(direction)) {
    throw new ExecutionFabricError(
      'invalid_artifact_input',
      'direction must be in | out (across the environment boundary)',
    );
  }
  const artifactRef = requireBoundedString(
    source,
    'artifactRef',
    'invalid_artifact_input',
    MAX_ARTIFACT_REF_CHARS,
    { required: true },
  )!;
  const artifactKind = requireBoundedString(
    source,
    'artifactKind',
    'invalid_artifact_input',
    MAX_ARTIFACT_KIND_CHARS,
    { required: true },
  )!;
  const digestRaw = optionalTrimmedString(source, 'digest');
  if (digestRaw === undefined) {
    throw new ExecutionFabricError('invalid_artifact_input', 'digest must be a string when present');
  }
  if (digestRaw !== null && !DIGEST_PATTERN.test(digestRaw)) {
    throw new ExecutionFabricError(
      'invalid_artifact_input',
      'digest must be 8..128 hex characters (a content digest, tamper-evident — never authority)',
    );
  }
  return { leaseId, direction, artifactRef, artifactKind, digest: digestRaw };
}

export interface ValidatedEvidenceInput {
  leaseId: string;
  captureKind: 'screenshot' | 'action-trace' | 'dom-snapshot' | 'console';
  artifactRef: string;
  verification: EvidenceVerification;
  detail: string | null;
}

const CAPTURE_KINDS = [
  'screenshot',
  'action-trace',
  'dom-snapshot',
  'console',
] as const;

export function isFabricCaptureKind(
  value: unknown,
): value is ValidatedEvidenceInput['captureKind'] {
  return typeof value === 'string' && (CAPTURE_KINDS as readonly string[]).includes(value);
}

export function validateRecordLeaseEvidenceInput(input: unknown): ValidatedEvidenceInput {
  const source = requireObject(input, 'invalid_evidence_input', 'recordLeaseEvidence input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_evidence_input');
  const captureKind = source['captureKind'];
  if (!isFabricCaptureKind(captureKind)) {
    throw new ExecutionFabricError(
      'invalid_evidence_input',
      'captureKind must be screenshot | action-trace | dom-snapshot | console (the frozen W131 capture vocabulary)',
    );
  }
  const artifactRef = requireBoundedString(
    source,
    'artifactRef',
    'invalid_evidence_input',
    MAX_ARTIFACT_REF_CHARS,
    { required: true },
  )!;
  const verification = source['verification'];
  if (!isFabricEvidenceVerification(verification)) {
    throw new ExecutionFabricError(
      'invalid_evidence_input',
      'verification must be unverified | verified | mismatched (nothing is a result before verification)',
    );
  }
  const detail = requireBoundedString(
    source,
    'detail',
    'invalid_evidence_input',
    MAX_DETAIL_CHARS,
    { required: false },
  );
  return { leaseId, captureKind, artifactRef, verification, detail };
}

export interface ValidatedCheckpointInput {
  leaseId: string;
  cursor: string;
  coveredEvidenceRefs: string[];
}

export function validateRecordLeaseCheckpointInput(input: unknown): ValidatedCheckpointInput {
  const source = requireObject(input, 'invalid_checkpoint_input', 'recordLeaseCheckpoint input');
  const leaseId = requireUuid(source, 'leaseId', 'invalid_checkpoint_input');
  const cursor = requireBoundedString(
    source,
    'cursor',
    'invalid_checkpoint_input',
    MAX_CURSOR_CHARS,
    { required: true },
  )!;
  const coveredEvidenceRefs = optionalBoundedStringArray(
    source['coveredEvidenceRefs'],
    'invalid_checkpoint_input',
    'coveredEvidenceRefs',
    MAX_COVERED_EVIDENCE_REFS,
    MAX_EVIDENCE_REF_CHARS,
  );
  return { leaseId, cursor, coveredEvidenceRefs };
}

// --- query validators ---------------------------------------------------------

function validateListLimit(source: Record<string, unknown>): number {
  return optionalInteger(source['limit'], 'invalid_query', 'limit', 1, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
}

export interface ValidatedGetDefinitionQuery {
  definitionId: string;
}

export function validateGetEnvironmentDefinitionQuery(input: unknown): ValidatedGetDefinitionQuery {
  const source = requireObject(input, 'invalid_query', 'getEnvironmentDefinition query');
  return { definitionId: requireUuid(source, 'definitionId', 'invalid_query') };
}

export interface ValidatedListDefinitionsQuery {
  status: 'active' | 'retired' | null;
  kind: ExecutionEnvironmentKind | null;
  limit: number;
}

export function validateListEnvironmentDefinitionsQuery(
  input: unknown,
): ValidatedListDefinitionsQuery {
  const source = requireObject(input, 'invalid_query', 'listEnvironmentDefinitions query');
  const statusRaw = source['status'];
  let status: ValidatedListDefinitionsQuery['status'] = null;
  if (statusRaw !== undefined && statusRaw !== null) {
    if (statusRaw !== 'active' && statusRaw !== 'retired') {
      throw new ExecutionFabricError('invalid_query', 'status must be active | retired');
    }
    status = statusRaw;
  }
  const kindRaw = source['kind'];
  let kind: ExecutionEnvironmentKind | null = null;
  if (kindRaw !== undefined && kindRaw !== null) {
    if (!isFabricEnvironmentKind(kindRaw)) {
      throw new ExecutionFabricError(
        'invalid_query',
        'kind must be one of the frozen W131 environment kinds',
      );
    }
    kind = kindRaw;
  }
  return { status, kind, limit: validateListLimit(source) };
}

export interface ValidatedGetLeaseQuery {
  leaseId: string;
}

export function validateGetFabricLeaseQuery(input: unknown): ValidatedGetLeaseQuery {
  const source = requireObject(input, 'invalid_query', 'getFabricLease query');
  return { leaseId: requireUuid(source, 'leaseId', 'invalid_query') };
}

export interface ValidatedListLeasesQuery {
  executionRunId: string | null;
  definitionId: string | null;
  status: FabricLeaseStatus | null;
  limit: number;
}

export function validateListFabricLeasesQuery(input: unknown): ValidatedListLeasesQuery {
  const source = requireObject(input, 'invalid_query', 'listFabricLeases query');
  const executionRunIdRaw = source['executionRunId'];
  let executionRunId: string | null = null;
  if (executionRunIdRaw !== undefined && executionRunIdRaw !== null) {
    if (!isUuid(executionRunIdRaw)) {
      throw new ExecutionFabricError('invalid_query', 'executionRunId must be a uuid');
    }
    executionRunId = executionRunIdRaw;
  }
  const definitionIdRaw = source['definitionId'];
  let definitionId: string | null = null;
  if (definitionIdRaw !== undefined && definitionIdRaw !== null) {
    if (!isUuid(definitionIdRaw)) {
      throw new ExecutionFabricError('invalid_query', 'definitionId must be a uuid');
    }
    definitionId = definitionIdRaw;
  }
  const statusRaw = source['status'];
  let status: FabricLeaseStatus | null = null;
  if (statusRaw !== undefined && statusRaw !== null) {
    if (!isFabricLeaseStatus(statusRaw)) {
      throw new ExecutionFabricError(
        'invalid_query',
        'status must be one of the fabric lease statuses',
      );
    }
    status = statusRaw;
  }
  return { executionRunId, definitionId, status, limit: validateListLimit(source) };
}

export interface ValidatedLeaseScopedListQuery {
  leaseId: string;
  limit: number;
}

function validateLeaseScopedQuery(
  input: unknown,
  what: string,
): ValidatedLeaseScopedListQuery {
  const source = requireObject(input, 'invalid_query', what);
  return { leaseId: requireUuid(source, 'leaseId', 'invalid_query'), limit: validateListLimit(source) };
}

export interface ValidatedListEventsQuery extends ValidatedLeaseScopedListQuery {
  kind: FabricLeaseEventKind | null;
}

const EVENT_KINDS = [
  'acquired',
  'prepared',
  'takeover',
  'handback',
  'loss',
  'recovery',
  'cancellation',
  'release',
  'failure',
  'artifact',
  'evidence',
  'checkpoint',
] as const;

export function isFabricLeaseEventKind(value: unknown): value is FabricLeaseEventKind {
  return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

export function validateListLeaseEventsQuery(input: unknown): ValidatedListEventsQuery {
  const base = validateLeaseScopedQuery(input, 'listLeaseEvents query');
  const source = requireObject(input, 'invalid_query', 'listLeaseEvents query');
  const kindRaw = source['kind'];
  let kind: ValidatedListEventsQuery['kind'] = null;
  if (kindRaw !== undefined && kindRaw !== null) {
    if (!isFabricLeaseEventKind(kindRaw)) {
      throw new ExecutionFabricError('invalid_query', 'kind must be a fabric lease event kind');
    }
    kind = kindRaw;
  }
  return { ...base, kind };
}

export interface ValidatedListArtifactsQuery extends ValidatedLeaseScopedListQuery {
  direction: ArtifactHandoffDirection | null;
}

export function validateListArtifactHandoffsQuery(input: unknown): ValidatedListArtifactsQuery {
  const base = validateLeaseScopedQuery(input, 'listArtifactHandoffs query');
  const source = requireObject(input, 'invalid_query', 'listArtifactHandoffs query');
  const directionRaw = source['direction'];
  let direction: ArtifactHandoffDirection | null = null;
  if (directionRaw !== undefined && directionRaw !== null) {
    if (!isFabricArtifactDirection(directionRaw)) {
      throw new ExecutionFabricError('invalid_query', 'direction must be in | out');
    }
    direction = directionRaw;
  }
  return { ...base, direction };
}

export interface ValidatedListEvidenceQuery extends ValidatedLeaseScopedListQuery {
  captureKind: ValidatedEvidenceInput['captureKind'] | null;
  verification: EvidenceVerification | null;
}

export function validateListLeaseEvidenceQuery(input: unknown): ValidatedListEvidenceQuery {
  const base = validateLeaseScopedQuery(input, 'listLeaseEvidence query');
  const source = requireObject(input, 'invalid_query', 'listLeaseEvidence query');
  const captureRaw = source['captureKind'];
  let captureKind: ValidatedListEvidenceQuery['captureKind'] = null;
  if (captureRaw !== undefined && captureRaw !== null) {
    if (!isFabricCaptureKind(captureRaw)) {
      throw new ExecutionFabricError(
        'invalid_query',
        'captureKind must be screenshot | action-trace | dom-snapshot | console',
      );
    }
    captureKind = captureRaw;
  }
  const verificationRaw = source['verification'];
  let verification: EvidenceVerification | null = null;
  if (verificationRaw !== undefined && verificationRaw !== null) {
    if (!isFabricEvidenceVerification(verificationRaw)) {
      throw new ExecutionFabricError(
        'invalid_query',
        'verification must be unverified | verified | mismatched',
      );
    }
    verification = verificationRaw;
  }
  return { ...base, captureKind, verification };
}

export function validateListLeaseCheckpointsQuery(input: unknown): ValidatedLeaseScopedListQuery {
  return validateLeaseScopedQuery(input, 'listLeaseCheckpoints query');
}
