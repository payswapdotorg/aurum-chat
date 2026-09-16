// Pure validation/normalization logic of the workforce module (no
// database). Everything a caller may put into a registration, revision,
// signal, assessment or query crosses these guards first; the SQL CHECK
// constraints in migrations/001-workforce.sql mirror the load-bearing rules
// as defense in depth — including the lock-20 employment guards and the
// adverse-grounding guard for 'termination' / 'performance_action'.
//
// Deliberately strict about unknown keys: a caller can never smuggle `id`,
// `tenantId`, `version`, `changeKind`, commit times, acting principals,
// `employmentImpacting` (module-minted from the recommendation kind), the
// `source` of explanations/alternatives (module-minted) or the computed
// assessment content into an input — identity, tenancy, version numbers,
// change classification, employment-impact classification and audit fields
// are minted by the system (the goals/capabilities discipline: workforce
// records are auditable, and audit fields are not caller-forgeable). The
// employee of an assignment and the decider of a decision are IMMUTABLE
// identity content — the revise inputs do not even accept those keys.
//
// Parties are opaque provider-neutral references (lock 16): free-form ids
// (uuids where the owning module uses them) and/or labels — unverified here
// by design (the events/observations precedent; people stays a
// non-dependency). The assessed employee and the human decider are the two
// exceptions with teeth: an employee reference REQUIRES an id (an
// employment-relevant record must be traceable to a specific employee), and
// a decider must be a person with an id (human decision authority, §14).
//
// The 'workforce:decide' authority claim follows the interim per-module
// claim pattern (identity's 'identity:link', actions' 'actions:approve').

import type { TenantContext } from '@/infra/tenant';
import { WorkforceError } from './errors';
import type { WorkforcePartyKind } from './types';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the CHECK constraints in migrations/001)
// ---------------------------------------------------------------------------

export const WORKFORCE_SIGNAL_KINDS = ['workload', 'performance'] as const;

export const WORKFORCE_RECORD_STATUSES = ['active', 'retired'] as const;

/** Audit-actor kinds (the events envelope's actor vocabulary minus `source`). */
export const WORKFORCE_PARTY_KINDS = [
  'person',
  'team',
  'agent',
  'system',
  'external',
] as const;

export const RECOMMENDATION_KINDS = [
  'redistribute_work',
  'training',
  'hire',
  'role_change',
  'performance_action',
  'process_improvement',
  'automation',
  'monitor',
  'no_action',
  'termination',
] as const;

export const ALTERNATIVE_KINDS = [
  'redistribute_work',
  'reassign',
  'train',
  'hire',
  'recruit_agent',
  'install_software',
  'outsource',
  'process_improvement',
  'investigate_further',
  'no_change',
] as const;

export const WORKFORCE_DECISION_KINDS = [
  'accepted',
  'rejected',
  'superseded',
  'more_information_needed',
] as const;

/** Authority claim that records human decisions on workforce assessments. */
export const WORKFORCE_AUTHORITY_DECIDE = 'workforce:decide';

// ---------------------------------------------------------------------------
// Size caps and defaults
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;

export const MAX_KEY_LENGTH = 200; // role key / employee id / party id / label
export const MAX_TITLE_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2000; // description / note / rationale / texts
export const MAX_SEARCH_LENGTH = 200;

/** Evidence observation references per record (deduplicated). */
export const MAX_EVIDENCE_REFS = 32;
/** Required capabilities per role. */
export const MAX_REQUIRED_CAPABILITIES_PER_ROLE = 32;
/** Distinct required capabilities considered per assessment (union bound). */
export const MAX_REQUIRED_CAPABILITIES_PER_ASSESSMENT = 64;
/** Active assignments considered per assessment. */
export const MAX_ASSIGNMENTS_PER_ASSESSMENT = 25;
/** Capability supplies of the employee read through the capabilities contract. */
export const MAX_SUPPLIES_PER_ASSESSMENT = 500;
/** Signals per kind considered per assessment window. */
export const MAX_SIGNALS_PER_ASSESSMENT = 100;
/** Caller-added alternative explanations per assessment. */
export const MAX_ADDITIONAL_EXPLANATIONS = 16;
/** Caller-added alternatives per assessment. */
export const MAX_ADDITIONAL_ALTERNATIVES = 16;

/** Weekly hours: role expectations and workload signals are bounded by the week. */
export const MAX_WEEKLY_HOURS = 168;

/** Assignment allocation default: fully assigned. */
export const DEFAULT_ALLOCATION = 1;

/** Assessment option defaults (snapshotted per version). */
export const DEFAULT_WINDOW_WEEKS = 4;
export const MIN_WINDOW_WEEKS = 1;
export const MAX_WINDOW_WEEKS = 52;
export const DEFAULT_WORKLOAD_MARGIN = 0.15;
export const DEFAULT_PERFORMANCE_STRONG = 0.75;
export const DEFAULT_PERFORMANCE_SATISFACTORY = 0.5;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isWorkforceSignalKind(value: unknown): value is 'workload' | 'performance' {
  return (
    typeof value === 'string' && (WORKFORCE_SIGNAL_KINDS as readonly string[]).includes(value)
  );
}

