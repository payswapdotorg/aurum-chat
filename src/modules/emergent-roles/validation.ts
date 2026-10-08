// Pure validation of the emergent-roles module's inputs and queries
// (see contract.ts). No database, no clock, no TenantContext reads —
// the org-lab discipline: everything here is unit-testable without
// infrastructure.
//
// VOCABULARY OWNERSHIP (the house ruling, mirrored here): the status,
// origin-kind and gap-source-kind unions are THIS module's own frozen
// vocabularies (types.ts is their single home); the cross-module
// vocabulary this module speaks — the marketplace package state frozen
// onto submission records — is consumed VERBATIM from the marketplace
// contract at record time and never re-validated here (a frozen
// snapshot is evidence, not input).

import type { TenantContext } from '@/infra/tenant';
import { EmergentRolesError } from './errors';
import type {
  GapEvidenceSourceKind,
  RoleProposalOriginKind,
  RoleProposalStatus,
} from './types';

// ---------------------------------------------------------------------------
// Limits (bounds every input field — the house discipline)
// ---------------------------------------------------------------------------

export const MAX_SLUG_CHARS = 64;
export const MAX_TITLE_CHARS = 200;
export const MAX_NOTE_CHARS = 2000;
export const MAX_REASON_CHARS = 512;
export const MAX_OBSERVATION_CHARS = 2000;
export const MIN_EVIDENCE_CITATIONS = 2;
export const MAX_EVIDENCE_CITATIONS = 16;
export const MIN_DEMANDS = 1;
export const MAX_DEMANDS = 16;
export const MIN_DEMAND_LEVEL = 0;
export const MAX_DEMAND_LEVEL = 1;
export const MAX_DEMAND_NOTE_CHARS = 512;
export const MIN_ALTERNATIVES = 1;
export const MAX_ALTERNATIVES = 8;
export const MAX_ALTERNATIVE_LABEL_CHARS = 128;
export const MAX_ALTERNATIVE_DESCRIPTION_CHARS = 2000;
export const MAX_ALTERNATIVE_EVALUATION_CHARS = 2000;
export const MAX_EVALUATION_CHARS = 2000;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vocabularies (frozen here; types.ts is the single home)
// ---------------------------------------------------------------------------

export const ROLE_PROPOSAL_STATUSES = [
  'draft',
  'under_review',
  'approved',
  'rejected',
  'fulfilled',
  'withdrawn',
] as const satisfies readonly RoleProposalStatus[];

export const ROLE_PROPOSAL_TERMINAL_STATUSES = [
  'rejected',
  'fulfilled',
  'withdrawn',
] as const satisfies readonly RoleProposalStatus[];

export const ROLE_PROPOSAL_ORIGIN_KINDS = [
  'org-lab',
  'tenant-operator',
] as const satisfies readonly RoleProposalOriginKind[];

export const GAP_EVIDENCE_SOURCE_KINDS = [
  'learning-outcome',
  'org-lab-recommendation',
  'execution-run',
] as const satisfies readonly GapEvidenceSourceKind[];

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isSlug(value: unknown): value is string {
  return typeof value === 'string' && SLUG_PATTERN.test(value);
}

