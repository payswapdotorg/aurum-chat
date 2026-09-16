// Pure validation/normalization logic of the attention module (no
// database). Everything a caller may put into a discovery run crosses
// these guards first; the SQL CHECK constraints in
// migrations/001-goal-gap-discovery.sql mirror the load-bearing rules as
// defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `counts`, `disposition`, `epistemicsUnknownId`, `missionId`,
// `coveredByMissionId` or `recordedAt` into an input — the run's
// identity, tenancy, derived counts, the application's promotion decision
// and commit times are minted by the system (discovery decisions are
// auditable, and audit fields are not caller-forgeable). The application
// decides (ADR-0017); the caller proposes inputs.
//
// Every shared primitive takes the error factory of its calling context,
// so a bad field reports the operation's own error code (invalid_run_input
// on run fields, invalid_reading on readings, invalid_proposal on
// proposals, invalid_query on reads — the missions/learning discipline).
//
// Score-like numbers (impact, information value, confidences, thresholds)
// are unit intervals; budgets follow IMPLEMENTATION-STACK §8 (integer
// minor units + ISO 4217-shaped currency); the confidence-gap rule
// (required > current) mirrors the missions module's target/current rule
// so a promoted candidate is always a representable mission.

import type { TenantContext } from '@/infra/tenant';
import { MISSION_CANDIDATE_KINDS } from '@/modules/missions/contract';
import { AttentionError } from './errors';
import type {
  AcquisitionPath,
  CandidateUrgency,
  DiscoveryPartyKind,
  DiscoveryTriggerKind,
  MaterialityPolicy,
} from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const DISCOVERY_TRIGGER_KINDS = ['cognitive-execution', 'scheduled', 'manual'] as const;

export const CANDIDATE_SOURCES = ['derived', 'proposed'] as const;

export const GAP_KINDS = ['driver', 'reading', 'standing', 'custom'] as const;

export const CANDIDATE_DISPOSITIONS = ['promoted', 'dismissed', 'already_covered'] as const;

export const CANDIDATE_URGENCIES = ['critical', 'high', 'medium', 'low'] as const;

export const DISCOVERY_PARTY_KINDS = ['person', 'team', 'agent', 'system', 'external'] as const;

/** The §7 acquisition-menu kinds (the missions module's candidate vocabulary). */
export const ACQUISITION_PATH_KINDS = MISSION_CANDIDATE_KINDS;

// ---------------------------------------------------------------------------
// Size caps and defaults
// ---------------------------------------------------------------------------

export const DEFAULT_IMPACT_THRESHOLD = 0.5;
export const DEFAULT_VALUE_THRESHOLD = 0.5;
/** Thresholds are policy in the exclusive (0, 1] interval — never zero (a zero gate promotes everything). */
export const MIN_POLICY_THRESHOLD = 0.01;

export const MAX_GOAL_REFS_PER_CANDIDATE = 4;
export const MAX_SCOPED_GOALS = 50;
export const MAX_READINGS_PER_RUN = 64;
export const MAX_PROPOSALS_PER_RUN = 8;
export const MAX_EVIDENCE_REFS = 16;
export const MAX_ACQUISITION_PATHS = 8;

export const MAX_GAP_KEY_LENGTH = 300;
export const MAX_METRIC_NAME_LENGTH = 200;
export const MAX_MISSING_KNOWLEDGE_LENGTH = 2000;
export const MAX_CONSEQUENCE_LENGTH = 2000;
export const MAX_PARTY_LABEL_LENGTH = 200;
export const MAX_TRIGGER_LABEL_LENGTH = 200;
export const MAX_GOAL_LABEL_LENGTH = 200;
export const MAX_RATIONALE_LENGTH = 2000;

/** Money/quantities: integer minor units within the JS safe-integer envelope. */
export const MAX_BUDGET_AMOUNT = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Input key sets (unknown-key rejection)
// ---------------------------------------------------------------------------

