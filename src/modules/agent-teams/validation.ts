// Pure validation/normalization logic of the agent-teams module (no
// database). Everything a caller may put into a team definition, a
// revision, a lifecycle transition or an outcome crosses these guards
// first; the SQL CHECK constraints and triggers in migrations/001–002
// mirror the load-bearing rules as defense in depth (the
// agents/missions discipline).
//
// Deliberately strict about unknown keys: a caller can never smuggle
// `id`, `tenantId`, `status`, `version` or `recordedAt` into content —
// a team's identity, tenancy and lifecycle state are minted by the
// system (content is history the moment a version is appended).
//
// The structural invariants that need more than shape — roster
// topology (single root, no cycles) and escalation consistency
// (routes need somewhere to land) — are checked by the pure functions
// of policy.ts, invoked from `validateTeamContent` so a create and a
// merged revision pass the SAME gate (the missions discipline: the
// merged snapshot validates like a fresh one).

import type { TenantContext } from '@/infra/tenant';
import { AgentTeamsError } from './errors';
import {
  ESCALATION_ROUTES,
  ESCALATION_TRIGGERS,
  OUTCOME_ASSESSMENTS,
  TEAM_PARTY_KINDS,
  TEAM_STATUSES,
  TEAM_TOPOLOGIES,
  escalationProblem,
  isEscalationRoute,
  isEscalationTrigger,
  isOutcomeAssessment,
  isTeamPartyKind,
  isTeamStatus,
  isTeamTopology,
  topologyProblem,
} from './policy';
import type {
  OutcomeAssessmentWord,
  TeamPartyKindWord,
  TeamTopologyWord,
} from './policy';
import type {
  ActivateTeamInput,
  CreateTeamInput,
  DissolveTeamInput,
  GetTeamQuery,
  ListTeamOutcomesQuery,
  ListTeamsQuery,
  ListTeamVersionsQuery,
  RecordTeamOutcomeInput,
  ReviseTeamInput,
  TeamEscalationRule,
  TeamMember,
  TeamObjective,
} from './types';

// ---------------------------------------------------------------------------
// Bounds (module-owned constants, re-exported through the contract)
// ---------------------------------------------------------------------------

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_SLUG_LENGTH = 64;
export const MAX_DISPLAY_NAME_CHARS = 128;
export const MAX_DESCRIPTION_CHARS = 2_048;
export const MAX_ROLE_CHARS = 128;
export const MAX_MEMBERS = 32;
export const MAX_OBJECTIVES = 25;
export const MAX_OBJECTIVE_KEY_LENGTH = 64;
export const MAX_OBJECTIVE_CHARS = 2_000;
export const MAX_SUCCESS_CRITERIA_CHARS = 2_000;
export const MAX_ESCALATION_RULES = 16;
export const MAX_OWNER_PRINCIPAL_CHARS = 200;
export const MAX_RATIONALE_CHARS = 2_000;
export const MAX_REASON_CHARS = 512;
export const MAX_HEADLINE_CHARS = 200;
export const MAX_DETAIL_CHARS = 4_000;
export const MAX_EVIDENCE_REFS = 32;
export const MAX_PARTY_LABEL_CHARS = 200;
export const MAX_PARTY_ID_CHARS = 200;
export const MAX_EVIDENCE_KIND_CHARS = 64;
export const MAX_EVIDENCE_REF_CHARS = 200;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const OBJECTIVE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
/** Opaque bounded printable identity (party/evidence ids) — filterable and log-safe. */
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;
const EVIDENCE_KIND_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

const CREATE_INPUT_KEYS = [
  'slug',
  'displayName',
  'description',
  'topology',
  'members',
  'objectives',
  'budget',
  'escalationRules',
  'ownerPrincipal',
  'actor',
  'rationale',
] as const;
const REVISE_INPUT_KEYS = [
  'teamId',
  'displayName',
  'description',
  'topology',
  'members',
  'objectives',
  'budget',
  'escalationRules',
  'ownerPrincipal',
  'actor',
  'rationale',
] as const;
const ACTIVATE_INPUT_KEYS = ['teamId', 'idempotencyKey'] as const;
const DISSOLVE_INPUT_KEYS = ['teamId', 'reason', 'idempotencyKey'] as const;
const OUTCOME_INPUT_KEYS = [
  'teamId',
  'objectiveKey',
  'headline',
  'detail',
  'assessment',
  'evidence',
  'actor',
] as const;
const GET_TEAM_QUERY_KEYS = ['teamId', 'slug'] as const;
const LIST_TEAMS_QUERY_KEYS = ['status', 'limit'] as const;
const LIST_VERSIONS_QUERY_KEYS = ['teamId'] as const;
const LIST_OUTCOMES_QUERY_KEYS = ['teamId', 'objectiveKey', 'limit'] as const;