export function isRoleProposalStatus(value: unknown): value is RoleProposalStatus {
  return (
    typeof value === 'string' && (ROLE_PROPOSAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalRoleProposalStatus(value: unknown): value is RoleProposalStatus {
  return (
    typeof value === 'string' &&
    (ROLE_PROPOSAL_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isRoleProposalOriginKind(value: unknown): value is RoleProposalOriginKind {
  return (
    typeof value === 'string' &&
    (ROLE_PROPOSAL_ORIGIN_KINDS as readonly string[]).includes(value)
  );
}

export function isGapEvidenceSourceKind(value: unknown): value is GapEvidenceSourceKind {
  return (
    typeof value === 'string' &&
    (GAP_EVIDENCE_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** The explicit TenantContext is asserted, never ambient (ADR-0001). */
export function assertEmergentRolesTenantContext(ctx: TenantContext): void {
  if (
    typeof ctx !== 'object' ||
    ctx === null ||
    typeof ctx.tenantId !== 'string' ||
    ctx.tenantId.length === 0 ||
    typeof ctx.principalId !== 'string' ||
    ctx.principalId.length === 0 ||
    !Array.isArray(ctx.authority)
  ) {
    throw new EmergentRolesError(
      'invalid_context',
      'an explicit TenantContext with tenant and principal is required',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type InputCode =
  | 'invalid_gap_input'
  | 'invalid_proposal_input'
  | 'invalid_transition_input'
  | 'invalid_review_input'
  | 'invalid_submission_input'
  | 'invalid_activation_input'
  | 'invalid_query';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, min: number, max: number, code: InputCode): string {
  if (typeof value !== 'string') {
    throw new EmergentRolesError(code, `${field} must be a string`);
  }
  if (value.length < min || value.length > max) {
    throw new EmergentRolesError(
      code,
      `${field} must be ${min}..${max} characters (got ${value.length})`,
    );
  }
  return value;
}

function optionalString(value: unknown, field: string, min: number, max: number, code: InputCode): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, min, max, code);
}

function requireUuid(value: unknown, field: string, code: InputCode): string {
  if (!isUuid(value)) {
    throw new EmergentRolesError(code, `${field} must be a uuid`);
  }
  return value;
}

function requireArray(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: InputCode,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new EmergentRolesError(code, `${field} must be an array`);
  }
  if (value.length < min || value.length > max) {
    throw new EmergentRolesError(
      code,
      `${field} must hold ${min}..${max} entries (got ${value.length})`,
    );
  }
  return value;
}

function requireLevel(value: unknown, field: string, code: InputCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new EmergentRolesError(code, `${field} must be a finite number`);
  }
  if (value < MIN_DEMAND_LEVEL || value > MAX_DEMAND_LEVEL) {
    throw new EmergentRolesError(
      code,
      `${field} must be in [${MIN_DEMAND_LEVEL}, ${MAX_DEMAND_LEVEL}] — the W017 proficiency semantics (got ${String(value)})`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// recordGapEvidence
// ---------------------------------------------------------------------------

/** The validated, normalized upstream source of one gap-evidence record. */
export type ValidatedGapSource =
  | { kind: 'learning-outcome'; outcomeId: string }
  | { kind: 'org-lab-recommendation'; recommendationId: string }
  | { kind: 'execution-run'; planId: string; runId: string };

export interface ValidatedRecordGapEvidenceInput {
  capabilityId: string;
  source: ValidatedGapSource;
  observation: string;
}

export function validateRecordGapEvidenceInput(
  input: unknown,
): ValidatedRecordGapEvidenceInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_gap_input', 'input must be an object');
  }
  const capabilityId = requireUuid(input.capabilityId, 'capabilityId', 'invalid_gap_input');
  const observation = requireString(
    input.observation,
    'observation',
    1,
    MAX_OBSERVATION_CHARS,
    'invalid_gap_input',
  );
  const source = validateGapSource(input.source);
  return { capabilityId, source, observation };
}

function validateGapSource(value: unknown): ValidatedGapSource {
  if (!isRecord(value)) {
    throw new EmergentRolesError('invalid_gap_input', 'source must be an object');
  }
  switch (value.kind) {
    case 'learning-outcome':
      return {
        kind: 'learning-outcome',
        outcomeId: requireUuid(value.outcomeId, 'source.outcomeId', 'invalid_gap_input'),
      };
    case 'org-lab-recommendation':
      return {
        kind: 'org-lab-recommendation',
        recommendationId: requireUuid(
          value.recommendationId,
          'source.recommendationId',
          'invalid_gap_input',
        ),
      };
    case 'execution-run':
      return {
        kind: 'execution-run',
        planId: requireUuid(value.planId, 'source.planId', 'invalid_gap_input'),
        runId: requireUuid(value.runId, 'source.runId', 'invalid_gap_input'),
      };
    default:
      throw new EmergentRolesError(
        'invalid_gap_input',
        `source.kind must be one of ${GAP_EVIDENCE_SOURCE_KINDS.join(' | ')}`,
      );
  }
}

// ---------------------------------------------------------------------------
// createRoleProposal
// ---------------------------------------------------------------------------

export interface ValidatedDemand {
  capabilityId: string;
  minimumLevel: number;
  note: string | null;
}

export interface ValidatedAlternative {
  label: string;
  description: string | null;
  evaluation: string;
}

export interface ValidatedEvaluation {
  rationale: string;
  whyNow: string;
  gapRecurrence: string;
}

export interface ValidatedCreateRoleProposalInput {
  slug: string;
  title: string;
  origin: {
    kind: RoleProposalOriginKind;
    recommendationId: string | null;
  };
  evidenceCitationIds: string[];
  demands: ValidatedDemand[];
  alternatives: ValidatedAlternative[];
  evaluation: ValidatedEvaluation;
  note: string | null;
}

export function validateCreateRoleProposalInput(
  input: unknown,
): ValidatedCreateRoleProposalInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_proposal_input', 'input must be an object');
  }
  if (!isSlug(input.slug)) {
    throw new EmergentRolesError(
      'invalid_proposal_input',
      'slug must match ^[a-z0-9][a-z0-9-]{0,63}$',
    );
  }
  const title = requireString(
    input.title,
    'title',
    1,
    MAX_TITLE_CHARS,
    'invalid_proposal_input',
  );
  const note = optionalString(input.note, 'note', 1, MAX_NOTE_CHARS, 'invalid_proposal_input');

  // The provenance: org-lab proposals REQUIRE their recommendation ref;
  // tenant-operator proposals must not carry one (a fabricated Lab
  // provenance is exactly the abuse the separation clause exists for).
  if (!isRecord(input.origin)) {
    throw new EmergentRolesError('invalid_proposal_input', 'origin must be an object');
  }
  if (!isRoleProposalOriginKind(input.origin.kind)) {
    throw new EmergentRolesError(
      'invalid_proposal_input',
      `origin.kind must be one of ${ROLE_PROPOSAL_ORIGIN_KINDS.join(' | ')}`,
    );
  }
  const kind = input.origin.kind;
  let recommendationId: string | null = null;
  if (kind === 'org-lab') {
    recommendationId = requireUuid(
      input.origin.recommendationId,
      'origin.recommendationId',
      'invalid_proposal_input',
    );
  } else if (input.origin.recommendationId !== undefined && input.origin.recommendationId !== null) {
    throw new EmergentRolesError(
      'invalid_proposal_input',
      'origin.recommendationId is only legal for org-lab proposals — a tenant-operator proposal has no Lab provenance',
    );
  }

  // The evidence citations (acceptance clause 1): 2..16 DISTINCT uuids —
  // the recurrence floor. A single gap is not a recurring gap.
  const citations = requireArray(
    input.evidenceCitationIds,
    'evidenceCitationIds',
    MIN_EVIDENCE_CITATIONS,
    MAX_EVIDENCE_CITATIONS,
    'invalid_proposal_input',
  );
  const evidenceCitationIds: string[] = [];
  const seenCitations = new Set<string>();
  for (const citation of citations) {
    const id = requireUuid(citation, 'evidenceCitationIds[]', 'invalid_proposal_input');
    if (seenCitations.has(id)) {
      throw new EmergentRolesError(
        'invalid_proposal_input',
        `evidence citation '${id}' appears more than once — distinct gaps only (one record cannot pose as two)`,
      );
    }
    seenCitations.add(id);
    evidenceCitationIds.push(id);
  }

  // The capability demands (acceptance clause 1): 1..16, distinct
  // capability ids, levels in the W017 proficiency semantics.
  const demandInputs = requireArray(
    input.demands,
    'demands',
    MIN_DEMANDS,
    MAX_DEMANDS,
    'invalid_proposal_input',
  );
  const demands: ValidatedDemand[] = [];
  const seenCapabilities = new Set<string>();
  for (const entry of demandInputs) {
    if (!isRecord(entry)) {
      throw new EmergentRolesError('invalid_proposal_input', 'demands[] entries must be objects');
    }
    const capabilityId = requireUuid(
      entry.capabilityId,
      'demands[].capabilityId',
      'invalid_proposal_input',
    );
    if (seenCapabilities.has(capabilityId)) {
      throw new EmergentRolesError(
        'invalid_proposal_input',
        `capability '${capabilityId}' is demanded more than once — one demand per capability`,
      );
    }
    seenCapabilities.add(capabilityId);
    demands.push({
      capabilityId,
      minimumLevel: requireLevel(
        entry.minimumLevel,
        'demands[].minimumLevel',
        'invalid_proposal_input',
      ),
      note: optionalString(
        entry.note,
        'demands[].note',
        1,
        MAX_DEMAND_NOTE_CHARS,
        'invalid_proposal_input',
      ),
    });
  }

  // The alternatives considered (acceptance clause 1): 1..8, each with
  // its REQUIRED retained evaluation (why it lost).
  const alternativeInputs = requireArray(
    input.alternatives,
    'alternatives',
    MIN_ALTERNATIVES,
    MAX_ALTERNATIVES,
    'invalid_proposal_input',
  );
  const alternatives: ValidatedAlternative[] = [];
  const seenLabels = new Set<string>();
  for (const entry of alternativeInputs) {
    if (!isRecord(entry)) {
      throw new EmergentRolesError(
        'invalid_proposal_input',
        'alternatives[] entries must be objects',
      );
    }
    const label = requireString(
      entry.label,
      'alternatives[].label',
      1,
      MAX_ALTERNATIVE_LABEL_CHARS,
      'invalid_proposal_input',
    );
    if (seenLabels.has(label)) {
      throw new EmergentRolesError(
        'invalid_proposal_input',
        `alternative label '${label}' appears more than once`,
      );
    }
    seenLabels.add(label);
    alternatives.push({
      label,
      description: optionalString(
        entry.description,
        'alternatives[].description',
        1,
        MAX_ALTERNATIVE_DESCRIPTION_CHARS,
        'invalid_proposal_input',
      ),
      evaluation: requireString(
        entry.evaluation,
        'alternatives[].evaluation',
        1,
        MAX_ALTERNATIVE_EVALUATION_CHARS,
        'invalid_proposal_input',
      ),
    });
  }

  // The structured evaluation summary (acceptance clause 1): all three
  // questions required.
  if (!isRecord(input.evaluation)) {
    throw new EmergentRolesError('invalid_proposal_input', 'evaluation must be an object');
  }
  const evaluation: ValidatedEvaluation = {
    rationale: requireString(
      input.evaluation.rationale,
      'evaluation.rationale',
      1,
      MAX_EVALUATION_CHARS,
      'invalid_proposal_input',
    ),
    whyNow: requireString(
      input.evaluation.whyNow,
      'evaluation.whyNow',
      1,
      MAX_EVALUATION_CHARS,
      'invalid_proposal_input',
    ),
    gapRecurrence: requireString(
      input.evaluation.gapRecurrence,
      'evaluation.gapRecurrence',
      1,
      MAX_EVALUATION_CHARS,
      'invalid_proposal_input',
    ),
  };

  return {
    slug: input.slug,
    title,
    origin: { kind, recommendationId },
    evidenceCitationIds,
    demands,
    alternatives,
    evaluation,
    note,
  };
}

// ---------------------------------------------------------------------------
// submitRoleProposal / withdrawRoleProposal (transitions)
// ---------------------------------------------------------------------------

export interface ValidatedSubmitRoleProposalInput {
  proposalId: string;
}

export function validateSubmitRoleProposalInput(
  input: unknown,
): ValidatedSubmitRoleProposalInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_transition_input', 'input must be an object');
  }
  return {
    proposalId: requireUuid(input.proposalId, 'proposalId', 'invalid_transition_input'),
  };
}

export interface ValidatedWithdrawRoleProposalInput {
  proposalId: string;
  reason: string;
}

export function validateWithdrawRoleProposalInput(
  input: unknown,
): ValidatedWithdrawRoleProposalInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_transition_input', 'input must be an object');
  }
  return {
    proposalId: requireUuid(input.proposalId, 'proposalId', 'invalid_transition_input'),
    reason: requireString(
      input.reason,
      'reason',
      1,
      MAX_REASON_CHARS,
      'invalid_transition_input',
    ),
  };
}

// ---------------------------------------------------------------------------
// recordProposalReview
// ---------------------------------------------------------------------------

export interface ValidatedRecordProposalReviewInput {
  proposalId: string;
  actionRequestId: string;
}

export function validateRecordProposalReviewInput(
  input: unknown,
): ValidatedRecordProposalReviewInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_review_input', 'input must be an object');
  }
  return {
    proposalId: requireUuid(input.proposalId, 'proposalId', 'invalid_review_input'),
    actionRequestId: requireUuid(
      input.actionRequestId,
      'actionRequestId',
      'invalid_review_input',
    ),
  };
}