export function isWorkforceRecordStatus(value: unknown): value is 'active' | 'retired' {
  return (
    typeof value === 'string' && (WORKFORCE_RECORD_STATUSES as readonly string[]).includes(value)
  );
}

export function isWorkforcePartyKind(value: unknown): value is WorkforcePartyKind {
  return typeof value === 'string' && (WORKFORCE_PARTY_KINDS as readonly string[]).includes(value);
}

export function isRecommendationKind(value: unknown): value is (typeof RECOMMENDATION_KINDS)[number] {
  return typeof value === 'string' && (RECOMMENDATION_KINDS as readonly string[]).includes(value);
}

export function isAlternativeKind(value: unknown): value is (typeof ALTERNATIVE_KINDS)[number] {
  return typeof value === 'string' && (ALTERNATIVE_KINDS as readonly string[]).includes(value);
}

export function isWorkforceDecisionKind(value: unknown): value is (typeof WORKFORCE_DECISION_KINDS)[number] {
  return (
    typeof value === 'string' && (WORKFORCE_DECISION_KINDS as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertWorkforceTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new WorkforceError(
      'invalid_context',
      'TenantContext.tenantId must be a non-empty string',
    );
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new WorkforceError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new WorkforceError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** Requires the 'workforce:decide' authority claim (throws `forbidden`). */
export function requireWorkforceDecisionAuthority(ctx: TenantContext): void {
  assertWorkforceTenantContext(ctx);
  if (!ctx.authority.includes(WORKFORCE_AUTHORITY_DECIDE)) {
    throw new WorkforceError(
      'forbidden',
      `this operation requires the '${WORKFORCE_AUTHORITY_DECIDE}' authority claim`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

type InputCode =
  | 'invalid_role_input'
  | 'invalid_assignment_input'
  | 'invalid_signal_input'
  | 'invalid_assessment_input'
  | 'invalid_decision_input';

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
  code: InputCode | 'invalid_query',
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw new WorkforceError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function inputError(code: InputCode, message: string): WorkforceError {
  return new WorkforceError(code, message);
}

function queryError(message: string): WorkforceError {
  return new WorkforceError('invalid_query', message);
}

function requireString(value: unknown, field: string, code: InputCode | 'invalid_query'): string {
  if (typeof value !== 'string') throw inputErrorOrQuery(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputErrorOrQuery(code, `${field} must be a non-empty string`);
  return text;
}

function inputErrorOrQuery(code: InputCode | 'invalid_query', message: string): WorkforceError {
  return code === 'invalid_query' ? queryError(message) : inputError(code, message);
}

/** Nullable text: undefined/null → null; else trimmed non-empty ≤ max chars. */
function optionalText(
  value: unknown,
  field: string,
  max: number,
  code: InputCode,
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field, code);
  if (text.length > max) {
    throw inputError(code, `${field} must be at most ${max} characters (got ${text.length})`);
  }
  return text;
}

function requireUuid(value: unknown, field: string, code: InputCode | 'invalid_query'): string {
  const text = requireString(value, field, code);
  if (!UUID_PATTERN.test(text)) {
    throw inputErrorOrQuery(code, `${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

/** A finite number in [min, max]. */
function requireNumber(
  value: unknown,
  field: string,
  min: number,
  max: number,
  code: InputCode,
  exclusiveMin = false,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (exclusiveMin && value === min)
  ) {
    const bound = exclusiveMin ? `(${min}, ${max}]` : `[${min}, ${max}]`;
    throw inputError(code, `${field} must be a finite number in ${bound} (got ${String(value)})`);
  }
  return value;
}

/** Evidence observation ids: uuids, ≤ MAX_EVIDENCE_REFS, deduplicated in order. */
function requireEvidenceIds(
  value: unknown,
  field: string,
  code: InputCode,
): string[] {
  if (!Array.isArray(value)) {
    throw inputError(code, `${field} must be an array of observation uuids`);
  }
  if (value.length > MAX_EVIDENCE_REFS) {
    throw inputError(
      code,
      `${field} supports at most ${MAX_EVIDENCE_REFS} references (got ${value.length})`,
    );
  }
  const out: string[] = [];
  for (const [index, entry] of value.entries()) {
    const id = requireUuid(entry, `${field}[${index}]`, code);
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** 1..MAX_LIST_LIMIT list limit (default applied by the caller when absent). */
function optionalLimit(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_LIST_LIMIT
  ) {
    throw queryError(`limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(value)})`);
  }
  return value;
}

/** Case-insensitive ILIKE wildcard escaping (the missions module's helper). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Parties, employees, deciders
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of an audit-actor party. */
export interface ValidatedParty {
  kind: string;
  id: string | null;
  label: string | null;
}

const PARTY_KEYS = ['kind', 'id', 'label'] as const;

function validateParty(
  value: unknown,
  where: string,
  code: InputCode,
): ValidatedParty {
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, PARTY_KEYS, where, code);
  const kind = value.kind;
  if (!isWorkforcePartyKind(kind)) {
    throw inputError(
      code,
      `${where}.kind must be one of ${WORKFORCE_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = optionalText(value.id, `${where}.id`, MAX_KEY_LENGTH, code);
  const label = optionalText(value.label, `${where}.label`, MAX_KEY_LENGTH, code);
  if (id === null && label === null) {
    throw inputError(
      code,
      `${where} must carry an id or a label — audit actors are traceable`,
    );
  }
  return { kind, id, label };
}

/** Fully validated + normalized form of the assessed employee. */
export interface ValidatedEmployee {
  id: string;
  label: string | null;
}

const EMPLOYEE_KEYS = ['id', 'label'] as const;

function validateEmployee(value: unknown, where: string, code: InputCode): ValidatedEmployee {
  if (!isPlainObject(value)) throw inputError(code, `${where} must be an object`);
  rejectUnknownKeys(value, EMPLOYEE_KEYS, where, code);
  // The id is REQUIRED: employment-relevant records are traceable to a
  // specific employee record (labels alone are not identity).
  const id = requireString(value.id, `${where}.id`, code);
  if (id.length > MAX_KEY_LENGTH) {
    throw inputError(code, `${where}.id must be at most ${MAX_KEY_LENGTH} characters`);
  }
  const label = optionalText(value.label, `${where}.label`, MAX_KEY_LENGTH, code);
  return { id, label };
}

/** Fully validated + normalized form of the human decider. */
export interface ValidatedDecider {
  kind: 'person';
  id: string;
  label: string | null;
}

const DECIDER_KEYS = ['kind', 'id', 'label'] as const;

function validateDecider(value: unknown, code: InputCode): ValidatedDecider {
  if (!isPlainObject(value)) throw inputError(code, 'decider must be an object');
  rejectUnknownKeys(value, DECIDER_KEYS, 'decider', code);
  if (value.kind !== 'person') {
    throw inputError(
      code,
      `decider.kind must be 'person' — workforce decisions are made by humans (got '${String(value.kind)}')`,
    );
  }
  const id = requireString(value.id, 'decider.id', code);
  if (id.length > MAX_KEY_LENGTH) {
    throw inputError(code, `decider.id must be at most ${MAX_KEY_LENGTH} characters`);
  }
  const label = optionalText(value.label, 'decider.label', MAX_KEY_LENGTH, code);
  return { kind: 'person', id, label };
}

// ---------------------------------------------------------------------------
// Role expectations
// ---------------------------------------------------------------------------

/** Fully validated role capability requirements (minLevel defaulted, deduplicated by capability). */
export type ValidatedRequirements = { capabilityId: string; minLevel: number }[];

function validateRequirements(
  value: unknown,
  field: string,
  code: InputCode,
): ValidatedRequirements {
  if (!Array.isArray(value)) {
    throw inputError(code, `${field} must be an array of { capabilityId, minLevel? }`);
  }
  if (value.length > MAX_REQUIRED_CAPABILITIES_PER_ROLE) {
    throw inputError(
      code,
      `${field} supports at most ${MAX_REQUIRED_CAPABILITIES_PER_ROLE} requirements (got ${value.length})`,
    );
  }
  const out: { capabilityId: string; minLevel: number }[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isPlainObject(entry)) {
      throw inputError(code, `${field}[${index}] must be an object`);
    }
    rejectUnknownKeys(entry, ['capabilityId', 'minLevel'], `${field}[${index}]`, code);
    const capabilityId = requireUuid(entry.capabilityId, `${field}[${index}].capabilityId`, code);
    const minLevel =
      entry.minLevel === undefined ? 0 : requireNumber(entry.minLevel, `${field}[${index}].minLevel`, 0, 1, code);
    const existing = out.find((requirement) => requirement.capabilityId === capabilityId);
    if (existing === undefined) out.push({ capabilityId, minLevel });
    else if (minLevel > existing.minLevel) existing.minLevel = minLevel; // duplicates demand the max
  }
  return out;
}

export interface ValidatedRegisterRoleInput {
  roleKey: string;
  title: string | null;
  description: string | null;
  requiredCapabilities: ValidatedRequirements;
  expectedWeeklyHours: number;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateRegisterRoleInput(input: unknown): ValidatedRegisterRoleInput {
  const code: InputCode = 'invalid_role_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    ['roleKey', 'title', 'description', 'requiredCapabilities', 'expectedWeeklyHours', 'actor', 'rationale'],
    'input',
    code,
  );
  const roleKey = requireString(input.roleKey, 'roleKey', code);
  if (roleKey.length > MAX_KEY_LENGTH) {
    throw inputError(code, `roleKey must be at most ${MAX_KEY_LENGTH} characters (got ${roleKey.length})`);
  }
  const title = optionalText(input.title, 'title', MAX_TITLE_LENGTH, code);
  const description = optionalText(input.description, 'description', MAX_TEXT_LENGTH, code);
  const requiredCapabilities =
    input.requiredCapabilities === undefined
      ? []
      : validateRequirements(input.requiredCapabilities, 'requiredCapabilities', code);
  const expectedWeeklyHours = requireNumber(
    input.expectedWeeklyHours,
    'expectedWeeklyHours',
    0,
    MAX_WEEKLY_HOURS,
    code,
    true,
  );
  const actor = validateParty(input.actor, 'actor', code);
  const rationale = optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code);
  return { roleKey, title, description, requiredCapabilities, expectedWeeklyHours, actor, rationale };
}

export interface ValidatedReviseRoleInput {
  roleId: string;
  patch: {
    title?: string | null;
    description?: string | null;
    requiredCapabilities?: ValidatedRequirements;
    expectedWeeklyHours?: number;
    status?: 'active' | 'retired';
  };
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseRoleInput(input: unknown): ValidatedReviseRoleInput {
  const code: InputCode = 'invalid_role_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    ['roleId', 'title', 'description', 'requiredCapabilities', 'expectedWeeklyHours', 'status', 'actor', 'rationale'],
    'input',
    code,
  );
  const roleId = requireUuid(input.roleId, 'roleId', code);
  const patch: ValidatedReviseRoleInput['patch'] = {};
  if (input.title !== undefined) patch.title = optionalText(input.title, 'title', MAX_TITLE_LENGTH, code);
  if (input.description !== undefined) {
    patch.description = optionalText(input.description, 'description', MAX_TEXT_LENGTH, code);
  }
  if (input.requiredCapabilities !== undefined) {
    patch.requiredCapabilities = validateRequirements(
      input.requiredCapabilities,
      'requiredCapabilities',
      code,
    );
  }
  if (input.expectedWeeklyHours !== undefined) {
    patch.expectedWeeklyHours = requireNumber(
      input.expectedWeeklyHours,
      'expectedWeeklyHours',
      0,
      MAX_WEEKLY_HOURS,
      code,
      true,
    );
  }
  if (input.status !== undefined) {
    if (!isWorkforceRecordStatus(input.status)) {
      throw inputError(code, `status must be 'active' or 'retired' (got '${String(input.status)}')`);
    }
    patch.status = input.status;
  }
  const actor = validateParty(input.actor, 'actor', code);
  const rationale = optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code);
  if (
    patch.title === undefined &&
    patch.description === undefined &&
    patch.requiredCapabilities === undefined &&
    patch.expectedWeeklyHours === undefined &&
    patch.status === undefined
  ) {
    throw inputError(code, 'a revision must change something (title, description, requiredCapabilities, expectedWeeklyHours or status)');
  }
  if (
    patch.status !== undefined &&
    (patch.title !== undefined ||
      patch.description !== undefined ||
      patch.requiredCapabilities !== undefined ||
      patch.expectedWeeklyHours !== undefined)
  ) {
    throw inputError(
      code,
      'a status revision must be surgical — combine no other change with it',
    );
  }
  return { roleId, patch, actor, rationale };
}

// ---------------------------------------------------------------------------
// Role assignments
// ---------------------------------------------------------------------------

export interface ValidatedAssignRoleInput {
  roleId: string;
  employee: ValidatedEmployee;
  allocation: number;
  evidenceObservationIds: string[];
  note: string | null;
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateAssignRoleInput(input: unknown): ValidatedAssignRoleInput {
  const code: InputCode = 'invalid_assignment_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    ['roleId', 'employee', 'allocation', 'evidenceObservationIds', 'note', 'actor', 'rationale'],
    'input',
    code,
  );
  const roleId = requireUuid(input.roleId, 'roleId', code);
  const employee = validateEmployee(input.employee, 'employee', code);
  const allocation =
    input.allocation === undefined
      ? DEFAULT_ALLOCATION
      : requireNumber(input.allocation, 'allocation', 0, 1, code, true);
  const evidenceObservationIds =
    input.evidenceObservationIds === undefined
      ? []
      : requireEvidenceIds(input.evidenceObservationIds, 'evidenceObservationIds', code);
  const note = optionalText(input.note, 'note', MAX_TEXT_LENGTH, code);
  const actor = validateParty(input.actor, 'actor', code);
  const rationale = optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code);
  return { roleId, employee, allocation, evidenceObservationIds, note, actor, rationale };
}

export interface ValidatedReviseAssignmentInput {
  assignmentId: string;
  patch: {
    allocation?: number;
    status?: 'active' | 'retired';
    evidenceObservationIds?: string[];
    note?: string | null;
  };
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateReviseAssignmentInput(input: unknown): ValidatedReviseAssignmentInput {
  const code: InputCode = 'invalid_assignment_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    ['assignmentId', 'allocation', 'status', 'evidenceObservationIds', 'note', 'actor', 'rationale'],
    'input',
    code,
  );
  const assignmentId = requireUuid(input.assignmentId, 'assignmentId', code);
  const patch: ValidatedReviseAssignmentInput['patch'] = {};
  if (input.allocation !== undefined) {
    patch.allocation = requireNumber(input.allocation, 'allocation', 0, 1, code, true);
  }
  if (input.status !== undefined) {
    if (!isWorkforceRecordStatus(input.status)) {
      throw inputError(code, `status must be 'active' or 'retired' (got '${String(input.status)}')`);
    }
    patch.status = input.status;
  }
  if (input.evidenceObservationIds !== undefined) {
    patch.evidenceObservationIds = requireEvidenceIds(
      input.evidenceObservationIds,
      'evidenceObservationIds',
      code,
    );
  }
  if (input.note !== undefined) patch.note = optionalText(input.note, 'note', MAX_TEXT_LENGTH, code);
  const actor = validateParty(input.actor, 'actor', code);
  const rationale = optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code);
  if (
    patch.allocation === undefined &&
    patch.status === undefined &&
    patch.evidenceObservationIds === undefined &&
    patch.note === undefined
  ) {
    throw inputError(code, 'a revision must change something (allocation, status, evidenceObservationIds or note)');
  }
  if (
    patch.status !== undefined &&
    (patch.allocation !== undefined ||
      patch.evidenceObservationIds !== undefined ||
      patch.note !== undefined)
  ) {
    throw inputError(
      code,
      'a status revision must be surgical — combine no other change with it',
    );
  }
  return { assignmentId, patch, actor, rationale };
}

// ---------------------------------------------------------------------------
// Workforce signals
// ---------------------------------------------------------------------------

export interface ValidatedRecordSignalInput {
  employee: ValidatedEmployee;
  kind: 'workload' | 'performance';
  value: number;
  evidenceObservationIds: string[];
  note: string | null;
  actor: ValidatedParty;
}

export function validateRecordSignalInput(input: unknown): ValidatedRecordSignalInput {
  const code: InputCode = 'invalid_signal_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    ['employee', 'kind', 'value', 'evidenceObservationIds', 'note', 'actor'],
    'input',
    code,
  );
  const employee = validateEmployee(input.employee, 'employee', code);
  if (!isWorkforceSignalKind(input.kind)) {
    throw inputError(code, `kind must be 'workload' or 'performance' (got '${String(input.kind)}')`);
  }
  const kind = input.kind;
  // Workload: hours per week in [0, 168]; performance: score in [0, 1].
  const value = requireNumber(
    input.value,
    'value',
    0,
    kind === 'workload' ? MAX_WEEKLY_HOURS : 1,
    code,
  );
  const evidenceObservationIds =
    input.evidenceObservationIds === undefined
      ? []
      : requireEvidenceIds(input.evidenceObservationIds, 'evidenceObservationIds', code);
  const note = optionalText(input.note, 'note', MAX_TEXT_LENGTH, code);
  const actor = validateParty(input.actor, 'actor', code);
  return { employee, kind, value, evidenceObservationIds, note, actor };
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

/** Fully validated + defaulted assessment options (threshold ordering enforced). */
export interface ValidatedAssessmentOptions {
  windowWeeks: number;
  workloadMargin: number;
  performanceStrong: number;
  performanceSatisfactory: number;
}

const OPTION_KEYS = ['windowWeeks', 'workloadMargin', 'performanceStrong', 'performanceSatisfactory'] as const;

export function validateAssessmentOptions(value: unknown): ValidatedAssessmentOptions {
  const code: InputCode = 'invalid_assessment_input';
  if (value === undefined || value === null) {
    return {
      windowWeeks: DEFAULT_WINDOW_WEEKS,
      workloadMargin: DEFAULT_WORKLOAD_MARGIN,
      performanceStrong: DEFAULT_PERFORMANCE_STRONG,
      performanceSatisfactory: DEFAULT_PERFORMANCE_SATISFACTORY,
    };
  }
  if (!isPlainObject(value)) throw inputError(code, 'options must be an object');
  rejectUnknownKeys(value, OPTION_KEYS, 'options', code);
  const windowWeeks =
    value.windowWeeks === undefined
      ? DEFAULT_WINDOW_WEEKS
      : requireNumber(value.windowWeeks, 'options.windowWeeks', MIN_WINDOW_WEEKS, MAX_WINDOW_WEEKS, code);
  if (!Number.isInteger(windowWeeks)) {
    throw inputError(code, 'options.windowWeeks must be an integer number of weeks');
  }
  const workloadMargin =
    value.workloadMargin === undefined
      ? DEFAULT_WORKLOAD_MARGIN
      : requireNumber(value.workloadMargin, 'options.workloadMargin', 0, 1, code);
  const performanceStrong =
    value.performanceStrong === undefined
      ? DEFAULT_PERFORMANCE_STRONG
      : requireNumber(value.performanceStrong, 'options.performanceStrong', 0, 1, code);
  const performanceSatisfactory =
    value.performanceSatisfactory === undefined
      ? DEFAULT_PERFORMANCE_SATISFACTORY
      : requireNumber(value.performanceSatisfactory, 'options.performanceSatisfactory', 0, 1, code);
  if (performanceStrong <= performanceSatisfactory) {
    throw inputError(
      code,
      `options.performanceStrong (${performanceStrong}) must be greater than options.performanceSatisfactory (${performanceSatisfactory}) — otherwise the 'satisfactory' band would be empty`,
    );
  }
  return { windowWeeks, workloadMargin, performanceStrong, performanceSatisfactory };
}

export interface ValidatedExplanation {
  text: string;
}

export interface ValidatedAlternativeAction {
  kind: (typeof ALTERNATIVE_KINDS)[number];
  description: string;
}

export interface ValidatedAssessWorkforceInput {
  employee: ValidatedEmployee;
  recommendationKind: (typeof RECOMMENDATION_KINDS)[number];
  recommendationText: string;
  confidence: number;
  options: ValidatedAssessmentOptions;
  additionalAlternativeExplanations: ValidatedExplanation[];
  additionalAlternatives: ValidatedAlternativeAction[];
  evidenceObservationIds: string[];
  actor: ValidatedParty;
  rationale: string | null;
}

export function validateAssessWorkforceInput(input: unknown): ValidatedAssessWorkforceInput {
  const code: InputCode = 'invalid_assessment_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    [
      'employee',
      'recommendation',
      'confidence',
      'options',
      'additionalAlternativeExplanations',
      'additionalAlternatives',
      'evidenceObservationIds',
      'actor',
      'rationale',
    ],
    'input',
    code,
  );
  const employee = validateEmployee(input.employee, 'employee', code);

  const recommendation = input.recommendation;
  if (!isPlainObject(recommendation)) {
    throw inputError(code, 'recommendation must be an object');
  }
  rejectUnknownKeys(recommendation, ['kind', 'text'], 'recommendation', code);
  if (!isRecommendationKind(recommendation.kind)) {
    throw inputError(
      code,
      `recommendation.kind must be one of ${RECOMMENDATION_KINDS.join(', ')} (got '${String(recommendation.kind)}')`,
    );
  }
  const recommendationText = requireString(recommendation.text, 'recommendation.text', code);
  if (recommendationText.length > MAX_TEXT_LENGTH) {
    throw inputError(
      code,
      `recommendation.text must be at most ${MAX_TEXT_LENGTH} characters (got ${recommendationText.length})`,
    );
  }

  const confidence = requireNumber(input.confidence, 'confidence', 0, 1, code);
  const options = validateAssessmentOptions(input.options);

  if (input.additionalAlternativeExplanations !== undefined) {
    if (!Array.isArray(input.additionalAlternativeExplanations)) {
      throw inputError(code, 'additionalAlternativeExplanations must be an array');
    }
    if (input.additionalAlternativeExplanations.length > MAX_ADDITIONAL_EXPLANATIONS) {
      throw inputError(
        code,
        `additionalAlternativeExplanations supports at most ${MAX_ADDITIONAL_EXPLANATIONS} entries (got ${input.additionalAlternativeExplanations.length})`,
      );
    }
  }
  const additionalAlternativeExplanations: ValidatedExplanation[] = [];
  for (const [index, entry] of (input.additionalAlternativeExplanations ?? []).entries()) {
    if (!isPlainObject(entry)) {
      throw inputError(code, `additionalAlternativeExplanations[${index}] must be an object`);
    }
    rejectUnknownKeys(entry, ['text'], `additionalAlternativeExplanations[${index}]`, code);
    const text = requireString(entry.text, `additionalAlternativeExplanations[${index}].text`, code);
    if (text.length > MAX_TEXT_LENGTH) {
      throw inputError(code, `additionalAlternativeExplanations[${index}].text must be at most ${MAX_TEXT_LENGTH} characters`);
    }
    additionalAlternativeExplanations.push({ text });
  }

  if (input.additionalAlternatives !== undefined) {
    if (!Array.isArray(input.additionalAlternatives)) {
      throw inputError(code, 'additionalAlternatives must be an array');
    }
    if (input.additionalAlternatives.length > MAX_ADDITIONAL_ALTERNATIVES) {
      throw inputError(
        code,
        `additionalAlternatives supports at most ${MAX_ADDITIONAL_ALTERNATIVES} entries (got ${input.additionalAlternatives.length})`,
      );
    }
  }
  const additionalAlternatives: ValidatedAlternativeAction[] = [];
  for (const [index, entry] of (input.additionalAlternatives ?? []).entries()) {
    if (!isPlainObject(entry)) {
      throw inputError(code, `additionalAlternatives[${index}] must be an object`);
    }
    rejectUnknownKeys(entry, ['kind', 'description'], `additionalAlternatives[${index}]`, code);
    if (!isAlternativeKind(entry.kind)) {
      throw inputError(
        code,
        `additionalAlternatives[${index}].kind must be one of ${ALTERNATIVE_KINDS.join(', ')} (got '${String(entry.kind)}')`,
      );
    }
    const description = requireString(entry.description, `additionalAlternatives[${index}].description`, code);
    if (description.length > MAX_TEXT_LENGTH) {
      throw inputError(code, `additionalAlternatives[${index}].description must be at most ${MAX_TEXT_LENGTH} characters`);
    }
    additionalAlternatives.push({ kind: entry.kind, description });
  }

  const evidenceObservationIds =
    input.evidenceObservationIds === undefined
      ? []
      : requireEvidenceIds(input.evidenceObservationIds, 'evidenceObservationIds', code);
  const actor = validateParty(input.actor, 'actor', code);
  const rationale = optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code);

  return {
    employee,
    recommendationKind: recommendation.kind,
    recommendationText,
    confidence,
    options,
    additionalAlternativeExplanations,
    additionalAlternatives,
    evidenceObservationIds,
    actor,
    rationale,
  };
}

