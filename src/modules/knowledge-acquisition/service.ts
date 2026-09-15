// Implementation of the knowledge-acquisition module's public operations
// (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`mission_not_found` / `plan_not_found`), on
// reads AND on writes.
//
// W012 acceptance is carried by these deliberate properties, all tested:
//   1. MISSION-DRIVEN: the planner chooses among the mission's CURRENT
//      candidate menu (loaded through the missions contract — the
//      sanctioned `missions → knowledge-acquisition` dependency); signal
//      entries that name anything else are rejected, and the plan records
//      the mission version it was computed against. The question it
//      composes for a person is derived from the mission's knowledge
//      objective by pure code (no LLM — reproducible and auditable).
//   2. NEXT-BEST, NOT EVERYTHING (lock 17): one planning pass selects ONE
//      action — the first eligible candidate in the deterministic ranking.
//      Candidates a previous plan already chose for this mission are
//      excluded (`already_attempted`), and candidates whose cost exceeds
//      the mission's remaining investigation budget are excluded
//      (`over_budget`). The read-attempts → score → choose → insert
//      sequence runs inside one transaction serialized by a
//      transaction-scoped PostgreSQL advisory lock keyed on
//      (tenant, mission), so concurrent planners cannot double-select.
//   3. DETERMINISTIC + EXPLAINABLE (ADR-0018): the six positive signals
//      are separately represented, scored by fixed weights
//      (ranking.ts — the policy/workflow level) and totally ordered
//      (score ↓, §7 kind order, key ↑). The full ranked snapshot —
//      signals, score, cost share, dominant signal, per-candidate
//      exclusion — is PERSISTED on every plan row: the rationale is
//      auditable after the fact, and a selection that changed because a
//      signal changed is reconstructable from the two snapshots.
//   4. POLICY-GATED QUESTIONING (§7 "when policy permits", §20): asking
//      an employee a question is an ASK-level 'employee-messaging'
//      action; the planner evaluates the actions module's authority
//      matrix (W009) through its read-only contract operation whenever
//      the menu contains person candidates. 'forbidden' excludes every
//      person candidate (`ask_policy_forbidden` — explicit access policy
//      is never overridden by ranking); 'approval_required' keeps the
//      person selectable and flags the question as gated; the evaluation
//      snapshot is persisted on the plan. Person candidates must resolve
//      to a readable person record, an ACTIVE employee, and a verified
//      linked channel identity (the people/identity W002 surface) before
//      they may be asked — targeted questioning needs a real, reachable
//      employee, uniformly reported as exclusion reasons (no leak).
//   5. APPEND-ONLY: planner decisions and outcomes are committed history;
//      no update/delete operation exists on the contract and PostgreSQL
//      itself rejects UPDATE/DELETE/TRUNCATE via migration 001 triggers.
//      The first outcome on a plan wins (`outcome_conflict`).
//   6. EVIDENCE-BACKED ANSWERS: an 'answered' outcome must carry evidence;
//      it is recorded as an immutable observation through the observations
//      contract (W004) with the acquired source as provenance — acquired
//      knowledge enters the loop as evidence, never as truth (lock 5/10).
//
// Storage shape: `acquisition_plans` (the decision + rationale + audit
// quartet) and `acquisition_outcomes` (first-write-wins terminal state,
// FK-scoped to its plan within the tenant).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { evaluateActionAuthority } from '@/modules/actions/contract';
import {
  getEmployeeByPerson,
  getPerson,
  listPersonIdentities,
  PeopleError,
} from '@/modules/people/contract';
import {
  getMission,
  MissionsError,
  type Mission,
  type MissionCandidate,
  type MissionCandidateKind,
} from '@/modules/missions/contract';
import {
  ObservationsError,
  recordObservation,
  type ObservationSourceKind,
} from '@/modules/observations/contract';
import { KnowledgeAcquisitionError } from './errors';
import {
  ACQUISITION_ACTIONS,
  candidateKey,
  composeTargetedQuestion,
  orderRankedCandidates,
  scoreCandidateSignals,
} from './ranking';
import {
  assertAcquisitionTenantContext,
  validateListAcquisitionPlansQuery,
  validatePlanNextAcquisitionInput,
  validateRecordAcquisitionOutcomeInput,
  type ValidatedCandidateSignals,
  type ValidatedOutcomeInput,
  type ValidatedPlanInput,
} from './validation';
import type {
  AcquisitionActionKind,
  AcquisitionOutcomeKind,
  AcquisitionPlan,
  AcquisitionPlanOutcome,
  AskPolicyEvaluation,
  ExclusionReason,
  ListAcquisitionPlansQuery,
  PlanDecision,
  PlanNextAcquisitionInput,
  RankedCandidate,
  RecordAcquisitionOutcomeInput,
} from './types';

