// Pure validation/normalization logic of the context module (no database,
// no cross-module reads). Everything a caller may put into a fingerprint
// derivation crosses these guards first; the SQL CHECK constraints in
// migrations/001 mirror the load-bearing rules as defense in depth.
//
// THE NULL-SIGNAL LAW starts at this input surface: every dimension of the
// observable context is OPTIONAL, and an absent dimension validates as
// ABSENT — there is no rule anywhere in this file that can turn a missing
// dimension into a fabricated value, and no rule that requires any subset
// of dimensions to be present. A derivation with zero observations is a
// VALID derivation (a fingerprint that knows nothing but its goal and
// task — the honest state when no context evidence exists yet).
//
// Deliberately strict about unknown keys: a caller can never smuggle
// identity, tenancy or derivation times into fingerprint state — ids,
// tenant and `derivedAt` are minted by the system.

import type { TenantContext } from '@/infra/tenant';
import { ContextError } from './errors';
import {
  CONTEXT_DIMENSIONS,
} from './types';
import type {
  ContextObservationsInput,
  DeriveFingerprintInput,
  DurationClass,
  GetFingerprintQuery,
  ListFingerprintsQuery,
  WorkloadLevel,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------

export { CONTEXT_DIMENSIONS };
export type { ContextDimensionKey } from './types';

export const DURATION_CLASSES = ['short', 'medium', 'long', 'ongoing'] as const;
export const WORKLOAD_LEVELS = ['light', 'normal', 'heavy', 'overloaded'] as const;
export const RISK_TOLERANCES = ['risk-averse', 'balanced', 'risk-tolerant'] as const;
export const EXPERIENCE_LEVELS = ['novice', 'intermediate', 'expert'] as const;

/** General slug grammar (coverage/epistemics precedent). */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const MAX_WINDOW_CHARS = 64;
export const MAX_NOTE_CHARS = 512;
export const MAX_SPAN_CHARS = 128;
export const MAX_HEADCOUNT = 1_000_000;
export const MAX_LIST_ITEMS = 32;
export const MAX_REQUIREMENT_ITEMS = 16;
export const MAX_SIGNAL_VALUE_CHARS = 256;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_REF_CHARS = 128;
export const MAX_TASK_TITLE_CHARS = 256;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isDurationClass(value: unknown): value is DurationClass {
  return typeof value === 'string' && (DURATION_CLASSES as readonly string[]).includes(value);
}

export function isWorkloadLevel(value: unknown): value is WorkloadLevel {
  return typeof value === 'string' && (WORKLOAD_LEVELS as readonly string[]).includes(value);
}

export function isRiskTolerance(value: unknown): value is 'risk-averse' | 'balanced' | 'risk-tolerant' {
  return typeof value === 'string' && (RISK_TOLERANCES as readonly string[]).includes(value);
}

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertContextTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new ContextError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new ContextError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers (all throw `invalid_derivation_input`)
// ---------------------------------------------------------------------------

function bad(field: string, problem: string): never {
  throw new ContextError('invalid_derivation_input', `${field} ${problem}`);
}

function optionalString(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') bad(field, 'must be a string when present');
  const trimmed = value.trim();
  if (trimmed === '') bad(field, 'must be a non-empty string when present');
  if (trimmed.length > maxLength) {
    bad(field, `must be at most ${maxLength} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function slugList(value: unknown, field: string, maxItems: number): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) bad(field, 'must be an array when present');
  if (value.length > maxItems) {
    bad(field, `must hold at most ${maxItems} items (got ${value.length})`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !SLUG_PATTERN.test(item)) {
      bad(`${field}[]`, `must match ${SLUG_EXPLAIN} (got '${String(item)}')`);
    }
    out.push(item);
  }
  return out;
}

const SLUG_EXPLAIN = 'the slug grammar (1..64 chars of letters/digits/._:-)';

function requirePlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    bad(field, 'must be an object when present');
  }
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Dimension validators — every one returns null for an ABSENT dimension
// ---------------------------------------------------------------------------

function validateSeason(input: unknown): ContextObservationsInput['season'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.season');
  const window = optionalString(object.window, 'observations.season.window', MAX_WINDOW_CHARS);
  if (window === null) {
    bad('observations.season.window', 'is required when season is present');
  }
  return {
    window,
    note: optionalString(object.note, 'observations.season.note', MAX_NOTE_CHARS),
  };
}

function validateDuration(input: unknown): ContextObservationsInput['duration'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.duration');
  if (!isDurationClass(object.durationClass)) {
    bad(
      'observations.duration.durationClass',
      `must be one of ${DURATION_CLASSES.join(', ')} (got '${String(object.durationClass)}')`,
    );
  }
  return {
    durationClass: object.durationClass,
    estimatedSpan: optionalString(
      object.estimatedSpan,
      'observations.duration.estimatedSpan',
      MAX_SPAN_CHARS,
    ),
  };
}

function validateStaffing(input: unknown): ContextObservationsInput['staffing'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.staffing');

  let headcount: number | null = null;
  if (object.headcount !== undefined && object.headcount !== null) {
    if (
      typeof object.headcount !== 'number' ||
      !Number.isInteger(object.headcount) ||
      object.headcount < 1 ||
      object.headcount > MAX_HEADCOUNT
    ) {
      bad(
        'observations.staffing.headcount',
        `must be an integer between 1 and ${MAX_HEADCOUNT} when present`,
      );
    }
    headcount = object.headcount;
  }

  let experienceMix: Record<'novice' | 'intermediate' | 'expert', number> | null = null;
  if (object.experienceMix !== undefined && object.experienceMix !== null) {
    const mix = requirePlainObject(object.experienceMix, 'observations.staffing.experienceMix');
    const parsed: Record<'novice' | 'intermediate' | 'expert', number> = {
      novice: 0,
      intermediate: 0,
      expert: 0,
    };
    const known = new Set(EXPERIENCE_LEVELS);
    for (const [key, value] of Object.entries(mix)) {
      if (!known.has(key as (typeof EXPERIENCE_LEVELS)[number])) {
        bad(
          'observations.staffing.experienceMix',
          `has an unknown experience level '${key}' (${EXPERIENCE_LEVELS.join('/')} only)`,
        );
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
        bad(`observations.staffing.experienceMix.${key}`, 'must be a non-negative integer');
      }
      parsed[key as (typeof EXPERIENCE_LEVELS)[number]] = value;
    }
    const total =
      parsed.novice + parsed.intermediate + parsed.expert;
    if (total < 1 || total > MAX_HEADCOUNT) {
      bad(
        'observations.staffing.experienceMix',
        `must sum to between 1 and ${MAX_HEADCOUNT} (got ${total})`,
      );
    }
    experienceMix = parsed;
  }

  return {
    headcount,
    experienceMix,
    note: optionalString(object.note, 'observations.staffing.note', MAX_NOTE_CHARS),
  };
}

function validateCapabilities(input: unknown): ContextObservationsInput['capabilities'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.capabilities');
  if (
    (object.available === undefined || object.available === null) &&
    (object.missing === undefined || object.missing === null)
  ) {
    bad('observations.capabilities', 'must state available and/or missing when present');
  }
  const available =
    slugList(object.available, 'observations.capabilities.available', MAX_LIST_ITEMS) ?? [];
  const missing =
    slugList(object.missing, 'observations.capabilities.missing', MAX_LIST_ITEMS) ?? [];
  if (available.length + missing.length === 0) {
    bad('observations.capabilities', 'must state at least one available or missing capability when present');
  }
  const overlap = available.filter((item) => missing.includes(item));
  if (overlap.length > 0) {
    bad(
      'observations.capabilities',
      `cannot list '${overlap[0]}' as both available and missing`,
    );
  }
  return { available, missing };
}

function validateEnvironment(input: unknown): ContextObservationsInput['environment'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.environment');
  const factors = slugList(object.factors, 'observations.environment.factors', MAX_LIST_ITEMS);
  if (factors === null || factors.length === 0) {
    bad('observations.environment.factors', 'must hold at least one factor when environment is present');
  }
  return { factors };
}

function validateConstraints(input: unknown): ContextObservationsInput['constraints'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.constraints');
  const riskTolerance = optionalString(
    object.riskTolerance,
    'observations.constraints.riskTolerance',
    MAX_WINDOW_CHARS,
  );
  if (riskTolerance !== null && !isRiskTolerance(riskTolerance)) {
    bad(
      'observations.constraints.riskTolerance',
      `must be one of ${RISK_TOLERANCES.join(', ')} (got '${riskTolerance}')`,
    );
  }
  return {
    budgetNote: optionalString(object.budgetNote, 'observations.constraints.budgetNote', MAX_NOTE_CHARS),
    slaNote: optionalString(object.slaNote, 'observations.constraints.slaNote', MAX_NOTE_CHARS),
    qualityTarget: optionalString(object.qualityTarget, 'observations.constraints.qualityTarget', MAX_NOTE_CHARS),
    riskTolerance,
    verificationRequirements:
      slugList(
        object.verificationRequirements,
        'observations.constraints.verificationRequirements',
        MAX_REQUIREMENT_ITEMS,
      ) ?? [],
  };
}

function validateEvidenceFreshness(input: unknown): ContextObservationsInput['evidenceFreshness'] {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'observations.evidenceFreshness');
  const maxEvidenceAge = optionalString(
    object.maxEvidenceAge,
    'observations.evidenceFreshness.maxEvidenceAge',
    MAX_WINDOW_CHARS,
  );
  const criticalFreshSurfaces =
    slugList(
      object.criticalFreshSurfaces,
      'observations.evidenceFreshness.criticalFreshSurfaces',
      MAX_LIST_ITEMS,
    ) ?? [];
  if (maxEvidenceAge === null && criticalFreshSurfaces.length === 0) {
    bad(
      'observations.evidenceFreshness',
      'must state maxEvidenceAge and/or criticalFreshSurfaces when present',
    );
  }
  return { maxEvidenceAge, criticalFreshSurfaces };
}

function validateAdditionalSignals(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  const object = requirePlainObject(input, 'observations.additionalSignals');
  const entries = Object.entries(object);
  if (entries.length > MAX_LIST_ITEMS) {
    bad(
      'observations.additionalSignals',
      `must hold at most ${MAX_LIST_ITEMS} signals (got ${entries.length})`,
    );
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!SLUG_PATTERN.test(key)) {
      bad('observations.additionalSignals', `key '${key}' must match ${SLUG_EXPLAIN}`);
    }
    if (typeof value !== 'string' || value.trim() === '') {
      bad(`observations.additionalSignals.${key}`, 'must be a non-empty string');
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_SIGNAL_VALUE_CHARS) {
      bad(
        `observations.additionalSignals.${key}`,
        `must be at most ${MAX_SIGNAL_VALUE_CHARS} characters`,
      );
    }
    out[key] = trimmed;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task + derivation input
// ---------------------------------------------------------------------------

export interface ValidatedTask {
  title: string | null;
  kind: string | null;
}

function validateTask(input: unknown): ValidatedTask | null {
  if (input === undefined || input === null) return null;
  const object = requirePlainObject(input, 'task');
  const title = optionalString(object.title, 'task.title', MAX_TASK_TITLE_CHARS);
  const kind =
    object.kind === undefined || object.kind === null
      ? null
      : optionalString(object.kind, 'task.kind', MAX_WINDOW_CHARS);
  if (kind !== null && !SLUG_PATTERN.test(kind)) {
    bad('task.kind', `must match ${SLUG_EXPLAIN} (got '${kind}')`);
  }
  if (title === null && kind === null) {
    bad('task', 'must state a title and/or kind when present');
  }
  return { title, kind };
}

function validateEvidenceRefs(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) bad('derivedFrom', 'must be an array of opaque evidence refs');
  if (input.length > MAX_EVIDENCE_REFS) {
    bad('derivedFrom', `must hold at most ${MAX_EVIDENCE_REFS} refs (got ${input.length})`);
  }
  const out: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string' || item.trim() === '' || item.trim().length > MAX_REF_CHARS) {
      bad('derivedFrom[]', `must be a non-empty ref of at most ${MAX_REF_CHARS} characters`);
    }
    out.push(item.trim());
  }
  return out;
}

export interface ValidatedDerivationInput {
  goalId: string;
  task: ValidatedTask | null;
  observations: {
    season: ContextObservationsInput['season'];
    duration: ContextObservationsInput['duration'];
    staffing: ContextObservationsInput['staffing'];
    workload: WorkloadLevel | null;
    capabilities: ContextObservationsInput['capabilities'];
    environment: ContextObservationsInput['environment'];
    constraints: ContextObservationsInput['constraints'];
    evidenceFreshness: ContextObservationsInput['evidenceFreshness'];
    additionalSignals: Record<string, string>;
  };
  derivedFrom: string[];
}

/** Validate + normalize a `deriveFingerprint` input (pure). */
export function validateDerivationInput(input: DeriveFingerprintInput): ValidatedDerivationInput {
  if (typeof input !== 'object' || input === null) {
    throw new ContextError('invalid_derivation_input', 'input must be an object');
  }
  if (!isUuid(input.goalId)) {
    bad('goalId', 'must be a uuid (the goals-module record being fingerprinted)');
  }

  const raw = (input.observations ?? {}) as Record<string, unknown>;
  const observationsObject = requirePlainObject(raw, 'observations');
  const workload =
    observationsObject.workload === undefined || observationsObject.workload === null
      ? null
      : isWorkloadLevel(observationsObject.workload)
        ? observationsObject.workload
        : bad(
            'observations.workload',
            `must be one of ${WORKLOAD_LEVELS.join(', ')} (got '${String(observationsObject.workload)}')`,
          );

  return {
    goalId: input.goalId,
    task: validateTask(input.task),
    observations: {
      season: validateSeason(observationsObject.season),
      duration: validateDuration(observationsObject.duration),
      staffing: validateStaffing(observationsObject.staffing),
      workload,
      capabilities: validateCapabilities(observationsObject.capabilities),
      environment: validateEnvironment(observationsObject.environment),
      constraints: validateConstraints(observationsObject.constraints),
      evidenceFreshness: validateEvidenceFreshness(observationsObject.evidenceFreshness),
      additionalSignals: validateAdditionalSignals(observationsObject.additionalSignals),
    },
    derivedFrom: validateEvidenceRefs(input.derivedFrom),
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

export interface ValidatedGetFingerprintQuery {
  fingerprintId: string;
}

export function validateGetFingerprintQuery(query: GetFingerprintQuery): ValidatedGetFingerprintQuery {
  if (typeof query !== 'object' || query === null) {
    throw new ContextError('invalid_query', 'query must be an object');
  }
  if (!isUuid(query.fingerprintId)) {
    throw new ContextError('invalid_query', 'query.fingerprintId must be a uuid');
  }
  return { fingerprintId: query.fingerprintId };
}

export interface ValidatedListFingerprintsQuery {
  goalId: string | null;
  limit: number;
}

export function validateListFingerprintsQuery(
  query?: ListFingerprintsQuery,
): ValidatedListFingerprintsQuery {
  if (query === undefined || query === null) {
    return { goalId: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (typeof query !== 'object') {
    throw new ContextError('invalid_query', 'query must be an object when present');
  }
  const goalId =
    query.goalId === undefined || query.goalId === null
      ? null
      : isUuid(query.goalId)
        ? query.goalId
        : (() => {
            throw new ContextError('invalid_query', 'query.goalId must be a uuid when present');
          })();
  let limit = DEFAULT_LIST_LIMIT;
  if (query.limit !== undefined && query.limit !== null) {
    if (typeof query.limit !== 'number' || !Number.isInteger(query.limit)) {
      throw new ContextError('invalid_query', 'query.limit must be an integer when present');
    }
    if (query.limit < 1 || query.limit > MAX_LIST_LIMIT) {
      throw new ContextError(
        'invalid_query',
        `query.limit must be between 1 and ${MAX_LIST_LIMIT} (got ${query.limit})`,
      );
    }
    limit = query.limit;
  }
  return { goalId, limit };
}
