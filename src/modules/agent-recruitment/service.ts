// Implementation of the agent-recruitment module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps come from the injectable clock and
// from the actions module's own recorded times (the decision time is the
// DECISION's, not the settlement's — §24 honest evidence); every
// statement is scoped by the explicit TenantContext (ADR-0001) —
// cross-tenant access is indistinguishable from a missing record
// (`proposal_not_found` / `capability_not_found`).
//
// W022 acceptance — "Create AgentRecruitmentProposal comparing train/
// reassign/hire/automate/recruit/install alternatives. Approval is
// explicit." — is carried by these deliberate properties, all tested:
//   1. THE COMPARISON: a proposal compares 2..6 alternatives with
//      distinct kinds, one per acquisition channel, each assessed on the
//      same dimensions (cost, timeline, capability contribution,
//      recommendation). The capability link is verified and SNAPSHOTTED
//      through the capabilities contract (W017) at creation — the
//      "existing capability" baseline of ARCHITECTURE.md §15 — so later
//      graph changes never rewrite why the proposal was made;
//   2. EXPLICIT APPROVAL: submitting routes through the W009 authority
//      matrix — kind 'agent-recruitment' (a CANONICAL_ACTION_KIND, §20),
//      level EXECUTE (what is approved is the consequential acquisition,
//      not the advisory comparison). Under the built-in default every
//      submission is gated behind a human decision; a tenant may
//      explicitly allow or forbid through policy (a recorded POLICY
//      decision either way — never silent). The gate decision lands on
//      the proposal through `settleRecruitmentProposal`, the W021 pump
//      precedent;
//   3. IDEMPOTENT SUBMISSION: the gate idempotency key is derived from
//      the proposal id, so a submission interrupted between the gate and
//      the lifecycle update replays the SAME request on retry — first
//      write wins, history is never rewritten;
//   4. IMMUTABLE EVIDENCE: the substantive proposal content and the
//      whole comparison are history the moment they are recorded
//      (storage-level triggers; a changed proposal is a NEW proposal);
//   5. SEPARATION OF DUTIES: the requesting principal can never decide
//      its own proposal (the actions module's `decideApproval` enforces
//      it on the gate side), and a draft can be withdrawn only by its
//      author or an agent-workforce administrator.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { authorizeAction, getActionRequest, listApprovalDecisions } from '@/modules/actions/contract';
import { ActionsError } from '@/modules/actions/contract';
import type { ActionRequest, AuthorityLevel } from '@/modules/actions/contract';
import { analyzeGaps, getCapability } from '@/modules/capabilities/contract';
import { CapabilitiesError } from '@/modules/capabilities/contract';
import { AGENTS_AUTHORITY_ADMINISTER_CLAIM, authorityLevelForScopes } from '@/modules/agents/contract';
import { AgentRecruitmentError } from './errors';
import {
  alternativesInCanonicalOrder,
  gateDescriptor,
  recommendationOf,
  statusForGateOutcome,
} from './comparison';
import {
  assertAgentRecruitmentTenantContext,
  validateCreateRecruitmentProposalInput,
  validateGetRecruitmentProposalQuery,
  validateListRecruitmentProposalsQuery,
  validateRequestRecruitmentApprovalInput,
  validateSettleRecruitmentProposalInput,
  validateWithdrawRecruitmentProposalInput,
} from './validation';
import type {
  ValidatedAlternative,
  ValidatedListQuery,
} from './validation';
import type {
  AgentRecruitmentProposal,
  CreateRecruitmentProposalInput,
  GetRecruitmentProposalQuery,
  ListRecruitmentProposalsQuery,
  RecruitmentAlternative,
  RecruitmentProposalStatus,
  RequestRecruitmentApprovalInput,
  SettleRecruitmentProposalInput,
  WithdrawRecruitmentProposalInput,
} from './types';

// ---------------------------------------------------------------------------
// Module-owned vocabulary
// ---------------------------------------------------------------------------

/**
 * The W009 action kind every recruitment-proposal submission routes
 * through — one of the CANONICAL_ACTION_KINDS (ARCHITECTURE.md §20: the
 * authority matrix "applies uniformly to ... agent recruitment ...").
 */
