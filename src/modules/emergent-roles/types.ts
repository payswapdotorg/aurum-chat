// Public domain types of the emergent-roles module (W138 — Emergent
// Roles + Marketplace Publication).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md §W138):
// "Allow recurring capability gaps to produce evidence-backed
//  RoleProposals and marketplace submissions."
// Acceptance: "role proposals carry evidence, capability demands,
// alternatives and evaluation; publication/install/activation remain
// governed; Lab cannot self-publish or self-activate."
//
// WHAT THIS MODULE IS: the EMERGENCE PROJECTION between the learning
// loop and the governed acquisition surfaces. When a capability gap
// RECURS — the same missing capability shows up as missed expected
// value (W040), as a negatively-calibrated organizational
// recommendation (W135) or as failed execution runs (W136) — this
// module aggregates those signals into gap-evidence records, lifts a
// recurring gap into an evidence-backed RoleProposal (what role would
// close it, what capabilities it demands, which alternatives were
// considered and why they lost, and the evaluation of why this role
// and why now), walks the proposal through the governed review (the
// W009 authority matrix decides; this module records the frozen
// decision), and links the APPROVED proposal to a marketplace package
// through a submission REQUEST and to a governed acquisition through
// an activation RECORD.
//
// THE THREE ACCEPTANCE LAWS, encoded structurally:
//   1. PROPOSALS CARRY EVIDENCE, DEMANDS, ALTERNATIVES AND EVALUATION —
//      a RoleProposal cannot exist without ≥2 distinct gap-evidence
//      citations (a single gap is not a recurring gap), ≥1 capability
//      demand typed against the capabilities module's proficiency
//      semantics (validated readable + active at write time), ≥1
//      alternative considered WITH its retained evaluation, and the
//      structured evaluation summary (why this role, why now, what gap
//      recurs). There is no constructor path that skips any of the
//      four; the storage row carries all four immutably.
//   2. PUBLICATION/INSTALL/ACTIVATION REMAIN GOVERNED — this module
//      never creates, submits, reviews, publishes or installs a
//      marketplace package and never recruits an agent. It creates a
//      typed submission REQUEST that cites a REAL marketplace package
//      (validated visible through the W028 contract) and an activation
//      RECORD that cites a REAL APPROVED agent-recruitment proposal
//      (W022). The marketplace's own governed chain (DRAFT → SUBMITTED
//      → … → PUBLISHED → INSTALLABLE) and the recruitment approval
//      stay exactly where they were; the proposal must itself be
//      APPROVED through a terminal W009 action request before either
//      record may land.
//   3. THE LAB CANNOT SELF-PUBLISH OR SELF-ACTIVATE — org-lab-sourced
//      proposals carry their provenance (the W135 recommendation they
//      emerged from + the principal that recorded them). The principal
//      that recorded an org-lab-sourced proposal is REFUSED, with
//      typed errors, as the recorder of its marketplace submission
//      (`lab_cannot_self_publish`) and of its activation
//      (`lab_cannot_self_activate`) — the Lab proposes, publication and
//      activation belong to governed authorities above it — and
//      PostgreSQL itself rejects those rows (storage triggers), so the
//      bad rows are unrepresentable even for callers bypassing the
//      service.
//
// THE EVIDENCE AUTHORITY RULE: this module invents NO evidence
// authority of its own. Every gap-evidence record cites ONE upstream
// record through its owning contract (a settled-MISSED W040 outcome, a
// NEGATIVELY-calibrated W135 recommendation — the Lab's own retained
// negative evidence — or a FAILED W136 execution run), validated at
// write time. The emergence projection aggregates; it never fabricates.
//
// Append-only where the house evidence law demands (§24 "Audit records
// are append-only from the domain perspective"): gap-evidence records,
// reviews, marketplace-submission requests and activations are
// immutable the moment they land (storage triggers reject
// UPDATE/DELETE/TRUNCATE). The proposal's evidence/demands/alternatives/
// evaluation content is immutable from creation — a changed proposal is
// a NEW proposal (the house law); only the one-way lifecycle moves
// (draft → under_review → approved | rejected → fulfilled, with the
// draft|under_review → withdrawn exit).
//
// Tenancy (ADR-0001): every record is tenant-scoped at the SQL layer;
// another tenant's gap evidence, proposals, submissions and activations
// are indistinguishable from missing ones (uniform not-found, no
// existence leak).