// ---------------------------------------------------------------------------
// Human decisions
// ---------------------------------------------------------------------------

export interface ValidatedRecordDecisionInput {
  assessmentId: string;
  version: number | null; // null = current version
  decision: (typeof WORKFORCE_DECISION_KINDS)[number];
  decider: ValidatedDecider;
  rationale: string | null;
  followUpNote: string | null;
}

export function validateRecordDecisionInput(input: unknown): ValidatedRecordDecisionInput {
  const code: InputCode = 'invalid_decision_input';
  if (!isPlainObject(input)) throw inputError(code, 'input must be an object');
  rejectUnknownKeys(
    input,
    ['assessmentId', 'version', 'decision', 'decider', 'rationale', 'followUpNote'],
    'input',
    code,
  );
  const assessmentId = requireUuid(input.assessmentId, 'assessmentId', code);
  let version: number | null = null;
  if (input.version !== undefined && input.version !== null) {
    if (
      typeof input.version !== 'number' ||
      !Number.isInteger(input.version) ||
      input.version < 1
    ) {
      throw inputError(code, `version must be a positive integer (got ${String(input.version)})`);
    }
    version = input.version;
  }
  if (!isWorkforceDecisionKind(input.decision)) {
    throw inputError(
      code,
      `decision must be one of ${WORKFORCE_DECISION_KINDS.join(', ')} (got '${String(input.decision)}')`,
    );
  }
  const decider = validateDecider(input.decider, code);
  const rationale = optionalText(input.rationale, 'rationale', MAX_TEXT_LENGTH, code);
  const followUpNote = optionalText(input.followUpNote, 'followUpNote', MAX_TEXT_LENGTH, code);
  return { assessmentId, version, decision: input.decision, decider, rationale, followUpNote };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface ValidatedListRolesQuery {
  search: string | null;
  status: 'active' | 'retired' | null;
  limit: number;
}

export function validateListRolesQuery(query: unknown): ValidatedListRolesQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, ['search', 'status', 'limit'], 'query', 'invalid_query');
  let search: string | null = null;
  if (query.search !== undefined && query.search !== null) {
    search = requireString(query.search, 'search', 'invalid_query');
    if (search.length > MAX_SEARCH_LENGTH) {
      throw queryError(`search must be at most ${MAX_SEARCH_LENGTH} characters`);
    }
  }
  let status: 'active' | 'retired' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isWorkforceRecordStatus(query.status)) {
      throw queryError(`status must be 'active' or 'retired' (got '${String(query.status)}')`);
    }
    status = query.status;
  }
  const limit = optionalLimit(query.limit);
  return { search, status, limit: limit ?? DEFAULT_LIST_LIMIT };
}