// ---------------------------------------------------------------------------
// recordMarketplaceSubmission
// ---------------------------------------------------------------------------

export interface ValidatedRecordMarketplaceSubmissionInput {
  proposalId: string;
  packageId: string;
  note: string | null;
}

export function validateRecordMarketplaceSubmissionInput(
  input: unknown,
): ValidatedRecordMarketplaceSubmissionInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_submission_input', 'input must be an object');
  }
  return {
    proposalId: requireUuid(input.proposalId, 'proposalId', 'invalid_submission_input'),
    packageId: requireUuid(input.packageId, 'packageId', 'invalid_submission_input'),
    note: optionalString(input.note, 'note', 1, MAX_NOTE_CHARS, 'invalid_submission_input'),
  };
}

// ---------------------------------------------------------------------------
// recordRoleActivation
// ---------------------------------------------------------------------------

export interface ValidatedRecordRoleActivationInput {
  proposalId: string;
  recruitmentProposalId: string;
  note: string | null;
}

export function validateRecordRoleActivationInput(
  input: unknown,
): ValidatedRecordRoleActivationInput {
  if (!isRecord(input)) {
    throw new EmergentRolesError('invalid_activation_input', 'input must be an object');
  }
  return {
    proposalId: requireUuid(input.proposalId, 'proposalId', 'invalid_activation_input'),
    recruitmentProposalId: requireUuid(
      input.recruitmentProposalId,
      'recruitmentProposalId',
      'invalid_activation_input',
    ),
    note: optionalString(input.note, 'note', 1, MAX_NOTE_CHARS, 'invalid_activation_input'),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ValidatedGetRoleProposalQuery {
  proposalId: string;
}

export function validateGetRoleProposalQuery(
  query: unknown,
): ValidatedGetRoleProposalQuery {
  if (!isRecord(query)) {
    throw new EmergentRolesError('invalid_query', 'query must be an object');
  }
  return { proposalId: requireUuid(query.proposalId, 'proposalId', 'invalid_query') };
}

export interface ValidatedListRoleProposalsQuery {
  status: RoleProposalStatus | null;
  originKind: RoleProposalOriginKind | null;
  limit: number;
}

export function validateListRoleProposalsQuery(
  query: unknown,
): ValidatedListRoleProposalsQuery {
  if (query === undefined || query === null) {
    return { status: null, originKind: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isRecord(query)) {
    throw new EmergentRolesError('invalid_query', 'query must be an object');
  }
  let status: RoleProposalStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isRoleProposalStatus(query.status)) {
      throw new EmergentRolesError(
        'invalid_query',
        `status must be one of ${ROLE_PROPOSAL_STATUSES.join(' | ')}`,
      );
    }
    status = query.status;
  }
  let originKind: RoleProposalOriginKind | null = null;
  if (query.originKind !== undefined && query.originKind !== null) {
    if (!isRoleProposalOriginKind(query.originKind)) {
      throw new EmergentRolesError(
        'invalid_query',
        `originKind must be one of ${ROLE_PROPOSAL_ORIGIN_KINDS.join(' | ')}`,
      );
    }
    originKind = query.originKind;
  }
  return { status, originKind, limit: requireLimit(query.limit) };
}

export interface ValidatedGetGapEvidenceQuery {
  gapEvidenceId: string;
}

export function validateGetGapEvidenceQuery(query: unknown): ValidatedGetGapEvidenceQuery {
  if (!isRecord(query)) {
    throw new EmergentRolesError('invalid_query', 'query must be an object');
  }
  return {
    gapEvidenceId: requireUuid(query.gapEvidenceId, 'gapEvidenceId', 'invalid_query'),
  };
}

export interface ValidatedListGapEvidenceQuery {
  capabilityId: string | null;
  sourceKind: GapEvidenceSourceKind | null;
  limit: number;
}

export function validateListGapEvidenceQuery(query: unknown): ValidatedListGapEvidenceQuery {
  if (query === undefined || query === null) {
    return { capabilityId: null, sourceKind: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (!isRecord(query)) {
    throw new EmergentRolesError('invalid_query', 'query must be an object');
  }
  let capabilityId: string | null = null;
  if (query.capabilityId !== undefined && query.capabilityId !== null) {
    capabilityId = requireUuid(query.capabilityId, 'capabilityId', 'invalid_query');
  }
  let sourceKind: GapEvidenceSourceKind | null = null;
  if (query.sourceKind !== undefined && query.sourceKind !== null) {
    if (!isGapEvidenceSourceKind(query.sourceKind)) {
      throw new EmergentRolesError(
        'invalid_query',
        `sourceKind must be one of ${GAP_EVIDENCE_SOURCE_KINDS.join(' | ')}`,
      );
    }
    sourceKind = query.sourceKind;
  }
  return { capabilityId, sourceKind, limit: requireLimit(query.limit) };
}

export interface ValidatedProposalScopedListQuery {
  proposalId: string;
  limit: number;
}

export function validateProposalScopedListQuery(
  query: unknown,
): ValidatedProposalScopedListQuery {
  if (!isRecord(query)) {
    throw new EmergentRolesError('invalid_query', 'query must be an object');
  }
  return {
    proposalId: requireUuid(query.proposalId, 'proposalId', 'invalid_query'),
    limit: requireLimit(query.limit),
  };
}

function requireLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new EmergentRolesError('invalid_query', 'limit must be an integer');
  }
  if (value < 1 || value > MAX_LIST_LIMIT) {
    throw new EmergentRolesError(
      'invalid_query',
      `limit must be 1..${MAX_LIST_LIMIT} (got ${String(value)})`,
    );
  }
  return value;
}