import type { MarketplacePackageState } from '@/modules/marketplace/contract';

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The one-way proposal lifecycle:
 *   draft → under_review → approved | rejected (terminal)
 *   draft | under_review → withdrawn (terminal)
 *   approved → fulfilled (terminal — the governed acquisition landed).
 */
export type RoleProposalStatus =
  | 'draft'
  | 'under_review'
  | 'approved'
  | 'rejected'
  | 'fulfilled'
  | 'withdrawn';

/**
 * Where a proposal emerged from. 'org-lab' proposals are the Lab's —
 * recorded against a REAL W135 recommendation, and structurally barred
 * from self-publication/self-activation (acceptance law 3).
 * 'tenant-operator' proposals are a tenant operator's own initiative.
 */
export type RoleProposalOriginKind = 'org-lab' | 'tenant-operator';

/**
 * The upstream seams a gap-evidence record may aggregate — exactly the
 * three recurring-gap signals the program owns: the W040 outcome stream
 * (a settled MISSED expected value), the W135 Lab's calibration loop (a
 * NEGATIVELY-calibrated recommendation — retained negative evidence)
 * and the W136 execution runs (a FAILED run). No other source kind
 * exists; this module aggregates existing evidence authorities, it
 * never mints one.
 */
export type GapEvidenceSourceKind =
  | 'learning-outcome'
  | 'org-lab-recommendation'
  | 'execution-run';

// ---------------------------------------------------------------------------
// The gap evidence (the recurring-gap detection input)
// ---------------------------------------------------------------------------

/**
 * One aggregated capability-gap observation: the capability that was
 * lacking, the upstream record that evidences the gap (validated
 * through its owning contract at write time — see the source kinds),
 * and the human observation of what recurred. Append-only evidence.
 */
export interface RoleGapEvidence {
  id: string;
  tenantId: string;
  /** The capability the gap was observed in (W017, validated readable + active at write time). */
  capabilityId: string;
  /** The upstream record that evidences this gap (one of the three seams). */
  source: GapEvidenceSource;
  /** What was observed (1..2000 chars) — the human aggregation note. */
  observation: string;
  recordedBy: string;
  recordedAt: string;
}

/**
 * The discriminated upstream source of one gap-evidence record. Exactly
 * one upstream id per record; each upstream record may be cited as gap
 * evidence AT MOST ONCE per tenant (partial unique indexes — honest
 * recurrence counting: one outcome cannot pose as two gaps).
 */
export type GapEvidenceSource =
  | { kind: 'learning-outcome'; outcomeId: string }
  | { kind: 'org-lab-recommendation'; recommendationId: string }
  | { kind: 'execution-run'; planId: string; runId: string };

/** Input shape of `GapEvidenceSource`. */
export type GapEvidenceSourceInput =
  | { kind: 'learning-outcome'; outcomeId: string }
  | { kind: 'org-lab-recommendation'; recommendationId: string }
  | { kind: 'execution-run'; planId: string; runId: string };

/** Input shape of `recordGapEvidence`. */
export interface RecordGapEvidenceInput {
  capabilityId: string;
  source: GapEvidenceSourceInput;
  observation: string;
}

// ---------------------------------------------------------------------------
// The capability demands (typed against the W017 proficiency semantics)
// ---------------------------------------------------------------------------

/**
 * One capability a proposed role demands, at a minimum proficiency —
 * the capabilities module's own semantics: a level in [0, 1], where 1
 * is full strength and 0 means presence suffices. The capability is
 * validated readable + active through the capabilities contract at
 * write time (a proposal demands a live capability of the graph).
 */
export interface CapabilityDemand {
  capabilityId: string;
  /** Minimum proficiency in [0, 1] (the W017 level semantics). */
  minimumLevel: number;
  note: string | null;
}