const RUN_INPUT_KEYS = [
  'trigger',
  'originExecutionId',
  'goalIds',
  'readings',
  'proposals',
  'policy',
  'investigationBudget',
  'rewardBudget',
  'actor',
  'rationale',
] as const;

const TRIGGER_KEYS = ['kind', 'label'] as const;
const POLICY_KEYS = ['impactThreshold', 'valueThreshold'] as const;
const BUDGET_KEYS = ['amount', 'currency'] as const;
const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const READING_KEYS = [
  'goalId',
  'metricName',
  'value',
  'driverConfidence',
  'evidenceClaimIds',
  'evidenceBeliefIds',
] as const;
const PROPOSAL_KEYS = [
  'gapKey',
  'affectedGoals',
  'missingKnowledge',
  'consequence',
  'decisionImpact',
  'urgency',
  'currentConfidence',
  'requiredConfidence',
  'informationValue',
  'evidenceClaimIds',
  'evidenceBeliefIds',
  'acquisitionPaths',
] as const;
const GOAL_REF_KEYS = ['goalId', 'label'] as const;
const PATH_KEYS = ['kind', 'id', 'label'] as const;

const GET_RUN_QUERY_KEYS = ['runId'] as const;
const GET_CANDIDATE_QUERY_KEYS = ['candidateId'] as const;
const LIST_QUERY_KEYS = ['triggerKind', 'originExecutionId', 'affectedGoalId', 'disposition', 'limit'] as const;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(value: unknown, list: readonly T[]): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

export function isDiscoveryTriggerKind(value: unknown): value is DiscoveryTriggerKind {
  return isOneOf(value, DISCOVERY_TRIGGER_KINDS);
}

export function isCandidateSource(value: unknown): value is 'derived' | 'proposed' {
  return isOneOf(value, CANDIDATE_SOURCES);
}

export function isGapKind(value: unknown): value is 'driver' | 'reading' | 'standing' | 'custom' {
  return isOneOf(value, GAP_KINDS);
}

export function isCandidateDisposition(
  value: unknown,
): value is 'promoted' | 'dismissed' | 'already_covered' {
  return isOneOf(value, CANDIDATE_DISPOSITIONS);
}

export function isCandidateUrgency(value: unknown): value is CandidateUrgency {
  return isOneOf(value, CANDIDATE_URGENCIES);
}

export function isDiscoveryPartyKind(value: unknown): value is DiscoveryPartyKind {
  return isOneOf(value, DISCOVERY_PARTY_KINDS);
}

export function isAcquisitionPathKind(value: unknown): value is AcquisitionPath['kind'] {
  return isOneOf(value, ACQUISITION_PATH_KINDS);
}

/** Run/candidate-id shape guard (uuid); malformed ids are simply "not found". */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shared primitive guards (each takes its calling context's error factory)
// ---------------------------------------------------------------------------

/** The error factory of one validation context. */
type Err = (message: string) => AttentionError;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
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

/** A unit-interval score: finite number in [0, 1]. */
function requireUnitScore(value: unknown, field: string, err: Err): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw err(`${field} must be a finite number (got ${String(value)})`);
  }
  if (value < 0 || value > 1) {
    throw err(`${field} must be within [0, 1] (got ${String(value)})`);
  }
  return value;
}

/** A metric reading value: any finite double within the safe-integer envelope. */
function requireMetricValue(value: unknown, field: string, err: Err): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw err(`${field} must be a finite number (got ${String(value)})`);
  }
  if (Math.abs(value) > MAX_BUDGET_AMOUNT) {
    throw err(`${field} must be within ±${MAX_BUDGET_AMOUNT} (got ${String(value)})`);
  }
  return value;
}

