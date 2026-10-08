// Implementation of the emergent-roles module's public operations (see
// contract.ts).
//
// W138 — Emergent Roles + Marketplace Publication (spec/work-items/
// WORK-ITEM-CATALOG.md §W138): recurring capability gaps →
// evidence-backed RoleProposals → governed review → marketplace
// submission REQUESTS + governed activation RECORDS. Everything here is
// a RECORD, a TRANSITION or a READ — the "publication/install/activation
// remain governed" acceptance law is structural: no operation creates,
// submits, reviews, publishes or installs a marketplace package, and
// none recruits an agent. Those authorities stay with the marketplace
// (W028), Agent Recruitment (W022) and the actions matrix (W009); this
// module PROVES its links against their real records at write time and
// then holds the emergence projection. The "Lab cannot self-publish or
// self-activate" clause is enforced TWICE: typed service errors
// (`lab_cannot_self_publish` / `lab_cannot_self_activate`) and storage
// triggers that make the bad rows unrepresentable (the marketplace
// reviewPackage separation-of-duties precedent).
//
// TRANSACTION DISCIPLINE (the W134 lesson, binding — the house law at
// src/modules/agents/service.ts:1325-1331): PGlite is single-connection,
// so a base-connection read inside an open `db.transaction(...)` starves
// the embedded database. EVERY cross-module read (capabilities,
// learning, org-lab, agent-exchange, marketplace, agent-recruitment,
// actions — all of which execute on the base connection through their
// own getDb()) and every evidence gate therefore runs BEFORE the
// transaction opens; each mutation then keeps its append + lifecycle
// transitions atomic in ONE transaction whose statements touch only
// this module's tables:
//
//   * recordGapEvidence — the capability gate + the per-kind upstream
//     source gate first, then a SINGLE append (one INSERT — atomic by
//     itself, the registerCandidate precedent);
//   * createRoleProposal — every gate first (origin recommendation
//     readable, every citation a readable gap-evidence record ABOUT a
//     demanded capability, every demand a live capability, slug free),
//     then ONE transaction appending the proposal row with its frozen
//     case (a single INSERT — the citations/demands/alternatives/
//     evaluation travel as columns, so one row IS the whole case);
//   * submitRoleProposal / withdrawRoleProposal — uniform not-found +
//     lifecycle pre-checks on the base connection, then ONE transaction
//     re-checking the one-way transition under a FOR UPDATE row lock
//     (the staleness re-check — a racing transition that committed
//     first owns the terminal state);
//   * recordProposalReview — the under_review pre-check + the terminal
//     W009 request gate first, then ONE transaction re-checking
//     under_review under the lock, appending the frozen decision record
//     and stamping approved | rejected exactly once;
//   * recordMarketplaceSubmission — every gate first (proposal
//     APPROVED, package visible + kind 'agent', the Lab self-publish
//     refusal), then a SINGLE append (the storage-level Lab-separation
//     trigger is the second lock);
//   * recordRoleActivation — every gate first (proposal APPROVED, the
//     W022 acquisition APPROVED, the Lab self-activate refusal), then
//     ONE transaction re-checking approved under the lock, appending
//     the activation record and stamping fulfilled exactly once.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by newId(); semantic
// timestamps come from the injectable clock and are never
// caller-supplied; principals (`createdBy`, `recordedBy`,
// `submittedBy`, `origin.principalId`) are system-captured from the
// explicit TenantContext; every statement is scoped by tenant
// (ADR-0001) — cross-tenant access is indistinguishable from missing
// records (uniform typed not-found, no existence leak).
//
// Deterministic orders (test-locked): proposals newest first
// (created_at DESC, id DESC); gap evidence, submissions and activations
// by (recorded_at ASC, id ASC) — the evidence-timeline order.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { CapabilitiesError, getCapability } from '@/modules/capabilities/contract';
import { LearningError, getOutcome } from '@/modules/learning/contract';
import { OrgLabError, getRecommendation } from '@/modules/org-lab/contract';
import {
  AgentExchangeError,
  getExecutionPlan,
  listExecutionRuns,
} from '@/modules/agent-exchange/contract';
import { MarketplaceError, getPackage } from '@/modules/marketplace/contract';
import {
  AgentRecruitmentError,
  getRecruitmentProposal,
} from '@/modules/agent-recruitment/contract';
import { ActionsError, getActionRequest } from '@/modules/actions/contract';
import { EmergentRolesError } from './errors';
import {
  assertEmergentRolesTenantContext,
  validateCreateRoleProposalInput,
  validateGetGapEvidenceQuery,
  validateGetRoleProposalQuery,
  validateListGapEvidenceQuery,
  validateListRoleProposalsQuery,
  validateProposalScopedListQuery,
  validateRecordGapEvidenceInput,
  validateRecordMarketplaceSubmissionInput,
  validateRecordProposalReviewInput,
  validateRecordRoleActivationInput,
  validateSubmitRoleProposalInput,
  validateWithdrawRoleProposalInput,
} from './validation';
import type {
  ValidatedCreateRoleProposalInput,
  ValidatedGapSource,
  ValidatedRecordMarketplaceSubmissionInput,
  ValidatedRecordProposalReviewInput,
  ValidatedRecordRoleActivationInput,
  ValidatedSubmitRoleProposalInput,
  ValidatedWithdrawRoleProposalInput,
} from './validation';
import type {
  AlternativeConsidered,
  CapabilityDemand,
  CreateRoleProposalInput,
  GapEvidenceSource,
  GetGapEvidenceQuery,
  GetRoleProposalQuery,
  ListGapEvidenceQuery,
  ListMarketplaceSubmissionsQuery,
  ListRoleActivationsQuery,
  ListRoleProposalsQuery,
  MarketplaceSubmissionRequest,
  ProposalReviewRecord,
  RecordGapEvidenceInput,
  RecordMarketplaceSubmissionInput,
  RecordProposalReviewInput,
  RecordRoleActivationInput,
  ReviewDecisionSnapshot,
  RoleActivation,
  RoleGapEvidence,
  RoleProposal,
  RoleProposalEvaluation,
  RoleProposalSummary,
  SubmitRoleProposalInput,
  WithdrawRoleProposalInput,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface GapEvidenceRow extends DbRow {
  id: string;
  tenant_id: string;
  capability_id: string;
  source_kind: string;
  source_outcome_id: string | null;
  source_recommendation_id: string | null;
  source_plan_id: string | null;
  source_run_id: string | null;
  observation: string;
  recorded_by: string;
  recorded_at: Date | string;
}

interface ProposalRow extends DbRow {
  id: string;
  tenant_id: string;
  slug: string;
  title: string;
  origin_kind: string;
  origin_recommendation_id: string | null;
  origin_principal_id: string;
  status: string;
  evidence_citations: string[];
  demands: CapabilityDemand[];
  alternatives: AlternativeConsidered[];
  evaluation: RoleProposalEvaluation;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  submitted_at: Date | string | null;
  submitted_by: string | null;
  decided_at: Date | string | null;
  fulfilled_at: Date | string | null;
  withdrawn_at: Date | string | null;
  lifecycle_note: string | null;
}

interface ReviewRow extends DbRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  action_request_id: string;
  decision: ReviewDecisionSnapshot;
  recorded_by: string;
  recorded_at: Date | string;
}