const CONTENT_KEYS = [
  'displayName',
  'description',
  'topology',
  'members',
  'objectives',
  'budget',
  'escalationRules',
  'ownerPrincipal',
] as const;
const MEMBER_KEYS = ['agentId', 'role', 'reportsTo'] as const;
const OBJECTIVE_KEYS = ['key', 'objective', 'successCriteria'] as const;
const RULE_KEYS = ['trigger', 'threshold', 'route'] as const;
const PARTY_KEYS = ['kind', 'id', 'label'] as const;
const EVIDENCE_KEYS = ['kind', 'id', 'label'] as const;
const BUDGET_KEYS = ['amountMinor', 'currency'] as const;

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAgentTeamsTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new AgentTeamsError('invalid_context', 'TenantContext must be an object');
  }
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AgentTeamsError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AgentTeamsError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority) || !ctx.authority.every((claim) => typeof claim === 'string')) {
    throw new AgentTeamsError(
      'invalid_context',
      'TenantContext.authority must be an array of claim strings',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

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
): void {
  for (const key of Object.keys(value)) {
    if (!(allowed as readonly string[]).includes(key)) {
      throw inputError(`unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`);
    }
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw inputError(`${field} must be a string`);
  const text = value.trim();
  if (text === '') throw inputError(`${field} must be a non-empty string`);
  return text;
}

function optionalTrimmed(value: unknown, field: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > maxChars) {
    throw inputError(`${field} must be at most ${maxChars} characters`);
  }
  return text === '' ? null : text;
}

function requireUuid(value: unknown, field: string): string {
  const text = requireString(value, field);
  if (!UUID_PATTERN.test(text)) {
    throw inputError(`${field} must be a uuid (got '${text}')`);
  }
  return text.toLowerCase();
}

function requireLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_LIST_LIMIT : value;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_LIST_LIMIT
  ) {
    throw queryError(
      `query.limit must be an integer in [1, ${MAX_LIST_LIMIT}] (got ${String(limit)})`,
    );
  }
  return limit;
}

function optionalIdempotencyKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, 'idempotencyKey');
  if (text.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw inputError(
      `idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters (got ${text.length})`,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(text)) {
    throw inputError(`idempotencyKey must match ${IDEMPOTENCY_KEY_PATTERN.source} (got '${text}')`);
  }
  return text;
}

/** A bounded opaque identity string (party/evidence ids). */
function optionalIdentity(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  const text = requireString(value, field);
  if (text.length > MAX_PARTY_ID_CHARS) {
    throw inputError(`${field} must be at most ${MAX_PARTY_ID_CHARS} characters`);
  }
  if (!IDENTITY_PATTERN.test(text)) {
    throw inputError(`${field} must match ${IDENTITY_PATTERN.source} (got '${text}')`);
  }
  return text;
}

function inputError(message: string): AgentTeamsError {
  return new AgentTeamsError('invalid_team_input', message);
}

function queryError(message: string): AgentTeamsError {
  return new AgentTeamsError('invalid_query', message);
}