/** Normalized, deduplicated, sorted uuid list bounded by `max`. */
function uuidList(
  value: unknown,
  field: string,
  max: number,
  err: Err,
  minOne = false,
): string[] {
  if (!Array.isArray(value)) throw err(`${field} must be an array of uuids`);
  if (minOne && value.length === 0) {
    throw err(`${field} must cite at least one uuid — evidence-linked readings only`);
  }
  if (value.length > max) {
    throw err(`${field} supports at most ${max} entries (got ${value.length})`);
  }
  const ids: string[] = [];
  for (const [index, id] of value.entries()) {
    if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw err(`${field}[${index}] must be a uuid`);
    }
    const normalized = id.toLowerCase();
    if (!ids.includes(normalized)) ids.push(normalized);
  }
  ids.sort();
  return ids;
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAttentionTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AttentionError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AttentionError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new AttentionError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

function runError(message: string): AttentionError {
  return new AttentionError('invalid_run_input', message);
}

function readingError(message: string): AttentionError {
  return new AttentionError('invalid_reading', message);
}

function proposalError(message: string): AttentionError {
  return new AttentionError('invalid_proposal', message);
}

function queryError(message: string): AttentionError {
  return new AttentionError('invalid_query', message);
}

// ---------------------------------------------------------------------------
// Validated shapes
// ---------------------------------------------------------------------------

export interface ValidatedParty {
  kind: DiscoveryPartyKind;
  id: string | null;
  label: string | null;
}

export interface ValidatedGoalRef {
  goalId: string;
  label: string | null;
}

export interface ValidatedAcquisitionPath {
  kind: AcquisitionPath['kind'];
  id: string | null;
  label: string | null;
}

export interface ValidatedBudget {
  amount: number;
  currency: string;
}

export interface ValidatedReading {
  goalId: string;
  metricName: string;
  value: number;
  driverConfidence: number;
  evidenceClaimIds: string[];
  evidenceBeliefIds: string[];
}

export interface ValidatedProposal {
  gapKey: string;
  affectedGoals: ValidatedGoalRef[];
  missingKnowledge: string;
  consequence: string;
  decisionImpact: number;
  urgency: CandidateUrgency;
  currentConfidence: number;
  requiredConfidence: number;
  informationValue: number;
  evidenceClaimIds: string[];
  evidenceBeliefIds: string[];
  acquisitionPaths: ValidatedAcquisitionPath[];
}

export interface ValidatedRunInput {
  trigger: { kind: DiscoveryTriggerKind; label: string | null };
  originExecutionId: string | null;
  goalIds: string[] | null;
  readings: ValidatedReading[];
  proposals: ValidatedProposal[];
  policy: MaterialityPolicy;
  investigationBudget: ValidatedBudget;
  rewardBudget: ValidatedBudget;
  actor: ValidatedParty;
  rationale: string | null;
}

// ---------------------------------------------------------------------------
// Shared reference validators
// ---------------------------------------------------------------------------

/** A provider-neutral party (lock 16): kind + uuid id and/or label (≥1 — traceable). */
function validateParty(party: unknown, where: string, err: Err): ValidatedParty {
  if (!isPlainObject(party)) throw err(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where, err);
  if (!isDiscoveryPartyKind(party.kind)) {
    throw err(
      `${where}.kind must be one of ${DISCOVERY_PARTY_KINDS.join(', ')} (got '${String(party.kind)}')`,
    );
  }
  const id = party.id === undefined || party.id === null ? null : requireUuid(party.id, `${where}.id`, err);
  const label = optionalTrimmed(party.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err(`${where} must carry an id or a label — the party must be traceable`);
  }
  return { kind: party.kind, id, label };
}

/** One affected-goal reference: a required goals-module uuid plus an optional label. */
function validateGoalRef(ref: unknown, where: string, err: Err): ValidatedGoalRef {
  if (!isPlainObject(ref)) throw err(`${where} must be an object`);
  rejectUnknownKeys(ref, GOAL_REF_KEYS, where, err);
  const goalId = requireUuid(ref.goalId, `${where}.goalId`, err);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_GOAL_LABEL_LENGTH, err);
  return { goalId, label };
}