export interface ValidatedVersionQuery {
  id: string;
  version: number | null;
}

function validateVersionQuery(
  query: unknown,
  idField: string,
  withVersion: boolean,
): ValidatedVersionQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, withVersion ? [idField, 'version'] : [idField], 'query', 'invalid_query');
  const id = requireUuid(query[idField], idField, 'invalid_query');
  let version: number | null = null;
  if (withVersion) {
    if (
      query.version === undefined ||
      typeof query.version !== 'number' ||
      !Number.isInteger(query.version) ||
      query.version < 1
    ) {
      throw queryError(`version must be a positive integer (got ${String(query.version)})`);
    }
    version = query.version;
  }
  return { id, version };
}

export function validateRoleVersionQuery(query: unknown): ValidatedVersionQuery {
  return validateVersionQuery(query, 'roleId', true);
}

export function validateRoleHistoryQuery(query: unknown): ValidatedVersionQuery {
  return validateVersionQuery(query, 'roleId', false);
}

export function validateAssignmentVersionQuery(query: unknown): ValidatedVersionQuery {
  return validateVersionQuery(query, 'assignmentId', true);
}

export function validateAssignmentHistoryQuery(query: unknown): ValidatedVersionQuery {
  return validateVersionQuery(query, 'assignmentId', false);
}