/** The shared string guards throw input-flavored errors; queries deserve `invalid_query`. */
function wrapQueryError<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof AgentTeamsError && error.code === 'invalid_team_input') {
      throw new AgentTeamsError('invalid_query', error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Parties, evidence, members, objectives, rules, budgets
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of a `TeamParty`. */
export interface ValidatedParty {
  kind: TeamPartyKindWord;
  id: string | null;
  label: string | null;
}

function validateParty(party: unknown, where: string): ValidatedParty {
  if (!isPlainObject(party)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(party, PARTY_KEYS, where);
  const kind = party.kind;
  if (!isTeamPartyKind(kind)) {
    throw inputError(
      `${where}.kind must be one of ${TEAM_PARTY_KINDS.join(', ')} (got '${String(kind)}')`,
    );
  }
  const id = optionalIdentity(party.id, `${where}.id`);
  const label = optionalTrimmed(party.label, `${where}.label`, MAX_PARTY_LABEL_CHARS);
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — the party must be traceable`);
  }
  return { kind, id, label };
}

/**
 * The acting party of a change: the caller's principal, unless an
 * explicit one is given. The principal is bound by the SERVICE (which
 * owns the TenantContext), so validation only checks explicit parties.
 */
function resolveActor(input: unknown): ValidatedParty | null {
  if (input === undefined || input === null) return null;
  return validateParty(input, 'actor');
}

/** Fully validated + normalized form of one evidence reference. */
export interface ValidatedEvidenceRef {
  kind: string;
  id: string | null;
  label: string | null;
}

function validateEvidenceRef(ref: unknown, where: string): ValidatedEvidenceRef {
  if (!isPlainObject(ref)) throw inputError(`${where} must be an object`);
  rejectUnknownKeys(ref, EVIDENCE_KEYS, where);
  const kind = requireString(ref.kind, `${where}.kind`).toLowerCase();
  if (kind.length > MAX_EVIDENCE_KIND_CHARS || !EVIDENCE_KIND_PATTERN.test(kind)) {
    throw inputError(`${where}.kind must match ${EVIDENCE_KIND_PATTERN.source} (got '${kind}')`);
  }
  const id = optionalIdentity(ref.id, `${where}.id`);
  const label = optionalTrimmed(ref.label, `${where}.label`, MAX_EVIDENCE_REF_CHARS);
  if (id === null && label === null) {
    throw inputError(`${where} must carry an id or a label — evidence must be traceable`);
  }
  return { kind, id, label };
}

function validateMembers(value: unknown): TeamMember[] {
  if (value === undefined || value === null || !Array.isArray(value)) {
    throw inputError('members must be an array of roster entries');
  }
  if (value.length === 0) {
    throw inputError(
      'members must contain at least one roster entry — a team is composed of agents',
    );
  }
  if (value.length > MAX_MEMBERS) {
    throw inputError(
      `members must contain at most ${MAX_MEMBERS} roster entries (got ${value.length})`,
    );
  }
  const out: TeamMember[] = [];
  for (const [index, entry] of value.entries()) {
    const where = `members[${index}]`;
    if (!isPlainObject(entry)) throw inputError(`${where} must be an object`);
    rejectUnknownKeys(entry, MEMBER_KEYS, where);
    const agentId = requireUuid(entry.agentId, `${where}.agentId`);
    const role = requireString(entry.role, `${where}.role`);
    if (role.length > MAX_ROLE_CHARS) {
      throw inputError(`${where}.role must be at most ${MAX_ROLE_CHARS} characters`);
    }
    const reportsTo =
      entry.reportsTo === undefined || entry.reportsTo === null
        ? null
        : requireUuid(entry.reportsTo, `${where}.reportsTo`);
    out.push({ agentId, role, reportsTo });
  }
  return out;
}

function validateObjectives(value: unknown): TeamObjective[] {
  if (value === undefined || value === null || !Array.isArray(value)) {
    throw inputError('objectives must be an array of shared objectives');
  }
  if (value.length === 0) {
    throw inputError(
      'objectives must contain at least one shared objective — a team works toward shared objectives',
    );
  }
  if (value.length > MAX_OBJECTIVES) {
    throw inputError(
      `objectives must contain at most ${MAX_OBJECTIVES} shared objectives (got ${value.length})`,
    );
  }
  const out: TeamObjective[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const where = `objectives[${index}]`;
    if (!isPlainObject(entry)) throw inputError(`${where} must be an object`);
    rejectUnknownKeys(entry, OBJECTIVE_KEYS, where);
    const key = requireString(entry.key, `${where}.key`).toLowerCase();
    if (!OBJECTIVE_KEY_PATTERN.test(key)) {
      throw inputError(`${where}.key must match ${OBJECTIVE_KEY_PATTERN.source} (got '${key}')`);
    }
    if (seen.has(key)) {
      throw inputError(`objective keys must be unique (duplicate '${key}')`);
    }
    seen.add(key);
    const objective = requireString(entry.objective, `${where}.objective`);
    if (objective.length > MAX_OBJECTIVE_CHARS) {
      throw inputError(`${where}.objective must be at most ${MAX_OBJECTIVE_CHARS} characters`);
    }
    const successCriteria = optionalTrimmed(
      entry.successCriteria,
      `${where}.successCriteria`,
      MAX_SUCCESS_CRITERIA_CHARS,
    );
    out.push({ key, objective, successCriteria });
  }
  return out;
}

function validateEscalationRules(value: unknown): TeamEscalationRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw inputError('escalationRules must be an array of escalation rules');
  }
  if (value.length > MAX_ESCALATION_RULES) {
    throw inputError(
      `escalationRules must contain at most ${MAX_ESCALATION_RULES} rules (got ${value.length})`,
    );
  }
  const out: TeamEscalationRule[] = [];
  for (const [index, entry] of value.entries()) {
    const where = `escalationRules[${index}]`;
    if (!isPlainObject(entry)) throw inputError(`${where} must be an object`);
    rejectUnknownKeys(entry, RULE_KEYS, where);
    const trigger: unknown = entry.trigger;
    if (!isEscalationTrigger(trigger)) {
      throw inputError(
        `${where}.trigger must be one of ${ESCALATION_TRIGGERS.join(', ')} (got '${String(trigger)}')`,
      );
    }
    const route: unknown = entry.route;
    if (!isEscalationRoute(route)) {
      throw inputError(
        `${where}.route must be one of ${ESCALATION_ROUTES.join(', ')} (got '${String(route)}')`,
      );
    }
    let threshold: number | null = null;
    if (entry.threshold !== undefined && entry.threshold !== null) {
      if (typeof entry.threshold !== 'number' || !Number.isFinite(entry.threshold)) {
        throw inputError(`${where}.threshold must be a finite number`);
      }
      threshold = entry.threshold;
    }
    out.push({ trigger, threshold, route });
  }
  return out;
}

/** Fully validated + normalized form of a `TeamBudget`. */
export interface ValidatedBudget {
  amountMinor: number;
  currency: string;
}

function validateBudget(value: unknown, field: string): ValidatedBudget {
  if (!isPlainObject(value)) throw inputError(`${field} must be an object`);
  rejectUnknownKeys(value, BUDGET_KEYS, field);
  const amountMinor = value.amountMinor;
  if (
    typeof amountMinor !== 'number' ||
    !Number.isInteger(amountMinor) ||
    amountMinor < 0 ||
    amountMinor > 9_007_199_254_740_991
  ) {
    throw inputError(
      `${field}.amountMinor must be an integer in [0, 9007199254740991] minor units (got ${String(amountMinor)})`,
    );
  }
  const currency = requireString(value.currency, `${field}.currency`).toUpperCase();
  if (!CURRENCY_PATTERN.test(currency)) {
    throw inputError(
      `${field}.currency must be a 3-letter ISO 4217-shaped code (got '${currency}')`,
    );
  }
  return { amountMinor, currency };
}

// ---------------------------------------------------------------------------
// Team content (the create/revise merge gate)
// ---------------------------------------------------------------------------

/**
 * Fully validated + normalized team content — what a version row
 * stores. Structural topology/escalation invariants (policy.ts) are
 * enforced here, so a fresh create and a merged revision pass the SAME
 * gate (the missions discipline).
 */
export interface ValidatedTeamContent {
  displayName: string | null;
  description: string | null;
  topology: TeamTopologyWord;
  members: TeamMember[];
  objectives: TeamObjective[];
  budget: ValidatedBudget;
  escalationRules: TeamEscalationRule[];
  ownerPrincipal: string | null;
}

/**
 * Validates a FULL team content object (all fields present — the create
 * input's content half, or a revision's merged snapshot). Throws
 * `invalid_team_input` naming the offending field/problem.
 */
export function validateTeamContent(content: Record<string, unknown>): ValidatedTeamContent {
  rejectUnknownKeys(content, CONTENT_KEYS, 'the team content');
  const displayName = optionalTrimmed(content.displayName, 'displayName', MAX_DISPLAY_NAME_CHARS);
  const description = optionalTrimmed(content.description, 'description', MAX_DESCRIPTION_CHARS);
  const topology = content.topology;
  if (!isTeamTopology(topology)) {
    throw inputError(
      `topology must be one of ${TEAM_TOPOLOGIES.join(', ')} (got '${String(topology)}')`,
    );
  }
  const members = validateMembers(content.members);
  const objectives = validateObjectives(content.objectives);
  const budget = validateBudget(content.budget, 'budget');
  const escalationRules = validateEscalationRules(content.escalationRules);
  const ownerPrincipal = optionalTrimmed(
    content.ownerPrincipal,
    'ownerPrincipal',
    MAX_OWNER_PRINCIPAL_CHARS,
  );

  // Structural invariants (pure policy): the roster's topology and the
  // escalation rules' landing spots.
  const topologyFailure = topologyProblem(topology, members);
  if (topologyFailure !== null) {
    const who =
      topologyFailure.agentId === undefined ? '' : ` (member '${topologyFailure.agentId}')`;
    throw inputError(
      `the roster does not form a valid ${topology} team${who}: ${topologyFailure.problem}`,
    );
  }
  const escalationFailure = escalationProblem(escalationRules, topology, ownerPrincipal !== null);
  if (escalationFailure !== null) {
    const where =
      escalationFailure.index === undefined
        ? 'the escalation rules'
        : `escalationRules[${escalationFailure.index}]`;
    throw inputError(`${where} are not well-formed: ${escalationFailure.problem}`);
  }

  return {
    displayName,
    description,
    topology,
    members,
    objectives,
    budget,
    escalationRules,
    ownerPrincipal,
  };
}

// ---------------------------------------------------------------------------
// createTeam
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `CreateTeamInput`. */
export interface ValidatedCreateTeamInput {
  slug: string;
  content: ValidatedTeamContent;
  /** Null = default to the calling principal (bound by the service). */
  actor: ValidatedParty | null;
  rationale: string | null;
}

export function validateCreateTeamInput(input: CreateTeamInput): ValidatedCreateTeamInput {
  if (!isPlainObject(input)) throw inputError('team input must be an object');
  rejectUnknownKeys(input, CREATE_INPUT_KEYS, 'the team input');

  const slug = requireString(input.slug, 'slug').toLowerCase();
  if (!SLUG_PATTERN.test(slug)) {
    throw inputError(`slug must match ${SLUG_PATTERN.source} (got '${slug}')`);
  }

  const content = validateTeamContent({
    displayName: input.displayName ?? null,
    description: input.description ?? null,
    topology: input.topology,
    members: input.members,
    objectives: input.objectives,
    budget: input.budget,
    escalationRules: input.escalationRules ?? [],
    ownerPrincipal: input.ownerPrincipal ?? null,
  });

  const actor = resolveActor(input.actor);
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_CHARS);
  return { slug, content, actor, rationale };
}

// ---------------------------------------------------------------------------
// reviseTeam (patch shape; the service merges and re-validates)
// ---------------------------------------------------------------------------

/** The validated patch fields of a revision (undefined = carry over). */
export interface ValidatedRevisionPatch {
  displayName?: string | null;
  description?: string | null;
  topology?: TeamTopologyWord;
  members?: TeamMember[];
  objectives?: TeamObjective[];
  budget?: ValidatedBudget;
  escalationRules?: TeamEscalationRule[];
  /** Tri-state: undefined = unchanged, null = cleared, string = set. */
  ownerPrincipal?: string | null;
}

/** Fully validated + normalized form of `ReviseTeamInput`. */
export interface ValidatedReviseTeamInput {
  teamId: string;
  patch: ValidatedRevisionPatch;
  /** Null = default to the calling principal (bound by the service). */
  actor: ValidatedParty | null;
  rationale: string | null;
}

export function validateReviseTeamInput(input: ReviseTeamInput): ValidatedReviseTeamInput {
  if (!isPlainObject(input)) throw inputError('team revision must be an object');
  rejectUnknownKeys(input, REVISE_INPUT_KEYS, 'the team revision');

  const teamId = requireUuid(input.teamId, 'teamId');

  const patch: ValidatedRevisionPatch = {};
  if (input.displayName !== undefined) {
    patch.displayName = optionalTrimmed(input.displayName, 'displayName', MAX_DISPLAY_NAME_CHARS);
  }
  if (input.description !== undefined) {
    patch.description = optionalTrimmed(input.description, 'description', MAX_DESCRIPTION_CHARS);
  }
  if (input.topology !== undefined && input.topology !== null) {
    if (!isTeamTopology(input.topology)) {
      throw inputError(
        `topology must be one of ${TEAM_TOPOLOGIES.join(', ')} (got '${String(input.topology)}')`,
      );
    }
    patch.topology = input.topology;
  }
  if (input.members !== undefined) {
    patch.members = validateMembers(input.members);
  }
  if (input.objectives !== undefined) {
    patch.objectives = validateObjectives(input.objectives);
  }
  if (input.budget !== undefined && input.budget !== null) {
    patch.budget = validateBudget(input.budget, 'budget');
  }
  if (input.escalationRules !== undefined) {
    patch.escalationRules = validateEscalationRules(input.escalationRules);
  }
  if (input.ownerPrincipal !== undefined) {
    patch.ownerPrincipal = optionalTrimmed(
      input.ownerPrincipal,
      'ownerPrincipal',
      MAX_OWNER_PRINCIPAL_CHARS,
    );
  }

  if (Object.keys(patch).length === 0) {
    throw inputError('team revision carries no change (set at least one content field)');
  }

  const actor = resolveActor(input.actor);
  const rationale = optionalTrimmed(input.rationale, 'rationale', MAX_RATIONALE_CHARS);
  return { teamId, patch, actor, rationale };
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Fully validated form of `ActivateTeamInput`. */
export interface ValidatedActivateInput {
  teamId: string;
  idempotencyKey: string | null;
}

export function validateActivateTeamInput(input: ActivateTeamInput): ValidatedActivateInput {
  if (!isPlainObject(input)) throw inputError('activation input must be an object');
  rejectUnknownKeys(input, ACTIVATE_INPUT_KEYS, 'the activation input');
  return {
    teamId: requireUuid(input.teamId, 'teamId'),
    idempotencyKey: optionalIdempotencyKey(input.idempotencyKey),
  };
}

/** Fully validated form of `DissolveTeamInput`. */
export interface ValidatedDissolveInput {
  teamId: string;
  reason: string;
  idempotencyKey: string | null;
}

export function validateDissolveTeamInput(input: DissolveTeamInput): ValidatedDissolveInput {
  if (!isPlainObject(input)) throw inputError('dissolution input must be an object');
  rejectUnknownKeys(input, DISSOLVE_INPUT_KEYS, 'the dissolution input');
  const teamId = requireUuid(input.teamId, 'teamId');
  const reason = requireString(input.reason, 'reason');
  if (reason.length > MAX_REASON_CHARS) {
    throw inputError(`reason must be at most ${MAX_REASON_CHARS} characters`);
  }
  return { teamId, reason, idempotencyKey: optionalIdempotencyKey(input.idempotencyKey) };
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** Fully validated + normalized form of `RecordTeamOutcomeInput`. */
export interface ValidatedOutcomeInput {
  teamId: string;
  objectiveKey: string | null;
  headline: string;
  detail: string | null;
  assessment: OutcomeAssessmentWord;
  evidence: ValidatedEvidenceRef[];
  /** Null = default to the calling principal (bound by the service). */
  actor: ValidatedParty | null;
}

export function validateRecordTeamOutcomeInput(
  input: RecordTeamOutcomeInput,
): ValidatedOutcomeInput {
  if (!isPlainObject(input)) throw inputError('team outcome input must be an object');
  rejectUnknownKeys(input, OUTCOME_INPUT_KEYS, 'the team outcome input');

  const teamId = requireUuid(input.teamId, 'teamId');

  let objectiveKey: string | null = null;
  if (input.objectiveKey !== undefined && input.objectiveKey !== null) {
    objectiveKey = requireString(input.objectiveKey, 'objectiveKey').toLowerCase();
    if (!OBJECTIVE_KEY_PATTERN.test(objectiveKey)) {
      throw inputError(
        `objectiveKey must match ${OBJECTIVE_KEY_PATTERN.source} (got '${objectiveKey}')`,
      );
    }
  }

  const headline = requireString(input.headline, 'headline');
  if (headline.length > MAX_HEADLINE_CHARS) {
    throw inputError(`headline must be at most ${MAX_HEADLINE_CHARS} characters`);
  }
  const detail = optionalTrimmed(input.detail, 'detail', MAX_DETAIL_CHARS);

  const assessment: unknown = input.assessment;
  if (!isOutcomeAssessment(assessment)) {
    throw inputError(
      `assessment must be one of ${OUTCOME_ASSESSMENTS.join(', ')} (got '${String(assessment)}')`,
    );
  }

  let evidence: ValidatedEvidenceRef[] = [];
  if (input.evidence !== undefined && input.evidence !== null) {
    if (!Array.isArray(input.evidence)) {
      throw inputError('evidence must be an array of references');
    }
    if (input.evidence.length > MAX_EVIDENCE_REFS) {
      throw inputError(
        `evidence must contain at most ${MAX_EVIDENCE_REFS} references (got ${input.evidence.length})`,
      );
    }
    evidence = input.evidence.map((entry, index) =>
      validateEvidenceRef(entry, `evidence[${index}]`),
    );
  }

  const actor = resolveActor(input.actor);
  return { teamId, objectiveKey, headline, detail, assessment, evidence, actor };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Fully validated form of `GetTeamQuery` (exactly one identifier). */
export interface ValidatedGetTeamQuery {
  teamId: string | null;
  slug: string | null;
}

export function validateGetTeamQuery(query: GetTeamQuery): ValidatedGetTeamQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, GET_TEAM_QUERY_KEYS, 'the query');
    const hasTeamId = query.teamId !== undefined && query.teamId !== null;
    const hasSlug = query.slug !== undefined && query.slug !== null;
    if (hasTeamId === hasSlug) {
      throw inputError('the query must carry exactly one of teamId or slug');
    }
    if (hasTeamId) {
      return { teamId: requireUuid(query.teamId, 'query.teamId'), slug: null };
    }
    const slug = requireString(query.slug, 'query.slug').toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw inputError(`query.slug must match ${SLUG_PATTERN.source} (got '${slug}')`);
    }
    return { teamId: null, slug };
  });
}

/** Fully validated form of `ListTeamsQuery`. */
export interface ValidatedListTeamsQuery {
  status: 'draft' | 'active' | 'dissolved' | null;
  limit: number;
}

export function validateListTeamsQuery(query: ListTeamsQuery): ValidatedListTeamsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_TEAMS_QUERY_KEYS, 'the query');
    let status: ValidatedListTeamsQuery['status'] = null;
    if (query.status !== undefined && query.status !== null) {
      if (!isTeamStatus(query.status)) {
        throw inputError(
          `query.status must be one of ${TEAM_STATUSES.join(', ')} (got '${String(query.status)}')`,
        );
      }
      status = query.status;
    }
    return { status, limit: requireLimit(query.limit) };
  });
}

/** Fully validated form of `ListTeamVersionsQuery`. */
export interface ValidatedListVersionsQuery {
  teamId: string;
}

export function validateListTeamVersionsQuery(
  query: ListTeamVersionsQuery,
): ValidatedListVersionsQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_VERSIONS_QUERY_KEYS, 'the query');
    return { teamId: requireUuid(query.teamId, 'query.teamId') };
  });
}

/** Fully validated form of `ListTeamOutcomesQuery`. */
export interface ValidatedListOutcomesQuery {
  teamId: string;
  objectiveKey: string | null;
  limit: number;
}

export function validateListTeamOutcomesQuery(
  query: ListTeamOutcomesQuery,
): ValidatedListOutcomesQuery {
  if (!isPlainObject(query)) throw queryError('query must be an object');
  return wrapQueryError(() => {
    rejectUnknownKeys(query, LIST_OUTCOMES_QUERY_KEYS, 'the query');
    const teamId = requireUuid(query.teamId, 'query.teamId');
    let objectiveKey: string | null = null;
    if (query.objectiveKey !== undefined && query.objectiveKey !== null) {
      objectiveKey = requireString(query.objectiveKey, 'query.objectiveKey').toLowerCase();
      if (!OBJECTIVE_KEY_PATTERN.test(objectiveKey)) {
        throw inputError(
          `query.objectiveKey must match ${OBJECTIVE_KEY_PATTERN.source} (got '${objectiveKey}')`,
        );
      }
    }
    return { teamId, objectiveKey, limit: requireLimit(query.limit) };
  });
}