/** One acquisition path: a §7-menu kind + uuid id and/or label (≥1 — traceable). */
function validateAcquisitionPath(path: unknown, where: string, err: Err): ValidatedAcquisitionPath {
  if (!isPlainObject(path)) throw err(`${where} must be an object`);
  rejectUnknownKeys(path, PATH_KEYS, where, err);
  if (!isAcquisitionPathKind(path.kind)) {
    throw err(
      `${where}.kind must be one of ${ACQUISITION_PATH_KINDS.join(', ')} (got '${String(path.kind)}')`,
    );
  }
  const id = path.id === undefined || path.id === null ? null : requireUuid(path.id, `${where}.id`, err);
  const label = optionalTrimmed(path.label, `${where}.label`, MAX_PARTY_LABEL_LENGTH, err);
  if (id === null && label === null) {
    throw err(`${where} must carry an id or a label — an acquisition path must be traceable`);
  }
  return { kind: path.kind, id, label };
}

function validateAcquisitionPaths(value: unknown, err: Err): ValidatedAcquisitionPath[] {
  if (!Array.isArray(value)) throw err('acquisitionPaths must be an array');
  if (value.length > MAX_ACQUISITION_PATHS) {
    throw err(`acquisitionPaths supports at most ${MAX_ACQUISITION_PATHS} entries (got ${value.length})`);
  }
  const paths = value.map((entry, index) =>
    validateAcquisitionPath(entry, `acquisitionPaths[${index}]`, err),
  );
  const seen = new Set<string>();
  for (const path of paths) {
    const key = `${path.kind}|${path.id ?? ''}|${path.label ?? ''}`;
    if (seen.has(key)) {
      throw err(`acquisitionPaths must be unique (duplicate '${key}')`);
    }
    seen.add(key);
  }
  return paths;
}

/** A mission budget: integer minor units + ISO 4217-shaped currency (§8). */
function validateBudget(budget: unknown, where: string, err: Err): ValidatedBudget {
  if (!isPlainObject(budget)) throw err(`${where} must be an object { amount, currency }`);
  rejectUnknownKeys(budget, BUDGET_KEYS, where, err);
  const { amount, currency } = budget;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !Number.isInteger(amount)) {
    throw err(`${where}.amount must be an integer amount of minor units (got ${String(amount)})`);
  }
  if (amount < 0) throw err(`${where}.amount must not be negative (got ${String(amount)})`);
  if (amount > MAX_BUDGET_AMOUNT) {
    throw err(`${where}.amount must not exceed ${MAX_BUDGET_AMOUNT} minor units (got ${String(amount)})`);
  }
  const code = requireString(currency, `${where}.currency`, err);
  if (!CURRENCY_PATTERN.test(code)) {
    throw err(`${where}.currency must be a 3-letter ISO currency code (got '${code}')`);
  }
  return { amount, currency: code };
}

// ---------------------------------------------------------------------------
// runGoalGapDiscovery
// ---------------------------------------------------------------------------