export function validateAssessmentVersionQuery(query: unknown): ValidatedVersionQuery {
  return validateVersionQuery(query, 'assessmentId', true);
}

export function validateAssessmentHistoryQuery(query: unknown): ValidatedVersionQuery {
  return validateVersionQuery(query, 'assessmentId', false);
}

export interface ValidatedListAssignmentsQuery {
  roleId: string | null;
  employeeId: string | null;
  status: 'active' | 'retired' | null;
  limit: number;
}

export function validateListAssignmentsQuery(query: unknown): ValidatedListAssignmentsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(
    query,
    ['roleId', 'employeeId', 'status', 'limit'],
    'query',
    'invalid_query',
  );
  let roleId: string | null = null;
  if (query.roleId !== undefined && query.roleId !== null) {
    roleId = requireUuid(query.roleId, 'roleId', 'invalid_query');
  }
  let employeeId: string | null = null;
  if (query.employeeId !== undefined && query.employeeId !== null) {
    employeeId = requireString(query.employeeId, 'employeeId', 'invalid_query');
    if (employeeId.length > MAX_KEY_LENGTH) {
      throw queryError(`employeeId must be at most ${MAX_KEY_LENGTH} characters`);
    }
  }
  let status: 'active' | 'retired' | null = null;
  if (query.status !== undefined && query.status !== null) {
    if (!isWorkforceRecordStatus(query.status)) {
      throw queryError(`status must be 'active' or 'retired' (got '${String(query.status)}')`);
    }
    status = query.status;
  }
  const limit = optionalLimit(query.limit);
  return { roleId, employeeId, status, limit: limit ?? DEFAULT_LIST_LIMIT };
}

