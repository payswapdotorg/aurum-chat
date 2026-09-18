// Implementation of the opportunities module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`opportunity_not_found` / `opportunity_version_not_found`
// / `run_not_found` / `candidate_not_found`), including on versions, runs
// and candidates.
//
// W015 acceptance — "Convert external/internal signals into evidence-backed
// opportunities with estimated value, confidence, affected goals and
// required capabilities" — is carried by these deliberate properties, all
// tested:
//   1. CONVERSION IS EVIDENCE-DRIVEN: every candidate's evidence basis is
//      the signal chain's immutable links — observations (W004) and claims
//      (W007) read THROUGH their contracts, never their tables. Each
//      reference is validated readable in-tenant at write time, and its
//      confidence is snapshotted so the version stays self-contained.
//   2. CONFIDENCE IS APPLICATION-DERIVED (lock 10): the deterministic
//      derivation (derivation.ts) computes every opportunity's confidence
//      from the cited evidence — the weakest evidence confidence plus a
//      bounded corroboration bonus, capped below certainty. No caller and
//      no LLM can assert the confidence of its own output.
//   3. CONVERSION IS POLICY-GATED AND AUDITED: the run snapshots the
//      recordability policy; below-threshold, currency-mismatched and
//      duplicate candidates are RECORDED with deterministic reasons — the
//      decision trail is append-only (PostgreSQL triggers), and continuous
//      conversion does not spam duplicates (re-analysis of the same signal
//      set is a revision of the live opportunity, not a second record).
//   4. OPPORTUNITIES ARE VERSIONED UNDERSTANDING: an identity plus an
//      append-only chain of full-snapshot versions — revisions append,
//      lifecycle transitions are surgical versions, no update/delete
//      operation exists on the contract, and PostgreSQL itself rejects
//      UPDATE/DELETE/TRUNCATE on versions (and runs/candidates) and
//      DELETE/TRUNCATE on identities via migration 001 triggers.
//
// Error propagation: sibling contract errors during reference validation
// are re-labelled into this module's uniform `invalid_*` codes (the
// attention module's precedent) so no existence information leaks through
// the error vocabulary either.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getExecution, CognitionError } from '@/modules/cognition/contract';
import { getClaim, EpistemicsError } from '@/modules/epistemics/contract';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import { getObservation, ObservationsError } from '@/modules/observations/contract';
import type { Claim } from '@/modules/epistemics/contract';
import type { Goal } from '@/modules/goals/contract';
import type { Observation } from '@/modules/observations/contract';
import { OpportunitiesError } from './errors';
import {
  deriveConfidence,
  evidenceFingerprintOf,
  evaluateRecordability,
} from './derivation';
import {
  assertOpportunitiesTenantContext,
  escapeLike,
  isUuid,
  validateCandidateQuery,
  validateConvertSignalsInput,
  validateHistoryQuery,
  validateListOpportunitiesQuery,
  validateReviseOpportunityInput,
  validateRunListQuery,
  validateRunQuery,
  validateVersionQuery,
  type ValidatedCandidateInput,
  type ValidatedEvidenceInput,
  type ValidatedParty,
  type ValidatedPolicy,
  type ValidatedRevisionPatch,
} from './validation';
import type {
  ConversionCandidate,
  ConversionRun,
  ConversionRunSummary,
  ConvertSignalsInput,
  EvidenceConfidenceSnapshot,
  GetConversionCandidateQuery,
  GetConversionRunQuery,
  GetOpportunityVersionQuery,
  ListConversionRunsQuery,
  ListOpportunitiesQuery,
  ListOpportunityVersionsQuery,
  Opportunity,
  OpportunityChangeKind,
  OpportunityContent,
  OpportunityStatus,
  OpportunityVersion,
  ReviseOpportunityInput,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  opportunity_id: string;
  version: number | string;
  change_kind: string;
  status: string;
  title: string;
  description: string;
  signal_origin: string;
  evidence_observation_ids: unknown;
  evidence_claim_ids: unknown;
  evidence_confidences: unknown;
  support: number | string;
  evidence_fingerprint: string;
  confidence: number;
  estimated_value_amount: number | string;
  estimated_value_currency: string;
  affected_goals: unknown;
  required_capabilities: unknown;
  world_entities: unknown;
  next_action_kind: string;
  next_action_statement: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface RunRow extends DbRow {
  id: string;
  tenant_id: string;
  trigger_kind: string;
  originating_execution_id: string | null;
  min_confidence: number;
  min_value_amount: number | string | null;
  min_value_currency: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface CandidateRow extends DbRow {
  id: string;
  tenant_id: string;
  run_id: string;
  disposition: string;
  signal_origin: string;
  title: string;
  description: string;
  evidence_observation_ids: unknown;
  evidence_claim_ids: unknown;
  evidence_confidences: unknown;
  support: number | string;
  evidence_fingerprint: string;
  confidence: number;
  estimated_value_amount: number | string;
  estimated_value_currency: string;
  affected_goals: unknown;
  required_capabilities: unknown;
  world_entities: unknown;
  next_action_kind: string;
  next_action_statement: string;
  created_opportunity_id: string | null;
  existing_opportunity_id: string | null;
  reason: string | null;
  recorded_at: Date | string;
}

/** Run row + the derived disposition counts of the run-feed join. */
interface RunSummaryRow extends RunRow {
  converted_count: number | string;
  below_threshold_count: number | string;
  currency_mismatch_count: number | string;
  duplicate_count: number | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

/** jsonb arrays arrive parsed on both backends; storage is write-validated. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function confidenceArray(value: unknown): EvidenceConfidenceSnapshot[] {
  return Array.isArray(value) ? (value as EvidenceConfidenceSnapshot[]) : [];
}

function mapPartyOf(row: {
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
}): ValidatedParty {
  return {
    kind: row.actor_kind as ValidatedParty['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

function contentOf(row: {
  status: string;
  title: string;
  description: string;
  signal_origin: string;
  evidence_observation_ids: unknown;
  evidence_claim_ids: unknown;
  evidence_confidences: unknown;
  support: number | string;
  confidence: number;
  estimated_value_amount: number | string;
  estimated_value_currency: string;
  affected_goals: unknown;
  required_capabilities: unknown;
  world_entities: unknown;
  next_action_kind: string;
  next_action_statement: string;
}): OpportunityContent {
  return {
    status: row.status as OpportunityStatus, // CHECK-constrained by migration 001
    title: row.title,
    description: row.description,
    signalOrigin: row.signal_origin as OpportunityContent['signalOrigin'], // CHECK-constrained
    evidence: {
      observationIds: stringArray(row.evidence_observation_ids),
      claimIds: stringArray(row.evidence_claim_ids),
      support: toInt(row.support),
      confidences: confidenceArray(row.evidence_confidences),
    },
    confidence: row.confidence,
    estimatedValue: {
      amount: toInt(row.estimated_value_amount),
      currency: row.estimated_value_currency,
    },
    affectedGoals: Array.isArray(row.affected_goals)
      ? (row.affected_goals as OpportunityContent['affectedGoals'])
      : [],
    requiredCapabilities: Array.isArray(row.required_capabilities)
      ? (row.required_capabilities as OpportunityContent['requiredCapabilities'])
      : [],
    worldEntities: Array.isArray(row.world_entities)
      ? (row.world_entities as OpportunityContent['worldEntities'])
      : [],
    recommendedNextAction: {
      kind: row.next_action_kind as OpportunityContent['recommendedNextAction']['kind'], // CHECK-constrained
      statement: row.next_action_statement,
    },
  };
}

function mapVersion(row: VersionRow): OpportunityVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    opportunityId: row.opportunity_id,
    version: toInt(row.version),
    changeKind: row.change_kind as OpportunityChangeKind, // CHECK-constrained by migration 001
    content: contentOf(row),
    evidenceFingerprint: row.evidence_fingerprint,
    actor: mapPartyOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapCandidate(row: CandidateRow): ConversionCandidate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    disposition: row.disposition as ConversionCandidate['disposition'], // CHECK-constrained
    title: row.title,
    description: row.description,
    signalOrigin: row.signal_origin as ConversionCandidate['signalOrigin'], // CHECK-constrained
    evidence: {
      observationIds: stringArray(row.evidence_observation_ids),
      claimIds: stringArray(row.evidence_claim_ids),
      support: toInt(row.support),
      confidences: confidenceArray(row.evidence_confidences),
    },
    evidenceFingerprint: row.evidence_fingerprint,
    confidence: row.confidence,
    estimatedValue: {
      amount: toInt(row.estimated_value_amount),
      currency: row.estimated_value_currency,
    },
    affectedGoals: Array.isArray(row.affected_goals)
      ? (row.affected_goals as ConversionCandidate['affectedGoals'])
      : [],
    requiredCapabilities: Array.isArray(row.required_capabilities)
      ? (row.required_capabilities as ConversionCandidate['requiredCapabilities'])
      : [],
    worldEntities: Array.isArray(row.world_entities)
      ? (row.world_entities as ConversionCandidate['worldEntities'])
      : [],
    recommendedNextAction: {
      kind: row.next_action_kind as ConversionCandidate['recommendedNextAction']['kind'],
      statement: row.next_action_statement,
    },
    createdOpportunityId: row.created_opportunity_id,
    existingOpportunityId: row.existing_opportunity_id,
    reason: row.reason,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapRunCountsOf(candidates: readonly ConversionCandidate[]): ConversionRunSummary['counts'] {
  return {
    converted: candidates.filter((candidate) => candidate.disposition === 'converted').length,
    belowThreshold: candidates.filter((candidate) => candidate.disposition === 'below_threshold').length,
    currencyMismatch: candidates.filter((candidate) => candidate.disposition === 'currency_mismatch').length,
    duplicate: candidates.filter((candidate) => candidate.disposition === 'duplicate').length,
  };
}

/** Counts from the run-feed join's FILTER aggregates. */
function runCountsOfSummaryRow(row: RunSummaryRow): ConversionRunSummary['counts'] {
  return {
    converted: toInt(row.converted_count),
    belowThreshold: toInt(row.below_threshold_count),
    currencyMismatch: toInt(row.currency_mismatch_count),
    duplicate: toInt(row.duplicate_count),
  };
}

function mapRunSummary(
  row: RunRow,
  counts: ConversionRunSummary['counts'] = { converted: 0, belowThreshold: 0, currencyMismatch: 0, duplicate: 0 },
): ConversionRunSummary {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    triggerKind: row.trigger_kind as ConversionRunSummary['triggerKind'], // CHECK-constrained
    originatingExecutionId: row.originating_execution_id,
    policy: {
      minConfidence: row.min_confidence,
      minValue:
        row.min_value_amount === null || row.min_value_currency === null
          ? null
          : { amount: toInt(row.min_value_amount), currency: row.min_value_currency },
    },
    actor: mapPartyOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
    counts,
  };
}

function opportunityNotFound(opportunityId: string): OpportunitiesError {
  return new OpportunitiesError(
    'opportunity_not_found',
    `opportunity '${opportunityId}' does not exist in this tenant`,
  );
}

function invalidEvidenceRef(id: string): OpportunitiesError {
  return new OpportunitiesError(
    'invalid_evidence_ref',
    `evidence reference '${id}' is not available in this tenant to this principal`,
  );
}

function invalidGoalRef(goalId: string): OpportunitiesError {
  return new OpportunitiesError(
    'invalid_goal_ref',
    `goal '${goalId}' is not available in this tenant to this principal`,
  );
}

function invalidOriginRef(executionId: string): OpportunitiesError {
  return new OpportunitiesError(
    'invalid_origin_ref',
    `originating execution '${executionId}' is not available in this tenant to this principal`,
  );
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
// Cross-module validation (contracts only — never sibling tables)
// ---------------------------------------------------------------------------

/** The originating cognitive execution must be readable in this tenant (W013). */
async function validateOriginExecution(ctx: TenantContext, executionId: string): Promise<void> {
  try {
    await getExecution(ctx, { executionId });
  } catch (error) {
    if (error instanceof CognitionError) throw invalidOriginRef(executionId);
    throw error;
  }
}

/** One goal must be readable in this tenant (uniform, no leak). */
async function requireGoal(ctx: TenantContext, goalId: string): Promise<Goal> {
  try {
    return await getGoal(ctx, goalId);
  } catch (error) {
    if (error instanceof GoalsError) throw invalidGoalRef(goalId);
    throw error;
  }
}

/** One observation must be readable in this tenant (W004 — the signal entry). */
async function requireObservation(ctx: TenantContext, observationId: string): Promise<Observation> {
  try {
    return await getObservation(ctx, observationId);
  } catch (error) {
    if (error instanceof ObservationsError) throw invalidEvidenceRef(observationId);
    throw error;
  }
}

/** One claim must be readable in this tenant (W007 — the derived proposition). */
async function requireClaim(ctx: TenantContext, claimId: string): Promise<Claim> {
  try {
    return await getClaim(ctx, { claimId });
  } catch (error) {
    if (error instanceof EpistemicsError) throw invalidEvidenceRef(claimId);
    throw error;
  }
}

/**
 * The validated + derived evidence basis of one version commit: every
 * reference validated readable through its contract, the confidence
 * snapshot taken, the support counted, the fingerprint computed and the
 * confidence derived (derivation.ts) — the caller never supplies any of
 * the derived values.
 */
interface DerivedEvidence {
  observationIds: string[];
  claimIds: string[];
  confidences: EvidenceConfidenceSnapshot[];
  support: number;
  fingerprint: string;
  confidence: number;
}

async function deriveEvidence(
  ctx: TenantContext,
  evidence: ValidatedEvidenceInput,
): Promise<DerivedEvidence> {
  const confidences: EvidenceConfidenceSnapshot[] = [];
  for (const observationId of evidence.observationIds) {
    const observation = await requireObservation(ctx, observationId);
    confidences.push({ kind: 'observation', id: observationId, value: observation.confidence.value });
  }
  for (const claimId of evidence.claimIds) {
    const claim = await requireClaim(ctx, claimId);
    confidences.push({ kind: 'claim', id: claimId, value: claim.confidence.value });
  }
  return {
    observationIds: evidence.observationIds,
    claimIds: evidence.claimIds,
    confidences,
    support: confidences.length,
    fingerprint: evidenceFingerprintOf(evidence.observationIds, evidence.claimIds),
    confidence: deriveConfidence(confidences),
  };
}

/**
 * The affected-goal refs of one version commit: each goal validated
 * readable through the goals contract; the stored label is the caller's
 * label or the goal's snapshotted title (any version decodes alone).
 */
async function resolveGoalRefs(
  ctx: TenantContext,
  refs: { goalId: string; label: string | null }[],
): Promise<{ goalId: string; label: string | null }[]> {
  const out: { goalId: string; label: string | null }[] = [];
  for (const ref of refs) {
    const goal = await requireGoal(ctx, ref.goalId);
    out.push({ goalId: ref.goalId, label: ref.label ?? goal.content.title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared SQL of the version append
// ---------------------------------------------------------------------------

/** The SQL value tuple of one version row (full snapshot). */
async function versionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    opportunityId: string;
    version: number;
    changeKind: OpportunityChangeKind;
    content: OpportunityContent;
    fingerprint: string;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO opportunity_versions (
       tenant_id, opportunity_id, version, change_kind,
       status, title, description, signal_origin,
       evidence_observation_ids, evidence_claim_ids, evidence_confidences, support, evidence_fingerprint,
       confidence, estimated_value_amount, estimated_value_currency,
       affected_goals, required_capabilities, world_entities,
       next_action_kind, next_action_statement,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9::jsonb, $10::jsonb, $11::jsonb, $12, $13,
       $14, $15, $16,
       $17::jsonb, $18::jsonb, $19::jsonb,
       $20, $21,
       $22, $23, $24, $25, $26, $27::timestamptz
     )`,
    [
      params.tenantId,
      params.opportunityId,
      params.version,
      params.changeKind,
      params.content.status,
      params.content.title,
      params.content.description,
      params.content.signalOrigin,
      JSON.stringify(params.content.evidence.observationIds),
      JSON.stringify(params.content.evidence.claimIds),
      JSON.stringify(params.content.evidence.confidences),
      params.content.evidence.support,
      params.fingerprint,
      params.content.confidence,
      params.content.estimatedValue.amount,
      params.content.estimatedValue.currency,
      JSON.stringify(params.content.affectedGoals),
      JSON.stringify(params.content.requiredCapabilities),
      JSON.stringify(params.content.worldEntities),
      params.content.recommendedNextAction.kind,
      params.content.recommendedNextAction.statement,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

/** The current-view Opportunity assembled from a freshly appended version. */
function opportunityOf(
  opportunityId: string,
  tenantId: string,
  createdAt: Date | string,
  version: OpportunityVersion,
): Opportunity {
  return {
    id: opportunityId,
    tenantId,
    version: version.version,
    content: version.content,
    evidenceFingerprint: version.evidenceFingerprint,
    createdAt: toIso(createdAt),
    updatedAt: version.recordedAt,
    lastChange: {
      kind: version.changeKind,
      actor: version.actor,
      changedByPrincipal: version.changedByPrincipal,
      rationale: version.rationale,
      recordedAt: version.recordedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// convertSignals — the engine's entry point
// ---------------------------------------------------------------------------

export async function convertSignals(
  ctx: TenantContext,
  input: ConvertSignalsInput,
): Promise<ConversionRun> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateConvertSignalsInput(input);

  // --- loop linkage (before any write: a bad link fails the whole pass) ---
  if (valid.originatingExecutionId !== null) {
    await validateOriginExecution(ctx, valid.originatingExecutionId);
  }

  // --- per-candidate cross-module validation + deterministic derivation ---
  // All references are validated and all derived values computed BEFORE
  // the transaction: one bad reference refuses the whole pass (a partial
  // conversion would be unauditable), and the pass's writes then stay pure
  // SQL appends.
  const derived: {
    candidate: ValidatedCandidateInput;
    evidence: DerivedEvidence;
    affectedGoals: { goalId: string; label: string | null }[];
  }[] = [];
  for (const candidate of valid.candidates) {
    derived.push({
      candidate,
      evidence: await deriveEvidence(ctx, candidate.evidence),
      affectedGoals: await resolveGoalRefs(ctx, candidate.judgment.affectedGoals),
    });
  }

  const recordedAt = now();
  const policy: ValidatedPolicy = valid.policy;

  return getDb().transaction(async (tx) => {
    // --- the run row (policy snapshot + trigger + actor + rationale) ---
    const runInsert = await tx.query<RunRow>(
      `INSERT INTO opportunity_conversion_runs (
         tenant_id, trigger_kind, originating_execution_id,
         min_confidence, min_value_amount, min_value_currency,
         actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
       ) VALUES (
         $1, $2, $3,
         $4, $5, $6,
         $7, $8, $9, $10, $11, $12::timestamptz
       ) RETURNING *`,
      [
        ctx.tenantId,
        valid.triggerKind,
        valid.originatingExecutionId,
        policy.minConfidence,
        policy.minValue === null ? null : policy.minValue.amount,
        policy.minValue === null ? null : policy.minValue.currency,
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        valid.rationale,
        recordedAt,
      ],
    );
    const run = mapRunSummary(runInsert.rows[0]!);

    const candidatesOut: ConversionCandidate[] = [];
    /** Fingerprints converted in THIS run (in-run duplicate detection). */
    const convertedInRun = new Map<string, string>();

    for (const { candidate, evidence, affectedGoals } of derived) {
      const judgment = candidate.judgment;
      const gate = evaluateRecordability(
        { minConfidence: policy.minConfidence, minValue: policy.minValue },
        evidence.confidence,
        judgment.estimatedValue,
      );

      let disposition = gate.disposition;
      let reason = gate.reason;
      let createdOpportunityId: string | null = null;
      let existingOpportunityId: string | null = null;

      if (disposition === 'converted') {
        // Duplicate detection: a LIVE (open or pursued) opportunity whose
        // CURRENT version carries the exact same signal set — including
        // ones created earlier in this same run.
        const existing = convertedInRun.get(evidence.fingerprint);
        if (existing !== undefined) {
          existingOpportunityId = existing;
        } else {
          const live = await tx.query<{ opportunity_id: string }>(
            `SELECT ov.opportunity_id
               FROM opportunity_versions ov
               INNER JOIN opportunities o
                 ON o.id = ov.opportunity_id
                AND o.tenant_id = ov.tenant_id
                AND ov.version = o.current_version
              WHERE ov.tenant_id = $1
                AND ov.evidence_fingerprint = $2
                AND ov.status IN ('open', 'pursued')
              ORDER BY o.created_at ASC, o.id ASC
              LIMIT 1`,
            [ctx.tenantId, evidence.fingerprint],
          );
          if (live.rows.length > 0) existingOpportunityId = live.rows[0]!.opportunity_id;
        }
        if (existingOpportunityId !== null) {
          disposition = 'duplicate';
          reason = `the exact signal set is already carried by live opportunity '${existingOpportunityId}' — re-analysis revises that record instead of creating a duplicate`;
        }
      }

      if (disposition === 'converted') {
        // --- the evidence-backed opportunity (version 1) ---
        const identity = await tx.query<{ id: string; created_at: Date | string }>(
          `INSERT INTO opportunities (tenant_id, created_at) VALUES ($1, $2)
             RETURNING id, created_at`,
          [ctx.tenantId, recordedAt],
        );
        createdOpportunityId = identity.rows[0]!.id;
        const content: OpportunityContent = {
          status: 'open',
          title: judgment.title,
          description: judgment.description,
          signalOrigin: candidate.signalOrigin,
          evidence: {
            observationIds: evidence.observationIds,
            claimIds: evidence.claimIds,
            support: evidence.support,
            confidences: evidence.confidences,
          },
          confidence: evidence.confidence,
          estimatedValue: judgment.estimatedValue,
          affectedGoals,
          requiredCapabilities: judgment.requiredCapabilities,
          worldEntities: judgment.worldEntities,
          recommendedNextAction: judgment.recommendedNextAction,
        };
        await versionInsert(tx, {
          tenantId: ctx.tenantId,
          opportunityId: createdOpportunityId,
          version: 1,
          changeKind: 'created',
          content,
          fingerprint: evidence.fingerprint,
          actor: valid.actor,
          principalId: ctx.principalId,
          rationale: valid.rationale,
          recordedAt,
        });
        convertedInRun.set(evidence.fingerprint, createdOpportunityId);
      }

      // --- the decided candidate row (self-contained audit) ---
      const candidateInsert = await tx.query<CandidateRow>(
        `INSERT INTO opportunity_conversion_candidates (
           tenant_id, run_id, disposition, signal_origin,
           title, description,
           evidence_observation_ids, evidence_claim_ids, evidence_confidences, support, evidence_fingerprint,
           confidence, estimated_value_amount, estimated_value_currency,
           affected_goals, required_capabilities, world_entities,
           next_action_kind, next_action_statement,
           created_opportunity_id, existing_opportunity_id, reason, recorded_at
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6,
           $7::jsonb, $8::jsonb, $9::jsonb, $10, $11,
           $12, $13, $14,
           $15::jsonb, $16::jsonb, $17::jsonb,
           $18, $19,
           $20, $21, $22, $23::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          run.id,
          disposition,
          candidate.signalOrigin,
          judgment.title,
          judgment.description,
          JSON.stringify(evidence.observationIds),
          JSON.stringify(evidence.claimIds),
          JSON.stringify(evidence.confidences),
          evidence.support,
          evidence.fingerprint,
          evidence.confidence,
          judgment.estimatedValue.amount,
          judgment.estimatedValue.currency,
          JSON.stringify(affectedGoals),
          JSON.stringify(judgment.requiredCapabilities),
          JSON.stringify(judgment.worldEntities),
          judgment.recommendedNextAction.kind,
          judgment.recommendedNextAction.statement,
          createdOpportunityId,
          existingOpportunityId,
          reason,
          recordedAt,
        ],
      );
      candidatesOut.push(mapCandidate(candidateInsert.rows[0]!));
    }

    // Counts are DERIVED from the decided candidate rows — the run row stays
    // one immutable record (the attention module's discovery-run precedent).
    return {
      ...run,
      counts: mapRunCountsOf(candidatesOut),
      candidates: candidatesOut,
    };
  });
}

// ---------------------------------------------------------------------------
// reviseOpportunity
// ---------------------------------------------------------------------------

export async function reviseOpportunity(
  ctx: TenantContext,
  input: ReviseOpportunityInput,
): Promise<Opportunity> {
  assertOpportunitiesTenantContext(ctx);
  const patch: ValidatedRevisionPatch = validateReviseOpportunityInput(input);
  if (!isUuid(patch.opportunityId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw opportunityNotFound(patch.opportunityId);
  }

  // --- phase 1: read the current version and do ALL cross-module work ---
  // Contract reads (evidence validation/confidence re-derivation, goal
  // resolution) must stay OUTSIDE the transaction — the db port is a single
  // pinned connection in a transaction, so an in-transaction contract read
  // would deadlock (the missions module's validate-before-transaction
  // precedent). Correctness is preserved by phase 2's version guard: the
  // append only lands on the exact version the merge was computed against.
  const preRead = await getDb().query<{ current_version: number | string; created_at: Date | string }>(
    `SELECT current_version, created_at FROM opportunities
      WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, patch.opportunityId],
  );
  const preIdentity = preRead.rows[0];
  if (preIdentity === undefined) throw opportunityNotFound(patch.opportunityId); // no leak: missing and foreign alike
  const baseVersionNumber = toInt(preIdentity.current_version);
  if (patch.expectedVersion !== null && patch.expectedVersion !== baseVersionNumber) {
    throw new OpportunitiesError(
      'opportunity_conflict',
      `expected version ${patch.expectedVersion} but opportunity '${patch.opportunityId}' is at version ${baseVersionNumber}; re-read the opportunity and retry`,
    );
  }
  const baseRows = await getDb().query<VersionRow>(
    `SELECT * FROM opportunity_versions
      WHERE tenant_id = $1 AND opportunity_id = $2 AND version = $3`,
    [ctx.tenantId, patch.opportunityId, baseVersionNumber],
  );
  const base = mapVersion(baseRows.rows[0]!);

  let changeKind: OpportunityChangeKind;
  let content: OpportunityContent;
  /** The evidence-set identity of the version being appended (the merged
   *  set for a content revision; carried over for a surgical transition). */
  let fingerprint: string;

  if (patch.status !== null) {
    // --- surgical lifecycle transition ---
    const from = base.content.status;
    const to = patch.status;
    if (from === 'pursued') {
      throw new OpportunitiesError(
        'invalid_revision_input',
        `opportunity '${patch.opportunityId}' is pursued (terminal) — follow-through and outcomes are measured where they belong, not on the opportunity record`,
      );
    }
    if (from === 'dismissed' && to !== 'open') {
      throw new OpportunitiesError(
        'invalid_revision_input',
        `a dismissed opportunity accepts nothing but reactivation (got '${to}')`,
      );
    }
    if (from === 'open' && to === 'open') {
      throw new OpportunitiesError(
        'invalid_revision_input',
        "opportunity is already open — a surgical status change must be a transition",
      );
    }
    changeKind = to === 'pursued' ? 'pursued' : to === 'dismissed' ? 'dismissed' : 'reactivated';
    content = { ...base.content, status: to };
    fingerprint = base.evidenceFingerprint; // surgical: the evidence set is untouched
  } else {
    // --- content revision (open opportunities only) ---
    if (base.content.status !== 'open') {
      throw new OpportunitiesError(
        'invalid_revision_input',
        `only an open opportunity's content can be revised (this one is ${base.content.status}); reactivate it first or record a new conversion`,
      );
    }
    const mergedEvidence = patch.evidence ?? {
      observationIds: base.content.evidence.observationIds,
      claimIds: base.content.evidence.claimIds,
    };
    const evidence = await deriveEvidence(ctx, mergedEvidence); // re-validated + re-derived
    const affectedGoals =
      patch.affectedGoals === null
        ? base.content.affectedGoals
        : await resolveGoalRefs(ctx, patch.affectedGoals);
    content = {
      status: base.content.status,
      title: patch.title ?? base.content.title,
      description: patch.description ?? base.content.description,
      signalOrigin: base.content.signalOrigin, // conversion-time classification — never revised
      evidence: {
        observationIds: evidence.observationIds,
        claimIds: evidence.claimIds,
        support: evidence.support,
        confidences: evidence.confidences,
      },
      confidence: evidence.confidence,
      estimatedValue: patch.estimatedValue ?? base.content.estimatedValue,
      affectedGoals,
      requiredCapabilities: patch.requiredCapabilities ?? base.content.requiredCapabilities,
      worldEntities: patch.worldEntities ?? base.content.worldEntities,
      recommendedNextAction: patch.recommendedNextAction ?? base.content.recommendedNextAction,
    };
    // The patch must actually change the content (the goals module's rule).
    const changed =
      content.title !== base.content.title ||
      content.description !== base.content.description ||
      content.confidence !== base.content.confidence ||
      content.evidence.support !== base.content.evidence.support ||
      content.evidence.observationIds.join(',') !== base.content.evidence.observationIds.join(',') ||
      content.evidence.claimIds.join(',') !== base.content.evidence.claimIds.join(',') ||
      content.estimatedValue.amount !== base.content.estimatedValue.amount ||
      content.estimatedValue.currency !== base.content.estimatedValue.currency ||
      JSON.stringify(content.affectedGoals) !== JSON.stringify(base.content.affectedGoals) ||
      JSON.stringify(content.requiredCapabilities) !==
        JSON.stringify(base.content.requiredCapabilities) ||
      JSON.stringify(content.worldEntities) !== JSON.stringify(base.content.worldEntities) ||
      content.recommendedNextAction.kind !== base.content.recommendedNextAction.kind ||
      content.recommendedNextAction.statement !== base.content.recommendedNextAction.statement;
    if (!changed) {
      throw new OpportunitiesError(
        'invalid_revision_input',
        'the revision must change at least one field (title, description, evidence, estimatedValue, affectedGoals, requiredCapabilities, worldEntities or recommendedNextAction)',
      );
    }
    changeKind = 'revised';
    fingerprint = evidence.fingerprint;
  }

  const version = baseVersionNumber + 1;

  // --- phase 2: the locked append — the version guard makes the phase-1
  // merge authoritative (a concurrent writer moving the pointer first
  // fails this append cleanly; the loser re-reads and retries). ---
  return getDb().transaction(async (tx) => {
    const locked = await tx.query<{ id: string; current_version: number | string; created_at: Date | string }>(
      `SELECT id, current_version, created_at FROM opportunities
         WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, patch.opportunityId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw opportunityNotFound(patch.opportunityId);
    if (toInt(identity.current_version) !== baseVersionNumber) {
      throw new OpportunitiesError(
        'opportunity_conflict',
        'a concurrent revision moved this opportunity forward; re-read it and retry',
      );
    }

    // Optimistic pointer advance (defense in depth on top of the row lock).
    const moved = await tx.query(
      `UPDATE opportunities SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, identity.id, version, baseVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new OpportunitiesError(
        'opportunity_conflict',
        'a concurrent revision moved this opportunity forward; re-read it and retry',
      );
    }

    try {
      await versionInsert(tx, {
        tenantId: ctx.tenantId,
        opportunityId: identity.id,
        version,
        changeKind,
        content,
        fingerprint,
        actor: patch.actor,
        principalId: ctx.principalId,
        rationale: patch.rationale,
        recordedAt: now(),
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'opportunity_versions')) {
        throw new OpportunitiesError(
          'opportunity_conflict',
          'a concurrent revision appended this version number first; re-read the opportunity and retry',
        );
      }
      throw error;
    }

    const versionRows = await tx.query<VersionRow>(
      `SELECT * FROM opportunity_versions
        WHERE tenant_id = $1 AND opportunity_id = $2 AND version = $3`,
      [ctx.tenantId, identity.id, version],
    );
    return opportunityOf(identity.id, ctx.tenantId, identity.created_at, mapVersion(versionRows.rows[0]!));
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The current-view join: the identity's created_at plus the FULL current
 *  version row (ov.*) — one query, no N+1; ov.opportunity_id is the
 *  identity id by the join condition. */
const CURRENT_VIEW_SELECT = `SELECT o.created_at AS opportunity_created_at, ov.*
FROM opportunities o
  INNER JOIN opportunity_versions ov
    ON ov.opportunity_id = o.id AND ov.tenant_id = o.tenant_id AND ov.version = o.current_version`;

/** VersionRow + the identity's created_at (the join's only extra column). */
interface CurrentViewRow extends VersionRow {
  opportunity_created_at: Date | string;
}

function mapOpportunityRow(row: CurrentViewRow): Opportunity {
  const version = mapVersion(row);
  return {
    id: row.opportunity_id,
    tenantId: row.tenant_id,
    version: version.version,
    content: version.content,
    evidenceFingerprint: version.evidenceFingerprint,
    createdAt: toIso(row.opportunity_created_at),
    updatedAt: version.recordedAt,
    lastChange: {
      kind: version.changeKind,
      actor: version.actor,
      changedByPrincipal: version.changedByPrincipal,
      rationale: version.rationale,
      recordedAt: version.recordedAt,
    },
  };
}

export async function getOpportunity(ctx: TenantContext, opportunityId: string): Promise<Opportunity> {
  assertOpportunitiesTenantContext(ctx);
  if (!isUuid(opportunityId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw opportunityNotFound(opportunityId);
  }
  const rows = await getDb().query<CurrentViewRow>(
    `${CURRENT_VIEW_SELECT}
      WHERE o.tenant_id = $1 AND o.id = $2`,
    [ctx.tenantId, opportunityId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw opportunityNotFound(opportunityId);
  return mapOpportunityRow(row);
}

export async function listOpportunities(
  ctx: TenantContext,
  query: ListOpportunitiesQuery,
): Promise<Opportunity[]> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateListOpportunitiesQuery(query);

  const conditions: string[] = ['o.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.status !== null) add('ov.status = $#', valid.status);
  if (valid.signalOrigin !== null) add('ov.signal_origin = $#', valid.signalOrigin);
  if (valid.minConfidence > 0) add('ov.confidence >= $#', valid.minConfidence);
  if (valid.goalId !== null) add('ov.affected_goals @> $#::jsonb', JSON.stringify([{ goalId: valid.goalId }]));
  if (valid.capabilityId !== null) {
    add('ov.required_capabilities @> $#::jsonb', JSON.stringify([{ capabilityId: valid.capabilityId }]));
  }
  if (valid.worldEntityId !== null) {
    add('ov.world_entities @> $#::jsonb', JSON.stringify([{ entityId: valid.worldEntityId }]));
  }
  if (valid.search !== null) {
    // escaped substring match on the title — caller text is never a wildcard
    // pattern (the missions module's ILIKE discipline).
    add("ov.title ILIKE '%' || $# || '%' ESCAPE '\\'", escapeLike(valid.search));
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<CurrentViewRow>(
    `${CURRENT_VIEW_SELECT}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ov.recorded_at DESC, o.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapOpportunityRow);
}

export async function getOpportunityVersion(
  ctx: TenantContext,
  query: GetOpportunityVersionQuery,
): Promise<OpportunityVersion> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateVersionQuery(query);
  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM opportunity_versions WHERE tenant_id = $1 AND opportunity_id = $2 AND version = $3`,
    [ctx.tenantId, valid.opportunityId, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OpportunitiesError(
      'opportunity_version_not_found',
      `version ${valid.version} of opportunity '${valid.opportunityId}' does not exist in this tenant`,
    );
  }
  return mapVersion(row);
}

export async function listOpportunityVersions(
  ctx: TenantContext,
  query: ListOpportunityVersionsQuery,
): Promise<OpportunityVersion[]> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateHistoryQuery(query);
  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM opportunity_versions WHERE tenant_id = $1 AND opportunity_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.opportunityId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such opportunity in this tenant" from "an
    // opportunity without history" (impossible by construction) — a
    // foreign-tenant opportunity id reads the same as a missing one.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM opportunities WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.opportunityId],
    );
    if (exists.rows.length === 0) throw opportunityNotFound(valid.opportunityId);
  }
  return rows.rows.map(mapVersion);
}

export async function getConversionRun(
  ctx: TenantContext,
  query: GetConversionRunQuery,
): Promise<ConversionRun> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateRunQuery(query);
  const rows = await getDb().query<RunRow>(
    `SELECT * FROM opportunity_conversion_runs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.runId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OpportunitiesError(
      'run_not_found',
      `conversion run '${valid.runId}' does not exist in this tenant`,
    );
  }
  const candidates = await getDb().query<CandidateRow>(
    `SELECT * FROM opportunity_conversion_candidates
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, valid.runId],
  );
  const decided = candidates.rows.map(mapCandidate);
  const summary = mapRunSummary(row);
  return { ...summary, counts: mapRunCountsOf(decided), candidates: decided };
}

export async function listConversionRuns(
  ctx: TenantContext,
  query: ListConversionRunsQuery,
): Promise<ConversionRunSummary[]> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateRunListQuery(query);

  const conditions: string[] = ['r.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.triggerKind !== null) add('r.trigger_kind = $#', valid.triggerKind);
  if (valid.originatingExecutionId !== null) {
    add('r.originating_execution_id = $#', valid.originatingExecutionId);
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<RunSummaryRow>(
    `SELECT r.*,
            count(c.id) FILTER (WHERE c.disposition = 'converted') AS converted_count,
            count(c.id) FILTER (WHERE c.disposition = 'below_threshold') AS below_threshold_count,
            count(c.id) FILTER (WHERE c.disposition = 'currency_mismatch') AS currency_mismatch_count,
            count(c.id) FILTER (WHERE c.disposition = 'duplicate') AS duplicate_count
       FROM opportunity_conversion_runs r
       LEFT JOIN opportunity_conversion_candidates c
         ON c.tenant_id = r.tenant_id AND c.run_id = r.id
      WHERE ${conditions.join(' AND ')}
      GROUP BY r.id
      ORDER BY r.recorded_at DESC, r.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map((row) => mapRunSummary(row, runCountsOfSummaryRow(row)));
}

export async function getConversionCandidate(
  ctx: TenantContext,
  query: GetConversionCandidateQuery,
): Promise<ConversionCandidate> {
  assertOpportunitiesTenantContext(ctx);
  const valid = validateCandidateQuery(query);
  const rows = await getDb().query<CandidateRow>(
    `SELECT * FROM opportunity_conversion_candidates WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.candidateId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new OpportunitiesError(
      'candidate_not_found',
      `conversion candidate '${valid.candidateId}' does not exist in this tenant`,
    );
  }
  return mapCandidate(row);
}
