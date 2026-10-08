// Implementation of the org-lab module's public operations (see
// contract.ts).
//
// W135 — the Contextual Organizational Lab (spec/work-items/
// WORK-ITEM-CATALOG.md §W135; design contract AGENT-BODY-LAB-CROSS-
// PLATFORM-ARCHITECTURE.md §2/§4/§5/§10/§11): register tenant-scoped
// organization candidates (§4 compositions of role proposals, agent/body
// nodes, topology edges and information routes — the §5 comparison set),
// search them under a ContextFingerprint (§2 — the W134 seam, never
// re-derived here), record recommendations as immutable §11 evidence
// objects (goal revision, fingerprint, knowledge objective, ALL evaluated
// candidates INCLUDING the rejected ones, model occupancies, evaluation
// configuration, expected outcomes), and calibrate them against the
// learning module's frozen outcome realizations.
//
// THE CONTEXTUAL RULE (binding): nothing here knows an industry, a season
// name or a "best practice". Candidates carry caller-supplied applicability
// hypotheses; the search matches those declarations MECHANICALLY against
// the observed fingerprint (ranking.ts), and outcome calibration modulates
// the ordering arithmetically. The same subject under a materially
// different fingerprint may rank a different candidate first — that
// divergence is data, never code.
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding — the house law at
// src/modules/agents/service.ts:1325-1331): PGlite is single-connection,
// so a base-connection read inside an open `db.transaction(...)` starves
// the embedded database. EVERY cross-module read (goals, context,
// info-strategy, agent-evaluation, learning, agent-body, provider-fabric —
// all of which execute on the base connection through their own getDb())
// and every evidence gate therefore runs BEFORE the transaction opens;
// each mutation then keeps its append + lifecycle transitions atomic in
// ONE transaction whose statements touch only this module's tables:
//
//   * registerCandidate — agent-body ref gates first, then ONE INSERT
//     (single-statement atomic; no transaction wrapper needed — the
//     agent-body createAgentBody precedent);
//   * retireCandidate — one transaction: FOR UPDATE row lock, one-way
//     status check, the single lifecycle UPDATE;
//   * recordRecommendation — ALL gates first (goal ACTIVE + version
//     snapshot, fingerprint readable + goal-matched, strategy readable,
//     candidates readable, agent evaluations readable, expected outcomes
//     OPEN, the model-occupancy snapshot through the agent-body +
//     provider-fabric seams), then ONE transaction appending the
//     recommendation pointer + every candidate evaluation + every
//     occupancy row + every expected-outcome snapshot;
//   * recordCalibration — the frozen realizations are read through the
//     learning contract FIRST, then ONE transaction re-checks the
//     recorded → calibrated transition under a FOR UPDATE row lock (the
//     immutable-version staleness re-check — an interrupted or racing
//     calibrate loses to the one that moved the row) and appends the
//     calibration + stamps the pointer.
//
// The Lab RECOMMENDS (§10, the completion law): no operation here
// installs a marketplace package, recruits an agent, executes an external
// specialist or grants any authority — everything is records and reads.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by newId(); semantic
// timestamps come from the injectable clock and are never
// caller-supplied; principals (`createdBy`, `recordedBy`, `calibratedBy`)
// are system-captured from the explicit TenantContext; every statement is
// scoped by tenant (ADR-0001) — cross-tenant access is indistinguishable
// from missing records (uniform typed not-found, no existence leak).
//
// Deterministic orders (test-locked): candidates by slug ASC;
// recommendations newest first (recorded_at DESC, id DESC); evaluations by
// their monotonic position; occupancy rows by (node_id, purpose); outcome
// snapshots by outcome_id; calibration evidence ids by (calibrated_at,
// id); search results by (rankScore DESC, slug ASC — ranking.ts).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import { getFingerprint, ContextError } from '@/modules/context/contract';
import { getStrategy, InfoStrategyError } from '@/modules/info-strategy/contract';
import {
  getAgentEvaluation,
  AgentEvaluationError,
} from '@/modules/agent-evaluation/contract';
import { getOutcome, LearningError } from '@/modules/learning/contract';
import {
  AgentBodyError,
  getActiveBinding,
  getAgentBody,
} from '@/modules/agent-body/contract';
import { getActiveModelBinding } from '@/modules/provider-fabric/contract';
import { OrgLabError } from './errors';
import {
  assertOrgLabTenantContext,
  validateGetCandidateCalibrationQuery,
  validateGetCandidateQuery,
  validateGetRecommendationQuery,
  validateListCandidatesQuery,
  validateListRecommendationsQuery,
  validateRecordCalibrationInput,
  validateRecordRecommendationInput,
  validateRegisterCandidateInput,
  validateRetireCandidateInput,
  validateSearchOrganizationsQuery,
} from './validation';
import type {
  ValidatedGetCandidateCalibrationQuery,
  ValidatedGetCandidateQuery,
  ValidatedGetRecommendationQuery,
  ValidatedListCandidatesQuery,
  ValidatedListRecommendationsQuery,
  ValidatedRecordCalibrationInput,
  ValidatedRecordRecommendationInput,
  ValidatedRegisterCandidateInput,
  ValidatedRetireCandidateInput,
  ValidatedSearchOrganizationsQuery,
  ValidatedCandidateEvaluation,
} from './validation';
import {
  calibrationAggregate,
  calibrationPolarity,
  rankOrganizationCandidates,
} from './ranking';
import type {
  CalibrationPolarity,
  CalibrationSummary,
  CandidateApplicability,
  CandidateEvaluationRecord,
  EvaluationConfig,
  ExpectedOutcomeRecord,
  GetCandidateCalibrationQuery,
  GetCandidateQuery,
  GetRecommendationQuery,
  ListCandidatesQuery,
  ListRecommendationsQuery,
  OccupancySnapshot,
  OrgCandidate,
  OrgComposition,
  OrgNodeKind,
  OrgRecommendation,
  OrgRecommendationSummary,
  OrgSearchResult,
  RealizedOutcomeRecord,
  RecordCalibrationInput,
  RecordRecommendationInput,
  RegisterCandidateInput,
  RetireCandidateInput,
  SearchOrganizationsQuery,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface CandidateRow extends DbRow {
  id: string;
  tenant_id: string;
  slug: string;
  label: string;
  description: string | null;
  composition: OrgComposition;
  applicability: CandidateApplicability;
  status: string;
  lifecycle_note: string | null;
  retired_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RecommendationRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  goal_version: number;
  fingerprint_id: string;
  strategy_id: string | null;
  knowledge_objective: string;
  evaluation_config: EvaluationConfig;
  recommended_candidate_id: string | null;
  status: string;
  note: string | null;
  derived_from: string[];
  recorded_by: string;
  recorded_at: Date | string;
  calibrated_at: Date | string | null;
}

interface RecommendationCandidateRow extends DbRow {
  id: string;
  tenant_id: string;
  recommendation_id: string;
  candidate_id: string;
  disposition: string;
  rejection_reasons: string[];
  evaluation: {
    summary: string;
    scores: { name: string; value: number }[];
    evidenceRefs: string[];
    agentEvaluationIds: string[];
  };
  position: number;
}

interface OccupancyRow extends DbRow {
  id: string;
  tenant_id: string;
  recommendation_id: string;
  node_id: string;
  role: string;
  purpose: string;
  body_id: string;
  body_binding_id: string | null;
  fabric_binding_id: string | null;
}

interface ExpectedOutcomeRow extends DbRow {
  id: string;
  tenant_id: string;
  recommendation_id: string;
  outcome_id: string;
  metric_name: string;
  metric_unit: string;
  direction: string;
  baseline: number;
  expected: number;
}

interface CalibrationRow extends DbRow {
  id: string;
  tenant_id: string;
  recommendation_id: string;
  polarity: string;
  realized: RealizedOutcomeRecord[];
  note: string | null;
  calibrated_by: string;
  calibrated_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapCandidate(row: CandidateRow): OrgCandidate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    label: row.label,
    description: row.description,
    composition: row.composition,
    applicability: row.applicability,
    status: row.status as OrgCandidate['status'],
    lifecycleNote: row.lifecycle_note,
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** PostgreSQL unique-violation (23505) from either db backend. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

/** The per-node-kind census of a composition (the §5 comparison set). */
function nodeKindCensus(composition: OrgComposition): Record<OrgNodeKind, number> {
  const census: Record<OrgNodeKind, number> = {
    'agent-body': 0,
    'tenant-agent': 0,
    'marketplace-agent-package': 0,
    'marketplace-extension-package': 0,
    'human-capability': 0,
    'external-specialist': 0,
  };
  for (const node of composition.nodes) {
    census[node.kind] += 1;
  }
  return census;
}

// ---------------------------------------------------------------------------
// Tenant-scoped loaders (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function findCandidateRow(
  db: Queryable,
  ctx: TenantContext,
  candidateId: string,
  forUpdate: boolean,
): Promise<CandidateRow | null> {
  const result = await db.query<CandidateRow>(
    `SELECT * FROM org_candidates WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, candidateId],
  );
  return result.rows[0] ?? null;
}

async function loadRecommendationRow(
  db: Queryable,
  ctx: TenantContext,
  recommendationId: string,
  forUpdate: boolean,
): Promise<RecommendationRow> {
  const result = await db.query<RecommendationRow>(
    `SELECT * FROM org_recommendations
       WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, recommendationId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new OrgLabError(
      'recommendation_not_found',
      `no recommendation '${recommendationId}' exists in this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Cross-module evidence gates — ALWAYS before a transaction (see the
// header's transaction-discipline law). Failure posture: a missing,
// foreign or unreadable reference reads uniformly as its typed not-found
// code, never leaking existence (the info-strategy discipline).
// ---------------------------------------------------------------------------

/**
 * The subject goal must exist and be ACTIVE in this tenant. Returns the
 * goal so callers can snapshot its current version (§11 "goal revision").
 */
async function requireActiveGoal(
  ctx: TenantContext,
  goalId: string,
): Promise<{ version: number }> {
  let goal;
  try {
    goal = await getGoal(ctx, goalId);
  } catch (error) {
    if (error instanceof GoalsError) {
      throw new OrgLabError(
        'goal_not_found',
        `goal '${goalId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (goal.content.status !== 'active') {
    throw new OrgLabError(
      'goal_not_found',
      `goal '${goalId}' is ${goal.content.status} — the Lab serves current direction only`,
    );
  }
  return { version: goal.version };
}

/**
 * The fingerprint must be readable in this tenant AND derived FOR the
 * subject goal — a search or recommendation for goal G under goal H's
 * context is incoherent (the W134 seam owns derivation; this layer only
 * consumes).
 */
async function requireFingerprintForGoal(
  ctx: TenantContext,
  fingerprintId: string,
  goalId: string,
): Promise<void> {
  let fingerprint;
  try {
    fingerprint = await getFingerprint(ctx, { fingerprintId });
  } catch (error) {
    if (error instanceof ContextError) {
      throw new OrgLabError(
        'fingerprint_not_found',
        `context fingerprint '${fingerprintId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (fingerprint.goalId !== goalId) {
    throw new OrgLabError(
      'fingerprint_goal_mismatch',
      `context fingerprint '${fingerprintId}' was derived for a different goal — condition the search on a fingerprint of goal '${goalId}'`,
    );
  }
}

/** The optional W134 info-strategy link must be readable (opaque after). */
async function requireStrategy(ctx: TenantContext, strategyId: string): Promise<void> {
  try {
    await getStrategy(ctx, { strategyId });
  } catch (error) {
    if (error instanceof InfoStrategyError) {
      throw new OrgLabError(
        'strategy_not_found',
        `info strategy '${strategyId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** Every cited agent evaluation (W024) must be readable in this tenant. */
async function requireAgentEvaluations(
  ctx: TenantContext,
  agentEvaluationIds: readonly string[],
): Promise<void> {
  for (const evaluationId of agentEvaluationIds) {
    try {
      await getAgentEvaluation(ctx, { evaluationId });
    } catch (error) {
      if (error instanceof AgentEvaluationError) {
        throw new OrgLabError(
          'evaluation_ref_not_found',
          `agent evaluation '${evaluationId}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }
}

/**
 * Every expected outcome must be a readable OPEN learning-module outcome —
 * the recommendation commits to its expected value BEFORE realization (the
 * W054 prediction-hygiene discipline). A settled, abandoned, foreign or
 * missing outcome is uniformly `invalid_outcome_ref` (no existence leak).
 * Returns the readable outcomes so the caller snapshots their immutable
 * definitions (one read per outcome, never two).
 */
async function loadOpenOutcomes(
  ctx: TenantContext,
  outcomeIds: readonly string[],
): Promise<Awaited<ReturnType<typeof getOutcome>>[]> {
  const outcomes: Awaited<ReturnType<typeof getOutcome>>[] = [];
  for (const outcomeId of outcomeIds) {
    let outcome;
    try {
      outcome = await getOutcome(ctx, outcomeId);
    } catch (error) {
      if (error instanceof LearningError) {
        throw new OrgLabError(
          'invalid_outcome_ref',
          `expected outcome '${outcomeId}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
    if (outcome.status !== 'open') {
      throw new OrgLabError(
        'invalid_outcome_ref',
        `expected outcome '${outcomeId}' is ${outcome.status} — a recommendation may only commit to outcomes that are still OPEN`,
      );
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Registration-time gate: every agent-body node references a body that is
 * readable and ACTIVE in this tenant (a FRESH design references live
 * bodies — the W133 seam). Every other node kind stays an opaque forward
 * reference owned by its registry (the §5 comparison set).
 */
async function validateAgentBodyRefs(
  ctx: TenantContext,
  composition: OrgComposition,
): Promise<void> {
  for (const node of composition.nodes) {
    if (node.kind !== 'agent-body') continue;
    let body;
    try {
      body = await getAgentBody(ctx, { bodyId: node.ref! });
    } catch (error) {
      if (error instanceof AgentBodyError) {
        throw new OrgLabError(
          'node_ref_not_found',
          `composition node '${node.nodeId}' references a body that is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
    if (body.status !== 'active') {
      throw new OrgLabError(
        'node_ref_inactive',
        `composition node '${node.nodeId}' references a retired body — a fresh design references live bodies`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// registerCandidate / getCandidate / listCandidates / retireCandidate
// ---------------------------------------------------------------------------

export async function registerCandidate(
  ctx: TenantContext,
  input: RegisterCandidateInput,
): Promise<OrgCandidate> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedRegisterCandidateInput = validateRegisterCandidateInput(input);

  // Cross-module gate BEFORE any write (the transaction-discipline law):
  // agent-body refs validate through the W133 contract on the base
  // connection, then the single INSERT runs atomically.
  await validateAgentBodyRefs(ctx, valid.composition);

  const db = getDb();
  // The friendly pre-check keeps the common path's error message precise;
  // the UNIQUE constraint (mapped below) is the truth under races.
  const existing = await db.query<CandidateRow>(
    `SELECT id FROM org_candidates WHERE tenant_id = $1 AND slug = $2`,
    [ctx.tenantId, valid.slug],
  );
  if (existing.rows.length > 0) {
    throw new OrgLabError(
      'candidate_slug_taken',
      `slug '${valid.slug}' is already taken by a candidate in this tenant`,
    );
  }

  const stampedAt = now();
  try {
    const result = await db.query<CandidateRow>(
      `INSERT INTO org_candidates
         (id, tenant_id, slug, label, description, composition, applicability,
          status, lifecycle_note, retired_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb,
               'active', NULL, NULL, $8, $9, $10)
       RETURNING *`,
      [
        newId(),
        ctx.tenantId,
        valid.slug,
        valid.label,
        valid.description,
        JSON.stringify(valid.composition),
        JSON.stringify(valid.applicability),
        ctx.principalId,
        stampedAt,
        stampedAt,
      ],
    );
    return mapCandidate(result.rows[0]!);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new OrgLabError(
        'candidate_slug_taken',
        `slug '${valid.slug}' is already taken by a candidate in this tenant`,
      );
    }
    throw error;
  }
}

export async function getCandidate(
  ctx: TenantContext,
  query: GetCandidateQuery,
): Promise<OrgCandidate> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedGetCandidateQuery = validateGetCandidateQuery(query);
  const row = await findCandidateRow(getDb(), ctx, valid.candidateId, false);
  if (row === null) {
    throw new OrgLabError(
      'candidate_not_found',
      `no candidate '${valid.candidateId}' exists in this tenant`,
    );
  }
  return mapCandidate(row);
}

export async function listCandidates(
  ctx: TenantContext,
  query?: ListCandidatesQuery,
): Promise<OrgCandidate[]> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedListCandidatesQuery = validateListCandidatesQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM org_candidates WHERE tenant_id = $1`;
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(valid.limit);
  // Deterministic order: the tenant-unique immutable slug.
  sql += ` ORDER BY slug ASC LIMIT $${params.length}`;
  const rows = await getDb().query<CandidateRow>(sql, params);
  return rows.rows.map(mapCandidate);
}

export async function retireCandidate(
  ctx: TenantContext,
  input: RetireCandidateInput,
): Promise<OrgCandidate> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedRetireCandidateInput = validateRetireCandidateInput(input);
  const db = getDb();

  // No cross-module reads needed — the whole lifecycle transition is ONE
  // transaction over this module's own table (FOR UPDATE serializes
  // double-retire races; the schema trigger guards the transition in
  // depth).
  return db.transaction(async (tx) => {
    const row = await findCandidateRow(tx, ctx, valid.candidateId, true);
    if (row === null) {
      throw new OrgLabError(
        'candidate_not_found',
        `no candidate '${valid.candidateId}' exists in this tenant`,
      );
    }
    if (row.status !== 'active') {
      throw new OrgLabError(
        'candidate_retired',
        `candidate '${valid.candidateId}' is already retired — the lifecycle is one-way`,
      );
    }
    // The evaluation history is deliberately left untouched: evaluations
    // are retained evidence about designs that were considered, and
    // retiring the candidate is recorded on the candidate.
    const stampedAt = now();
    const updated = await tx.query<CandidateRow>(
      `UPDATE org_candidates
         SET status = 'retired', retired_at = $3, lifecycle_note = $4, updated_at = $5
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
      [ctx.tenantId, valid.candidateId, stampedAt, valid.reason, stampedAt],
    );
    return mapCandidate(updated.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// searchOrganizations — the contextually-conditioned organization search
// ---------------------------------------------------------------------------

/** Keyset page size for the active-candidate scan (bounded, complete). */
const CANDIDATE_PAGE_SIZE = 500;

/**
 * The calibration aggregate of every given candidate: calibrated
 * recommendations in which the candidate was the RECOMMENDED one
 * (disposition 'recommended' — the polarity measures the outcomes of the
 * design that actually ran; a rejected alternative carries no realized
 * outcome of its own). Aggregates only, never per-recommendation labels
 * (the ADR-0019 no-leak law). Ascending (calibrated_at, id) order — the
 * evidence trail is deterministic.
 */
async function calibrationSummariesFor(
  db: Queryable,
  ctx: TenantContext,
  candidateIds: readonly string[],
): Promise<Map<string, CalibrationSummary>> {
  const summaries = new Map<string, CalibrationSummary>();
  if (candidateIds.length === 0) return summaries;
  const rows = await db.query<{
    candidate_id: string;
    recommendation_id: string;
    polarity: string;
  }>(
    `SELECT rc.candidate_id, r.id AS recommendation_id, c.polarity
       FROM org_recommendation_calibrations c
       JOIN org_recommendations r
         ON r.tenant_id = c.tenant_id AND r.id = c.recommendation_id
       JOIN org_recommendation_candidates rc
         ON rc.tenant_id = c.tenant_id
        AND rc.recommendation_id = c.recommendation_id
        AND rc.disposition = 'recommended'
      WHERE c.tenant_id = $1 AND rc.candidate_id = ANY($2)
      ORDER BY c.calibrated_at ASC, r.id ASC`,
    [ctx.tenantId, [...candidateIds]],
  );
  const byCandidate = new Map<string, { recommendationId: string; polarity: 'positive' | 'negative' }[]>();
  for (const row of rows.rows) {
    const entry = byCandidate.get(row.candidate_id) ?? [];
    entry.push({ recommendationId: row.recommendation_id, polarity: row.polarity as 'positive' | 'negative' });
    byCandidate.set(row.candidate_id, entry);
  }
  for (const [candidateId, polarities] of byCandidate) {
    const summary = calibrationAggregate(polarities);
    if (summary !== null) {
      summaries.set(candidateId, { ...summary, candidateId });
    }
  }
  return summaries;
}

export async function searchOrganizations(
  ctx: TenantContext,
  query: SearchOrganizationsQuery,
): Promise<OrgSearchResult[]> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedSearchOrganizationsQuery = validateSearchOrganizationsQuery(query);

  // Evidence gates on the base connection — BEFORE any ranking work (the
  // transaction-discipline law; this operation is read-only throughout).
  await requireActiveGoal(ctx, valid.goalId);
  let fingerprint;
  try {
    fingerprint = await getFingerprint(ctx, { fingerprintId: valid.fingerprintId });
  } catch (error) {
    if (error instanceof ContextError) {
      throw new OrgLabError(
        'fingerprint_not_found',
        `context fingerprint '${valid.fingerprintId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (fingerprint.goalId !== valid.goalId) {
    throw new OrgLabError(
      'fingerprint_goal_mismatch',
      `context fingerprint '${valid.fingerprintId}' was derived for a different goal — condition the search on a fingerprint of goal '${valid.goalId}'`,
    );
  }

  const db = getDb();

  // The complete active-candidate scan, keyset-paged on the immutable slug
  // (bounded pages, no skipped candidates regardless of registry size).
  const rows: CandidateRow[] = [];
  let afterSlug = '';
  for (;;) {
    const page = await db.query<CandidateRow>(
      `SELECT * FROM org_candidates
        WHERE tenant_id = $1 AND status = 'active' AND slug > $2
        ORDER BY slug ASC
        LIMIT $3`,
      [ctx.tenantId, afterSlug, CANDIDATE_PAGE_SIZE],
    );
    rows.push(...page.rows);
    if (page.rows.length < CANDIDATE_PAGE_SIZE) break;
    afterSlug = page.rows[page.rows.length - 1]!.slug;
  }

  // The calibration aggregates for every scanned candidate (one query).
  const calibrations = await calibrationSummariesFor(
    db,
    ctx,
    rows.map((row) => row.id),
  );

  // The pure ranker: mechanical fit of declared hypotheses against the
  // observed fingerprint, modulated by outcome calibration. Read-only data
  // in, deterministic order out.
  const ranked = rankOrganizationCandidates(
    fingerprint,
    rows.map((row) => ({
      candidateId: row.id,
      slug: row.slug,
      applicability: row.applicability,
    })),
    calibrations,
  );

  const byId = new Map(rows.map((row) => [row.id, row] as const));
  return ranked.slice(0, valid.limit).map((entry) => {
    const row = byId.get(entry.candidateId)!;
    return {
      candidateId: entry.candidateId,
      slug: entry.slug,
      label: row.label,
      status: row.status as OrgCandidate['status'],
      rankScore: entry.rankScore,
      fitScore: entry.fitScore,
      dimensions: entry.dimensions,
      calibration: calibrations.get(entry.candidateId) ?? null,
      nodeKinds: nodeKindCensus(row.composition),
    };
  });
}

// ---------------------------------------------------------------------------
// recordRecommendation — the §11 evidence object
// ---------------------------------------------------------------------------

/**
 * The model-occupancy snapshot of the RECOMMENDED candidate's agent-body
 * nodes (§11 "model occupancies"): for every purpose a binding must
 * actively possess the body through, the body's current active attachment
 * (its OPAQUE fabric binding id, VERBATIM — the W133 seam) and the
 * tenant's current active fabric binding for that purpose (the W132
 * seam). null = honestly unoccupied at snapshot time. The Lab never
 * creates, swaps or detaches bindings — it records what is.
 */
async function snapshotModelOccupancy(
  ctx: TenantContext,
  recommendedCandidateId: string | null,
  candidatesById: ReadonlyMap<string, CandidateRow>,
): Promise<OccupancySnapshot[]> {
  if (recommendedCandidateId === null) return [];
  const candidate = candidatesById.get(recommendedCandidateId);
  if (candidate === undefined) return [];
  const snapshots: OccupancySnapshot[] = [];
  for (const node of candidate.composition.nodes) {
    if (node.kind !== 'agent-body') continue;
    if (node.ref === null) {
      // Unreachable post-validation (agent-body nodes carry uuid refs) —
      // stated honestly rather than silently skipped.
      throw new OrgLabError(
        'invalid_recommendation_input',
        `composition node '${node.nodeId}' is an agent-body node without a body reference`,
      );
    }
    for (const purpose of node.purposes) {
      const attachment = await getActiveBinding(ctx, { bodyId: node.ref, purpose });
      const fabric = await getActiveModelBinding(ctx, { purpose });
      snapshots.push({
        nodeId: node.nodeId,
        role: node.role,
        purpose,
        bodyId: node.ref,
        bodyBindingId: attachment === null ? null : attachment.bindingId,
        fabricBindingId: fabric === null ? null : fabric.bindingId,
      });
    }
  }
  // Deterministic storage order (the UNIQUE (node_id, purpose) backstop
  // makes duplicates impossible).
  snapshots.sort((a, b) =>
    a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.purpose < b.purpose ? -1 : 1,
  );
  return snapshots;
}

export async function recordRecommendation(
  ctx: TenantContext,
  input: RecordRecommendationInput,
): Promise<OrgRecommendation> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedRecordRecommendationInput = validateRecordRecommendationInput(input);

  // ---- EVERY evidence gate BEFORE the transaction (the W134/W135 law) --
  const goal = await requireActiveGoal(ctx, valid.goalId);
  await requireFingerprintForGoal(ctx, valid.fingerprintId, valid.goalId);
  if (valid.strategyId !== null) {
    await requireStrategy(ctx, valid.strategyId);
  }

  // Every evaluated candidate must be readable in this tenant (any status:
  // an evaluation of a retired design is legitimate retained evidence —
  // only the SEARCH refuses retired candidates).
  const db = getDb();
  const evaluatedIds = valid.candidates.map((candidate) => candidate.candidateId);
  const candidateRows = await db.query<CandidateRow>(
    `SELECT * FROM org_candidates WHERE tenant_id = $1 AND id = ANY($2)`,
    [ctx.tenantId, evaluatedIds],
  );
  const candidatesById = new Map(candidateRows.rows.map((row) => [row.id, row] as const));
  for (const candidateId of evaluatedIds) {
    if (!candidatesById.has(candidateId)) {
      throw new OrgLabError(
        'candidate_not_found',
        `no candidate '${candidateId}' exists in this tenant`,
      );
    }
  }

  const citedEvaluations = [
    ...new Set(valid.candidates.flatMap((candidate) => candidate.agentEvaluationIds)),
  ];
  await requireAgentEvaluations(ctx, citedEvaluations);
  const openOutcomes = await loadOpenOutcomes(ctx, valid.expectedOutcomeIds);

  // The occupancy snapshot runs through the agent-body + provider-fabric
  // seams on the base connection — before the transaction opens.
  const recommended =
    valid.candidates.find((candidate) => candidate.disposition === 'recommended') ?? null;
  const occupancy = await snapshotModelOccupancy(
    ctx,
    recommended === null ? null : recommended.candidateId,
    candidatesById,
  );

  // The expected-outcome snapshots (the commitment BEFORE realization),
  // built from the same single read the OPEN gate used.
  const expectedOutcomes: ExpectedOutcomeRecord[] = openOutcomes.map((outcome) => ({
    outcomeId: outcome.id,
    metricName: outcome.metricName,
    metricUnit: outcome.metricUnit,
    direction: outcome.direction,
    baseline: outcome.baseline,
    expected: outcome.expected,
  }));

  const recommendationId = newId();
  const recordedAt = now();

  // ---- ONE transaction: pointer + evaluations + occupancy + outcomes ---
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO org_recommendations
         (id, tenant_id, goal_id, goal_version, fingerprint_id, strategy_id,
          knowledge_objective, evaluation_config, recommended_candidate_id,
          status, note, derived_from, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
               'recorded', $10, $11::jsonb, $12, $13)`,
      [
        recommendationId,
        ctx.tenantId,
        valid.goalId,
        goal.version,
        valid.fingerprintId,
        valid.strategyId,
        valid.knowledgeObjective,
        JSON.stringify(valid.evaluationConfig),
        recommended === null ? null : recommended.candidateId,
        valid.note,
        JSON.stringify(valid.derivedFrom),
        ctx.principalId,
        recordedAt,
      ],
    );

    let position = 0;
    for (const candidate of valid.candidates) {
      position += 1;
      await insertCandidateEvaluation(tx, ctx, recommendationId, candidate, position);
    }

    for (const snapshot of occupancy) {
      await tx.query(
        `INSERT INTO org_recommendation_occupancy
           (id, tenant_id, recommendation_id, node_id, role, purpose, body_id,
            body_binding_id, fabric_binding_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newId(),
          ctx.tenantId,
          recommendationId,
          snapshot.nodeId,
          snapshot.role,
          snapshot.purpose,
          snapshot.bodyId,
          snapshot.bodyBindingId,
          snapshot.fabricBindingId,
        ],
      );
    }

    for (const expected of expectedOutcomes) {
      await tx.query(
        `INSERT INTO org_recommendation_outcomes
           (id, tenant_id, recommendation_id, outcome_id, metric_name,
            metric_unit, direction, baseline, expected)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          newId(),
          ctx.tenantId,
          recommendationId,
          expected.outcomeId,
          expected.metricName,
          expected.metricUnit,
          expected.direction,
          expected.baseline,
          expected.expected,
        ],
      );
    }
  });

  return getRecommendation(ctx, { recommendationId });
}

async function insertCandidateEvaluation(
  tx: Queryable,
  ctx: TenantContext,
  recommendationId: string,
  candidate: ValidatedCandidateEvaluation,
  position: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO org_recommendation_candidates
       (id, tenant_id, recommendation_id, candidate_id, disposition,
        rejection_reasons, evaluation, position)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      newId(),
      ctx.tenantId,
      recommendationId,
      candidate.candidateId,
      candidate.disposition,
      candidate.rejectionReasons,
      JSON.stringify({
        summary: candidate.summary,
        scores: candidate.scores,
        evidenceRefs: candidate.evidenceRefs,
        agentEvaluationIds: candidate.agentEvaluationIds,
      }),
      position,
    ],
  );
}

// ---------------------------------------------------------------------------
// recordCalibration — the outcome-calibration loop
// ---------------------------------------------------------------------------

export async function recordCalibration(
  ctx: TenantContext,
  input: RecordCalibrationInput,
): Promise<OrgRecommendation> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedRecordCalibrationInput = validateRecordCalibrationInput(input);
  const db = getDb();

  // ---- Pre-transaction: uniform not-found + the frozen realizations ----
  const existing = await loadRecommendationRow(db, ctx, valid.recommendationId, false);
  if (existing.status !== 'recorded') {
    throw new OrgLabError(
      'recommendation_already_calibrated',
      `recommendation '${valid.recommendationId}' is already calibrated — one calibration per recommendation, terminal`,
    );
  }

  const snapshotRows = await db.query<ExpectedOutcomeRow>(
    `SELECT * FROM org_recommendation_outcomes
       WHERE tenant_id = $1 AND recommendation_id = $2
       ORDER BY outcome_id ASC`,
    [ctx.tenantId, valid.recommendationId],
  );

  // The learning module's frozen realizations, consumed VERBATIM (never
  // re-derived here). Every expected outcome must have settled — an
  // abandoned or still-open outcome can never calibrate (errors.ts law).
  const realized: RealizedOutcomeRecord[] = [];
  for (const snapshot of snapshotRows.rows) {
    let outcome;
    try {
      outcome = await getOutcome(ctx, snapshot.outcome_id);
    } catch (error) {
      if (error instanceof LearningError) {
        throw new OrgLabError(
          'invalid_outcome_ref',
          `expected outcome '${snapshot.outcome_id}' is no longer available in this tenant`,
        );
      }
      throw error;
    }
    if (outcome.status !== 'settled' || outcome.realization === null) {
      throw new OrgLabError(
        'invalid_outcome_ref',
        `expected outcome '${snapshot.outcome_id}' is ${outcome.status} — calibration consumes SETTLED realizations only (an abandoned outcome never realizes)`,
      );
    }
    realized.push({
      outcomeId: snapshot.outcome_id,
      realizedValue: outcome.realization.realizedValue,
      varianceVsExpected: outcome.realization.varianceVsExpected,
      assessment: outcome.realization.assessment,
      fromMeasurementId: outcome.realization.fromMeasurementId,
      settledAt: outcome.realization.settledAt,
    });
  }

  const polarity = calibrationPolarity(realized);
  const calibratedAt = now();

  // ---- ONE transaction: staleness re-check under the lock, append, stamp
  await db.transaction(async (tx) => {
    const row = await loadRecommendationRow(tx, ctx, valid.recommendationId, true);
    if (row.status !== 'recorded') {
      // The immutable-version staleness re-check (the W134 lesson): a
      // racing calibration that committed first owns the transition.
      throw new OrgLabError(
        'recommendation_already_calibrated',
        `recommendation '${valid.recommendationId}' is already calibrated — one calibration per recommendation, terminal`,
      );
    }
    await tx.query(
      `INSERT INTO org_recommendation_calibrations
         (id, tenant_id, recommendation_id, polarity, realized, note, calibrated_by, calibrated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        newId(),
        ctx.tenantId,
        valid.recommendationId,
        polarity,
        JSON.stringify(realized),
        valid.note,
        ctx.principalId,
        calibratedAt,
      ],
    );
    await tx.query(
      `UPDATE org_recommendations
         SET status = 'calibrated', calibrated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.recommendationId, calibratedAt],
    );
  });

  return getRecommendation(ctx, { recommendationId: valid.recommendationId });
}

// ---------------------------------------------------------------------------
// getRecommendation / listRecommendations / getCandidateCalibration
// ---------------------------------------------------------------------------

export async function getRecommendation(
  ctx: TenantContext,
  query: GetRecommendationQuery,
): Promise<OrgRecommendation> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedGetRecommendationQuery = validateGetRecommendationQuery(query);
  const db = getDb();
  const pointer = await loadRecommendationRow(db, ctx, valid.recommendationId, false);

  const candidateRows = await db.query<RecommendationCandidateRow>(
    `SELECT * FROM org_recommendation_candidates
       WHERE tenant_id = $1 AND recommendation_id = $2
       ORDER BY position ASC`,
    [ctx.tenantId, valid.recommendationId],
  );
  const occupancyRows = await db.query<OccupancyRow>(
    `SELECT * FROM org_recommendation_occupancy
       WHERE tenant_id = $1 AND recommendation_id = $2
       ORDER BY node_id ASC, purpose ASC`,
    [ctx.tenantId, valid.recommendationId],
  );
  const outcomeRows = await db.query<ExpectedOutcomeRow>(
    `SELECT * FROM org_recommendation_outcomes
       WHERE tenant_id = $1 AND recommendation_id = $2
       ORDER BY outcome_id ASC`,
    [ctx.tenantId, valid.recommendationId],
  );
  const calibrationRows = await db.query<CalibrationRow>(
    `SELECT * FROM org_recommendation_calibrations
       WHERE tenant_id = $1 AND recommendation_id = $2`,
    [ctx.tenantId, valid.recommendationId],
  );

  const candidates: CandidateEvaluationRecord[] = candidateRows.rows.map((row) => ({
    candidateId: row.candidate_id,
    disposition: row.disposition as CandidateEvaluationRecord['disposition'],
    rejectionReasons: row.rejection_reasons ?? [],
    summary: row.evaluation.summary,
    scores: row.evaluation.scores ?? [],
    evidenceRefs: row.evaluation.evidenceRefs ?? [],
    agentEvaluationIds: row.evaluation.agentEvaluationIds ?? [],
    position: Number(row.position),
  }));
  const modelOccupancy: OccupancySnapshot[] = occupancyRows.rows.map((row) => ({
    nodeId: row.node_id,
    role: row.role,
    purpose: row.purpose as OccupancySnapshot['purpose'],
    bodyId: row.body_id,
    bodyBindingId: row.body_binding_id,
    fabricBindingId: row.fabric_binding_id,
  }));
  const expectedOutcomes: ExpectedOutcomeRecord[] = outcomeRows.rows.map((row) => ({
    outcomeId: row.outcome_id,
    metricName: row.metric_name,
    metricUnit: row.metric_unit,
    direction: row.direction as ExpectedOutcomeRecord['direction'],
    baseline: Number(row.baseline),
    expected: Number(row.expected),
  }));
  const calibrationRow = calibrationRows.rows[0] ?? null;

  return {
    id: pointer.id,
    tenantId: pointer.tenant_id,
    goalId: pointer.goal_id,
    goalVersion: Number(pointer.goal_version),
    fingerprintId: pointer.fingerprint_id,
    strategyId: pointer.strategy_id,
    knowledgeObjective: pointer.knowledge_objective,
    evaluationConfig: pointer.evaluation_config,
    recommendedCandidateId: pointer.recommended_candidate_id,
    status: pointer.status as OrgRecommendation['status'],
    note: pointer.note,
    derivedFrom: pointer.derived_from ?? [],
    recordedBy: pointer.recorded_by,
    recordedAt: toIso(pointer.recorded_at),
    calibratedAt: pointer.calibrated_at === null ? null : toIso(pointer.calibrated_at),
    candidates,
    modelOccupancy,
    expectedOutcomes,
    calibration:
      calibrationRow === null
        ? null
        : {
            polarity: calibrationRow.polarity as CalibrationPolarity,
            realized: calibrationRow.realized ?? [],
            note: calibrationRow.note,
            calibratedBy: calibrationRow.calibrated_by,
            calibratedAt: toIso(calibrationRow.calibrated_at),
          },
  };
}

export async function listRecommendations(
  ctx: TenantContext,
  query?: ListRecommendationsQuery,
): Promise<OrgRecommendationSummary[]> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedListRecommendationsQuery = validateListRecommendationsQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT r.*,
       (SELECT COUNT(*) FROM org_recommendation_candidates c
         WHERE c.tenant_id = r.tenant_id AND c.recommendation_id = r.id) AS candidate_count,
       (SELECT COUNT(*) FROM org_recommendation_candidates c
         WHERE c.tenant_id = r.tenant_id AND c.recommendation_id = r.id
           AND c.disposition = 'rejected') AS rejected_count
     FROM org_recommendations r
     WHERE r.tenant_id = $1`;
  if (valid.goalId !== null) {
    params.push(valid.goalId);
    sql += ` AND r.goal_id = $${params.length}`;
  }
  if (valid.fingerprintId !== null) {
    params.push(valid.fingerprintId);
    sql += ` AND r.fingerprint_id = $${params.length}`;
  }
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND r.status = $${params.length}`;
  }
  if (valid.candidateId !== null) {
    params.push(valid.candidateId);
    sql += ` AND EXISTS (
       SELECT 1 FROM org_recommendation_candidates c
        WHERE c.tenant_id = r.tenant_id
          AND c.recommendation_id = r.id
          AND c.candidate_id = $${params.length})`;
  }
  params.push(valid.limit);
  // Newest first, deterministic tiebreak.
  sql += ` ORDER BY r.recorded_at DESC, r.id DESC LIMIT $${params.length}`;

  const rows = await getDb().query<RecommendationRow & {
    candidate_count: string | number;
    rejected_count: string | number;
  }>(sql, params);
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    fingerprintId: row.fingerprint_id,
    strategyId: row.strategy_id,
    recommendedCandidateId: row.recommended_candidate_id,
    status: row.status as OrgRecommendationSummary['status'],
    candidateCount: Number(row.candidate_count),
    rejectedCount: Number(row.rejected_count),
    knowledgeObjective: row.knowledge_objective,
    recordedAt: toIso(row.recorded_at),
    calibratedAt: row.calibrated_at === null ? null : toIso(row.calibrated_at),
  }));
}

export async function getCandidateCalibration(
  ctx: TenantContext,
  query: GetCandidateCalibrationQuery,
): Promise<CalibrationSummary | null> {
  assertOrgLabTenantContext(ctx);
  const valid: ValidatedGetCandidateCalibrationQuery = validateGetCandidateCalibrationQuery(query);
  const db = getDb();

  // The candidate must be readable in this tenant (uniform not-found); a
  // readable candidate with no calibrated recommendations is the honest
  // cold start (null), never an error.
  const row = await findCandidateRow(db, ctx, valid.candidateId, false);
  if (row === null) {
    throw new OrgLabError(
      'candidate_not_found',
      `no candidate '${valid.candidateId}' exists in this tenant`,
    );
  }
  const summaries = await calibrationSummariesFor(db, ctx, [valid.candidateId]);
  return summaries.get(valid.candidateId) ?? null;
}