export interface ValidatedListSignalsQuery {
  employeeId: string | null;
  kind: 'workload' | 'performance' | null;
  limit: number;
}

export function validateListSignalsQuery(query: unknown): ValidatedListSignalsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, ['employeeId', 'kind', 'limit'], 'query', 'invalid_query');
  let employeeId: string | null = null;
  if (query.employeeId !== undefined && query.employeeId !== null) {
    employeeId = requireString(query.employeeId, 'employeeId', 'invalid_query');
    if (employeeId.length > MAX_KEY_LENGTH) {
      throw queryError(`employeeId must be at most ${MAX_KEY_LENGTH} characters`);
    }
  }
  let kind: 'workload' | 'performance' | null = null;
  if (query.kind !== undefined && query.kind !== null) {
    if (!isWorkforceSignalKind(query.kind)) {
      throw queryError(`kind must be 'workload' or 'performance' (got '${String(query.kind)}')`);
    }
    kind = query.kind;
  }
  const limit = optionalLimit(query.limit);
  return { employeeId, kind, limit: limit ?? DEFAULT_LIST_LIMIT };
}

export interface ValidatedListAssessmentsQuery {
  employeeId: string | null;
  employmentImpacting: boolean | null;
  recommendationKind: (typeof RECOMMENDATION_KINDS)[number] | null;
  limit: number;
}

