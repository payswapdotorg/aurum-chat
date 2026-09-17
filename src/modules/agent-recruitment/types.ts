// Public domain types of the agent-recruitment module (W022 — Agent
// Recruitment).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W022):
// "Create AgentRecruitmentProposal comparing train/reassign/hire/automate/
//  recruit/install alternatives. Approval is explicit."
//
// ARCHITECTURE.md §15 (frozen): "AgentRecruitmentProposal compares existing
// capability, training, human hiring, automation, marketplace capabilities
// and agent alternatives before requesting approval." A recruitment
// proposal is the acquisition-option link of the §13 chain
// `process → capability → gap → acquisition option → authorization →
// deployment → outcome`: it takes ONE capability (the W017 graph node the
// acquisition would strengthen), snapshots what exists today (the
// "existing capability" baseline of the §15 comparison), and compares the
// SIX acquisition alternatives the work item names verbatim — train an
// existing employee, reassign existing work, hire human capability,
// automate the work, recruit an agent, install a marketplace capability —
// each assessed on the same dimensions (what it is, what it costs, how
// fast it lands, what capability level/capacity it would contribute).
//
// APPROVAL IS EXPLICIT (the work item's second sentence, lock 23: "Agent
// recruitment and termination obey policy/approval"): submitting a
// proposal routes it through the W009 authority matrix — kind
// 'agent-recruitment' (a CANONICAL_ACTION_KIND, ARCHITECTURE.md §20: the
// matrix "applies uniformly to ... agent recruitment ...") at the EXECUTE
// level, because what is being approved is the consequential acquisition,
// not the advisory comparison. Under the built-in default matrix EXECUTE
// is approval-gated, so every recruitment proposal awaits an explicit
// human decision until tenant policy says otherwise; a tenant may
// explicitly allow (policy auto-approval, recorded as a POLICY decision)
// or forbid outright (a terminal policy rejection). The decision lands on
// the proposal through `settleRecruitmentProposal` — the W021 pump
// precedent (the agents module resolves its approved gates between
// calls).
//
// A proposal is DECISION EVIDENCE, not mutable understanding: the
// substantive content (title, capability, snapshot, rationale, evidence,
// alternatives) is immutable the moment it is recorded — a changed
// proposal is a NEW proposal (the actions module's discipline, verbatim).
// Only the lifecycle state ever moves, and only forward:
//
//   proposed ──requestApproval──▶ awaiting_approval ──settle──▶ approved
//      │                                │
//      │                                └──settle──▶ rejected
//      └──withdraw──▶ withdrawn
//
//   plus the two direct policy paths at submission time:
//   proposed ──requestApproval(policy allows)──▶ approved   (policy decision)
//   proposed ──requestApproval(policy forbids)─▶ rejected   (policy decision)
//
// The post-approval states of the §15 agent lifecycle (PROPOSED →
// APPROVAL → RECRUITED → ACTIVE → EVALUATED → ...) belong to the agents
// module and W023/W024; W022 owns the proposal and its explicit
// authorization, nothing further.
//
// Tenancy (ADR-0001): every record is tenant-scoped; the capability link
// is verified through the capabilities contract at creation time and is
// deliberately NOT a cross-module foreign key (the capabilities module's
// own rule) — a foreign-tenant capability id reads the same as a missing
// one (`capability_not_found`), and a foreign-tenant proposal reads the
// same as a missing one (`proposal_not_found`) — no existence leak.

import type { AgentPermissionScope, AuthorityLevelWord } from '@/modules/agents/contract';

// ---------------------------------------------------------------------------
// Vocabularies (mirrored by the migrations' CHECK constraints)
// ---------------------------------------------------------------------------

/**
 * The six acquisition alternatives the W022 work item names verbatim, in
 * its canonical order: train / reassign / hire / automate / recruit /
 * install. ARCHITECTURE.md §13 lists the wider automation-option
 * vocabulary (agent teams, build-new-extension, outsource) — those belong
 * to the automation module (W018) and future items; W022 compares exactly
 * the six it names.
 */
export type RecruitmentAlternativeKind =
  | 'train'
  | 'reassign'
  | 'hire'
  | 'automate'
  | 'recruit'
  | 'install';