interface SubmissionRow extends DbRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  package_id: string;
  package_key: string;
  package_version: string;
  package_state: string;
  note: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

interface ActivationRow extends DbRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  recruitment_proposal_id: string;
  note: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapGapEvidence(row: GapEvidenceRow): RoleGapEvidence {
  const source: GapEvidenceSource =
    row.source_kind === 'learning-outcome'
      ? { kind: 'learning-outcome', outcomeId: row.source_outcome_id! }
      : row.source_kind === 'org-lab-recommendation'
        ? {
            kind: 'org-lab-recommendation',
            recommendationId: row.source_recommendation_id!,
          }
        : { kind: 'execution-run', planId: row.source_plan_id!, runId: row.source_run_id! };
  return {
    id: row.id,
    tenantId: row.tenant_id,
    capabilityId: row.capability_id,
    source,
    observation: row.observation,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapProposal(row: ProposalRow): RoleProposal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    title: row.title,
    origin: {
      kind: row.origin_kind as RoleProposal['origin']['kind'],
      recommendationId: row.origin_recommendation_id,
      principalId: row.origin_principal_id,
    },
    status: row.status as RoleProposal['status'],
    evidenceCitationIds: row.evidence_citations ?? [],
    demands: row.demands ?? [],
    alternatives: row.alternatives ?? [],
    evaluation: row.evaluation,
    note: row.note,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    submittedAt: row.submitted_at === null ? null : toIso(row.submitted_at),
    submittedBy: row.submitted_by,
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    fulfilledAt: row.fulfilled_at === null ? null : toIso(row.fulfilled_at),
    withdrawnAt: row.withdrawn_at === null ? null : toIso(row.withdrawn_at),
    lifecycleNote: row.lifecycle_note,
  };
}