/** Validates and normalizes `runGoalGapDiscovery`'s input (pure). */
export function validateRunInput(input: unknown): ValidatedRunInput {
  const err = runError;
  if (!isPlainObject(input)) throw err('run input must be an object');
  rejectUnknownKeys(input, RUN_INPUT_KEYS, 'run input', err);

  // trigger
  const trigger = input.trigger;
  if (!isPlainObject(trigger)) throw err('trigger must be an object');
  rejectUnknownKeys(trigger, TRIGGER_KEYS, 'trigger', err);
  if (!isDiscoveryTriggerKind(trigger.kind)) {
    throw err(
      `trigger.kind must be one of ${DISCOVERY_TRIGGER_KINDS.join(', ')} (got '${String(trigger.kind)}')`,
    );
  }
  const triggerLabel = optionalTrimmed(trigger.label, 'trigger.label', MAX_TRIGGER_LABEL_LENGTH, err);

  // origin execution link (required for cognitive-execution triggers)
  const originExecutionId =
    input.originExecutionId === undefined || input.originExecutionId === null
      ? null
      : requireUuid(input.originExecutionId, 'originExecutionId', err);
  if (trigger.kind === 'cognitive-execution' && originExecutionId === null) {
    throw err(
      "trigger.kind 'cognitive-execution' requires originExecutionId — the loop linkage is the trigger",
    );
  }

  // goal scope
  let goalIds: string[] | null = null;
  if (input.goalIds !== undefined && input.goalIds !== null) {
    if (!Array.isArray(input.goalIds)) throw err('goalIds must be an array of goal uuids');
    if (input.goalIds.length === 0) throw err('goalIds must hold at least one goal uuid when present');
    if (input.goalIds.length > MAX_SCOPED_GOALS) {
      throw err(`goalIds supports at most ${MAX_SCOPED_GOALS} entries (got ${input.goalIds.length})`);
    }
    goalIds = uuidList(input.goalIds, 'goalIds', MAX_SCOPED_GOALS, err, true);
  }

  // readings (evidence extraction)
  const readings: ValidatedReading[] = [];
  if (input.readings !== undefined && input.readings !== null) {
    if (!Array.isArray(input.readings)) throw err('readings must be an array');
    if (input.readings.length > MAX_READINGS_PER_RUN) {
      throw err(`readings supports at most ${MAX_READINGS_PER_RUN} entries (got ${input.readings.length})`);
    }
    for (const [index, raw] of input.readings.entries()) {
      readings.push(validateReading(raw, `readings[${index}]`));
    }
  }

  // proposals (the bounded-reasoning seam)
  const proposals: ValidatedProposal[] = [];
  if (input.proposals !== undefined && input.proposals !== null) {
    if (!Array.isArray(input.proposals)) throw err('proposals must be an array');
    if (input.proposals.length > MAX_PROPOSALS_PER_RUN) {
      throw err(`proposals supports at most ${MAX_PROPOSALS_PER_RUN} entries (got ${input.proposals.length})`);
    }
    for (const [index, raw] of input.proposals.entries()) {
      proposals.push(validateProposal(raw, `proposals[${index}]`));
    }
  }

  // the materiality policy
  let policy: MaterialityPolicy = {
    impactThreshold: DEFAULT_IMPACT_THRESHOLD,
    valueThreshold: DEFAULT_VALUE_THRESHOLD,
  };
  if (input.policy !== undefined && input.policy !== null) {
    if (!isPlainObject(input.policy)) throw err('policy must be an object');
    rejectUnknownKeys(input.policy, POLICY_KEYS, 'policy', err);
    const impactThreshold =
      input.policy.impactThreshold === undefined
        ? policy.impactThreshold
        : requireUnitScore(input.policy.impactThreshold, 'policy.impactThreshold', err);
    const valueThreshold =
      input.policy.valueThreshold === undefined
        ? policy.valueThreshold
        : requireUnitScore(input.policy.valueThreshold, 'policy.valueThreshold', err);
    if (impactThreshold < MIN_POLICY_THRESHOLD || valueThreshold < MIN_POLICY_THRESHOLD) {
      throw err(
        `policy thresholds must be at least ${MIN_POLICY_THRESHOLD} — a lower gate promotes everything and is not a policy`,
      );
    }
    policy = { impactThreshold, valueThreshold };
  }

  const investigationBudget = validateBudget(input.investigationBudget, 'investigationBudget', err);
  const rewardBudget = validateBudget(input.rewardBudget, 'rewardBudget', err);
  const actor = validateParty(input.actor, 'actor', err);
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, err);

  return {
    trigger: { kind: trigger.kind, label: triggerLabel },
    originExecutionId,
    goalIds,
    readings,
    proposals,
    policy,
    investigationBudget,
    rewardBudget,
    actor,
    rationale,
  };
}