/**
 * The lifecycle of a recruitment proposal. `proposed` and
 * `awaiting_approval` are live; the rest are terminal history:
 *  * `proposed`         — recorded, not yet submitted to the approval gate;
 *  * `awaiting_approval`— submitted; the linked W009 action request is
 *    pending a human decision;
 *  * `approved`         — the acquisition was explicitly authorized (by a
 *    human principal, or by tenant policy the tenant explicitly allowed);
 *  * `rejected`         — refused (by a human principal, or by policy);
 *  * `withdrawn`        — the author (or an agent-workforce administrator)
 *    withdrew the draft before submission.
 */
export type RecruitmentProposalStatus =
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'withdrawn';

/**
 * The frozen W009 gate snapshot a proposal carries from submission time
 * (the agents module's `AgentExecutionPolicySnapshot` discipline): what
 * the authority matrix decided, through which policy row, and — once
 * terminal — who decided and when. Later policy edits never rewrite what
 * gated a recorded proposal (§24 decision evidence).
 */
export interface RecruitmentApprovalSnapshot {
  /** The linked action request (kind 'agent-recruitment', level EXECUTE). */
  actionRequestId: string | null;
  /** The matrix outcome at submission: allowed / approval_required / forbidden. */
  policyOutcome: 'allowed' | 'approval_required' | 'forbidden' | null;
  /** Which policy row decided: kind / tenant-default / built-in. */
  policyResolvedVia: 'kind' | 'tenant-default' | 'built-in' | null;
  /** The principal that submitted the proposal to the gate. */
  submittedBy: string | null;
  submittedAt: string | null;
  /** 'policy' when the matrix decided on its own; 'principal' when a human did. */
  decidedBy: 'policy' | 'principal' | null;
  /** The deciding human principal; null on policy decisions and while pending. */
  decidedByPrincipal: string | null;
  decidedAt: string | null;
}

// ---------------------------------------------------------------------------
// Alternatives (the comparison — the heart of W022)
// ---------------------------------------------------------------------------

/**
 * One compared acquisition alternative. Every alternative of a proposal is
 * assessed on the SAME dimensions, so the six kinds are genuinely
 * comparable (a comparison of differently-shaped objects is not a
 * comparison):
 *  * `summary` — what this alternative concretely proposes;
 *  * `estimatedCostMinor` + `estimatedCostCurrency` — the house money
 *    convention (integer minor units + ISO 4217 code), when estimated;
 *  * `estimatedWeeks` — time to capability impact, when estimated;
 *  * `expectedLevel` / `expectedCapacity` — the capability contribution
 *    this alternative would supply (the W017 supply dimensions: level in
 *    [0, 1] and a capacity quantity), when estimated;
 *  * `recommended` — at most one alternative per proposal may carry this
 *    flag (a partial UNIQUE index enforces it at storage level); zero is
 *    legal — "no clear winner, human judgment required" is an honest
 *    outcome;
 *  * `agentPermissions` — RECRUIT alternatives only: the permission scopes
 *    the proposed agent would be granted (the agents module's closed
 *    vocabulary, reused through its contract). Making the future grant
 *    visible at approval time is what §15's "agents are organizational
 *    actors with ... permissions" demands of a recruitment proposal; the
 *    §20 level those scopes imply is surfaced as `impliedAuthorityLevel`.
 */
export interface RecruitmentAlternative {
  id: string;
  tenantId: string;
  proposalId: string;
  kind: RecruitmentAlternativeKind;
  summary: string;
  note: string | null;
  estimatedCostMinor: number | null;
  estimatedCostCurrency: string | null;
  estimatedWeeks: number | null;
  expectedLevel: number | null;
  expectedCapacity: number | null;
  recommended: boolean;
  /** Present on 'recruit' alternatives only (null elsewhere). */
  agentPermissions: AgentPermissionScope[] | null;
  /** The §20 level the granted scopes imply (recruit only; null elsewhere). */
  impliedAuthorityLevel: AuthorityLevelWord | null;
}

/** Input shape of one compared alternative (see `RecruitmentAlternative`). */
export interface RecruitmentAlternativeInput {
  kind: RecruitmentAlternativeKind;
  summary: string;
  note?: string | null;
  /** Integer minor units; requires/pairs with `estimatedCostCurrency`. */
  estimatedCostMinor?: number | null;
  /** ISO 4217 code; defaults to 'USD' when a cost is given without one. */
  estimatedCostCurrency?: string | null;
  /** Whole weeks to capability impact, 1..520. */
  estimatedWeeks?: number | null;
  /** Capability level contribution in [0, 1]. */
  expectedLevel?: number | null;
  /** Capability capacity contribution ≥ 0. */
  expectedCapacity?: number | null;
  recommended?: boolean;
  /** 'recruit' alternatives only: the permission scopes the agent would be granted. */
  agentPermissions?: AgentPermissionScope[] | null;
}