/** Input shape of `CapabilityDemand`. */
export interface CapabilityDemandInput {
  capabilityId: string;
  minimumLevel: number;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// The alternatives considered (recorded, with evaluation)
// ---------------------------------------------------------------------------

/**
 * One alternative considered and NOT chosen for the proposal — each
 * with its retained evaluation (why it lost: the trade-off, the cost,
 * the failure mode). The house "nothing is ever discarded" law: the
 * losing alternatives are part of the proposal's evidence.
 */
export interface AlternativeConsidered {
  label: string;
  description: string | null;
  /** Why this alternative was not chosen (1..2000 chars, REQUIRED). */
  evaluation: string;
}

/** Input shape of `AlternativeConsidered`. */
export interface AlternativeConsideredInput {
  label: string;
  description?: string | null;
  evaluation: string;
}

// ---------------------------------------------------------------------------
// The evaluation summary (why this role, why now, what gap recurs)
// ---------------------------------------------------------------------------

/**
 * The structured evaluation every proposal carries — the three
 * questions an evidence-backed role proposal must answer, all
 * required, all retained immutably.
 */
export interface RoleProposalEvaluation {
  /** Why THIS role closes the gap (1..2000 chars). */
  rationale: string;
  /** Why NOW (1..2000 chars). */
  whyNow: string;
  /** What gap recurs — the recurrence claim, backed by the cited evidence (1..2000 chars). */
  gapRecurrence: string;
}

/** Input shape of `RoleProposalEvaluation`. */
export interface RoleProposalEvaluationInput {
  rationale: string;
  whyNow: string;
  gapRecurrence: string;
}

// ---------------------------------------------------------------------------
// The role proposal (the emergence projection's spine)
// ---------------------------------------------------------------------------

/**
 * The provenance of a proposal. For 'org-lab' proposals (acceptance
 * law 3): the REAL W135 recommendation the proposal emerged from
 * (validated readable at creation) and the principal that recorded it —
 * that principal is the Lab's, and it is structurally barred from
 * recording the proposal's marketplace submission or activation.
 * `principalId` is SYSTEM-CAPTURED from the TenantContext, never
 * caller-supplied.
 */
export interface RoleProposalOrigin {
  kind: RoleProposalOriginKind;
  /** The W135 recommendation (REQUIRED for 'org-lab', must be null otherwise). */
  recommendationId: string | null;
  /** The principal that recorded the proposal (system-captured). */
  principalId: string;
}

/**
 * The evidence-backed role proposal: what role would close a recurring
 * capability gap. Content (citations, demands, alternatives,
 * evaluation) is IMMUTABLE from creation — a changed proposal is a NEW
 * proposal; only the one-way lifecycle moves.
 */
export interface RoleProposal {
  id: string;
  tenantId: string;
  /** Tenant-unique slug (slug grammar — deterministic referencing). */
  slug: string;
  title: string;
  origin: RoleProposalOrigin;
  status: RoleProposalStatus;
  /** The cited gap-evidence records (2..16 distinct ids, validated readable at creation). */
  evidenceCitationIds: string[];
  /** The demanded capabilities (1..16, distinct capability ids). */
  demands: CapabilityDemand[];
  /** The alternatives considered (1..8, each with its retained evaluation). */
  alternatives: AlternativeConsidered[];
  /** The structured evaluation summary (required). */
  evaluation: RoleProposalEvaluation;
  note: string | null;
  createdBy: string;
  createdAt: string;
  submittedAt: string | null;
  submittedBy: string | null;
  /** Stamped exactly once by the review transition (approved or rejected). */
  decidedAt: string | null;
  /** Stamped exactly once by the activation transition. */
  fulfilledAt: string | null;
  /** Stamped exactly once by the withdrawal transition. */
  withdrawnAt: string | null;
  /** The retained withdrawal reason. */
  lifecycleNote: string | null;
}

/** Input shape of `createRoleProposal`. */
export interface CreateRoleProposalInput {
  slug: string;
  title: string;
  origin: {
    kind: RoleProposalOriginKind;
    /** REQUIRED when kind is 'org-lab'; must be absent otherwise. */
    recommendationId?: string | null;
  };
  /** 2..16 distinct gap-evidence ids (the recurrence floor: one gap is not a recurring gap). */
  evidenceCitationIds: string[];
  /** 1..16 capability demands (distinct capability ids). */
  demands: CapabilityDemandInput[];
  /** 1..8 alternatives considered, each with its evaluation. */
  alternatives: AlternativeConsideredInput[];
  evaluation: RoleProposalEvaluationInput;
  note?: string | null;
}

/** Input shape of `submitRoleProposal` (draft → under_review). */
export interface SubmitRoleProposalInput {
  proposalId: string;
}

/** Input shape of `withdrawRoleProposal` (draft | under_review → withdrawn). */
export interface WithdrawRoleProposalInput {
  proposalId: string;
  /** Required reason (1..512 chars), retained. */
  reason: string;
}

// ---------------------------------------------------------------------------
// The governed review (the W009 authority system decides)
// ---------------------------------------------------------------------------

/**
 * The frozen authority decision a review record carries — consumed
 * VERBATIM from the actions module's terminal request state at record
 * time (this module never decides, anticipates or rewords an authority
 * outcome; it records that the authority system decided).
 */
export interface ReviewDecisionSnapshot {
  actionRequestId: string;
  actionKind: string;
  authorityLevel: string;
  /** The request's terminal status at snapshot time. */
  status: 'approved' | 'rejected';
  requestedBy: string;
  requestedAt: string;
  decidedAt: string;
}

/**
 * One review record — the governed decision that moves a proposal out
 * of under_review. The action request must be TERMINAL at record time:
 * the authority system has already decided (approved → the proposal is
 * APPROVED; rejected → the proposal is REJECTED, retained exactly like
 * an approval — the house evidence law). Append-only; at most one per
 * proposal (the lifecycle is one-way).
 */
export interface ProposalReviewRecord {
  id: string;
  tenantId: string;
  proposalId: string;
  decision: ReviewDecisionSnapshot;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordProposalReview`. */
export interface RecordProposalReviewInput {
  proposalId: string;
  /** The actions-module action request whose terminal decision is being recorded. */
  actionRequestId: string;
}

// ---------------------------------------------------------------------------
// The marketplace submission REQUEST (acceptance law 2 — publication
// stays governed)
// ---------------------------------------------------------------------------

/**
 * One marketplace-submission REQUEST: the typed record that links an
 * APPROVED proposal to a REAL marketplace package the vendor created
 * through the marketplace's own governed path (W028's createPackage —
 * claim 'marketplace:submit'). The package's identity and state are
 * FROZEN at record time; the governed chain that actually publishes
 * (submitPackage → automated verification → platform review → publish
 * → installable) belongs entirely to the marketplace and the platform —
 * this module never invokes it, never advances it, and never installs
 * anything. Append-only evidence.
 */
export interface MarketplaceSubmissionRequest {
  id: string;
  tenantId: string;
  proposalId: string;
  /** The marketplace package the approved proposal is submitted through (W028, validated visible + kind 'agent'). */
  packageId: string;
  /** The package's catalog key, frozen at record time. */
  packageKey: string;
  /** The package's release version, frozen at record time. */
  packageVersion: string;
  /** The package's governed state, frozen at record time (verbatim W028 vocabulary). */
  packageState: MarketplacePackageState;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordMarketplaceSubmission`. */
export interface RecordMarketplaceSubmissionInput {
  proposalId: string;
  packageId: string;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// The activation RECORD (acceptance law 2 — installation/activation stay
// governed; acceptance law 3 — the Lab cannot self-activate)
// ---------------------------------------------------------------------------

/**
 * One activation record: the typed evidence that the proposed role
 * became operational through a GOVERNED acquisition — a REAL APPROVED
 * agent-recruitment proposal (W022, validated readable + approved at
 * record time; the recruitment's own W009 gate decided the
 * acquisition). Recording the activation moves the proposal's one-way
 * lifecycle approved → fulfilled. This module never recruits, installs
 * or activates anything itself. Append-only evidence.
 */
export interface RoleActivation {
  id: string;
  tenantId: string;
  proposalId: string;
  /** The APPROVED agent-recruitment proposal that acquired the role (W022). */
  recruitmentProposalId: string;
  note: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** Input shape of `recordRoleActivation`. */
export interface RecordRoleActivationInput {
  proposalId: string;
  recruitmentProposalId: string;
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Query shape of `getRoleProposal`. */
export interface GetRoleProposalQuery {
  proposalId: string;
}

/** Query shape of `listRoleProposals`. All filters AND-combined. */
export interface ListRoleProposalsQuery {
  status?: RoleProposalStatus;
  originKind?: RoleProposalOriginKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getGapEvidence`. */
export interface GetGapEvidenceQuery {
  gapEvidenceId: string;
}

/** Query shape of `listGapEvidence`. All filters AND-combined. */
export interface ListGapEvidenceQuery {
  capabilityId?: string;
  sourceKind?: GapEvidenceSourceKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listMarketplaceSubmissions`. */
export interface ListMarketplaceSubmissionsQuery {
  proposalId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listRoleActivations`. */
export interface ListRoleActivationsQuery {
  proposalId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** `listRoleProposals` summary row (deep-link with `getRoleProposal`). */
export interface RoleProposalSummary {
  id: string;
  tenantId: string;
  slug: string;
  title: string;
  originKind: RoleProposalOriginKind;
  recommendationId: string | null;
  status: RoleProposalStatus;
  demandCount: number;
  citationCount: number;
  alternativeCount: number;
  createdAt: string;
}
