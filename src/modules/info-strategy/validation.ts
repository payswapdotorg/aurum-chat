// Pure validation/normalization logic of the info-strategy module (no
// database, no cross-module reads). Everything a caller may put into a
// strategy or a strategy version crosses these guards first; the SQL
// CHECK constraints in migrations/001 mirror the load-bearing rules as
// defense in depth.
//
// THE CONTEXTUAL RULE starts at this input surface: there is NO rule
// anywhere in this file that produces, defaults or "improves" strategy
// CONTENT. Every requirement, source preference, ceiling and threshold
// is caller-supplied and validated for SHAPE only — the module cannot
// hardcode a per-industry or per-task strategy because it has no code
// path that invents strategy content at all. (A strategy must carry at
// least one knowledge requirement — that is a shape rule about being a
// strategy, not a content rule about any industry.)
//
// Deliberately strict about unknown keys: a caller can never smuggle
// identity, tenancy, version numbers or timestamps into strategy state —
// ids, versions and `recordedAt` are minted by the system.

import type { TenantContext } from '@/infra/tenant';
import { COVERAGE_SOURCE_REGISTRIES } from '@/modules/coverage/contract';
import { InfoStrategyError } from './errors';
import type {
  CostCeiling,
  CostCeilingScope,
  EscalationThreshold,
  EscalationTrigger,
  GetStrategyQuery,
  GetStrategyVersionQuery,
  KnowledgeRequirement,
  ListStrategiesQuery,
  ListStrategyVersionsQuery,
  OutcomeEvidence,
  OutcomeEvidenceInput,
  PreferredSource,
} from './types';
import { OUTCOME_EVIDENCE_KINDS } from './types';

// ---------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------

export { OUTCOME_EVIDENCE_KINDS };
export type { OutcomeEvidenceKind } from './types';

export const COST_CEILING_SCOPES = ['per-requirement', 'per-acquisition', 'per-strategy'] as const;
export const ESCALATION_TRIGGERS = [
  'failed-attempts',
  'budget-exhausted',
  'freshness-breach',
  'confidence-shortfall',
] as const;

export const MAX_REQUIREMENTS = 32;
export const MAX_PREFERRED_SOURCES = 16;
export const MAX_COST_CEILINGS = 8;
export const MAX_ESCALATION_THRESHOLDS = 8;
export const MAX_OUTCOME_EVIDENCE = 16;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_REF_CHARS = 256;
export const MAX_RATIONALE_CHARS = 1024;
export const MAX_NOTE_CHARS = 2048;
export const MAX_OBSERVED_CHARS = 1024;
export const MAX_AMOUNT = 1_000_000_000_000_000; // 10^15 minor units
export const MAX_ATTEMPTS = 100;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isCostCeilingScope(value: unknown): value is CostCeilingScope {
  return typeof value === 'string' && (COST_CEILING_SCOPES as readonly string[]).includes(value);
}

export function isEscalationTrigger(value: unknown): value is EscalationTrigger {
  return typeof value === 'string' && (ESCALATION_TRIGGERS as readonly string[]).includes(value);
}

export function isOutcomeEvidenceKind(value: unknown): value is OutcomeEvidenceInput['kind'] {
  return typeof value === 'string' && (OUTCOME_EVIDENCE_KINDS as readonly string[]).includes(value);
}

export function isPreferredSourceRegistry(
  value: unknown,
): value is PreferredSource['registry'] {
  return (
    typeof value === 'string' &&
    (COVERAGE_SOURCE_REGISTRIES as readonly string[]).includes(value)
  );
}

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertInfoStrategyTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new InfoStrategyError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new InfoStrategyError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function badInput(code: 'invalid_strategy_input' | 'invalid_adjustment_input', field: string, problem: string): never {
  throw new InfoStrategyError(code, `${field} ${problem}`);
}