export function validateListAssessmentsQuery(query: unknown): ValidatedListAssessmentsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(
    query,
    ['employeeId', 'employmentImpacting', 'recommendationKind', 'limit'],
    'query',
    'invalid_query',
  );
  let employeeId: string | null = null;
  if (query.employeeId !== undefined && query.employeeId !== null) {
    employeeId = requireString(query.employeeId, 'employeeId', 'invalid_query');
    if (employeeId.length > MAX_KEY_LENGTH) {
      throw queryError(`employeeId must be at most ${MAX_KEY_LENGTH} characters`);
    }
  }
  let employmentImpacting: boolean | null = null;
  if (query.employmentImpacting !== undefined && query.employmentImpacting !== null) {
    if (typeof query.employmentImpacting !== 'boolean') {
      throw queryError(`employmentImpacting must be a boolean (got '${String(query.employmentImpacting)}')`);
    }
    employmentImpacting = query.employmentImpacting;
  }
  let recommendationKind: (typeof RECOMMENDATION_KINDS)[number] | null = null;
  if (query.recommendationKind !== undefined && query.recommendationKind !== null) {
    if (!isRecommendationKind(query.recommendationKind)) {
      throw queryError(
        `recommendationKind must be one of ${RECOMMENDATION_KINDS.join(', ')} (got '${String(query.recommendationKind)}')`,
      );
    }
    recommendationKind = query.recommendationKind;
  }
  const limit = optionalLimit(query.limit);
  return { employeeId, employmentImpacting, recommendationKind, limit: limit ?? DEFAULT_LIST_LIMIT };
}