// ---------------------------------------------------------------------------
// Wiring constants (the policy integration points, exported via contract)
// ---------------------------------------------------------------------------

/** Asking an employee a question is an 'employee-messaging' ASK action (§20). */
export const ASK_ACTION_KIND = 'employee-messaging';

/** The authority level of requesting information from a human (§20). */
export const ASK_AUTHORITY_LEVEL = 'ASK' as const;

/** Observation kind of an acquisition answer (W004 evidence). */
export const ANSWER_OBSERVATION_KIND = 'acquisition.answer';

/** Provider-neutral channel key for evidence recorded by this module (lock 16). */
export const ACQUISITION_CHANNEL = 'knowledge-acquisition';

/**
 * How a mission candidate kind maps onto an observation source kind when
 * an answer is recorded as evidence: documents are (unregistered) sources;
 * an analysis is Aurum's own analytical work, recorded with the 'agent'
 * origin kind and the analysis label.
 */
const OBSERVATION_SOURCE_KIND_BY_CANDIDATE: Record<MissionCandidateKind, ObservationSourceKind> = {
  person: 'person',
  system: 'system',
  document: 'source',
  external: 'external',
  agent: 'agent',
  analysis: 'agent',
};

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

/** Row shape of `acquisition_plans`. */
interface PlanRow extends DbRow {
  id: string;
  tenant_id: string;
  mission_id: string;
  mission_version: number | string;
  decision: string;
  chosen_kind: string | null;
  chosen_id: string | null;
  chosen_label: string | null;
  action: string | null;
  question: string | null;
  ask_policy_outcome: string | null;
  ask_policy_source: string | null;
  ranked: unknown;
  budget_remaining: number | string;
  budget_currency: string;
  estimated_cost: number | string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  planned_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the plan ⋈ outcome join (the read model). */
interface JoinedPlanRow extends PlanRow {
  outcome_kind: string | null;
  outcome_note: string | null;
  evidence_observation_id: string | null;
  outcome_recorded_by_principal: string | null;
  outcome_recorded_at: Date | string | null;
}

const PLAN_FIELDS = [
  'id',
  'tenant_id',
  'mission_id',
  'mission_version',
  'decision',
  'chosen_kind',
  'chosen_id',
  'chosen_label',
  'action',
  'question',
  'ask_policy_outcome',
  'ask_policy_source',
  'ranked',
  'budget_remaining',
  'budget_currency',
  'estimated_cost',
  'actor_kind',
  'actor_id',
  'actor_label',
  'planned_by_principal',
  'rationale',
  'recorded_at',
] as const;

/** Unqualified plan columns — the INSERT ... RETURNING list. */
const PLAN_COLUMNS = PLAN_FIELDS.join(', ');

/** Tenant-qualified plan columns — the join-select list. */
const QUALIFIED_PLAN_COLUMNS = PLAN_FIELDS.map((field) => `p.${field}`).join(', ');

const PLAN_WITH_OUTCOME_FROM = `FROM acquisition_plans p
  LEFT JOIN acquisition_outcomes o
    ON o.plan_id = p.id AND o.tenant_id = p.tenant_id`;

const OUTCOME_COLUMNS = `o.outcome AS outcome_kind, o.note AS outcome_note,
    o.evidence_observation_id,
    o.recorded_by_principal AS outcome_recorded_by_principal,
    o.recorded_at AS outcome_recorded_at`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function planNotFound(planId: string): KnowledgeAcquisitionError {
  return new KnowledgeAcquisitionError(
    'plan_not_found',
    `acquisition plan '${planId}' does not exist in this tenant`,
  );
}

function planInputError(message: string): KnowledgeAcquisitionError {
  return new KnowledgeAcquisitionError('invalid_plan_input', message);
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapRanked(value: unknown): RankedCandidate[] {
  return Array.isArray(value) ? (value as RankedCandidate[]) : [];
}

function mapChosen(row: {
  chosen_kind: string | null;
  chosen_id: string | null;
  chosen_label: string | null;
}): AcquisitionPlan['chosen'] {
  if (row.chosen_kind === null) return null;
  return {
    kind: row.chosen_kind as MissionCandidateKind, // CHECK-constrained by migration 001
    id: row.chosen_id,
    label: row.chosen_label,
  };
}

function mapAskPolicy(row: {
  ask_policy_outcome: string | null;
  ask_policy_source: string | null;
}): AskPolicyEvaluation | null {
  if (row.ask_policy_outcome === null) return null;
  return {
    outcome: row.ask_policy_outcome as AskPolicyEvaluation['outcome'], // CHECK-constrained
    resolvedVia: row.ask_policy_source as AskPolicyEvaluation['resolvedVia'], // CHECK-constrained
  };
}

function mapOutcome(row: JoinedPlanRow): AcquisitionPlanOutcome | null {
  if (row.outcome_kind === null) return null;
  return {
    planId: row.id,
    outcome: row.outcome_kind as AcquisitionOutcomeKind, // CHECK-constrained
    note: row.outcome_note,
    evidenceObservationId: row.evidence_observation_id,
    recordedByPrincipal: row.outcome_recorded_by_principal!,
    recordedAt: toIso(row.outcome_recorded_at!),
  };
}

function mapPlan(row: JoinedPlanRow): AcquisitionPlan {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    missionVersion: toInt(row.mission_version),
    decision: row.decision as PlanDecision, // CHECK-constrained
    chosen: mapChosen(row),
    action: row.action as AcquisitionActionKind | null, // CHECK-constrained
    question: row.question,
    askPolicy: mapAskPolicy(row),
    ranked: mapRanked(row.ranked),
    budgetRemaining: toInt(row.budget_remaining),
    budgetCurrency: row.budget_currency,
    estimatedCost: row.estimated_cost === null ? null : toInt(row.estimated_cost),
    actor: {
      kind: row.actor_kind as AcquisitionPlan['actor']['kind'], // CHECK-constrained
      id: row.actor_id,
      label: row.actor_label,
    },
    plannedByPrincipal: row.planned_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
    outcome: mapOutcome(row),
  };
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Cross-module wiring
// ---------------------------------------------------------------------------

/**
 * Loads the mission through the missions contract (the sanctioned
 * dependency). Missing, malformed and foreign-tenant mission ids are
 * uniformly `mission_not_found` here (no existence leak — the missions
 * module's own error is remapped, the events module's wrapper precedent).
 */
async function loadMission(ctx: TenantContext, missionId: string): Promise<Mission> {
  try {
    return await getMission(ctx, missionId);
  } catch (error) {
    if (error instanceof MissionsError && error.code === 'mission_not_found') {
      throw new KnowledgeAcquisitionError(
        'mission_not_found',
        `mission '${missionId}' does not exist in this tenant`,
      );
    }
    throw error;
  }
}

/** The person gates' outcome for one person candidate (null exclusion = askable). */
interface PersonGate {
  exclusion: ExclusionReason | null;
  /** The resolved person's directory name (question targeting). */
  fullName: string | null;
}

/**
 * Resolves ONE person candidate through the people/identity W002 surface:
 * a targeted question needs a readable person record, an ACTIVE employee
 * and a verified linked channel identity (delivery itself is the channels
 * module's concern, W030). Failures are uniform exclusion reasons — a
 * foreign-tenant person id reads exactly like a missing one (no leak).
 */
async function resolvePersonCandidate(
  ctx: TenantContext,
  candidate: MissionCandidate,
): Promise<PersonGate> {
  if (candidate.id === null || candidate.id === undefined) {
    // Label-only person candidates cannot be targeted at an employee.
    return { exclusion: 'person_unresolvable', fullName: null };
  }
  let person: Awaited<ReturnType<typeof getPerson>>;
  try {
    person = await getPerson(ctx, candidate.id);
  } catch (error) {
    if (error instanceof PeopleError) {
      return { exclusion: 'person_unresolvable', fullName: null };
    }
    throw error;
  }
  const employee = await getEmployeeByPerson(ctx, person.id);
  if (employee === null || employee.status !== 'active') {
    return { exclusion: 'employee_inactive', fullName: person.fullName };
  }
  const identities = await listPersonIdentities(ctx, person.id);
  const reachable = identities.some((identity) => identity.status === 'verified');
  if (!reachable) {
    return { exclusion: 'person_unreachable', fullName: person.fullName };
  }
  return { exclusion: null, fullName: person.fullName };
}

/**
 * A stable non-negative bigint for the transaction-scoped advisory lock
 * that serializes planners per (tenant, mission) — FNV-1a 64 over the
 * scoped key. Collisions only over-serialize; they cannot under-serialize
 * because the key is injective over the pair before hashing.
 */
function planLockKey(tenantId: string, missionId: string): string {
  let hash = 0xcbf29ce484222325n;
  const scoped = `${tenantId}:${missionId}`;
  for (let i = 0; i < scoped.length; i += 1) {
    hash ^= BigInt(scoped.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return (hash & 0x7fffffffffffffffn).toString();
}

// ---------------------------------------------------------------------------
// planNextAcquisition
// ---------------------------------------------------------------------------

export async function planNextAcquisition(
  ctx: TenantContext,
  input: PlanNextAcquisitionInput,
): Promise<AcquisitionPlan> {
  assertAcquisitionTenantContext(ctx);
  const valid: ValidatedPlanInput = validatePlanNextAcquisitionInput(input);

  // --- the mission (mission-driven by construction) ---
  const mission = await loadMission(ctx, valid.missionId);
  if (mission.content.status !== 'active') {
    throw new KnowledgeAcquisitionError(
      'mission_not_active',
      `mission '${valid.missionId}' is ${mission.content.status} — only an active mission can be planned; define a new mission instead`,
    );
  }

  // --- the menu + signal coverage (the planner never invents signals) ---
  const menu = new Map<string, MissionCandidate>();
  for (const candidate of mission.content.candidateSources) {
    const key = candidateKey(candidate);
    if (!menu.has(key)) menu.set(key, candidate); // duplicate menu entries collapse by key
  }
  const signalsByKey = new Map<string, ValidatedCandidateSignals>();
  for (const entry of valid.candidates) {
    const key = candidateKey(entry);
    if (signalsByKey.has(key)) {
      throw planInputError(
        `duplicate ranking signals for candidate '${key}' — score each candidate once`,
      );
    }
    signalsByKey.set(key, entry);
  }
  for (const key of menu.keys()) {
    if (!signalsByKey.has(key)) {
      throw planInputError(
        `no ranking signals supplied for menu candidate '${key}' — every candidate of the mission's current menu must be scored`,
      );
    }
  }
  for (const [key, entry] of signalsByKey) {
    if (!menu.has(key)) {
      throw planInputError(
        `ranking signals supplied for '${entry.kind}' candidate '${entry.label ?? entry.id}' which is not in the mission's current candidate menu — the planner chooses among the mission's candidates only`,
      );
    }
  }

  // --- the ASK authority gate (actions contract, read-only) ---
  const hasPersonCandidates = [...menu.values()].some(
    (candidate) => candidate.kind === 'person',
  );
  let askPolicy: AskPolicyEvaluation | null = null;
  if (hasPersonCandidates) {
    const evaluation = await evaluateActionAuthority(ctx, {
      actionKind: ASK_ACTION_KIND,
      authorityLevel: ASK_AUTHORITY_LEVEL,
    });
    askPolicy = { outcome: evaluation.outcome, resolvedVia: evaluation.resolvedVia };
  }

  // --- person gates (people/identity W002 surface) ---
  const personGates = new Map<string, PersonGate>();
  for (const [key, candidate] of menu) {
    if (candidate.kind === 'person') {
      personGates.set(key, await resolvePersonCandidate(ctx, candidate));
    }
  }

  const recordedAt = now();
  const inserted = await getDb().transaction(async (tx) => {
    // Serialize planners for this mission: attempt detection and budget
    // accounting must see a stable world between read and insert. The
    // lock is transaction-scoped (auto-released) and touches no other
    // module's tables.
    await tx.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [
      planLockKey(ctx.tenantId, valid.missionId),
    ]);

    // --- what this mission already committed (lock-stable reads) ---
    const prior = await tx.query<{
      chosen_kind: string;
      chosen_id: string | null;
      chosen_label: string | null;
      estimated_cost: number | string | null;
    }>(
      `SELECT chosen_kind, chosen_id, chosen_label, estimated_cost FROM acquisition_plans
        WHERE tenant_id = $1 AND mission_id = $2 AND decision = 'selected'`,
      [ctx.tenantId, valid.missionId],
    );
    const attempted = new Set<string>();
    let committedCost = 0;
    for (const row of prior.rows) {
      attempted.add(candidateKey({ kind: row.chosen_kind as MissionCandidateKind, id: row.chosen_id, label: row.chosen_label }));
      if (row.estimated_cost !== null) committedCost += toInt(row.estimated_cost);
    }
    const budgetAmount = mission.content.investigationBudget.amount;
    const remaining = Math.max(0, budgetAmount - committedCost);

    // --- the deterministic ranking rationale (ADR-0018) ---
    const ranked: RankedCandidate[] = [];
    for (const [key, candidate] of menu) {
      const signals = signalsByKey.get(key)!;
      const evaluation = scoreCandidateSignals(signals, signals.cost, budgetAmount);
      // The gate chain, in fixed order — the first failure is the
      // recorded exclusion (deterministic rationale).
      let exclusion: ExclusionReason | null = null;
      if (attempted.has(key)) {
        exclusion = 'already_attempted';
      } else if (signals.access === 'forbidden') {
        exclusion = 'access_forbidden';
      } else if (candidate.kind === 'person') {
        const gate = personGates.get(key)!;
        exclusion =
          gate.exclusion ??
          (askPolicy !== null && askPolicy.outcome === 'forbidden'
            ? 'ask_policy_forbidden'
            : null);
      }
      if (exclusion === null && signals.cost > remaining) {
        exclusion = 'over_budget';
      }
      ranked.push({
        candidate: {
          kind: candidate.kind,
          id: candidate.id ?? null,
          label: candidate.label ?? null,
        },
        signals: {
          relevance: signals.relevance,
          reliability: signals.reliability,
          freshness: signals.freshness,
          authority: signals.authority,
          expectedQuality: signals.expectedQuality,
          priorContributionValue: signals.priorContributionValue,
          cost: signals.cost,
          access: signals.access,
        },
        score: evaluation.score,
        costShare: evaluation.costShare,
        dominantSignal: evaluation.dominantSignal,
        status: exclusion === null ? 'eligible' : 'excluded',
        exclusion,
      });
    }
    const ordered = orderRankedCandidates(ranked);
    const winner = ordered.find((entry) => entry.status === 'eligible') ?? null;

    // --- the decision ---
    const decision: PlanDecision = winner === null ? 'no_candidate' : 'selected';
    const action: AcquisitionActionKind | null =
      winner === null ? null : ACQUISITION_ACTIONS[winner.candidate.kind];
    let question: string | null = null;
    if (winner !== null && winner.candidate.kind === 'person') {
      const gate = personGates.get(candidateKey(winner.candidate))!;
      question = composeTargetedQuestion({
        missionTitle: mission.content.title,
        knowledgeObjective: mission.content.knowledgeObjective,
        personName: gate.fullName ?? winner.candidate.label ?? 'there',
      });
    }

    const result: DbResult<PlanRow> = await tx.query<PlanRow>(
      `INSERT INTO acquisition_plans (
         tenant_id, mission_id, mission_version, decision,
         chosen_kind, chosen_id, chosen_label, action, question,
         ask_policy_outcome, ask_policy_source, ranked,
         budget_remaining, budget_currency, estimated_cost,
         actor_kind, actor_id, actor_label, planned_by_principal, rationale, recorded_at
       ) VALUES (
         $1, $2, $3, $4,
         $5, $6, $7, $8, $9,
         $10, $11, $12::jsonb,
         $13, $14, $15,
         $16, $17, $18, $19, $20, $21::timestamptz
       ) RETURNING ${PLAN_COLUMNS}`,
      [
        ctx.tenantId,
        valid.missionId,
        mission.version,
        decision,
        winner === null ? null : winner.candidate.kind,
        winner === null ? null : winner.candidate.id,
        winner === null ? null : winner.candidate.label,
        action,
        question,
        askPolicy === null ? null : askPolicy.outcome,
        askPolicy === null ? null : askPolicy.resolvedVia,
        JSON.stringify(ordered),
        remaining,
        mission.content.investigationBudget.currency,
        winner === null ? null : signalsByKey.get(candidateKey(winner.candidate))!.cost,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        valid.rationale,
        recordedAt,
      ],
    );
    return result.rows[0]!;
  });

  // A fresh plan has no outcome by construction.
  return mapPlan({ ...inserted, outcome_kind: null, outcome_note: null, evidence_observation_id: null, outcome_recorded_by_principal: null, outcome_recorded_at: null });
}

// ---------------------------------------------------------------------------
// recordAcquisitionOutcome
// ---------------------------------------------------------------------------

export async function recordAcquisitionOutcome(
  ctx: TenantContext,
  input: RecordAcquisitionOutcomeInput,
): Promise<AcquisitionPlan> {
  assertAcquisitionTenantContext(ctx);
  const valid: ValidatedOutcomeInput = validateRecordAcquisitionOutcomeInput(input);

  const rows = await getDb().query<JoinedPlanRow>(
    `SELECT ${QUALIFIED_PLAN_COLUMNS}, ${OUTCOME_COLUMNS}
       ${PLAN_WITH_OUTCOME_FROM}
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [ctx.tenantId, valid.planId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw planNotFound(valid.planId);
  if (row.outcome_kind !== null) {
    throw new KnowledgeAcquisitionError(
      'outcome_conflict',
      `acquisition plan '${valid.planId}' already carries its terminal outcome — the first outcome wins`,
    );
  }
  if (row.decision !== 'selected') {
    throw new KnowledgeAcquisitionError(
      'invalid_outcome_input',
      `acquisition plan '${valid.planId}' decided 'no_candidate' — there is no acquisition action to resolve`,
    );
  }

  const recordedAt = now();

  // An answered acquisition enters the loop as immutable evidence (W004),
  // with the acquired source as provenance.
  let evidenceObservationId: string | null = null;
  if (valid.outcome === 'answered') {
    const evidence = valid.evidence!;
    const chosen = mapChosen(row)!;
    try {
      const observation = await recordObservation(ctx, {
        kind: ANSWER_OBSERVATION_KIND,
        payload: evidence.payload,
        observedAt: evidence.observedAt ?? recordedAt.toISOString(),
        source: {
          kind: OBSERVATION_SOURCE_KIND_BY_CANDIDATE[chosen.kind],
          id: chosen.id,
          label: chosen.label,
        },
        channel: ACQUISITION_CHANNEL,
        confidence: evidence.confidence,
      });
      evidenceObservationId = observation.id;
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new KnowledgeAcquisitionError(
          'invalid_evidence',
          `the acquisition evidence was rejected: ${error.message}`,
        );
      }
      throw error;
    }
  }

  try {
    await getDb().query(
      `INSERT INTO acquisition_outcomes (
         tenant_id, plan_id, outcome, note, evidence_observation_id,
         recorded_by_principal, recorded_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)`,
      [
        ctx.tenantId,
        valid.planId,
        valid.outcome,
        valid.note,
        evidenceObservationId,
        ctx.principalId,
        recordedAt,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'acquisition_outcomes')) {
      throw new KnowledgeAcquisitionError(
        'outcome_conflict',
        `acquisition plan '${valid.planId}' already carries its terminal outcome — the first outcome wins`,
      );
    }
    throw error;
  }

  const plan = mapPlan(row);
  return {
    ...plan,
    outcome: {
      planId: plan.id,
      outcome: valid.outcome,
      note: valid.note,
      evidenceObservationId,
      recordedByPrincipal: ctx.principalId,
      recordedAt: toIso(recordedAt),
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getAcquisitionPlan(
  ctx: TenantContext,
  planId: string,
): Promise<AcquisitionPlan> {
  assertAcquisitionTenantContext(ctx);
  if (typeof planId !== 'string' || planId.trim() === '') throw planNotFound(planId);
  const trimmed = planId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    // Malformed ids are indistinguishable from missing plans (no leak).
    throw planNotFound(trimmed);
  }

  const rows = await getDb().query<JoinedPlanRow>(
    `SELECT ${QUALIFIED_PLAN_COLUMNS}, ${OUTCOME_COLUMNS}
       ${PLAN_WITH_OUTCOME_FROM}
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [ctx.tenantId, trimmed.toLowerCase()],
  );
  const row = rows.rows[0];
  if (row === undefined) throw planNotFound(trimmed);
  return mapPlan(row);
}

export async function listAcquisitionPlans(
  ctx: TenantContext,
  query: ListAcquisitionPlansQuery,
): Promise<AcquisitionPlan[]> {
  assertAcquisitionTenantContext(ctx);
  const valid = validateListAcquisitionPlansQuery(query);

  const conditions: string[] = ['p.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.missionId !== null) add('p.mission_id = $#', valid.missionId);
  if (valid.decision !== null) add('p.decision = $#', valid.decision);
  if (valid.action !== null) add('p.action = $#', valid.action);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Latest first (the actions module's approvals-feed precedent); id
  // breaks ties deterministically.
  const rows = await getDb().query<JoinedPlanRow>(
    `SELECT ${QUALIFIED_PLAN_COLUMNS}, ${OUTCOME_COLUMNS}
       ${PLAN_WITH_OUTCOME_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.recorded_at DESC, p.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapPlan);
}