// ---------------------------------------------------------------------------
// The proposal
// ---------------------------------------------------------------------------

/**
 * The decision-time snapshot of the capability being addressed — the
 * "existing capability" side of the §15 comparison, frozen when the
 * proposal was created so later capability-graph changes never rewrite
 * WHY the proposal was made (the same reason the actions module snapshots
 * the policy evaluation on a request). `status` is null when the
 * capability was out of gap-analysis scope at creation time (no active
 * requirements — nothing demands it; the proposal then argues for new
 * capability, not gap closure).
 */
export interface RecruitmentCapabilitySnapshot {
  capabilityId: string;
  /** The capability's tenant-unique name, snapshotted (self-containment). */
  capabilityName: string;
  capabilityStatus: 'active' | 'retired';
  /** The W017 gap classification at creation; null when out of gap scope. */
  gapStatus: 'uncovered' | 'level_shortfall' | 'capacity_shortfall' | 'covered' | null;
  /** Best active supply level at creation; null when out of gap scope. */
  bestActiveLevel: number | null;
  /** Total declared active capacity at creation; null when out of gap scope. */
  totalActiveCapacity: number | null;
}

/**
 * One AgentRecruitmentProposal: an immutable, evidence-backed comparison
 * of the six acquisition alternatives for one capability, plus its
 * explicit approval trail. The recommendation (if any) is the alternative
 * flagged `recommended`; the approval authorizes the PROPOSAL AS
 * SUBMITTED — an approver who wants a different outcome rejects and a new
 * proposal is drafted (the actions module's "a changed proposal is a NEW
 * request" discipline).
 */
export interface AgentRecruitmentProposal {
  id: string;
  tenantId: string;
  title: string;
  status: RecruitmentProposalStatus;
  /** The capability being addressed, snapshotted at creation. */
  capability: RecruitmentCapabilitySnapshot;
  /** Why the acquisition is proposed (1..2000 chars). */
  rationale: string;
  /** Observation (W004) ids cited as evidence (≤ 32, opaque forward references). */
  evidenceObservationIds: string[];
  /** The compared alternatives, 2..6, in canonical kind order. */
  alternatives: RecruitmentAlternative[];
  /** The recommended alternative, or null when no winner was proposed. */
  recommendation: RecruitmentAlternative | null;
  /** The explicit-approval trail (W009 gate snapshot + decision). */
  approval: RecruitmentApprovalSnapshot;
  /** The principal that recorded the proposal. */
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Set when (and only when) the proposal was withdrawn. */
  withdrawnAt: string | null;
  withdrawalReason: string | null;
}

// ---------------------------------------------------------------------------
// Inputs and queries
// ---------------------------------------------------------------------------

/** Input shape of `createRecruitmentProposal`. */
export interface CreateRecruitmentProposalInput {
  title: string;
  /** The capability (W017) the acquisition would strengthen; must exist in this tenant. */
  capabilityId: string;
  rationale: string;
  /** Observation (W004) ids cited as evidence (≤ 32, opaque forward references). */
  evidenceObservationIds?: string[];
  /** 2..6 alternatives with DISTINCT kinds — a comparison needs comparing. */
  alternatives: RecruitmentAlternativeInput[];
}

/** Input shape of `requestRecruitmentApproval`. */
export interface RequestRecruitmentApprovalInput {
  proposalId: string;
  /** Optional justification recorded on the action request (≤ 512 chars). */
  justification?: string | null;
}

/** Input shape of `settleRecruitmentProposal`. */
export interface SettleRecruitmentProposalInput {
  proposalId: string;
}

/** Input shape of `withdrawRecruitmentProposal` (drafts only). */
export interface WithdrawRecruitmentProposalInput {
  proposalId: string;
  /** Required reason (1..512 chars), recorded on the withdrawal. */
  reason: string;
}

/** Query shape of `getRecruitmentProposal`. */
export interface GetRecruitmentProposalQuery {
  proposalId: string;
}

/** Query shape of `listRecruitmentProposals`. */
export interface ListRecruitmentProposalsQuery {
  status?: RecruitmentProposalStatus;
  capabilityId?: string;
  /** Only proposals whose RECOMMENDED alternative has this kind. */
  recommendedKind?: RecruitmentAlternativeKind;
  /** 1..500, default 50. */
  limit?: number;
}