/** One metric reading: evidence extraction about one goal metric. */
function validateReading(raw: unknown, where: string): ValidatedReading {
  const err = readingError;
  if (!isPlainObject(raw)) throw err(`${where} must be an object`);
  rejectUnknownKeys(raw, READING_KEYS, where, err);
  const goalId = requireUuid(raw.goalId, `${where}.goalId`, err);
  const metricName = requireBoundedString(raw.metricName, `${where}.metricName`, MAX_METRIC_NAME_LENGTH, err);
  const value = requireMetricValue(raw.value, `${where}.value`, err);
  const driverConfidence =
    raw.driverConfidence === undefined || raw.driverConfidence === null
      ? 0
      : requireUnitScore(raw.driverConfidence, `${where}.driverConfidence`, err);
  const evidenceClaimIds = uuidList(raw.evidenceClaimIds, `${where}.evidenceClaimIds`, MAX_EVIDENCE_REFS, err, true);
  const evidenceBeliefIds = uuidList(raw.evidenceBeliefIds ?? [], `${where}.evidenceBeliefIds`, MAX_EVIDENCE_REFS, err);
  return { goalId, metricName, value, driverConfidence, evidenceClaimIds, evidenceBeliefIds };
}

/** One gap proposal: the full candidate field set at the seam. */
function validateProposal(raw: unknown, where: string): ValidatedProposal {
  const err = proposalError;
  if (!isPlainObject(raw)) throw err(`${where} must be an object`);
  rejectUnknownKeys(raw, PROPOSAL_KEYS, where, err);

  const gapKey = requireBoundedString(raw.gapKey, `${where}.gapKey`, MAX_GAP_KEY_LENGTH, err);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9 .:_|-]*$/.test(gapKey)) {
    throw err(`${where}.gapKey must be a stable slug of letters, digits, .:_| - and spaces (got '${gapKey}')`);
  }

  if (!Array.isArray(raw.affectedGoals)) throw err(`${where}.affectedGoals must be an array`);
  if (raw.affectedGoals.length === 0) {
    throw err(`${where}.affectedGoals must cite at least one goal — a candidate unknown is goal-driven`);
  }
  if (raw.affectedGoals.length > MAX_GOAL_REFS_PER_CANDIDATE) {
    throw err(
      `${where}.affectedGoals supports at most ${MAX_GOAL_REFS_PER_CANDIDATE} entries (got ${raw.affectedGoals.length})`,
    );
  }
  const affectedGoals = raw.affectedGoals.map((entry: unknown, index: number) =>
    validateGoalRef(entry, `${where}.affectedGoals[${index}]`, err),
  );
  const seen = new Set<string>();
  for (const ref of affectedGoals) {
    if (seen.has(ref.goalId)) {
      throw err(`${where}.affectedGoals must be unique (duplicate '${ref.goalId}')`);
    }
    seen.add(ref.goalId);
  }

  const missingKnowledge = requireBoundedString(
    raw.missingKnowledge,
    `${where}.missingKnowledge`,
    MAX_MISSING_KNOWLEDGE_LENGTH,
    err,
  );
  const consequence = requireBoundedString(raw.consequence, `${where}.consequence`, MAX_CONSEQUENCE_LENGTH, err);
  const decisionImpact = requireUnitScore(raw.decisionImpact, `${where}.decisionImpact`, err);
  if (!isCandidateUrgency(raw.urgency)) {
    throw err(
      `${where}.urgency must be one of ${CANDIDATE_URGENCIES.join(', ')} (got '${String(raw.urgency)}')`,
    );
  }
  const currentConfidence = requireUnitScore(raw.currentConfidence, `${where}.currentConfidence`, err);
  const requiredConfidence = requireUnitScore(raw.requiredConfidence, `${where}.requiredConfidence`, err);
  if (requiredConfidence <= currentConfidence) {
    throw err(
      `${where}.requiredConfidence must exceed currentConfidence — a closed gap is not a candidate unknown`,
    );
  }
  const informationValue = requireUnitScore(raw.informationValue, `${where}.informationValue`, err);
  const evidenceClaimIds = uuidList(raw.evidenceClaimIds ?? [], `${where}.evidenceClaimIds`, MAX_EVIDENCE_REFS, err);
  const evidenceBeliefIds = uuidList(raw.evidenceBeliefIds ?? [], `${where}.evidenceBeliefIds`, MAX_EVIDENCE_REFS, err);
  const acquisitionPaths = validateAcquisitionPaths(raw.acquisitionPaths ?? [], err);

  return {
    gapKey,
    affectedGoals,
    missingKnowledge,
    consequence,
    decisionImpact,
    urgency: raw.urgency,
    currentConfidence,
    requiredConfidence,
    informationValue,
    evidenceClaimIds,
    evidenceBeliefIds,
    acquisitionPaths,
  };
}

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

