// Pure validation/normalization logic of the automation module (no
// database). Everything a caller may put into a registration, revision,
// measurement or query crosses these guards first; the SQL CHECK
// constraints in migrations/001-automation-opportunities.sql mirror the
// load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `changeKind`, `status` of the *identity*, commit
// times or acting principals into an input — identity, tenancy, version
// number, change classification and audit fields are minted by the system
// (the goals/processes/capabilities discipline: automation records are
// auditable, and audit fields are not caller-forgeable). The process of a
// candidate is IMMUTABLE identity content — the revise input does not even
// accept a `processId` key, so a candidate about one process can only ever
// become a candidate about another through a new record, never by
// rewriting one. The name is likewise immutable (revise does not accept
// it).
//
// Parties (audit actors, measurement evidence) are opaque provider-neutral
// references (lock 16): free-form ids (uuids where the owning module uses
// them) and/or labels — unvalidated here by design (the
// events/observations precedent; the owning modules stay non-dependencies).
// `processId`, `findingIds` and `capabilityId` are shape-checked uuid
// forward references; their readability is verified by the service through
// the sibling contracts (never their tables).
//
// The revision discipline mirrors the capabilities module: a revision must
// change at least one field, and a status change must be the ONLY change —
// lifecycle transitions are surgical so the audit trail never conflates
// them with content revisions.