function optionalText(
  value: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') badInput(code, field, 'must be a string when present');
  const trimmed = value.trim();
  if (trimmed === '') badInput(code, field, 'must be a non-empty string when present');
  if (trimmed.length > maxLength) {
    badInput(code, field, `must be at most ${maxLength} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function requiredText(
  value: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
  maxLength: number,
): string {
  const text = optionalText(value, code, field, maxLength);
  if (text === null) badInput(code, field, 'is required');
  return text;
}

function requirePlainObject(
  value: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    badInput(code, field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function evidenceRefs(
  value: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) badInput(code, 'derivedFrom', 'must be an array of opaque evidence refs');
  if (value.length > MAX_EVIDENCE_REFS) {
    badInput(code, 'derivedFrom', `must hold at most ${MAX_EVIDENCE_REFS} refs (got ${value.length})`);
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '' || item.trim().length > MAX_REF_CHARS) {
      badInput(code, 'derivedFrom[]', `must be a non-empty ref of at most ${MAX_REF_CHARS} characters`);
    }
    out.push(item.trim());
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content validators
// ---------------------------------------------------------------------------

function validateRequirements(
  input: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
  { requireAtLeastOne }: { requireAtLeastOne: boolean },
): KnowledgeRequirement[] {
  if (input === undefined || input === null) {
    if (requireAtLeastOne) badInput(code, field, 'is required (a strategy must want to know something)');
    return [];
  }
  if (!Array.isArray(input)) badInput(code, field, 'must be an array');
  if (input.length < (requireAtLeastOne ? 1 : 0) || input.length > MAX_REQUIREMENTS) {
    badInput(
      code,
      field,
      `must hold between ${requireAtLeastOne ? 1 : 0} and ${MAX_REQUIREMENTS} requirements (got ${input.length})`,
    );
  }
  const out: KnowledgeRequirement[] = [];
  for (const item of input) {
    const object = requirePlainObject(item, code, `${field}[]`);
    if (!isUuid(object.unknownId)) {
      badInput(code, `${field}[].unknownId`, 'must be a uuid (the epistemics Unknown being tracked)');
    }
    if (
      typeof object.targetConfidence !== 'number' ||
      !(object.targetConfidence > 0 && object.targetConfidence <= 1)
    ) {
      badInput(code, `${field}[].targetConfidence`, 'must be a number in (0, 1]');
    }
    let maxEvidenceAgeSeconds: number | null = null;
    if (object.maxEvidenceAgeSeconds !== undefined && object.maxEvidenceAgeSeconds !== null) {
      if (
        typeof object.maxEvidenceAgeSeconds !== 'number' ||
        !Number.isInteger(object.maxEvidenceAgeSeconds) ||
        object.maxEvidenceAgeSeconds < 1
      ) {
        badInput(code, `${field}[].maxEvidenceAgeSeconds`, 'must be a positive integer of seconds when present');
      }
      maxEvidenceAgeSeconds = object.maxEvidenceAgeSeconds;
    }
    out.push({
      unknownId: object.unknownId,
      targetConfidence: object.targetConfidence,
      maxEvidenceAgeSeconds,
      rationale: requiredText(object.rationale, code, `${field}[].rationale`, MAX_RATIONALE_CHARS),
    });
  }
  const seen = new Set<string>();
  for (const requirement of out) {
    if (seen.has(requirement.unknownId)) {
      badInput(code, field, `tracks unknown '${requirement.unknownId}' more than once`);
    }
    seen.add(requirement.unknownId);
  }
  return out;
}

function validatePreferredSources(
  input: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
): PreferredSource[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) badInput(code, field, 'must be an array when present');
  if (input.length > MAX_PREFERRED_SOURCES) {
    badInput(code, field, `must hold at most ${MAX_PREFERRED_SOURCES} sources (got ${input.length})`);
  }
  const out: PreferredSource[] = [];
  for (const item of input) {
    const object = requirePlainObject(item, code, `${field}[]`);
    if (!isPreferredSourceRegistry(object.registry)) {
      badInput(
        code,
        `${field}[].registry`,
        `must be one of ${COVERAGE_SOURCE_REGISTRIES.join(', ')} (got '${String(object.registry)}')`,
      );
    }
    if (typeof object.ref !== 'string' || object.ref.trim() === '' || object.ref.trim().length > MAX_REF_CHARS) {
      badInput(code, `${field}[].ref`, `must be a non-empty ref of at most ${MAX_REF_CHARS} characters`);
    }
    out.push({
      registry: object.registry,
      ref: object.ref.trim(),
      rationale: requiredText(object.rationale, code, `${field}[].rationale`, MAX_RATIONALE_CHARS),
    });
  }
  return out;
}

function validateCostCeilings(
  input: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
): CostCeiling[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) badInput(code, field, 'must be an array when present');
  if (input.length > MAX_COST_CEILINGS) {
    badInput(code, field, `must hold at most ${MAX_COST_CEILINGS} ceilings (got ${input.length})`);
  }
  const out: CostCeiling[] = [];
  for (const item of input) {
    const object = requirePlainObject(item, code, `${field}[]`);
    if (!isCostCeilingScope(object.scope)) {
      badInput(
        code,
        `${field}[].scope`,
        `must be one of ${COST_CEILING_SCOPES.join(', ')} (got '${String(object.scope)}')`,
      );
    }
    if (
      typeof object.amount !== 'number' ||
      !Number.isInteger(object.amount) ||
      object.amount < 1 ||
      object.amount > MAX_AMOUNT
    ) {
      badInput(code, `${field}[].amount`, `must be an integer between 1 and ${MAX_AMOUNT} minor units`);
    }
    if (typeof object.currency !== 'string' || !CURRENCY_PATTERN.test(object.currency)) {
      badInput(code, `${field}[].currency`, 'must be a 3-letter ISO 4217 code');
    }
    out.push({ scope: object.scope, amount: object.amount, currency: object.currency });
  }
  const seen = new Set<string>();
  for (const ceiling of out) {
    const key = `${ceiling.scope}:${ceiling.currency}`;
    if (seen.has(key)) {
      badInput(code, field, `has more than one '${ceiling.scope}' ceiling in ${ceiling.currency}`);
    }
    seen.add(key);
  }
  return out;
}

function validateEscalationThresholds(
  input: unknown,
  code: 'invalid_strategy_input' | 'invalid_adjustment_input',
  field: string,
): EscalationThreshold[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) badInput(code, field, 'must be an array when present');
  if (input.length > MAX_ESCALATION_THRESHOLDS) {
    badInput(code, field, `must hold at most ${MAX_ESCALATION_THRESHOLDS} thresholds (got ${input.length})`);
  }
  const out: EscalationThreshold[] = [];
  for (const item of input) {
    const object = requirePlainObject(item, code, `${field}[]`);
    if (!isEscalationTrigger(object.trigger)) {
      badInput(
        code,
        `${field}[].trigger`,
        `must be one of ${ESCALATION_TRIGGERS.join(', ')} (got '${String(object.trigger)}')`,
      );
    }
    let afterAttempts: number | null = null;
    if (object.afterAttempts !== undefined && object.afterAttempts !== null) {
      if (
        typeof object.afterAttempts !== 'number' ||
        !Number.isInteger(object.afterAttempts) ||
        object.afterAttempts < 1 ||
        object.afterAttempts > MAX_ATTEMPTS
      ) {
        badInput(code, `${field}[].afterAttempts`, `must be an integer between 1 and ${MAX_ATTEMPTS} when present`);
      }
      afterAttempts = object.afterAttempts;
    }
    if (object.trigger === 'failed-attempts' && afterAttempts === null) {
      badInput(code, `${field}[].afterAttempts`, "is required when trigger is 'failed-attempts'");
    }
    if (object.trigger !== 'failed-attempts' && afterAttempts !== null) {
      badInput(code, `${field}[].afterAttempts`, `only applies to the 'failed-attempts' trigger`);
    }
    out.push({
      trigger: object.trigger,
      afterAttempts,
      note: optionalText(object.note, code, `${field}[].note`, MAX_RATIONALE_CHARS),
    });
  }
  const seen = new Set<string>();
  for (const threshold of out) {
    if (seen.has(threshold.trigger)) {
      badInput(code, field, `has more than one '${threshold.trigger}' threshold`);
    }
    seen.add(threshold.trigger);
  }
  return out;
}

function validateOutcomeEvidence(input: unknown): OutcomeEvidence[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new InfoStrategyError('invalid_adjustment_input', 'outcomeEvidence must be an array when present');
  }
  if (input.length > MAX_OUTCOME_EVIDENCE) {
    throw new InfoStrategyError(
      'invalid_adjustment_input',
      `outcomeEvidence must hold at most ${MAX_OUTCOME_EVIDENCE} entries (got ${input.length})`,
    );
  }
  const out: OutcomeEvidence[] = [];
  for (const item of input) {
    const object = requirePlainObject(item, 'invalid_adjustment_input', 'outcomeEvidence[]');
    if (!isOutcomeEvidenceKind(object.kind)) {
      throw new InfoStrategyError(
        'invalid_adjustment_input',
        `outcomeEvidence[].kind must be one of ${OUTCOME_EVIDENCE_KINDS.join(', ')} (got '${String(object.kind)}')`,
      );
    }
    if (typeof object.ref !== 'string' || object.ref.trim() === '' || object.ref.trim().length > MAX_REF_CHARS) {
      throw new InfoStrategyError(
        'invalid_adjustment_input',
        `outcomeEvidence[].ref must be a non-empty ref of at most ${MAX_REF_CHARS} characters`,
      );
    }
    out.push({
      kind: object.kind,
      ref: object.ref.trim(),
      observed: requiredText(object.observed, 'invalid_adjustment_input', 'outcomeEvidence[].observed', MAX_OBSERVED_CHARS),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operation inputs
// ---------------------------------------------------------------------------

export interface ValidatedStrategyContent {
  knowledgeRequirements: KnowledgeRequirement[];
  preferredSources: PreferredSource[];
  costCeilings: CostCeiling[];
  escalationThresholds: EscalationThreshold[];
}

/**
 * The VALIDATED patch shape: every present field holds the normalized
 * (stored-shape) arrays the content validators produce — `maxEvidenceAgeSeconds`
 * and `afterAttempts` are already resolved to `number | null`, never left
 * optional. (The INPUT-facing `StrategyContentPatch` keeps its optional
 * input shapes; this is what the service merges.)
 */
export interface ValidatedStrategyContentPatch {
  knowledgeRequirements?: KnowledgeRequirement[];
  preferredSources?: PreferredSource[];
  costCeilings?: CostCeiling[];
  escalationThresholds?: EscalationThreshold[];
}

export interface ValidatedDefineStrategyInput {
  goalId: string;
  fingerprintId: string;
  content: ValidatedStrategyContent;
  note: string | null;
  derivedFrom: string[];
}

export function validateDefineStrategyInput(input: unknown): ValidatedDefineStrategyInput {
  const code = 'invalid_strategy_input' as const;
  const object = requirePlainObject(input, code, 'input');
  if (!isUuid(object.goalId)) {
    badInput(code, 'goalId', 'must be a uuid (the goals-module record this strategy serves)');
  }
  if (!isUuid(object.fingerprintId)) {
    badInput(code, 'fingerprintId', 'must be a uuid (the context fingerprint conditioning this strategy)');
  }
  const contentObject = requirePlainObject(object.content, code, 'content');
  return {
    goalId: object.goalId,
    fingerprintId: object.fingerprintId,
    content: {
      knowledgeRequirements: validateRequirements(
        contentObject.knowledgeRequirements,
        code,
        'content.knowledgeRequirements',
        { requireAtLeastOne: true },
      ),
      preferredSources: validatePreferredSources(contentObject.preferredSources, code, 'content.preferredSources'),
      costCeilings: validateCostCeilings(contentObject.costCeilings, code, 'content.costCeilings'),
      escalationThresholds: validateEscalationThresholds(
        contentObject.escalationThresholds,
        code,
        'content.escalationThresholds',
      ),
    },
    note: optionalText(object.note, code, 'note', MAX_NOTE_CHARS),
    derivedFrom: evidenceRefs(object.derivedFrom, code),
  };
}

export interface ValidatedAdjustStrategyInput {
  strategyId: string;
  changes: ValidatedStrategyContentPatch | null;
  outcomeEvidence: OutcomeEvidence[];
  note: string;
  derivedFrom: string[];
}

export function validateAdjustStrategyInput(input: unknown): ValidatedAdjustStrategyInput {
  const code = 'invalid_adjustment_input' as const;
  const object = requirePlainObject(input, code, 'input');
  if (!isUuid(object.strategyId)) {
    badInput(code, 'strategyId', 'must be a uuid');
  }
  let changes: ValidatedStrategyContentPatch | null = null;
  if (object.changes !== undefined && object.changes !== null) {
    const patchObject = requirePlainObject(object.changes, code, 'changes');
    const keys = ['knowledgeRequirements', 'preferredSources', 'costCeilings', 'escalationThresholds'] as const;
    const present = keys.filter((key) => patchObject[key] !== undefined && patchObject[key] !== null);
    if (present.length > 0) {
      changes = {
        knowledgeRequirements:
          patchObject.knowledgeRequirements === undefined || patchObject.knowledgeRequirements === null
            ? undefined
            : validateRequirements(
                patchObject.knowledgeRequirements,
                code,
                'changes.knowledgeRequirements',
                { requireAtLeastOne: false },
              ),
        preferredSources:
          patchObject.preferredSources === undefined || patchObject.preferredSources === null
            ? undefined
            : validatePreferredSources(patchObject.preferredSources, code, 'changes.preferredSources'),
        costCeilings:
          patchObject.costCeilings === undefined || patchObject.costCeilings === null
            ? undefined
            : validateCostCeilings(patchObject.costCeilings, code, 'changes.costCeilings'),
        escalationThresholds:
          patchObject.escalationThresholds === undefined || patchObject.escalationThresholds === null
            ? undefined
            : validateEscalationThresholds(
                patchObject.escalationThresholds,
                code,
                'changes.escalationThresholds',
              ),
      };
    }
  }
  const outcomeEvidence = validateOutcomeEvidence(object.outcomeEvidence);
  if (changes === null && outcomeEvidence.length === 0) {
    badInput(
      code,
      'input',
      'must record changes and/or outcomeEvidence — a version that records nothing is not an adjustment',
    );
  }
  return {
    strategyId: object.strategyId,
    changes,
    outcomeEvidence,
    note: requiredText(object.note, code, 'note', MAX_NOTE_CHARS),
    derivedFrom: evidenceRefs(object.derivedFrom, code),
  };
}

export interface ValidatedRetireStrategyInput {
  strategyId: string;
  reason: string;
}

export function validateRetireStrategyInput(input: unknown): ValidatedRetireStrategyInput {
  const code = 'invalid_strategy_input' as const;
  const object = requirePlainObject(input, code, 'input');
  if (!isUuid(object.strategyId)) {
    badInput(code, 'strategyId', 'must be a uuid');
  }
  return {
    strategyId: object.strategyId,
    reason: requiredText(object.reason, code, 'reason', MAX_NOTE_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

export interface ValidatedGetStrategyQuery {
  strategyId: string;
}

export function validateGetStrategyQuery(query: GetStrategyQuery): ValidatedGetStrategyQuery {
  if (typeof query !== 'object' || query === null) {
    throw new InfoStrategyError('invalid_query', 'query must be an object');
  }
  if (!isUuid(query.strategyId)) {
    throw new InfoStrategyError('invalid_query', 'query.strategyId must be a uuid');
  }
  return { strategyId: query.strategyId };
}

export interface ValidatedGetStrategyVersionQuery {
  strategyId: string;
  version: number;
}

export function validateGetStrategyVersionQuery(query: GetStrategyVersionQuery): ValidatedGetStrategyVersionQuery {
  if (typeof query !== 'object' || query === null) {
    throw new InfoStrategyError('invalid_query', 'query must be an object');
  }
  if (!isUuid(query.strategyId)) {
    throw new InfoStrategyError('invalid_query', 'query.strategyId must be a uuid');
  }
  if (typeof query.version !== 'number' || !Number.isInteger(query.version) || query.version < 1) {
    throw new InfoStrategyError('invalid_query', 'query.version must be a positive integer (1-based)');
  }
  return { strategyId: query.strategyId, version: query.version };
}

export interface ValidatedListStrategyVersionsQuery {
  strategyId: string;
}

export function validateListStrategyVersionsQuery(
  query: ListStrategyVersionsQuery,
): ValidatedListStrategyVersionsQuery {
  if (typeof query !== 'object' || query === null) {
    throw new InfoStrategyError('invalid_query', 'query must be an object');
  }
  if (!isUuid(query.strategyId)) {
    throw new InfoStrategyError('invalid_query', 'query.strategyId must be a uuid');
  }
  return { strategyId: query.strategyId };
}

export interface ValidatedListStrategiesQuery {
  goalId: string | null;
  fingerprintId: string | null;
  status: 'active' | 'retired' | null;
  limit: number;
}

export function validateListStrategiesQuery(
  query?: ListStrategiesQuery,
): ValidatedListStrategiesQuery {
  if (query === undefined || query === null) {
    return { goalId: null, fingerprintId: null, status: null, limit: DEFAULT_LIST_LIMIT };
  }
  if (typeof query !== 'object') {
    throw new InfoStrategyError('invalid_query', 'query must be an object when present');
  }
  const optionalUuid = (value: unknown, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (!isUuid(value)) {
      throw new InfoStrategyError('invalid_query', `${field} must be a uuid when present`);
    }
    return value;
  };
  let status: 'active' | 'retired' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (query.status !== 'active' && query.status !== 'retired') {
      throw new InfoStrategyError('invalid_query', "query.status must be 'active' or 'retired' when present");
    }
    status = query.status;
  }
  let limit = DEFAULT_LIST_LIMIT;
  if (query.limit !== undefined && query.limit !== null) {
    if (typeof query.limit !== 'number' || !Number.isInteger(query.limit)) {
      throw new InfoStrategyError('invalid_query', 'query.limit must be an integer when present');
    }
    if (query.limit < 1 || query.limit > MAX_LIST_LIMIT) {
      throw new InfoStrategyError(
        'invalid_query',
        `query.limit must be between 1 and ${MAX_LIST_LIMIT} (got ${query.limit})`,
      );
    }
    limit = query.limit;
  }
  return {
    goalId: optionalUuid(query.goalId, 'query.goalId'),
    fingerprintId: optionalUuid(query.fingerprintId, 'query.fingerprintId'),
    status,
    limit,
  };
}