export const AGENT_RECRUITMENT_ACTION_KIND = 'agent-recruitment';

/**
 * The §20 level a submission is authorized at: EXECUTE — what is being
 * approved is the consequential acquisition (hiring, training,
 * installing, recruiting an agent), not the advisory comparison. Under
 * the built-in default matrix EXECUTE is approval-gated, which is
 * exactly "Approval is explicit" (the work item); tenants tighten or
 * relax it per kind through `setAuthorityPolicy`.
 */
export const AGENT_RECRUITMENT_AUTHORITY_LEVEL: AuthorityLevel = 'EXECUTE';

// ---------------------------------------------------------------------------
// Row shapes + mapping
// ---------------------------------------------------------------------------

interface ProposalRow extends DbRow {
  id: string;
  tenant_id: string;
  title: string;
  capability_id: string;
  capability_name: string;
  capability_status: string;
  gap_status: string | null;
  gap_best_level: number | null;
  gap_total_capacity: number | null;
  rationale: string;
  evidence_observation_ids: unknown;
  status: string;
  action_request_id: string | null;
  policy_outcome: string | null;
  policy_resolved_via: string | null;
  submitted_by: string | null;
  submitted_at: Date | string | null;
  decided_by: string | null;
  decided_by_principal: string | null;
  decided_at: Date | string | null;
  withdrawn_at: Date | string | null;
  withdrawal_reason: string | null;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AlternativeRow extends DbRow {
  id: string;
  tenant_id: string;
  proposal_id: string;
  kind: string;
  summary: string;
  note: string | null;
  estimated_cost_minor: number | string | null; // bigint arrives as string
  estimated_cost_currency: string | null;
  estimated_weeks: number | null;
  expected_level: number | null;
  expected_capacity: number | null;
  recommended: boolean;
  agent_permissions: unknown;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/** bigint columns arrive as strings on both backends; numbers stay numbers. */
function toNumberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  return typeof value === 'string' ? Number(value) : value;
}

/** jsonb arrays arrive parsed on both backends; storage is write-validated. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapAlternative(row: AlternativeRow): RecruitmentAlternative {
  const agentPermissions = row.agent_permissions === null ? null : stringArray(row.agent_permissions);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposalId: row.proposal_id,
    kind: row.kind as RecruitmentAlternative['kind'], // CHECK-constrained by migration 001
    summary: row.summary,
    note: row.note,
    estimatedCostMinor: toNumberOrNull(row.estimated_cost_minor),
    estimatedCostCurrency: row.estimated_cost_currency,
    estimatedWeeks: row.estimated_weeks,
    expectedLevel: row.expected_level,
    expectedCapacity: row.expected_capacity,
    recommended: row.recommended,
    agentPermissions: agentPermissions as RecruitmentAlternative['agentPermissions'],
    // The §20 level the future agent's grant implies — derived, never
    // stored (the agents module's pure mapping, reused via its contract).
    impliedAuthorityLevel:
      agentPermissions !== null && agentPermissions.length > 0
        ? authorityLevelForScopes(
            agentPermissions as NonNullable<RecruitmentAlternative['agentPermissions']>,
          )
        : null,
  };
}

function mapProposal(row: ProposalRow, alternativeRows: AlternativeRow[]): AgentRecruitmentProposal {
  const alternatives = alternativesInCanonicalOrder(alternativeRows.map(mapAlternative));
  return {
    id: row.id,
    tenantId: row.tenant_id,
    title: row.title,
    status: row.status as RecruitmentProposalStatus, // CHECK-constrained
    capability: {
      capabilityId: row.capability_id,
      capabilityName: row.capability_name,
      capabilityStatus: row.capability_status as AgentRecruitmentProposal['capability']['capabilityStatus'],
      gapStatus: row.gap_status as AgentRecruitmentProposal['capability']['gapStatus'],
      bestActiveLevel: row.gap_best_level,
      totalActiveCapacity: row.gap_total_capacity,
    },
    rationale: row.rationale,
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    alternatives,
    recommendation: recommendationOf(alternatives),
    approval: {
      actionRequestId: row.action_request_id,
      policyOutcome: row.policy_outcome as AgentRecruitmentProposal['approval']['policyOutcome'],
      policyResolvedVia: row.policy_resolved_via as AgentRecruitmentProposal['approval']['policyResolvedVia'],
      submittedBy: row.submitted_by,
      submittedAt: toIsoOrNull(row.submitted_at),
      decidedBy: row.decided_by as AgentRecruitmentProposal['approval']['decidedBy'],
      decidedByPrincipal: row.decided_by_principal,
      decidedAt: toIsoOrNull(row.decided_at),
    },
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    withdrawnAt: toIsoOrNull(row.withdrawn_at),
    withdrawalReason: row.withdrawal_reason,
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function findProposalRow(
  db: Queryable,
  ctx: TenantContext,
  proposalId: string,
): Promise<ProposalRow | null> {
  const rows = await db.query<ProposalRow>(
    `SELECT * FROM agent_recruitment_proposals WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, proposalId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

async function loadAlternativeRows(
  db: Queryable,
  ctx: TenantContext,
  proposalIds: readonly string[],
): Promise<Map<string, AlternativeRow[]>> {
  const grouped = new Map<string, AlternativeRow[]>();
  if (proposalIds.length === 0) return grouped;
  const rows = await db.query<AlternativeRow>(
    `SELECT * FROM agent_recruitment_alternatives
       WHERE tenant_id = $1 AND proposal_id = ANY($2::uuid[])`,
    [ctx.tenantId, [...proposalIds]],
  );
  for (const row of rows.rows) {
    const list = grouped.get(row.proposal_id);
    if (list === undefined) grouped.set(row.proposal_id, [row]);
    else list.push(row);
  }
  return grouped;
}

function proposalNotFound(proposalId: string): AgentRecruitmentError {
  return new AgentRecruitmentError(
    'proposal_not_found',
    `no recruitment proposal '${proposalId}' exists in this tenant`,
  );
}

/** Loads one proposal with its alternatives (the uniform not-found discipline). */
async function loadProposal(
  ctx: TenantContext,
  proposalId: string,
): Promise<{ row: ProposalRow; alternatives: AlternativeRow[] }> {
  const row = await findProposalRow(getDb(), ctx, proposalId);
  if (row === null) throw proposalNotFound(proposalId);
  const grouped = await loadAlternativeRows(getDb(), ctx, [row.id]);
  return { row, alternatives: grouped.get(row.id) ?? [] };
}

// ---------------------------------------------------------------------------
// Cross-module error translation (contract boundaries)
// ---------------------------------------------------------------------------

/**
 * Capabilities-contract failures → module errors. A missing (or
 * foreign-tenant) capability is `capability_not_found` — the uniform
    * cross-tenant not-found discipline; anything else after pre-validation
 * is an internal invariant violation (loud, never silent).
 */
function translateCapabilitiesError(error: unknown): unknown {
  if (error instanceof CapabilitiesError) {
    if (error.code === 'invalid_context') {
      return new AgentRecruitmentError('invalid_context', error.message);
    }
    if (error.code === 'capability_not_found') {
      return new AgentRecruitmentError('capability_not_found', error.message);
    }
    return new Error(
      `the capabilities contract rejected a pre-validated recruitment-proposal lookup (internal invariant violation): ${error.message}`,
      { cause: error },
    );
  }
  return error;
}

/** Actions-contract failures on the consequential path (`authorizeAction`). */
function translateGateError(error: unknown): unknown {
  if (error instanceof ActionsError) {
    if (error.code === 'invalid_context') {
      return new AgentRecruitmentError('invalid_context', error.message);
    }
    if (error.code === 'invalid_action_input') {
      return new AgentRecruitmentError('invalid_proposal_input', error.message);
    }
    return new Error(
      `the authority gate rejected a pre-validated agent-recruitment submission (internal invariant violation): ${error.message}`,
      { cause: error },
    );
  }
  return error;
}

/** Actions-contract failures on the read paths (request + decision trail). */
function translateActionsReadError(error: unknown, what: string): unknown {
  if (error instanceof ActionsError) {
    if (error.code === 'invalid_context') {
      return new AgentRecruitmentError('invalid_context', error.message);
    }
    if (error.code === 'invalid_query') {
      return new AgentRecruitmentError('invalid_query', error.message);
    }
    return new Error(
      `${what} (internal invariant violation): ${error.message}`,
      { cause: error },
    );
  }
  return error;
}

// ---------------------------------------------------------------------------
// The W009 gate
// ---------------------------------------------------------------------------

/** The proposal's gate idempotency key — one request per proposal, ever. */
function gateIdempotencyKey(proposalId: string): string {
  return `${AGENT_RECRUITMENT_ACTION_KIND}:${proposalId}`;
}

/**
 * Derives the proposal lifecycle state (and the decision evidence) from
 * the CURRENT state of the linked action request. Deterministic routing
 * of the gate onto the recruitment lifecycle:
 *  * request pending                     → awaiting_approval (the gate);
 *  * request approved/rejected, matrix-
 *    decided (allowed/forbidden)         → approved/rejected, decided by
 *    POLICY (the tenant's explicit configuration — recorded, auditable);
 *  * request approved/rejected, gated
 *    (approval_required)                 → approved/rejected, decided by
 *    a PRINCIPAL — the deciding human is read from the append-only
 *    decision trail (exactly one principal decision exists; first
 *    decision wins).
 */
async function decisionFromRequest(
  ctx: TenantContext,
  request: ActionRequest,
): Promise<{
  status: RecruitmentProposalStatus;
  decidedBy: 'policy' | 'principal' | null;
  decidedByPrincipal: string | null;
  decidedAt: string | null;
}> {
  if (request.status === 'pending') {
    return { status: 'awaiting_approval', decidedBy: null, decidedByPrincipal: null, decidedAt: null };
  }
  // The matrix decided on its own exactly when the request was not
  // gated: 'allowed' → approved, 'forbidden' → rejected, by POLICY (the
  // tenant's explicit configuration — recorded, auditable).
  if (request.evaluation.outcome !== 'approval_required') {
    return {
      status: statusForGateOutcome(request.evaluation.outcome),
      decidedBy: 'policy',
      decidedByPrincipal: null,
      decidedAt: request.decidedAt,
    };
  }
  // A gated request was decided by a human: the deciding principal is
  // read from the append-only trail (§24 — who approved, not just that
  // it was approved; exactly one principal decision exists — first
  // decision wins).
  const decisions = await listApprovalDecisions(ctx, { requestId: request.id });
  const principalDecision = decisions.find((decision) => decision.decidedBy === 'principal') ?? null;
  return {
    status: request.status === 'approved' ? 'approved' : 'rejected',
    decidedBy: 'principal',
    decidedByPrincipal: principalDecision?.principalId ?? null,
    decidedAt: request.decidedAt,
  };
}

// ---------------------------------------------------------------------------
// createRecruitmentProposal
// ---------------------------------------------------------------------------

export async function createRecruitmentProposal(
  ctx: TenantContext,
  input: CreateRecruitmentProposalInput,
): Promise<AgentRecruitmentProposal> {
  assertAgentRecruitmentTenantContext(ctx);
  const valid = validateCreateRecruitmentProposalInput(input);

  // The capability link — verified through the capabilities contract and
  // snapshotted (the "existing capability" side of the §15 comparison;
  // a foreign-tenant capability id reads the same as a missing one).
  const capability = await (async () => {
    try {
      return await getCapability(ctx, valid.capabilityId);
    } catch (error) {
      throw translateCapabilitiesError(error);
    }
  })();

  // The decision-time gap snapshot: what exists today, frozen. A
  // capability out of gap-analysis scope (no active requirements) snaps
  // to nulls — the proposal then argues for new capability, not gap
  // closure. Deliberately NOT recomputed on read: later graph changes
  // must never rewrite why a recorded proposal was made.
  const gap = await (async () => {
    try {
      const gaps = await analyzeGaps(ctx, { capabilityId: valid.capabilityId });
      return gaps.at(0) ?? null;
    } catch (error) {
      throw translateCapabilitiesError(error);
    }
  })();

  const createdAt = now();
  return getDb().transaction(async (tx) => {
    const inserted = await tx.query<ProposalRow>(
      `INSERT INTO agent_recruitment_proposals (
         tenant_id, title, capability_id, capability_name, capability_status,
         gap_status, gap_best_level, gap_total_capacity,
         rationale, evidence_observation_ids, status,
         created_by, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'proposed', $11, $12, $12)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.title,
        valid.capabilityId,
        capability.name,
        capability.status,
        gap?.status ?? null,
        gap?.bestActiveLevel ?? null,
        gap?.totalActiveCapacity ?? null,
        valid.rationale,
        JSON.stringify(valid.evidenceObservationIds),
        ctx.principalId,
        createdAt,
      ],
    );
    const proposalRow = inserted.rows[0];
    if (proposalRow === undefined) {
      throw new Error(
        'recruitment proposal insert returned no row (internal invariant violation)',
      );
    }

    const alternativeRows = await insertAlternatives(tx, ctx, proposalRow.id, valid.alternatives);
    return mapProposal(proposalRow, alternativeRows);
  });
}

async function insertAlternatives(
  tx: Queryable,
  ctx: TenantContext,
  proposalId: string,
  alternatives: readonly ValidatedAlternative[],
): Promise<AlternativeRow[]> {
  const rows: AlternativeRow[] = [];
  for (const alternative of alternatives) {
    const inserted = await tx.query<AlternativeRow>(
      `INSERT INTO agent_recruitment_alternatives (
         tenant_id, proposal_id, kind, summary, note,
         estimated_cost_minor, estimated_cost_currency, estimated_weeks,
         expected_level, expected_capacity, recommended, agent_permissions
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       RETURNING *`,
      [
        ctx.tenantId,
        proposalId,
        alternative.kind,
        alternative.summary,
        alternative.note,
        alternative.estimatedCostMinor,
        alternative.estimatedCostCurrency,
        alternative.estimatedWeeks,
        alternative.expectedLevel,
        alternative.expectedCapacity,
        alternative.recommended,
        alternative.agentPermissions === null ? null : JSON.stringify(alternative.agentPermissions),
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      throw new Error(
        'recruitment alternative insert returned no row (internal invariant violation)',
      );
    }
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getRecruitmentProposal(
  ctx: TenantContext,
  query: GetRecruitmentProposalQuery,
): Promise<AgentRecruitmentProposal> {
  assertAgentRecruitmentTenantContext(ctx);
  const valid = validateGetRecruitmentProposalQuery(query);
  const { row, alternatives } = await loadProposal(ctx, valid.proposalId);
  return mapProposal(row, alternatives);
}

export async function listRecruitmentProposals(
  ctx: TenantContext,
  query: ListRecruitmentProposalsQuery,
): Promise<AgentRecruitmentProposal[]> {
  assertAgentRecruitmentTenantContext(ctx);
  const valid: ValidatedListQuery = validateListRecruitmentProposalsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.status !== null) add('status = $#', valid.status);
  if (valid.capabilityId !== null) add('capability_id = $#', valid.capabilityId);
  if (valid.recommendedKind !== null) {
    params.push(valid.recommendedKind);
    const kindPlaceholder = `$${params.length}`;
    conditions.push(
      `EXISTS (SELECT 1 FROM agent_recruitment_alternatives a
         WHERE a.tenant_id = agent_recruitment_proposals.tenant_id
           AND a.proposal_id = agent_recruitment_proposals.id
           AND a.kind = ${kindPlaceholder} AND a.recommended)`,
    );
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;

  const rows = await getDb().query<ProposalRow>(
    `SELECT * FROM agent_recruitment_proposals WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  const grouped = await loadAlternativeRows(
    getDb(),
    ctx,
    rows.rows.map((row) => row.id),
  );
  return rows.rows.map((row) => mapProposal(row, grouped.get(row.id) ?? []));
}

// ---------------------------------------------------------------------------
// requestRecruitmentApproval — the explicit gate
// ---------------------------------------------------------------------------

export async function requestRecruitmentApproval(
  ctx: TenantContext,
  input: RequestRecruitmentApprovalInput,
): Promise<AgentRecruitmentProposal> {
  assertAgentRecruitmentTenantContext(ctx);
  const valid = validateRequestRecruitmentApprovalInput(input);

  const { row, alternatives } = await loadProposal(ctx, valid.proposalId);
  if (row.status !== 'proposed') {
    throw new AgentRecruitmentError(
      'invalid_transition',
      `recruitment proposal '${valid.proposalId}' is already ${row.status} — only a proposed (draft) proposal can be submitted for approval`,
    );
  }

  // The compact descriptor the approver decides on (§24): what is being
  // approved, for which capability, which channels were compared and
  // which course of action is recommended.
  const mapped = mapProposal(row, alternatives);
  const descriptor = gateDescriptor({
    proposalId: row.id,
    title: row.title,
    capabilityId: row.capability_id,
    capabilityName: row.capability_name,
    gapStatus: row.gap_status,
    alternativeKinds: mapped.alternatives.map((alternative) => alternative.kind),
    recommendation:
      mapped.recommendation === null
        ? null
        : {
            kind: mapped.recommendation.kind,
            summary: mapped.recommendation.summary,
            estimatedCostMinor: mapped.recommendation.estimatedCostMinor,
            estimatedCostCurrency: mapped.recommendation.estimatedCostCurrency,
            estimatedWeeks: mapped.recommendation.estimatedWeeks,
          },
  });

  // The gate (W009): kind 'agent-recruitment' at EXECUTE. The
  // idempotency key is derived from the proposal id — a submission
  // interrupted between the gate and the lifecycle update replays the
  // SAME request on retry (first write wins), so the gate history and
  // the proposal lifecycle can never fork.
  const request = await (async () => {
    try {
      return await authorizeAction(ctx, {
        actionKind: AGENT_RECRUITMENT_ACTION_KIND,
        authorityLevel: AGENT_RECRUITMENT_AUTHORITY_LEVEL,
        payload: descriptor,
        justification: valid.justification,
        idempotencyKey: gateIdempotencyKey(row.id),
      });
    } catch (error) {
      throw translateGateError(error);
    }
  })();

  const decision = await (async () => {
    try {
      return await decisionFromRequest(ctx, request);
    } catch (error) {
      throw translateActionsReadError(
        error,
        'reading the decision trail of the gate request failed',
      );
    }
  })();
  const updatedAt = now();

  const updated = await getDb().query<ProposalRow>(
    `UPDATE agent_recruitment_proposals
       SET status = $3, action_request_id = $4, policy_outcome = $5, policy_resolved_via = $6,
           submitted_by = $7, submitted_at = $8,
           decided_by = $9, decided_by_principal = $10, decided_at = $11,
           updated_at = $12
     WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'
     RETURNING *`,
    [
      ctx.tenantId,
      row.id,
      decision.status,
      request.id,
      request.evaluation.outcome,
      request.evaluation.resolvedVia,
      ctx.principalId,
      request.requestedAt,
      decision.decidedBy,
      decision.decidedByPrincipal,
      decision.decidedAt,
      updatedAt,
    ],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow !== undefined) {
    const grouped = await loadAlternativeRows(getDb(), ctx, [updatedRow.id]);
    return mapProposal(updatedRow, grouped.get(updatedRow.id) ?? []);
  }

  // The guarded update lost the race (a concurrent submission or
  // withdrawal moved the draft first). The current state is the truth —
  // return it.
  const current = await loadProposal(ctx, row.id);
  return mapProposal(current.row, current.alternatives);
}

// ---------------------------------------------------------------------------
// settleRecruitmentProposal — landing the human/policy decision
// ---------------------------------------------------------------------------

export async function settleRecruitmentProposal(
  ctx: TenantContext,
  input: SettleRecruitmentProposalInput,
): Promise<AgentRecruitmentProposal> {
  assertAgentRecruitmentTenantContext(ctx);
  const valid = validateSettleRecruitmentProposalInput(input);

  const { row, alternatives } = await loadProposal(ctx, valid.proposalId);

  // Idempotent read: only an open gate settles. Drafts, and proposals
  // already terminal (approved / rejected / withdrawn, including the two
  // direct policy paths at submission time), return as they are.
  if (row.status !== 'awaiting_approval') {
    return mapProposal(row, alternatives);
  }
  if (row.action_request_id === null) {
    throw new Error(
      'an awaiting_approval recruitment proposal has no linked action request (internal invariant violation)',
    );
  }

  const request = await (async () => {
    try {
      return await getActionRequest(ctx, { requestId: row.action_request_id as string });
    } catch (error) {
      throw translateActionsReadError(
        error,
        'the linked action request of an awaiting_approval recruitment proposal is missing',
      );
    }
  })();

  const decision = await (async () => {
    try {
      return await decisionFromRequest(ctx, request);
    } catch (error) {
      throw translateActionsReadError(error, 'reading the decision trail of the linked action request failed');
    }
  })();

  // Still gated: the human has not decided yet. Idempotent no-op.
  if (decision.status === 'awaiting_approval') {
    return mapProposal(row, alternatives);
  }

  const updated = await getDb().query<ProposalRow>(
    `UPDATE agent_recruitment_proposals
       SET status = $3, decided_by = $4, decided_by_principal = $5, decided_at = $6, updated_at = $7
     WHERE tenant_id = $1 AND id = $2 AND status = 'awaiting_approval'
     RETURNING *`,
    [
      ctx.tenantId,
      row.id,
      decision.status,
      decision.decidedBy,
      decision.decidedByPrincipal,
      decision.decidedAt,
      now(),
    ],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow !== undefined) {
    const grouped = await loadAlternativeRows(getDb(), ctx, [updatedRow.id]);
    return mapProposal(updatedRow, grouped.get(updatedRow.id) ?? []);
  }

  // A concurrent settle won; the current state is the truth.
  const current = await loadProposal(ctx, row.id);
  return mapProposal(current.row, current.alternatives);
}

// ---------------------------------------------------------------------------
// withdrawRecruitmentProposal
// ---------------------------------------------------------------------------

export async function withdrawRecruitmentProposal(
  ctx: TenantContext,
  input: WithdrawRecruitmentProposalInput,
): Promise<AgentRecruitmentProposal> {
  assertAgentRecruitmentTenantContext(ctx);
  const valid = validateWithdrawRecruitmentProposalInput(input);

  const { row } = await loadProposal(ctx, valid.proposalId);

  // Authorization before state (the decideApproval discipline): a draft
  // is withdrawn by its author or by an agent-workforce administrator —
  // agent recruitment IS agent-workforce management, so the agents
  // module's administer claim governs (reused through its contract).
  if (
    ctx.principalId !== row.created_by &&
    !ctx.authority.includes(AGENTS_AUTHORITY_ADMINISTER_CLAIM)
  ) {
    throw new AgentRecruitmentError(
      'forbidden',
      `withdrawing another principal's recruitment proposal requires the '${AGENTS_AUTHORITY_ADMINISTER_CLAIM}' authority claim`,
    );
  }

  if (row.status !== 'proposed') {
    throw new AgentRecruitmentError(
      'invalid_transition',
      `recruitment proposal '${valid.proposalId}' is already ${row.status} — only a proposed (draft) proposal can be withdrawn; a submitted one is decided through the approval gate`,
    );
  }

  const withdrawnAt = now();
  const updated = await getDb().query<ProposalRow>(
    `UPDATE agent_recruitment_proposals
       SET status = 'withdrawn', withdrawn_at = $3, withdrawal_reason = $4, updated_at = $5
     WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'
     RETURNING *`,
    [ctx.tenantId, row.id, withdrawnAt, valid.reason, withdrawnAt],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow === undefined) {
    // The guarded update lost the race — almost certainly a concurrent
    // submission. Re-read: if it is withdrawn, a concurrent withdrawal
    // won (return it); anything else is a genuine transition failure.
    const current = await loadProposal(ctx, row.id);
    if (current.row.status === 'withdrawn') {
      return mapProposal(current.row, current.alternatives);
    }
    throw new AgentRecruitmentError(
      'invalid_transition',
      `recruitment proposal '${valid.proposalId}' is already ${current.row.status} — only a proposed (draft) proposal can be withdrawn`,
    );
  }
  const grouped = await loadAlternativeRows(getDb(), ctx, [updatedRow.id]);
  return mapProposal(updatedRow, grouped.get(updatedRow.id) ?? []);
}