function mapReview(row: ReviewRow): ProposalReviewRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposalId: row.proposal_id,
    decision: row.decision,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapSubmission(row: SubmissionRow): MarketplaceSubmissionRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposalId: row.proposal_id,
    packageId: row.package_id,
    packageKey: row.package_key,
    packageVersion: row.package_version,
    packageState: row.package_state as MarketplaceSubmissionRequest['packageState'],
    note: row.note,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapActivation(row: ActivationRow): RoleActivation {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposalId: row.proposal_id,
    recruitmentProposalId: row.recruitment_proposal_id,
    note: row.note,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

// ---------------------------------------------------------------------------
// Tenant-scoped loaders (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function findProposalRow(
  db: Queryable,
  ctx: TenantContext,
  proposalId: string,
  forUpdate: boolean,
): Promise<ProposalRow | null> {
  const result = await db.query<ProposalRow>(
    `SELECT * FROM role_proposals WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, proposalId],
  );
  return result.rows[0] ?? null;
}

async function loadProposalRow(
  db: Queryable,
  ctx: TenantContext,
  proposalId: string,
  forUpdate: boolean,
): Promise<ProposalRow> {
  const row = await findProposalRow(db, ctx, proposalId, forUpdate);
  if (row === null) {
    throw new EmergentRolesError(
      'proposal_not_found',
      `no role proposal '${proposalId}' exists in this tenant`,
    );
  }
  return row;
}

async function loadGapEvidenceRow(
  db: Queryable,
  ctx: TenantContext,
  gapEvidenceId: string,
): Promise<GapEvidenceRow> {
  const result = await db.query<GapEvidenceRow>(
    `SELECT * FROM role_gap_evidence WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, gapEvidenceId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new EmergentRolesError(
      'gap_evidence_not_found',
      `no gap-evidence record '${gapEvidenceId}' exists in this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Cross-module evidence gates — ALWAYS before a transaction/append (see
// the header's transaction-discipline law). Failure posture: a missing,
// foreign or unreadable reference reads uniformly as its typed
// not-found code, never leaking existence (the org-lab discipline).
// ---------------------------------------------------------------------------

/**
 * A demanded or gap-observed capability must exist and be ACTIVE in
 * this tenant (a live proposal demands live graph nodes; a retired or
 * archived capability reads uniformly as not-found).
 */
async function requireLiveCapability(ctx: TenantContext, capabilityId: string): Promise<void> {
  let capability;
  try {
    capability = await getCapability(ctx, capabilityId);
  } catch (error) {
    if (error instanceof CapabilitiesError) {
      throw new EmergentRolesError(
        'capability_ref_not_found',
        `capability '${capabilityId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (capability.status !== 'active') {
    throw new EmergentRolesError(
      'capability_ref_not_found',
      `capability '${capabilityId}' is ${capability.status} — a live proposal demands live graph nodes`,
    );
  }
}

/**
 * The W040 gap signal: a REAL learning-module outcome, readable in this
 * tenant, SETTLED with the frozen assessment 'missed' — a missed
 * expected value is the outcome stream's capability-gap signal. An
 * open, abandoned, met or exceeded outcome is uniformly not gap
 * evidence (the signal must be the frozen miss, never a prediction).
 */
async function requireMissedOutcome(ctx: TenantContext, outcomeId: string): Promise<void> {
  let outcome;
  try {
    outcome = await getOutcome(ctx, outcomeId);
  } catch (error) {
    if (error instanceof LearningError) {
      throw new EmergentRolesError(
        'outcome_ref_not_found',
        `outcome '${outcomeId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (outcome.status !== 'settled' || outcome.realization?.assessment !== 'missed') {
    throw new EmergentRolesError(
      'outcome_not_gap_evidence',
      `outcome '${outcomeId}' is ${outcome.status}${outcome.realization === null ? '' : ` (assessed '${outcome.realization.assessment}')`} — only a settled outcome assessed 'missed' is a capability-gap signal`,
    );
  }
}

/**
 * The W135 gap signal: a REAL org-lab recommendation, readable in this
 * tenant, CALIBRATED with NEGATIVE polarity — the Lab's own retained
 * negative evidence (a failed recommended organization). An uncalibrated
 * or positively-calibrated recommendation is uniformly not gap
 * evidence.
 */
async function requireNegativelyCalibratedRecommendation(
  ctx: TenantContext,
  recommendationId: string,
): Promise<void> {
  let recommendation;
  try {
    recommendation = await getRecommendation(ctx, { recommendationId });
  } catch (error) {
    if (error instanceof OrgLabError) {
      throw new EmergentRolesError(
        'recommendation_ref_not_found',
        `org-lab recommendation '${recommendationId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (recommendation.calibration === null || recommendation.calibration.polarity !== 'negative') {
    throw new EmergentRolesError(
      'recommendation_not_gap_evidence',
      `org-lab recommendation '${recommendationId}' carries no negative calibration — only a NEGATIVELY-calibrated recommendation (the Lab's retained negative evidence) is a capability-gap signal`,
    );
  }
}

/**
 * The W136 gap signal: a REAL agent-exchange execution run, readable in
 * this tenant through the exchange contract, with the frozen execution
 * status 'failed' — a failed execution is the run stream's
 * capability-gap signal. A live, succeeded, refused or cancelled run is
 * uniformly not gap evidence.
 */
async function requireFailedExecutionRun(
  ctx: TenantContext,
  planId: string,
  runId: string,
): Promise<void> {
  try {
    await getExecutionPlan(ctx, { planId });
  } catch (error) {
    if (error instanceof AgentExchangeError) {
      throw new EmergentRolesError(
        'plan_ref_not_found',
        `execution plan '${planId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  const runs = await listExecutionRuns(ctx, { planId, limit: 500 });
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    throw new EmergentRolesError(
      'run_ref_not_found',
      `execution run '${runId}' is not recorded on plan '${planId}' in this tenant`,
    );
  }
  if (run.executionStatus !== 'failed') {
    throw new EmergentRolesError(
      'run_not_gap_evidence',
      `execution run '${runId}' is ${run.executionStatus} — only a FAILED run is a capability-gap signal`,
    );
  }
}

/** Dispatches the per-kind upstream gap-source gate. */
async function requireGapSource(ctx: TenantContext, source: ValidatedGapSource): Promise<void> {
  switch (source.kind) {
    case 'learning-outcome':
      return requireMissedOutcome(ctx, source.outcomeId);
    case 'org-lab-recommendation':
      return requireNegativelyCalibratedRecommendation(ctx, source.recommendationId);
    case 'execution-run':
      return requireFailedExecutionRun(ctx, source.planId, source.runId);
  }
}

/**
 * The org-lab PROVENANCE of a proposal: a REAL W135 recommendation,
 * readable in this tenant (any status — provenance is where the
 * proposal emerged from, not a gap signal).
 */
async function requireOriginRecommendation(
  ctx: TenantContext,
  recommendationId: string,
): Promise<void> {
  try {
    await getRecommendation(ctx, { recommendationId });
  } catch (error) {
    if (error instanceof OrgLabError) {
      throw new EmergentRolesError(
        'recommendation_ref_not_found',
        `org-lab recommendation '${recommendationId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * The governed review (the W009 authority system decides): a REAL
 * actions-module request, readable in this tenant, whose status is
 * TERMINAL — approved or rejected, both retained evidence. Returns the
 * frozen decision snapshot, consumed verbatim. A still-pending request
 * refuses: this module records decisions, it never anticipates them.
 */
async function requireTerminalReviewRequest(
  ctx: TenantContext,
  actionRequestId: string,
): Promise<ReviewDecisionSnapshot> {
  let request;
  try {
    request = await getActionRequest(ctx, { requestId: actionRequestId });
  } catch (error) {
    if (error instanceof ActionsError) {
      throw new EmergentRolesError(
        'review_request_not_found',
        `action request '${actionRequestId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (request.status === 'pending') {
    throw new EmergentRolesError(
      'review_not_decided',
      `action request '${actionRequestId}' is still pending — the review records authority decisions after the authority system makes them`,
    );
  }
  return {
    actionRequestId: request.id,
    actionKind: request.actionKind,
    authorityLevel: request.authorityLevel,
    status: request.status,
    requestedBy: request.requestedBy,
    requestedAt: request.requestedAt,
    decidedAt: request.decidedAt ?? request.requestedAt,
  };
}

/**
 * The marketplace package a submission request cites (acceptance
 * law 2): a REAL W028 package, visible to this tenant through the
 * marketplace contract (the vendor view + the public catalog — the
 * marketplace owns visibility), of kind 'agent' — a role proposal
 * materializes as an AgentPackage (§17: "The same governance applies to
 * AgentPackages"). The package's own governed chain (submit → verify →
 * review → publish → installable) stays entirely with the marketplace
 * and the platform; this gate only proves the cited artifact exists and
 * is visible, and freezes its identity + state verbatim.
 */
async function requireVisibleAgentPackage(
  ctx: TenantContext,
  packageId: string,
): Promise<{ packageKey: string; version: string; state: string }> {
  let pkg;
  try {
    pkg = await getPackage(ctx, { packageId });
  } catch (error) {
    if (error instanceof MarketplaceError) {
      throw new EmergentRolesError(
        'marketplace_ref_not_found',
        `marketplace package '${packageId}' is not available to this tenant`,
      );
    }
    throw error;
  }
  if (pkg.kind !== 'agent') {
    throw new EmergentRolesError(
      'marketplace_ref_not_agent_package',
      `marketplace package '${packageId}' is of kind '${pkg.kind}' — a role proposal is submitted through an AgentPackage`,
    );
  }
  return { packageKey: pkg.packageKey, version: pkg.version, state: pkg.state };
}

/**
 * The governed acquisition an activation cites (acceptance law 2): a
 * REAL agent-recruitment proposal (W022), readable in this tenant and
 * APPROVED — the recruitment's own W009 gate decided the acquisition.
 * Roles become operational through governed, approved acquisitions
 * only.
 */
async function requireApprovedRecruitment(
  ctx: TenantContext,
  recruitmentProposalId: string,
): Promise<void> {
  let proposal;
  try {
    proposal = await getRecruitmentProposal(ctx, { proposalId: recruitmentProposalId });
  } catch (error) {
    if (error instanceof AgentRecruitmentError) {
      throw new EmergentRolesError(
        'recruitment_ref_not_found',
        `agent-recruitment proposal '${recruitmentProposalId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (proposal.status !== 'approved') {
    throw new EmergentRolesError(
      'recruitment_not_approved',
      `agent-recruitment proposal '${recruitmentProposalId}' is in status '${proposal.status}' — roles become operational through APPROVED acquisitions only`,
    );
  }
}

/**
 * THE LAB AUTHORITY SEPARATION (acceptance clause): the principal that
 * recorded an org-lab-sourced proposal cannot be the principal that
 * records its marketplace submission or its activation. The Lab
 * proposes; publication and activation belong to governed authorities
 * above it. (The storage triggers on role_marketplace_submissions and
 * role_activations are the second lock — the bad rows are
 * unrepresentable even for callers bypassing this service.)
 */
function refuseLabSelfAction(
  proposal: ProposalRow,
  actorPrincipalId: string,
  code: 'lab_cannot_self_publish' | 'lab_cannot_self_activate',
  action: string,
): void {
  if (proposal.origin_kind === 'org-lab' && actorPrincipalId === proposal.origin_principal_id) {
    throw new EmergentRolesError(
      code,
      `this role proposal emerged from the Lab (org-lab recommendation '${proposal.origin_recommendation_id}') and was recorded by principal '${actorPrincipalId}' — the Lab cannot ${action} its own proposal; a governed authority above the Lab must`,
    );
  }
}

// ---------------------------------------------------------------------------
// recordGapEvidence — the recurring-gap detection input
// ---------------------------------------------------------------------------

export async function recordGapEvidence(
  ctx: TenantContext,
  input: RecordGapEvidenceInput,
): Promise<RoleGapEvidence> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateRecordGapEvidenceInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the append ----
  await requireLiveCapability(ctx, valid.capabilityId);
  await requireGapSource(ctx, valid.source);

  // One upstream record is one gap (the partial unique indexes are the
  // backstop; the pre-check gives the typed error).
  const cited = await db.query<{ id: string }>(
    `SELECT id FROM role_gap_evidence
       WHERE tenant_id = $1
         AND ((source_kind = 'learning-outcome' AND source_outcome_id = $2)
           OR (source_kind = 'org-lab-recommendation' AND source_recommendation_id = $3)
           OR (source_kind = 'execution-run' AND source_run_id = $4))`,
    [
      ctx.tenantId,
      valid.source.kind === 'learning-outcome' ? valid.source.outcomeId : null,
      valid.source.kind === 'org-lab-recommendation' ? valid.source.recommendationId : null,
      valid.source.kind === 'execution-run' ? valid.source.runId : null,
    ],
  );
  if (cited.rows.length > 0) {
    throw new EmergentRolesError(
      'gap_source_already_cited',
      `this upstream record is already cited as gap evidence ('${cited.rows[0]!.id}') — one upstream record is one gap`,
    );
  }

  const gapEvidenceId = newId();
  const recordedAt = now();
  await db.query(
    `INSERT INTO role_gap_evidence
       (id, tenant_id, capability_id, source_kind, source_outcome_id,
        source_recommendation_id, source_plan_id, source_run_id, observation,
        recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      gapEvidenceId,
      ctx.tenantId,
      valid.capabilityId,
      valid.source.kind,
      valid.source.kind === 'learning-outcome' ? valid.source.outcomeId : null,
      valid.source.kind === 'org-lab-recommendation' ? valid.source.recommendationId : null,
      valid.source.kind === 'execution-run' ? valid.source.planId : null,
      valid.source.kind === 'execution-run' ? valid.source.runId : null,
      valid.observation,
      ctx.principalId,
      recordedAt,
    ],
  );

  const row = await db.query<GapEvidenceRow>(
    `SELECT * FROM role_gap_evidence WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, gapEvidenceId],
  );
  return mapGapEvidence(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// createRoleProposal — the emergence projection's spine
// ---------------------------------------------------------------------------

export async function createRoleProposal(
  ctx: TenantContext,
  input: CreateRoleProposalInput,
): Promise<RoleProposal> {
  assertEmergentRolesTenantContext(ctx);
  const valid: ValidatedCreateRoleProposalInput = validateCreateRoleProposalInput(input);
  const db = getDb();

  // ---- EVERY gate BEFORE the append (the W134/W135 law) ----
  if (valid.origin.kind === 'org-lab' && valid.origin.recommendationId !== null) {
    await requireOriginRecommendation(ctx, valid.origin.recommendationId);
  }
  for (const demand of valid.demands) {
    await requireLiveCapability(ctx, demand.capabilityId);
  }

  // Every citation must be a readable gap-evidence record of THIS
  // tenant, and every cited gap must be ABOUT a demanded capability —
  // the proposal may not pad its case with unrelated gaps (the
  // recurrence claim stays grounded).
  const citations = await db.query<GapEvidenceRow>(
    `SELECT * FROM role_gap_evidence WHERE tenant_id = $1 AND id = ANY($2)`,
    [ctx.tenantId, valid.evidenceCitationIds],
  );
  const found = new Map(citations.rows.map((row) => [row.id, row] as const));
  for (const citationId of valid.evidenceCitationIds) {
    if (!found.has(citationId)) {
      throw new EmergentRolesError(
        'gap_evidence_not_found',
        `cited gap-evidence record '${citationId}' is not available in this tenant`,
      );
    }
  }
  const demandedCapabilities = new Set(valid.demands.map((demand) => demand.capabilityId));
  for (const row of citations.rows) {
    if (!demandedCapabilities.has(row.capability_id)) {
      throw new EmergentRolesError(
        'citation_demand_mismatch',
        `cited gap-evidence record '${row.id}' concerns capability '${row.capability_id}', which the proposal does not demand — the cited evidence must be about the demanded capabilities`,
      );
    }
  }

  // Slug uniqueness (the unique constraint is the backstop).
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM role_proposals WHERE tenant_id = $1 AND slug = $2`,
    [ctx.tenantId, valid.slug],
  );
  if (existing.rows.length > 0) {
    throw new EmergentRolesError(
      'slug_taken',
      `slug '${valid.slug}' is already a role proposal in this tenant — a changed proposal is a NEW proposal with a new slug`,
    );
  }

  const proposalId = newId();
  const createdAt = now();
  await db.query(
    `INSERT INTO role_proposals
       (id, tenant_id, slug, title, origin_kind, origin_recommendation_id,
        origin_principal_id, status, evidence_citations, demands, alternatives,
        evaluation, note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9::jsonb, $10::jsonb,
        $11::jsonb, $12, $13, $14)`,
    [
      proposalId,
      ctx.tenantId,
      valid.slug,
      valid.title,
      valid.origin.kind,
      valid.origin.recommendationId,
      ctx.principalId,
      valid.evidenceCitationIds,
      JSON.stringify(valid.demands),
      JSON.stringify(valid.alternatives),
      JSON.stringify(valid.evaluation),
      valid.note,
      ctx.principalId,
      createdAt,
    ],
  );

  return getRoleProposal(ctx, { proposalId });
}

// ---------------------------------------------------------------------------
// submitRoleProposal — draft → under_review
// ---------------------------------------------------------------------------

export async function submitRoleProposal(
  ctx: TenantContext,
  input: SubmitRoleProposalInput,
): Promise<RoleProposal> {
  assertEmergentRolesTenantContext(ctx);
  const valid: ValidatedSubmitRoleProposalInput = validateSubmitRoleProposalInput(input);
  const db = getDb();

  // Pre-transaction: uniform not-found + lifecycle posture.
  const existing = await loadProposalRow(db, ctx, valid.proposalId, false);
  if (existing.status !== 'draft') {
    throw new EmergentRolesError(
      'proposal_not_submittable',
      `role proposal '${valid.proposalId}' is ${existing.status} — only a draft may be submitted for review`,
    );
  }

  const submittedAt = now();

  // ---- ONE transaction: staleness re-check under the lock, stamp ----
  await db.transaction(async (tx) => {
    const row = await loadProposalRow(tx, ctx, valid.proposalId, true);
    if (row.status !== 'draft') {
      // The staleness re-check (the W134 lesson): a racing transition
      // that committed first owns the state.
      throw new EmergentRolesError(
        'proposal_not_submittable',
        `role proposal '${valid.proposalId}' is ${row.status} — only a draft may be submitted for review`,
      );
    }
    await tx.query(
      `UPDATE role_proposals
         SET status = 'under_review', submitted_at = $3, submitted_by = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.proposalId, submittedAt, ctx.principalId],
    );
  });

  return getRoleProposal(ctx, { proposalId: valid.proposalId });
}

// ---------------------------------------------------------------------------
// withdrawRoleProposal — draft | under_review → withdrawn (terminal)
// ---------------------------------------------------------------------------

export async function withdrawRoleProposal(
  ctx: TenantContext,
  input: WithdrawRoleProposalInput,
): Promise<RoleProposal> {
  assertEmergentRolesTenantContext(ctx);
  const valid: ValidatedWithdrawRoleProposalInput = validateWithdrawRoleProposalInput(input);
  const db = getDb();

  const existing = await loadProposalRow(db, ctx, valid.proposalId, false);
  if (existing.status !== 'draft' && existing.status !== 'under_review') {
    throw new EmergentRolesError(
      'proposal_not_withdrawable',
      `role proposal '${valid.proposalId}' is ${existing.status} — only a draft or an under-review proposal may be withdrawn`,
    );
  }

  const withdrawnAt = now();

  await db.transaction(async (tx) => {
    const row = await loadProposalRow(tx, ctx, valid.proposalId, true);
    if (row.status !== 'draft' && row.status !== 'under_review') {
      throw new EmergentRolesError(
        'proposal_not_withdrawable',
        `role proposal '${valid.proposalId}' is ${row.status} — only a draft or an under-review proposal may be withdrawn`,
      );
    }
    await tx.query(
      `UPDATE role_proposals
         SET status = 'withdrawn', withdrawn_at = $3, lifecycle_note = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.proposalId, withdrawnAt, valid.reason],
    );
  });

  return getRoleProposal(ctx, { proposalId: valid.proposalId });
}

// ---------------------------------------------------------------------------
// recordProposalReview — the governed decision
// ---------------------------------------------------------------------------

export async function recordProposalReview(
  ctx: TenantContext,
  input: RecordProposalReviewInput,
): Promise<ProposalReviewRecord> {
  assertEmergentRolesTenantContext(ctx);
  const valid: ValidatedRecordProposalReviewInput = validateRecordProposalReviewInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the transaction ----
  const proposal = await loadProposalRow(db, ctx, valid.proposalId, false);
  if (proposal.status !== 'under_review') {
    throw new EmergentRolesError(
      'proposal_not_under_review',
      `role proposal '${valid.proposalId}' is ${proposal.status} — the review is the one exit from under_review`,
    );
  }
  const decision = await requireTerminalReviewRequest(ctx, valid.actionRequestId);

  const reviewId = newId();
  const recordedAt = now();
  const newStatus = decision.status === 'approved' ? 'approved' : 'rejected';

  // ---- ONE transaction: staleness re-check under the lock, append the
  // frozen decision, stamp the one-way transition ----
  await db.transaction(async (tx) => {
    const row = await loadProposalRow(tx, ctx, valid.proposalId, true);
    if (row.status !== 'under_review') {
      throw new EmergentRolesError(
        'proposal_not_under_review',
        `role proposal '${valid.proposalId}' is ${row.status} — the review is the one exit from under_review`,
      );
    }
    await tx.query(
      `INSERT INTO role_proposal_reviews
         (id, tenant_id, proposal_id, action_request_id, decision,
          recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        reviewId,
        ctx.tenantId,
        valid.proposalId,
        valid.actionRequestId,
        JSON.stringify(decision),
        ctx.principalId,
        recordedAt,
      ],
    );
    await tx.query(
      `UPDATE role_proposals
         SET status = $3, decided_at = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.proposalId, newStatus, recordedAt],
    );
  });

  const row = await db.query<ReviewRow>(
    `SELECT * FROM role_proposal_reviews WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, reviewId],
  );
  return mapReview(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// recordMarketplaceSubmission — the publication REQUEST (governed)
// ---------------------------------------------------------------------------

export async function recordMarketplaceSubmission(
  ctx: TenantContext,
  input: RecordMarketplaceSubmissionInput,
): Promise<MarketplaceSubmissionRequest> {
  assertEmergentRolesTenantContext(ctx);
  const valid: ValidatedRecordMarketplaceSubmissionInput =
    validateRecordMarketplaceSubmissionInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the append ----
  const proposal = await loadProposalRow(db, ctx, valid.proposalId, false);
  if (proposal.status !== 'approved') {
    throw new EmergentRolesError(
      'proposal_not_approved',
      `role proposal '${valid.proposalId}' is ${proposal.status} — only a proposal the governed review APPROVED may be submitted to the marketplace`,
    );
  }
  refuseLabSelfAction(proposal, ctx.principalId, 'lab_cannot_self_publish', 'publish');
  const pkg = await requireVisibleAgentPackage(ctx, valid.packageId);

  // SINGLE append (atomic by itself; the storage-level Lab-separation
  // trigger is the second lock).
  const submissionId = newId();
  const recordedAt = now();
  await db.query(
    `INSERT INTO role_marketplace_submissions
       (id, tenant_id, proposal_id, package_id, package_key, package_version,
        package_state, note, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      submissionId,
      ctx.tenantId,
      valid.proposalId,
      valid.packageId,
      pkg.packageKey,
      pkg.version,
      pkg.state,
      valid.note,
      ctx.principalId,
      recordedAt,
    ],
  );

  const row = await db.query<SubmissionRow>(
    `SELECT * FROM role_marketplace_submissions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, submissionId],
  );
  return mapSubmission(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// recordRoleActivation — the governed acquisition record
// ---------------------------------------------------------------------------

export async function recordRoleActivation(
  ctx: TenantContext,
  input: RecordRoleActivationInput,
): Promise<RoleActivation> {
  assertEmergentRolesTenantContext(ctx);
  const valid: ValidatedRecordRoleActivationInput = validateRecordRoleActivationInput(input);
  const db = getDb();

  // ---- Gates on the base connection, before the transaction ----
  const proposal = await loadProposalRow(db, ctx, valid.proposalId, false);
  if (proposal.status !== 'approved') {
    throw new EmergentRolesError(
      'proposal_not_approved',
      `role proposal '${valid.proposalId}' is ${proposal.status} — only a proposal the governed review APPROVED may be activated`,
    );
  }
  refuseLabSelfAction(proposal, ctx.principalId, 'lab_cannot_self_activate', 'activate');
  await requireApprovedRecruitment(ctx, valid.recruitmentProposalId);

  const activationId = newId();
  const recordedAt = now();

  // ---- ONE transaction: staleness re-check under the lock, append the
  // activation, stamp fulfilled exactly once ----
  await db.transaction(async (tx) => {
    const row = await loadProposalRow(tx, ctx, valid.proposalId, true);
    if (row.status !== 'approved') {
      throw new EmergentRolesError(
        'proposal_not_approved',
        `role proposal '${valid.proposalId}' is ${row.status} — only a proposal the governed review APPROVED may be activated`,
      );
    }
    await tx.query(
      `INSERT INTO role_activations
         (id, tenant_id, proposal_id, recruitment_proposal_id, note,
          recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        activationId,
        ctx.tenantId,
        valid.proposalId,
        valid.recruitmentProposalId,
        valid.note,
        ctx.principalId,
        recordedAt,
      ],
    );
    await tx.query(
      `UPDATE role_proposals
         SET status = 'fulfilled', fulfilled_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.proposalId, recordedAt],
    );
  });

  const row = await db.query<ActivationRow>(
    `SELECT * FROM role_activations WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, activationId],
  );
  return mapActivation(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getRoleProposal(
  ctx: TenantContext,
  query: GetRoleProposalQuery,
): Promise<RoleProposal> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateGetRoleProposalQuery(query);
  const db = getDb();
  const proposal = await loadProposalRow(db, ctx, valid.proposalId, false);
  return mapProposal(proposal);
}

export async function listRoleProposals(
  ctx: TenantContext,
  query?: ListRoleProposalsQuery,
): Promise<RoleProposalSummary[]> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateListRoleProposalsQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT id, tenant_id, slug, title, origin_kind, origin_recommendation_id, status,
       jsonb_array_length(demands) AS demand_count,
       cardinality(evidence_citations) AS citation_count,
       jsonb_array_length(alternatives) AS alternative_count,
       created_at
     FROM role_proposals
     WHERE tenant_id = $1`;
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  if (valid.originKind !== null) {
    params.push(valid.originKind);
    sql += ` AND origin_kind = $${params.length}`;
  }
  params.push(valid.limit);
  // Newest first, deterministic tiebreak.
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;

  const rows = await getDb().query<
    DbRow & {
      id: string;
      tenant_id: string;
      slug: string;
      title: string;
      origin_kind: string;
      origin_recommendation_id: string | null;
      status: string;
      demand_count: number | string;
      citation_count: number | string;
      alternative_count: number | string;
      created_at: Date | string;
    }
  >(sql, params);
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    title: row.title,
    originKind: row.origin_kind as RoleProposalSummary['originKind'],
    recommendationId: row.origin_recommendation_id,
    status: row.status as RoleProposalSummary['status'],
    demandCount: typeof row.demand_count === 'number' ? row.demand_count : Number(row.demand_count),
    citationCount:
      typeof row.citation_count === 'number' ? row.citation_count : Number(row.citation_count),
    alternativeCount:
      typeof row.alternative_count === 'number'
        ? row.alternative_count
        : Number(row.alternative_count),
    createdAt: toIso(row.created_at),
  }));
}

export async function getGapEvidence(
  ctx: TenantContext,
  query: GetGapEvidenceQuery,
): Promise<RoleGapEvidence> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateGetGapEvidenceQuery(query);
  const db = getDb();
  return mapGapEvidence(await loadGapEvidenceRow(db, ctx, valid.gapEvidenceId));
}

export async function listGapEvidence(
  ctx: TenantContext,
  query?: ListGapEvidenceQuery,
): Promise<RoleGapEvidence[]> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateListGapEvidenceQuery(query);
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM role_gap_evidence WHERE tenant_id = $1`;
  if (valid.capabilityId !== null) {
    params.push(valid.capabilityId);
    sql += ` AND capability_id = $${params.length}`;
  }
  if (valid.sourceKind !== null) {
    params.push(valid.sourceKind);
    sql += ` AND source_kind = $${params.length}`;
  }
  params.push(valid.limit);
  // The evidence-timeline order: oldest first, deterministic tiebreak.
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;

  const rows = await getDb().query<GapEvidenceRow>(sql, params);
  return rows.rows.map(mapGapEvidence);
}

export async function listMarketplaceSubmissions(
  ctx: TenantContext,
  query: ListMarketplaceSubmissionsQuery,
): Promise<MarketplaceSubmissionRequest[]> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateProposalScopedListQuery(query);
  const rows = await getDb().query<SubmissionRow>(
    `SELECT * FROM role_marketplace_submissions
       WHERE tenant_id = $1 AND proposal_id = $2
       ORDER BY recorded_at ASC, id ASC LIMIT $3`,
    [ctx.tenantId, valid.proposalId, valid.limit],
  );
  return rows.rows.map(mapSubmission);
}

export async function listRoleActivations(
  ctx: TenantContext,
  query: ListRoleActivationsQuery,
): Promise<RoleActivation[]> {
  assertEmergentRolesTenantContext(ctx);
  const valid = validateProposalScopedListQuery(query);
  const rows = await getDb().query<ActivationRow>(
    `SELECT * FROM role_activations
       WHERE tenant_id = $1 AND proposal_id = $2
       ORDER BY recorded_at ASC, id ASC LIMIT $3`,
    [ctx.tenantId, valid.proposalId, valid.limit],
  );
  return rows.rows.map(mapActivation);
}
