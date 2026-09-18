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
import { listTransactiveEntries } from '@/modules/memory/contract';
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
  getObservation,
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
  deriveSourceSignals,
  LEARNING_WINDOW,
  missionSubjectTopics,
  orderRankedSources,
  TRANSACTIVE_WINDOW,
} from './source-ranking';
import {
  assertAcquisitionTenantContext,
  validateListAcquisitionPlansQuery,
  validateListSourceRankingsQuery,
  validatePlanNextAcquisitionInput,
  validateRankMissionSourcesInput,
  validateRecordAcquisitionOutcomeInput,
  type ValidatedCandidateSignals,
  type ValidatedOutcomeInput,
  type ValidatedPlanInput,
  type ValidatedRankingInput,
  type ValidatedRankingListQuery,
  type ValidatedSourcePolicy,
} from './validation';
import type {
  AcquisitionActionKind,
  AcquisitionOutcomeKind,
  AcquisitionPlan,
  AcquisitionPlanOutcome,
  AskPolicyEvaluation,
  CandidateSignals,
  ExclusionReason,
  ListAcquisitionPlansQuery,
  ListSourceRankingsQuery,
  PlanDecision,
  PlanNextAcquisitionInput,
  RankedCandidate,
  RankedSource,
  RankMissionSourcesInput,
  RecordAcquisitionOutcomeInput,
  SourceEvidenceSnapshot,
  SourceRanking,
  SourceTransactiveEntrySnapshot,
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

// ---------------------------------------------------------------------------
// W052 — Knowledge Source Ranking (ADR-0018)
//
// rankMissionSources is the evidence-driven front door of the planner:
// it DERIVES the ADR-0018 signal values for one mission's candidate menu
// from source evidence (instead of taking them as caller input), hands
// them to planNextAcquisition — which owns the deterministic evaluation,
// the eligibility gates, the budget accounting, the targeted questioning
// and the plan's own persisted rationale — and then commits the
// DERIVATION rationale as an append-only source_rankings row linking the
// plan it produced.
//
//   learned signals  (reliability, expectedQuality, priorContributionValue,
//                      freshness)  ← the source's terminal acquisition
//                      outcomes, tenant-wide across missions (the learned
//                      CompanyModel track record), and the confidence +
//                      observation clock of the evidence each answered
//                      acquisition produced (observations contract);
//   learned signals  (relevance, authority) ← transactive memory (memory
//                      contract, W010) matched against the mission's
//                      subject topics (deterministic tokenization);
//   explicit policy  (cost, access) ← the caller, per candidate, on every
//                      call — never learned, never defaulted (ADR-0018:
//                      learned state cannot override explicit access
//                      policy).
//
// Determinism (ADR-0018): the evidence loaders are pure reads of
// append-only state, the derivation is a total function of (evidence,
// mission topics, evaluation instant), and the planner's evaluation is
// fixed-weight arithmetic — the same learned state, the same mission and
// the same instant always produce the same ranking and the same
// selection. Freshness is derived against the single evaluation instant
// stamped on the ranking record, so two snapshots are comparable.
//
// W051 posture (declared dependency, no import): goal-gap discovery
// promotes material unknowns into missions THROUGH the missions contract;
// this module ranks those missions through the same contract. The audit
// chain goal gap → unknown → mission → ranking → plan is reconstructable
// across the two modules' records without any edge between them — and an
// import would be architecturally impossible: attention depends on
// cognition (the originating-execution link), and cognition depends on
// this module's planner (W013 drives planNextAcquisition), so
// knowledge-acquisition → attention would be a migration-order cycle
// (scripts/migrate.ts treats any contract import as an edge).
//
// Ordering: the plan is committed FIRST (its own transaction), the
// ranking row second, linking the plan. If the ranking insert fails the
// plan still stands — it is self-contained evidence (it carries the full
// signal snapshot it was given); the caller sees the error and the
// missing ranking is visible in the audit feed. There is no
// half-committed ranking (the ranking is one row).
// ---------------------------------------------------------------------------

/** Row shape of `source_rankings`. */
interface SourceRankingRow extends DbRow {
  id: string;
  tenant_id: string;
  mission_id: string;
  mission_version: number | string;
  subject_topics: unknown;
  derived: unknown;
  decision: string;
  plan_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  ranked_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

const RANKING_FIELDS = [
  'id',
  'tenant_id',
  'mission_id',
  'mission_version',
  'subject_topics',
  'derived',
  'decision',
  'plan_id',
  'actor_kind',
  'actor_id',
  'actor_label',
  'ranked_by_principal',
  'rationale',
  'recorded_at',
] as const;

const RANKING_COLUMNS = RANKING_FIELDS.join(', ');

function rankingNotFound(rankingId: string): KnowledgeAcquisitionError {
  return new KnowledgeAcquisitionError(
    'ranking_not_found',
    `source ranking '${rankingId}' does not exist in this tenant`,
  );
}

function rankingInputError(message: string): KnowledgeAcquisitionError {
  return new KnowledgeAcquisitionError('invalid_ranking_input', message);
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapStringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapRanking(row: SourceRankingRow): SourceRanking {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    missionVersion: toInt(row.mission_version),
    subjectTopics: mapStringArray(row.subject_topics),
    derived: Array.isArray(row.derived) ? (row.derived as RankedSource[]) : [],
    decision: row.decision as PlanDecision, // CHECK-constrained
    planId: row.plan_id,
    actor: {
      kind: row.actor_kind as SourceRanking['actor']['kind'], // CHECK-constrained
      id: row.actor_id,
      label: row.actor_label,
    },
    rankedByPrincipal: row.ranked_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

/** Row shape of the source track-record query (plans ⋈ outcomes). */
interface TrackRow extends DbRow {
  outcome: string;
  evidence_observation_id: string | null;
}

/**
 * Assembles ONE candidate's source evidence — everything the learned
 * signals are derived from:
 *
 *  * the terminal outcome track record: the plans that CHOSE this exact
 *    candidate (the planner's own (kind, id)/(kind, label) identity rule)
 *    across ALL the tenant's missions, joined with their first-write
 *    terminal outcomes, latest LEARNING_WINDOW rows — the learned
 *    CompanyModel reliability record of the source;
 *  * the answered evidence: each answered outcome's evidence observation
 *    (observations contract) contributes its confidence (expected
 *    quality) and its observation clock (freshness). Evidence the
 *    ranking principal may not read is skipped — a partial view, never a
 *    leak (the memory module's evidence-resolution precedent);
 *  * transactive memory (memory contract, W010): the latest
 *    TRANSACTIVE_WINDOW entries about the actor, for id-bearing person
 *    and agent candidates only (the memory module's actor vocabulary).
 *    Everything else carries no transactive evidence — the derivation
 *    treats that as neutral, not zero.
 */
async function loadSourceEvidence(
  ctx: TenantContext,
  candidate: MissionCandidate,
): Promise<SourceEvidenceSnapshot> {
  const id = candidate.id ?? null;
  const label = candidate.label ?? null;
  const track = await getDb().query<TrackRow>(
    `SELECT o.outcome, o.evidence_observation_id
       FROM acquisition_plans p
       JOIN acquisition_outcomes o
         ON o.plan_id = p.id AND o.tenant_id = p.tenant_id
      WHERE p.tenant_id = $1 AND p.decision = 'selected' AND p.chosen_kind = $2
        AND (p.chosen_id = $3
             OR ($3::text IS NULL AND p.chosen_id IS NULL AND p.chosen_label = $4))
      ORDER BY o.recorded_at DESC, o.id DESC
      LIMIT $5`,
    [ctx.tenantId, candidate.kind, id, label, LEARNING_WINDOW],
  );

  const outcomes = { answered: 0, unavailable: 0, failed: 0 };
  const evidenceConfidences: number[] = [];
  let latestEvidenceObservedAt: string | null = null;
  for (const row of track.rows) {
    if (row.outcome === 'answered') outcomes.answered += 1;
    else if (row.outcome === 'unavailable') outcomes.unavailable += 1;
    else outcomes.failed += 1;
    if (row.outcome === 'answered' && row.evidence_observation_id !== null) {
      try {
        const observation = await getObservation(ctx, row.evidence_observation_id);
        evidenceConfidences.push(observation.confidence.value);
        if (
          latestEvidenceObservedAt === null ||
          observation.observedAt > latestEvidenceObservedAt
        ) {
          latestEvidenceObservedAt = observation.observedAt;
        }
      } catch (error) {
        if (!(error instanceof ObservationsError)) throw error;
        // Unreadable evidence is skipped (partial view, no leak); the
        // outcome itself still counts toward the track record.
      }
    }
  }

  const transactiveEntries: SourceTransactiveEntrySnapshot[] = [];
  if ((candidate.kind === 'person' || candidate.kind === 'agent') && id !== null) {
    const entries = await listTransactiveEntries(ctx, {
      actorKind: candidate.kind === 'person' ? 'person' : 'agent',
      actorId: id,
      limit: TRANSACTIVE_WINDOW,
    });
    for (const entry of entries) {
      transactiveEntries.push({
        id: entry.id,
        relation: entry.relation,
        topics: [...entry.topics],
      });
    }
  }

  return { outcomes, evidenceConfidences, latestEvidenceObservedAt, transactiveEntries };
}

/**
 * Derives the ADR-0018 signal values for one mission's candidate menu
 * from source evidence, drives the W012 planner with them, and persists
 * the derivation rationale (source_rankings) linking the plan it
 * produced. Returns both records. See the section header for the full
 * contract; the derivation itself is source-ranking.ts (pure).
 */
export async function rankMissionSources(
  ctx: TenantContext,
  input: RankMissionSourcesInput,
): Promise<{ ranking: SourceRanking; plan: AcquisitionPlan }> {
  assertAcquisitionTenantContext(ctx);
  const valid: ValidatedRankingInput = validateRankMissionSourcesInput(input);

  // --- the mission (the ranking is mission-driven by construction) ---
  const mission = await loadMission(ctx, valid.missionId);
  if (mission.content.status !== 'active') {
    throw new KnowledgeAcquisitionError(
      'mission_not_active',
      `mission '${valid.missionId}' is ${mission.content.status} — only an active mission can be ranked; define a new mission instead`,
    );
  }

  // --- the menu + explicit policy coverage (the ranking never invents
  //     policy it was not given) ---
  const menu = new Map<string, MissionCandidate>();
  for (const candidate of mission.content.candidateSources) {
    const key = candidateKey(candidate);
    if (!menu.has(key)) menu.set(key, candidate); // duplicate menu entries collapse by key
  }
  const policyByKey = new Map<string, ValidatedSourcePolicy>();
  for (const policy of valid.policies) {
    const key = candidateKey(policy);
    if (!menu.has(key)) {
      throw rankingInputError(
        `policy supplied for '${policy.kind}' candidate '${policy.label ?? policy.id}' which is not in the mission's current candidate menu — the ranking governs the mission's candidates only`,
      );
    }
    policyByKey.set(key, policy);
  }
  for (const key of menu.keys()) {
    if (!policyByKey.has(key)) {
      throw rankingInputError(
        `no explicit policy supplied for menu candidate '${key}' — every candidate's cost and access scope must be stated (learned state never supplies them)`,
      );
    }
  }

  // --- the evaluation instant: one clock read anchors freshness AND the
  //     ranking record, so a snapshot explains its own time base ---
  const evaluationAt = now();
  const subjectTopics = missionSubjectTopics(
    mission.content.title,
    mission.content.knowledgeObjective,
  );
  const budgetAmount = mission.content.investigationBudget.amount;

  // --- the derivation: evidence → signals + basis, and the planner's own
  //     deterministic evaluation of each derived vector ---
  const derived: RankedSource[] = [];
  const planCandidates: CandidateSignals[] = [];
  for (const candidate of menu.values()) {
    const policy = policyByKey.get(candidateKey(candidate))!;
    const evidence = await loadSourceEvidence(ctx, candidate);
    const derivation = deriveSourceSignals(subjectTopics, evidence, evaluationAt);
    const evaluation = scoreCandidateSignals(derivation.signals, policy.cost, budgetAmount);
    derived.push({
      candidate: {
        kind: candidate.kind,
        id: candidate.id ?? null,
        label: candidate.label ?? null,
      },
      signals: {
        ...derivation.signals,
        cost: policy.cost,
        access: policy.access,
      },
      score: evaluation.score,
      costShare: evaluation.costShare,
      dominantSignal: evaluation.dominantSignal,
      basis: derivation.basis,
    });
    planCandidates.push({
      kind: candidate.kind,
      id: candidate.id ?? null,
      label: candidate.label ?? null,
      ...derivation.signals,
      cost: policy.cost,
      access: policy.access,
    });
  }
  const ordered = orderRankedSources(derived);

  // --- the planner commits the plan from the derived signals: its own
  //     transaction, advisory lock, eligibility gates (attempted, access,
  //     person resolution, ASK policy, budget), composed question and
  //     persisted ranked snapshot. Its missionVersion equals the one
  //     loaded above whenever planning succeeds — the derived signals
  //     cover exactly the menu the planner validates against.
  const plan = await planNextAcquisition(ctx, {
    missionId: valid.missionId,
    candidates: planCandidates,
    actor: valid.actor,
    rationale: valid.rationale,
  });

  // --- the derivation rationale, append-only, linking the plan ---
  const result: DbResult<SourceRankingRow> = await getDb().query<SourceRankingRow>(
    `INSERT INTO source_rankings (
       tenant_id, mission_id, mission_version,
       subject_topics, derived, decision, plan_id,
       actor_kind, actor_id, actor_label, ranked_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3,
       $4::jsonb, $5::jsonb, $6, $7,
       $8, $9, $10, $11, $12, $13::timestamptz
     ) RETURNING ${RANKING_COLUMNS}`,
    [
      ctx.tenantId,
      valid.missionId,
      plan.missionVersion,
      JSON.stringify(subjectTopics),
      JSON.stringify(ordered),
      plan.decision,
      plan.decision === 'selected' ? plan.id : null,
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      ctx.principalId,
      valid.rationale,
      evaluationAt,
    ],
  );

  return { ranking: mapRanking(result.rows[0]!), plan };
}

// ---------------------------------------------------------------------------
// Source ranking reads
// ---------------------------------------------------------------------------

export async function getSourceRanking(
  ctx: TenantContext,
  rankingId: string,
): Promise<SourceRanking> {
  assertAcquisitionTenantContext(ctx);
  if (typeof rankingId !== 'string' || rankingId.trim() === '') throw rankingNotFound(rankingId);
  const trimmed = rankingId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    // Malformed ids are indistinguishable from missing rankings (no leak).
    throw rankingNotFound(trimmed);
  }

  const rows = await getDb().query<SourceRankingRow>(
    `SELECT ${RANKING_COLUMNS} FROM source_rankings
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, trimmed.toLowerCase()],
  );
  const row = rows.rows[0];
  if (row === undefined) throw rankingNotFound(trimmed);
  return mapRanking(row);
}

export async function listSourceRankings(
  ctx: TenantContext,
  query: ListSourceRankingsQuery,
): Promise<SourceRanking[]> {
  assertAcquisitionTenantContext(ctx);
  const valid: ValidatedRankingListQuery = validateListSourceRankingsQuery(query);

  const conditions: string[] = ['r.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.missionId !== null) add('r.mission_id = $#', valid.missionId);
  if (valid.decision !== null) add('r.decision = $#', valid.decision);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Latest first, id breaks ties deterministically (the plans feed
  // precedent).
  const rows = await getDb().query<SourceRankingRow>(
    `SELECT ${RANKING_COLUMNS} FROM source_rankings r
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.recorded_at DESC, r.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapRanking);
}