/** Validates `getDiscoveryRun`'s query. */
export function validateGetRunQuery(query: unknown): { runId: string } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, GET_RUN_QUERY_KEYS, 'query', queryError);
  return { runId: requireUuid(query.runId, 'runId', queryError) };
}

/** Validates `getDiscoveryCandidate`'s query. */
export function validateGetCandidateQuery(query: unknown): { candidateId: string } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, GET_CANDIDATE_QUERY_KEYS, 'query', queryError);
  return { candidateId: requireUuid(query.candidateId, 'candidateId', queryError) };
}

export interface ValidatedListQuery {
  triggerKind: DiscoveryTriggerKind | null;
  originExecutionId: string | null;
  affectedGoalId: string | null;
  disposition: 'promoted' | 'dismissed' | 'already_covered' | null;
  limit: number;
}

/** Validates `listDiscoveryRuns`'s query. */
export function validateListQuery(query: unknown): ValidatedListQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, LIST_QUERY_KEYS, 'query', queryError);

  let triggerKind: DiscoveryTriggerKind | null = null;
  if (query.triggerKind !== undefined && query.triggerKind !== null) {
    if (!isDiscoveryTriggerKind(query.triggerKind)) {
      throw queryError(
        `triggerKind must be one of ${DISCOVERY_TRIGGER_KINDS.join(', ')} (got '${String(query.triggerKind)}')`,
      );
    }
    triggerKind = query.triggerKind;
  }

  const originExecutionId =
    query.originExecutionId === undefined || query.originExecutionId === null
      ? null
      : requireUuid(query.originExecutionId, 'originExecutionId', queryError);
  const affectedGoalId =
    query.affectedGoalId === undefined || query.affectedGoalId === null
      ? null
      : requireUuid(query.affectedGoalId, 'affectedGoalId', queryError);

  let disposition: ValidatedListQuery['disposition'] = null;
  if (query.disposition !== undefined && query.disposition !== null) {
    if (!isCandidateDisposition(query.disposition)) {
      throw queryError(
        `disposition must be one of ${CANDIDATE_DISPOSITIONS.join(', ')} (got '${String(query.disposition)}')`,
      );
    }
    disposition = query.disposition;
  }

  let limit = DEFAULT_LIST_LIMIT;
  if (query.limit !== undefined && query.limit !== null) {
    if (typeof query.limit !== 'number' || !Number.isInteger(query.limit)) {
      throw queryError('limit must be an integer');
    }
    if (query.limit < 1 || query.limit > MAX_LIST_LIMIT) {
      throw queryError(`limit must be between 1 and ${MAX_LIST_LIMIT} (got ${String(query.limit)})`);
    }
    limit = query.limit;
  }

  return { triggerKind, originExecutionId, affectedGoalId, disposition, limit };
}