import type { TenantContext } from '@/infra/tenant';
import { AutomationError } from './errors';
import type {
  AutomationChangeKind,
  AutomationEvidenceKind,
  AutomationPartyKind,
  AutomationPeriod,
  AutomationSolutionType,
  AutomationStatus,
  GetAutomationMeasurementQuery,
  GetAutomationOpportunityQuery,
  GetAutomationOpportunityVersionQuery,
  ListAutomationMeasurementsQuery,
  ListAutomationOpportunitiesQuery,
  ListAutomationOpportunityVersionsQuery,
  OutcomeDirection,
  OutcomePlan,
  RecordAutomationMeasurementInput,
  RegisterAutomationOpportunityInput,
  ReviseAutomationOpportunityInput,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

/** The eight solution options ARCHITECTURE.md §13 names verbatim. */
export const AUTOMATION_SOLUTION_TYPES = [
  'train_employee',
  'reassign_work',
  'hire_human',
  'recruit_agent',
  'recruit_agent_team',
  'install_extension',
  'build_extension',
  'outsource',
] as const;

/** The periods frequency, cost and expected savings are expressed per. */
export const AUTOMATION_PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const;

export const AUTOMATION_STATUSES = ['candidate', 'accepted', 'dismissed'] as const;

export const AUTOMATION_CHANGE_KINDS = [
  'created',
  'revised',
  'accepted',
  'dismissed',
  'reopened',
] as const;

/** Audit-actor kinds (the events envelope's actor vocabulary minus `source`). */
export const AUTOMATION_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** Measurement-evidence kinds (the canonical evidence surfaces). */
export const AUTOMATION_EVIDENCE_KINDS = [
  'observation',
  'event',
  'document',
  'report',
  'system',
  'metric',
] as const;

export const OUTCOME_DIRECTIONS = ['at_least', 'at_most'] as const;

// ---------------------------------------------------------------------------
// Size caps and bounds
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_NAME_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2000; // description / note / rationale
export const MAX_PARTY_LENGTH = 200; // party / evidence id / label
export const MAX_SEARCH_LENGTH = 200;
export const MAX_METRIC_NAME_LENGTH = 200;
export const MAX_METRIC_UNIT_LENGTH = 100;

/** Process-finding references per candidate (deduplicated). */
export const MAX_FINDING_REFS = 32;
/** Measurement evidence references per measurement (deduplicated). */
export const MAX_EVIDENCE_REFS = 32;

/** Integer minor-unit money bound (10^15 minor units ≈ 10 trillion major units). */
export const MAX_MONEY_MINOR = 1_000_000_000_000_000;

/** Occurrence count per period bound. */
export const MAX_FREQUENCY_COUNT = 1_000_000_000;

/** ROI assessment horizon bound, in periods. */
export const MAX_ROI_HORIZON_PERIODS = 1200;

/** Metric values (baseline, target, observed) bound — Number.MAX_SAFE_INTEGER. */
export const MAX_METRIC_VALUE = 9_007_199_254_740_991;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isAutomationSolutionType(value: unknown): value is AutomationSolutionType {
  return (
    typeof value === 'string' &&
    (AUTOMATION_SOLUTION_TYPES as readonly string[]).includes(value)
  );
}

export function isAutomationPeriod(value: unknown): value is AutomationPeriod {
  return (
    typeof value === 'string' && (AUTOMATION_PERIODS as readonly string[]).includes(value)
  );
}

export function isAutomationStatus(value: unknown): value is AutomationStatus {
  return (
    typeof value === 'string' && (AUTOMATION_STATUSES as readonly string[]).includes(value)
  );
}

export function isAutomationChangeKind(value: unknown): value is AutomationChangeKind {
  return (
    typeof value === 'string' && (AUTOMATION_CHANGE_KINDS as readonly string[]).includes(value)
  );
}

export function isAutomationPartyKind(value: unknown): value is AutomationPartyKind {
  return (
    typeof value === 'string' &&
    (AUTOMATION_PARTY_KINDS as readonly string[]).includes(value)
  );
}

export function isAutomationEvidenceKind(value: unknown): value is AutomationEvidenceKind {
  return (
    typeof value === 'string' &&
    (AUTOMATION_EVIDENCE_KINDS as readonly string[]).includes(value)
  );
}

export function isOutcomeDirection(value: unknown): value is OutcomeDirection {
  return (
    typeof value === 'string' && (OUTCOME_DIRECTIONS as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAutomationTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AutomationError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AutomationError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new AutomationError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

type InputCode = 'invalid_registration' | 'invalid_revision' | 'invalid_measurement';

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  code: InputCode | 'invalid_query',
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new AutomationError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(code: InputCode, message: string): AutomationError {
  return new AutomationError(code, message);
}

function queryError(message: string): AutomationError {
  return new AutomationError('invalid_query', message);
}

function requireString(value: unknown, field: string, code: InputCode): string {
  if (typeof value !== 'string') throw inputError(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(code, `${field} must be a non-empty string`);
  return text;
}

/** Nullable text: undefined/null → null; else trimmed non-empty ≤ max chars. */
function optionalText(value: unknown, field: string, max: number, code: InputCode): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, code);
  if (text.length > max) {
    throw inputError(code, `${field} must be at most ${max} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string, code: InputCode): string {
  const text = requireString(value, field, code);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(code, `${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** Integer minor-unit money: finite integer in [0, MAX_MONEY_MINOR]. */
function requireMoney(value: unknown, field: string, code: InputCode): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_MONEY_MINOR
  ) {
    throw inputError(
      code,
      `${field} must be an integer amount of minor units in [0, ${MAX_MONEY_MINOR}] (got ${String(value)})`,
    );
  }
  return value;
}

/** Metric value: finite number within ±MAX_METRIC_VALUE. */
function requireMetricValue(value: unknown, field: string, code: InputCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_METRIC_VALUE) {
    throw inputError(
      code,
      `${field} must be a finite number within ±${MAX_METRIC_VALUE} (got ${String(value)})`,
    );
  }
  return value;
}

/** Case-insensitive ILIKE wildcard escaping (the missions module's helper). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Parties and evidence refs
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of a party (kind + id/label, ≥ one present). */
export interface ValidatedParty {
  kind: string;
  id: string | null;
  label: string | null;
}

const PARTY_KEYS = ['kind', 'id', 'label'] as const;

function validateParty(value: unknown, where: string, code: InputCode): ValidatedParty {
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, PARTY_KEYS, where, code);
  const kind = value.kind;
  if (!isAutomationPartyKind(kind)) {
    throw inputError(
      code,
      `${where}.kind must be one of ${AUTOMATION_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = optionalText(value.id, `${where}.id`, MAX_PARTY_LENGTH, code);
  const label = optionalText(value.label, `${where}.label`, MAX_PARTY_LENGTH, code);
  if (id === null && label === null) {
    throw inputError(
      code,
      `${where} must carry an id or a label — audit actors are traceable`,
    );
  }
  return { kind, id, label };
}

/** Fully validated + normalized form of a measurement evidence reference. */
export interface ValidatedEvidenceRef {
  kind: AutomationEvidenceKind;
  id: string | null;
  label: string | null;
}

function validateEvidenceRef(value: unknown, index: number, code: InputCode): ValidatedEvidenceRef {
  const where = `evidence[${index}]`;
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, PARTY_KEYS, where, code);
  const kind = value.kind;
  if (!isAutomationEvidenceKind(kind)) {
    throw inputError(
      code,
      `${where}.kind must be one of ${AUTOMATION_EVIDENCE_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = optionalText(value.id, `${where}.id`, MAX_PARTY_LENGTH, code);
  const label = optionalText(value.label, `${where}.label`, MAX_PARTY_LENGTH, code);
  if (id === null && label === null) {
    throw inputError(
      code,
      `${where} must carry an id or a label — measurement evidence is traceable`,
    );
  }
  return { kind, id, label };
}

/** Measurement evidence references: ≤ MAX_EVIDENCE_REFS, deduplicated in order. */
function requireEvidenceRefs(value: unknown, field: string, code: InputCode): ValidatedEvidenceRef[] {
  if (!Array.isArray(value)) {
    throw inputError(code, `${field} must be an array of evidence references`);
  }
  if (value.length > MAX_EVIDENCE_REFS) {
    throw inputError(
      code,
      `${field} supports at most ${MAX_EVIDENCE_REFS} references (got ${value.length})`,
    );
  }
  const out: ValidatedEvidenceRef[] = [];
  for (const [index, entry] of value.entries()) {
    const ref = validateEvidenceRef(entry, index, code);
    const key = `${ref.kind}:${ref.id ?? ref.label}`;
    if (!out.some((seen) => `${seen.kind}:${seen.id ?? seen.label}` === key)) out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared content fields (registration and revision)
// ---------------------------------------------------------------------------

/** Process-finding references: uuids, 1..MAX_FINDING_REFS, deduplicated in order. */
function requireFindingIds(value: unknown, field: string, code: InputCode): string[] {
  if (!Array.isArray(value)) {
    throw inputError(code, `${field} must be an array of process-finding uuids`);
  }
  if (value.length < 1) {
    throw inputError(
      code,
      `${field} must cite at least one process finding — an automation candidate is evidence-backed (lock 19)`,
    );
  }
  if (value.length > MAX_FINDING_REFS) {
    throw inputError(
      code,
      `${field} supports at most ${MAX_FINDING_REFS} references (got ${value.length})`,
    );
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const id = requireUuid(entry, `${field}[${index}]`, code);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Solution types: 1..8, deduplicated, canonical storage order. */
function requireSolutionTypes(value: unknown, field: string, code: InputCode): AutomationSolutionType[] {
  if (!Array.isArray(value)) {
    throw inputError(code, `${field} must be an array of solution types`);
  }
  if (value.length < 1) {
    throw inputError(
      code,
      `${field} must name at least one candidate solution type (allowed: ${AUTOMATION_SOLUTION_TYPES.join(', ')})`,
    );
  }
  const out: AutomationSolutionType[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isAutomationSolutionType(entry)) {
      throw inputError(
        code,
        `${field}[${index}] must be one of ${AUTOMATION_SOLUTION_TYPES.join(', ')} (got '${String(entry)}')`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return [...out].sort(
    (a, b) =>
      (AUTOMATION_SOLUTION_TYPES as readonly string[]).indexOf(a) -
      (AUTOMATION_SOLUTION_TYPES as readonly string[]).indexOf(b),
  );
}

/** Frequency count: integer in [1, MAX_FREQUENCY_COUNT]. */
function requireFrequencyCount(value: unknown, field: string, code: InputCode): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_FREQUENCY_COUNT
  ) {
    throw inputError(
      code,
      `${field} must be an integer in [1, ${MAX_FREQUENCY_COUNT}] (got ${String(value)})`,
    );
  }
  return value;
}

/** Error rate: finite number in [0, 1]. */
function requireErrorRate(value: unknown, field: string, code: InputCode): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw inputError(
      code,
      `${field} must be a finite number in [0, 1] (got ${String(value)})`,
    );
  }
  return value;
}

/** ISO 4217 currency code (three uppercase letters). */
function requireCurrency(value: unknown, field: string, code: InputCode): string {
  const text = requireString(value, field, code);
  if (!CURRENCY_PATTERN.test(text)) {
    throw inputError(
      code,
      `${field} must be a three-letter ISO 4217 currency code (got '${text}')`,
    );
  }
  return text;
}

/** ROI horizon: integer in [1, MAX_ROI_HORIZON_PERIODS]. */
function requireHorizon(value: unknown, field: string, code: InputCode): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_ROI_HORIZON_PERIODS
  ) {
    throw inputError(
      code,
      `${field} must be an integer in [1, ${MAX_ROI_HORIZON_PERIODS}] (got ${String(value)})`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The outcome measurement plan
// ---------------------------------------------------------------------------

const OUTCOME_PLAN_KEYS = [
  'metricName',
  'metricUnit',
  'direction',
  'baseline',
  'target',
] as const;

/** Fully validated + normalized form of `OutcomePlanInput`. */
export type ValidatedOutcomePlan = OutcomePlan;

function validateOutcomePlan(value: unknown, where: string, code: InputCode): ValidatedOutcomePlan {
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, OUTCOME_PLAN_KEYS, where, code);
  const metricName = requireString(value.metricName, `${where}.metricName`, code);
  if (metricName.length > MAX_METRIC_NAME_LENGTH) {
    throw inputError(
      code,
      `${where}.metricName must be at most ${MAX_METRIC_NAME_LENGTH} characters (got ${metricName.length})`,
    );
  }
  const metricUnit = requireString(value.metricUnit, `${where}.metricUnit`, code);
  if (metricUnit.length > MAX_METRIC_UNIT_LENGTH) {
    throw inputError(
      code,
      `${where}.metricUnit must be at most ${MAX_METRIC_UNIT_LENGTH} characters (got ${metricUnit.length})`,
    );
  }
  const direction = value.direction;
  if (!isOutcomeDirection(direction)) {
    throw inputError(
      code,
      `${where}.direction must be one of ${OUTCOME_DIRECTIONS.join(', ')} (got '${String(direction)}')`,
    );
  }
  return {
    metricName,
    metricUnit,
    direction,
    baseline: requireMetricValue(value.baseline, `${where}.baseline`, code),
    target: requireMetricValue(value.target, `${where}.target`, code),
  };
}

/**
 * The validated patch of a measurement plan (undefined = carry over). Used
 * by the service to merge into the current plan.
 */
export type ValidatedOutcomePlanPatch = Partial<OutcomePlan>;

function validateOutcomePlanPatch(value: unknown, code: InputCode): ValidatedOutcomePlanPatch {
  if (!isPlainObject(value)) throw inputError(code, 'outcome must be an object');
  rejectUnknownKeys(value, OUTCOME_PLAN_KEYS, 'outcome', code);
  const patch: ValidatedOutcomePlanPatch = {};
  if (value.metricName !== undefined) {
    const metricName = requireString(value.metricName, 'outcome.metricName', code);
    if (metricName.length > MAX_METRIC_NAME_LENGTH) {
      throw inputError(
        code,
        `outcome.metricName must be at most ${MAX_METRIC_NAME_LENGTH} characters (got ${metricName.length})`,
      );
    }
    patch.metricName = metricName;
  }
  if (value.metricUnit !== undefined) {
    const metricUnit = requireString(value.metricUnit, 'outcome.metricUnit', code);
    if (metricUnit.length > MAX_METRIC_UNIT_LENGTH) {
      throw inputError(
        code,
        `outcome.metricUnit must be at most ${MAX_METRIC_UNIT_LENGTH} characters (got ${metricUnit.length})`,
      );
    }
    patch.metricUnit = metricUnit;
  }
  if (value.direction !== undefined) {
    if (!isOutcomeDirection(value.direction)) {
      throw inputError(
        code,
        `outcome.direction must be one of ${OUTCOME_DIRECTIONS.join(', ')} (got '${String(value.direction)}')`,
      );
    }
    patch.direction = value.direction;
  }
  if (value.baseline !== undefined) {
    patch.baseline = requireMetricValue(value.baseline, 'outcome.baseline', code);
  }
  if (value.target !== undefined) {
    patch.target = requireMetricValue(value.target, 'outcome.target', code);
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

const REGISTER_KEYS = [
  'name',
  'processId',
  'findingIds',
  'capabilityId',
  'description',
  'frequencyCount',
  'period',
  'currency',
  'currentCostMinor',
  'errorRate',
  'solutionTypes',
  'expectedSavingsMinor',
  'expectedInvestmentMinor',
  'roiHorizonPeriods',
  'outcome',
  'actor',
  'rationale',
] as const;

/** Fully validated + normalized form of `RegisterAutomationOpportunityInput`. */
export interface ValidatedRegisterInput {
  name: string;
  processId: string;
  findingIds: string[];
  /** Tri-state resolved: null = no capability named. */
  capabilityId: string | null;
  description: string | null;
  frequencyCount: number;
  period: AutomationPeriod;
  currency: string;
  currentCostMinor: number;
  errorRate: number;
  solutionTypes: AutomationSolutionType[];
  expectedSavingsMinor: number;
  expectedInvestmentMinor: number;
  roiHorizonPeriods: number;
  outcome: ValidatedOutcomePlan;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRegisterInput(
  input: RegisterAutomationOpportunityInput,
): ValidatedRegisterInput {
  const code = 'invalid_registration' as const;
  if (!isPlainObject(input)) {
    throw inputError(code, 'automation registration must be an object');
  }
  rejectUnknownKeys(input, REGISTER_KEYS, 'the automation registration', code);

  const name = requireString(input.name, 'name', code);
  if (name.length > MAX_NAME_LENGTH) {
    throw inputError(code, `name must be at most ${MAX_NAME_LENGTH} characters (got ${name.length})`);
  }
  const processId = requireUuid(input.processId, 'processId', code);
  const findingIds = requireFindingIds(input.findingIds, 'findingIds', code);
  const capabilityId =
    input.capabilityId === undefined || input.capabilityId === null
      ? null
      : requireUuid(input.capabilityId, 'capabilityId', code);
  if (!isAutomationPeriod(input.period)) {
    throw inputError(
      code,
      `period must be one of ${AUTOMATION_PERIODS.join(', ')} (got '${String(input.period)}')`,
    );
  }

  return {
    name,
    processId,
    findingIds,
    capabilityId,
    description: optionalText(input.description, 'description', MAX_TEXT_LENGTH, code),
    frequencyCount: requireFrequencyCount(input.frequencyCount, 'frequencyCount', code),
    period: input.period,
    currency: requireCurrency(input.currency, 'currency', code),
    currentCostMinor: requireMoney(input.currentCostMinor, 'currentCostMinor', code),
    errorRate: requireErrorRate(input.errorRate, 'errorRate', code),
    solutionTypes: requireSolutionTypes(input.solutionTypes, 'solutionTypes', code),
    expectedSavingsMinor: requireMoney(input.expectedSavingsMinor, 'expectedSavingsMinor', code),
    expectedInvestmentMinor: requireMoney(input.expectedInvestmentMinor, 'expectedInvestmentMinor', code),
    roiHorizonPeriods: requireHorizon(input.roiHorizonPeriods, 'roiHorizonPeriods', code),
    outcome: validateOutcomePlan(input.outcome, 'outcome', code),
    actor: validateParty(input.actor, 'actor', code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

// ---------------------------------------------------------------------------
// Revision
// ---------------------------------------------------------------------------

const REVISE_KEYS = [
  'opportunityId',
  'capabilityId',
  'description',
  'findingIds',
  'frequencyCount',
  'period',
  'currency',
  'currentCostMinor',
  'errorRate',
  'solutionTypes',
  'expectedSavingsMinor',
  'expectedInvestmentMinor',
  'roiHorizonPeriods',
  'outcome',
  'status',
  'expectedVersion',
  'actor',
  'rationale',
] as const;

/** The validated patch fields of a revision (undefined = carry over). */
export interface ValidatedRevisionPatch {
  /** Tri-state: undefined = unchanged, null = cleared, uuid = set. */
  capabilityId?: string | null;
  description?: string | null;
  findingIds?: string[];
  frequencyCount?: number;
  period?: AutomationPeriod;
  currency?: string;
  currentCostMinor?: number;
  errorRate?: number;
  solutionTypes?: AutomationSolutionType[];
  expectedSavingsMinor?: number;
  expectedInvestmentMinor?: number;
  roiHorizonPeriods?: number;
  outcome?: ValidatedOutcomePlanPatch;
  status?: AutomationStatus;
}

/** Fully validated + normalized form of `ReviseAutomationOpportunityInput`. */
export interface ValidatedReviseInput {
  opportunityId: string;
  patch: ValidatedRevisionPatch;
  /** Which fields the patch touches (for the surgical assertion). */
  changed: string[];
  expectedVersion: number | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseInput(input: ReviseAutomationOpportunityInput): ValidatedReviseInput {
  const code = 'invalid_revision' as const;
  if (!isPlainObject(input)) throw inputError(code, 'automation revision must be an object');
  rejectUnknownKeys(input, REVISE_KEYS, 'the automation revision', code);

  const opportunityId = requireUuid(input.opportunityId, 'opportunityId', code);
  const patch: ValidatedRevisionPatch = {};
  const changed: string[] = [];

  if (input.capabilityId !== undefined) {
    patch.capabilityId =
      input.capabilityId === null ? null : requireUuid(input.capabilityId, 'capabilityId', code);
    changed.push('capabilityId');
  }
  if (input.description !== undefined) {
    patch.description = optionalText(input.description, 'description', MAX_TEXT_LENGTH, code);
    changed.push('description');
  }
  if (input.findingIds !== undefined) {
    patch.findingIds = requireFindingIds(input.findingIds, 'findingIds', code);
    changed.push('findingIds');
  }
  if (input.frequencyCount !== undefined) {
    patch.frequencyCount = requireFrequencyCount(input.frequencyCount, 'frequencyCount', code);
    changed.push('frequencyCount');
  }
  if (input.period !== undefined) {
    if (!isAutomationPeriod(input.period)) {
      throw inputError(
        code,
        `period must be one of ${AUTOMATION_PERIODS.join(', ')} (got '${String(input.period)}')`,
      );
    }
    patch.period = input.period;
    changed.push('period');
  }
  if (input.currency !== undefined) {
    patch.currency = requireCurrency(input.currency, 'currency', code);
    changed.push('currency');
  }
  if (input.currentCostMinor !== undefined) {
    patch.currentCostMinor = requireMoney(input.currentCostMinor, 'currentCostMinor', code);
    changed.push('currentCostMinor');
  }
  if (input.errorRate !== undefined) {
    patch.errorRate = requireErrorRate(input.errorRate, 'errorRate', code);
    changed.push('errorRate');
  }
  if (input.solutionTypes !== undefined) {
    patch.solutionTypes = requireSolutionTypes(input.solutionTypes, 'solutionTypes', code);
    changed.push('solutionTypes');
  }
  if (input.expectedSavingsMinor !== undefined) {
    patch.expectedSavingsMinor = requireMoney(input.expectedSavingsMinor, 'expectedSavingsMinor', code);
    changed.push('expectedSavingsMinor');
  }
  if (input.expectedInvestmentMinor !== undefined) {
    patch.expectedInvestmentMinor = requireMoney(input.expectedInvestmentMinor, 'expectedInvestmentMinor', code);
    changed.push('expectedInvestmentMinor');
  }
  if (input.roiHorizonPeriods !== undefined) {
    patch.roiHorizonPeriods = requireHorizon(input.roiHorizonPeriods, 'roiHorizonPeriods', code);
    changed.push('roiHorizonPeriods');
  }
  if (input.outcome !== undefined) {
    patch.outcome = validateOutcomePlanPatch(input.outcome, code);
    changed.push('outcome');
  }
  if (input.status !== undefined) {
    if (!isAutomationStatus(input.status)) {
      throw inputError(
        code,
        `status must be one of ${AUTOMATION_STATUSES.join(', ')} (got '${String(input.status)}')`,
      );
    }
    patch.status = input.status;
    changed.push('status');
  }

  // --- the surgical revision discipline (the capabilities module's rule) ---
  if (changed.length === 0) {
    throw inputError(
      code,
      `a revision must change at least one field (content, outcome, or a surgical status transition)`,
    );
  }
  if (patch.status !== undefined && changed.length > 1) {
    throw inputError(
      code,
      `a status change must be the only change in its revision (also changed: ${changed
        .filter((field) => field !== 'status')
        .join(', ')}) — lifecycle transitions are surgical so the audit trail never conflates them with content revisions`,
    );
  }

  let expectedVersion: number | null = null;
  if (input.expectedVersion !== undefined && input.expectedVersion !== null) {
    if (
      typeof input.expectedVersion !== 'number' ||
      !Number.isInteger(input.expectedVersion) ||
      input.expectedVersion < 1
    ) {
      throw inputError(
        code,
        `expectedVersion must be an integer ≥ 1 (got ${String(input.expectedVersion)})`,
      );
    }
    expectedVersion = input.expectedVersion;
  }

  return {
    opportunityId,
    patch,
    changed,
    expectedVersion,
    actor: validateParty(input.actor, 'actor', code),
    rationale: optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code),
  };
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const MEASUREMENT_KEYS = ['opportunityId', 'value', 'note', 'evidence', 'actor'] as const;

/** Fully validated + normalized form of `RecordAutomationMeasurementInput`. */
export interface ValidatedMeasurementInput {
  opportunityId: string;
  value: number;
  note: string | null;
  evidence: ValidatedEvidenceRef[];
  actor: ValidatedParty;
}

export function validateMeasurementInput(
  input: RecordAutomationMeasurementInput,
): ValidatedMeasurementInput {
  const code = 'invalid_measurement' as const;
  if (!isPlainObject(input)) throw inputError(code, 'outcome measurement must be an object');
  rejectUnknownKeys(input, MEASUREMENT_KEYS, 'the outcome measurement', code);

  return {
    opportunityId: requireUuid(input.opportunityId, 'opportunityId', code),
    value: requireMetricValue(input.value, 'value', code),
    note: optionalText(input.note, 'note', MAX_TEXT_LENGTH, code),
    evidence:
      input.evidence === undefined ? [] : requireEvidenceRefs(input.evidence, 'evidence', code),
    actor: validateParty(input.actor, 'actor', code),
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

function requireQueryUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw queryError(`${field} must be a uuid (got '${String(value)}')`);
  }
  return value.toLowerCase();
}

function requireQueryInt(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw queryError(`${field} must be an integer in [${min}, ${max}] (got ${String(value)})`);
  }
  return value;
}

function requireQueryLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIST_LIMIT : value;
  return requireQueryInt(limit, 'query.limit', 1, MAX_LIST_LIMIT);
}

function optionalQueryText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw queryError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw queryError(`${field} must be a non-empty string`);
  if (text.length > max) {
    throw queryError(`${field} must be at most ${max} characters (got ${text.length})`);
  }
  return text;
}

/** Fully validated + normalized form of `GetAutomationOpportunityQuery`. */
export interface ValidatedOpportunityQuery {
  opportunityId: string;
}

export function validateOpportunityQuery(
  query: GetAutomationOpportunityQuery,
): ValidatedOpportunityQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'opportunityId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: opportunityId)`);
  }
  return { opportunityId: requireQueryUuid(query.opportunityId, 'query.opportunityId') };
}

const LIST_QUERY_KEYS = [
  'name',
  'search',
  'status',
  'processId',
  'solutionType',
  'limit',
] as const;

/** Fully validated + normalized form of `ListAutomationOpportunitiesQuery`. */
export interface ValidatedListQuery {
  name: string | null;
  search: string | null;
  status: AutomationStatus | null;
  processId: string | null;
  solutionType: AutomationSolutionType | null;
  limit: number;
}

export function validateListQuery(query: ListAutomationOpportunitiesQuery): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(LIST_QUERY_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(
      `unknown query field '${unknown[0]}' (allowed: ${LIST_QUERY_KEYS.join(', ')})`,
    );
  }

  const name = optionalQueryText(query.name, 'query.name', MAX_NAME_LENGTH);
  const search = optionalQueryText(query.search, 'query.search', MAX_SEARCH_LENGTH);

  let status: AutomationStatus | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isAutomationStatus(query.status)) {
      throw queryError(
        `query.status must be one of ${AUTOMATION_STATUSES.join(', ')} (got '${String(query.status)}')`,
      );
    }
    status = query.status;
  }

  const processId =
    query.processId === undefined || query.processId === null
      ? null
      : requireQueryUuid(query.processId, 'query.processId');

  let solutionType: AutomationSolutionType | null = null;
  if (query.solutionType !== undefined && query.solutionType !== null) {
    if (!isAutomationSolutionType(query.solutionType)) {
      throw queryError(
        `query.solutionType must be one of ${AUTOMATION_SOLUTION_TYPES.join(', ')} (got '${String(query.solutionType)}')`,
      );
    }
    solutionType = query.solutionType;
  }

  return { name, search, status, processId, solutionType, limit: requireQueryLimit(query.limit) };
}

/** Fully validated + normalized form of `GetAutomationOpportunityVersionQuery`. */
export interface ValidatedVersionQuery {
  opportunityId: string;
  version: number;
}

export function validateVersionQuery(
  query: GetAutomationOpportunityVersionQuery,
): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter(
    (key) => !(['opportunityId', 'version'] as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: opportunityId, version)`);
  }
  return {
    opportunityId: requireQueryUuid(query.opportunityId, 'query.opportunityId'),
    version: requireQueryInt(query.version, 'query.version', 1, Number.MAX_SAFE_INTEGER),
  };
}

/** Fully validated + normalized form of `ListAutomationOpportunityVersionsQuery`. */
export interface ValidatedHistoryQuery {
  opportunityId: string;
}

export function validateHistoryQuery(
  query: ListAutomationOpportunityVersionsQuery,
): ValidatedHistoryQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'opportunityId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: opportunityId)`);
  }
  return { opportunityId: requireQueryUuid(query.opportunityId, 'query.opportunityId') };
}

/** Fully validated + normalized form of `ListAutomationMeasurementsQuery`. */
export interface ValidatedMeasurementsQuery {
  opportunityId: string;
}

export function validateMeasurementsQuery(
  query: ListAutomationMeasurementsQuery,
): ValidatedMeasurementsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'opportunityId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: opportunityId)`);
  }
  return { opportunityId: requireQueryUuid(query.opportunityId, 'query.opportunityId') };
}

/** Fully validated + normalized form of `GetAutomationMeasurementQuery`. */
export interface ValidatedMeasurementQuery {
  measurementId: string;
}

export function validateMeasurementQuery(
  query: GetAutomationMeasurementQuery,
): ValidatedMeasurementQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  const unknown = Object.keys(query).filter((key) => key !== 'measurementId');
  if (unknown.length > 0) {
    throw queryError(`unknown query field '${unknown[0]}' (allowed: measurementId)`);
  }
  return { measurementId: requireQueryUuid(query.measurementId, 'query.measurementId') };
}