export interface ValidatedListDecisionsQuery {
  assessmentId: string | null;
  decisionKind: (typeof WORKFORCE_DECISION_KINDS)[number] | null;
  limit: number;
}

export function validateListDecisionsQuery(query: unknown): ValidatedListDecisionsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, ['assessmentId', 'decisionKind', 'limit'], 'query', 'invalid_query');
  let assessmentId: string | null = null;
  if (query.assessmentId !== undefined && query.assessmentId !== null) {
    assessmentId = requireUuid(query.assessmentId, 'assessmentId', 'invalid_query');
  }
  let decisionKind: (typeof WORKFORCE_DECISION_KINDS)[number] | null = null;
  if (query.decisionKind !== undefined && query.decisionKind !== null) {
    if (!isWorkforceDecisionKind(query.decisionKind)) {
      throw queryError(
        `decisionKind must be one of ${WORKFORCE_DECISION_KINDS.join(', ')} (got '${String(query.decisionKind)}')`,
      );
    }
    decisionKind = query.decisionKind;
  }
  const limit = optionalLimit(query.limit);
  return { assessmentId, decisionKind, limit: limit ?? DEFAULT_LIST_LIMIT };
}

export function validateGetSignalQuery(query: unknown): { signalId: string } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, ['signalId'], 'query', 'invalid_query');
  return { signalId: requireUuid(query.signalId, 'signalId', 'invalid_query') };
}

export function validateGetDecisionQuery(query: unknown): { decisionId: string } {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  rejectUnknownKeys(query, ['decisionId'], 'query', 'invalid_query');
  return { decisionId: requireUuid(query.decisionId, 'decisionId', 'invalid_query') };
}
