// ============================================================================
// emergent-roles — the ONLY public surface of the emergent-roles module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W138 — Emergent Roles + Marketplace Publication
// (spec/work-items/WORK-ITEM-CATALOG.md §W138):
// "Allow recurring capability gaps to produce evidence-backed
//  RoleProposals and marketplace submissions."
// Acceptance: "role proposals carry evidence, capability demands,
// alternatives and evaluation; publication/install/activation remain
// governed; Lab cannot self-publish or self-activate."
//
//   The recurring-gap detection input (the module invents NO evidence
//   authority — it aggregates the three existing recurring-gap signals
//   through their owning contracts):
//   recordGapEvidence — append ONE immutable gap-evidence record: a
//      capability (W017, validated readable + active) + ONE upstream
//      record that evidences the gap — a settled-MISSED W040 outcome
//      (the frozen miss is the signal, never a prediction), a
//      NEGATIVELY-calibrated W135 recommendation (the Lab's own
//      retained negative evidence) or a FAILED W136 execution run
//      (readable through the exchange contract) — plus the human
//      observation of what recurred. One upstream record is one gap:
//      partial unique indexes make double-citation unrepresentable, so
//      recurrence counting stays honest.
//
//   The evidence-backed proposal (acceptance clause 1):
//   createRoleProposal — mint ONE draft: tenant-unique slug, the
//      provenance ('org-lab' proposals cite the REAL W135
//      recommendation they emerged from, validated readable; the
//      origin principal is system-captured), 2..16 DISTINCT
//      gap-evidence citations (the recurrence floor: a single gap is
//      not a recurring gap; every citation must concern a DEMANDED
//      capability — the cited evidence is about the proposal's case),
//      1..16 capability demands (W017 ids + the [0,1] proficiency
//      level semantics, each validated readable + active), 1..8
//      alternatives considered EACH with its retained evaluation (why
//      it lost — nothing is ever discarded), and the structured
//      evaluation (rationale / whyNow / gapRecurrence — all required).
//      Content is IMMUTABLE from creation (a changed proposal is a NEW
//      proposal); only the one-way lifecycle moves.
//
//   The one-way lifecycle:
//   submitRoleProposal — draft → under_review (submitted_at/by stamped
//      exactly once; staleness re-check under the FOR UPDATE row lock).
//   withdrawRoleProposal — draft | under_review → withdrawn (terminal;
//      required retained reason).
//   recordProposalReview — under_review → approved | rejected: the
//      W009 authority system decides, this module records the frozen
//      decision snapshot VERBATIM (an approved request approves the
//      proposal; a REJECTED request rejects it — a rejection is
//      retained evidence exactly like an approval). A still-pending
//      request refuses with `review_not_decided`; at most one review
//      per proposal, ever (append-only + UNIQUE).
//
//   The governed publication + acquisition (acceptance clauses 2 + 3):
//   recordMarketplaceSubmission — append ONE immutable submission
//      REQUEST linking an APPROVED proposal to a REAL marketplace
//      AgentPackage (W028, validated visible through the marketplace
//      contract; kind 'agent' — §17 "The same governance applies to
//      AgentPackages"), with the package key/version/state FROZEN at
//      record time. The governed chain that actually publishes
//      (submitPackage → automated verification → platform review →
//      publishPackage → makePackageInstallable) belongs ENTIRELY to
//      the marketplace and the platform: this module never invokes it,
//      never advances a package state, never installs anything.
//   recordRoleActivation — append ONE immutable activation RECORD
//      citing a REAL APPROVED agent-recruitment proposal (W022 — the
//      acquisition's own W009 gate decided it), stamping the proposal
//      approved → fulfilled exactly once. This module never recruits,
//      installs or activates anything itself.
//
// THE LAB AUTHORITY SEPARATION (acceptance clause 3, structural): the
// principal that recorded an org-lab-sourced proposal is REFUSED as
// the recorder of its marketplace submission (`lab_cannot_self_publish`)
// and of its activation (`lab_cannot_self_activate`) — the Lab
// proposes; publication and activation belong to governed authorities
// above it — and PostgreSQL itself rejects those rows (storage
// triggers), so the bad rows are unrepresentable even for callers
// bypassing this service. Tenant-operator proposals follow the same
// governed review before submission/activation; their origin principal
// may record both (the review's authority separation stays with the
// W009 matrix that decided it).
//
// There is deliberately NO operation to create, submit, review,
// publish, install or activate a marketplace package, to recruit an
// agent, or to decide an approval: the marketplace (W028) owns the
// governed package chain through INSTALLABLE, Agent Recruitment (W022)
// owns approved acquisitions, and the actions matrix (W009) owns
// authority decisions. Every cross-module import the service makes is
// a READ (existence, state, snapshot); every mutation touches only
// this module's tables; gap evidence, reviews, submissions and
// activations are append-only evidence (storage triggers reject
// UPDATE/DELETE/TRUNCATE).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's gap
// evidence, proposals, reviews, submissions and activations are
// indistinguishable from missing ones — no existence leak.
// ============================================================================

export {
  // The recurring-gap detection input
  recordGapEvidence,
  // The evidence-backed proposal
  createRoleProposal,
  // The one-way lifecycle
  submitRoleProposal,
  withdrawRoleProposal,
  recordProposalReview,
  // The governed publication + acquisition
  recordMarketplaceSubmission,
  recordRoleActivation,
  // Reads
  getGapEvidence,
  getRoleProposal,
  listGapEvidence,
  listMarketplaceSubmissions,
  listRoleActivations,
  listRoleProposals,
} from './service';

export { EmergentRolesError } from './errors';
export type { EmergentRolesErrorCode } from './errors';

// Guards + vocabularies + limits (pure; unit-testable without a database).
export {
  DEFAULT_LIST_LIMIT,
  GAP_EVIDENCE_SOURCE_KINDS,
  MAX_ALTERNATIVES,
  MAX_ALTERNATIVE_DESCRIPTION_CHARS,
  MAX_ALTERNATIVE_EVALUATION_CHARS,
  MAX_ALTERNATIVE_LABEL_CHARS,
  MAX_DEMANDS,
  MAX_DEMAND_LEVEL,
  MAX_DEMAND_NOTE_CHARS,
  MAX_EVALUATION_CHARS,
  MAX_EVIDENCE_CITATIONS,
  MAX_LIST_LIMIT,
  MAX_NOTE_CHARS,
  MAX_OBSERVATION_CHARS,
  MAX_REASON_CHARS,
  MAX_SLUG_CHARS,
  MAX_TITLE_CHARS,
  MIN_ALTERNATIVES,
  MIN_DEMANDS,
  MIN_DEMAND_LEVEL,
  MIN_EVIDENCE_CITATIONS,
  ROLE_PROPOSAL_ORIGIN_KINDS,
  ROLE_PROPOSAL_STATUSES,
  ROLE_PROPOSAL_TERMINAL_STATUSES,
  assertEmergentRolesTenantContext,
  isGapEvidenceSourceKind,
  isRoleProposalOriginKind,
  isRoleProposalStatus,
  isTerminalRoleProposalStatus,
  isUuid,
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
export type {
  ValidatedAlternative,
  ValidatedCreateRoleProposalInput,
  ValidatedDemand,
  ValidatedEvaluation,
  ValidatedGapSource,
  ValidatedGetGapEvidenceQuery,
  ValidatedGetRoleProposalQuery,
  ValidatedListGapEvidenceQuery,
  ValidatedListRoleProposalsQuery,
  ValidatedProposalScopedListQuery,
  ValidatedRecordGapEvidenceInput,
  ValidatedRecordMarketplaceSubmissionInput,
  ValidatedRecordProposalReviewInput,
  ValidatedRecordRoleActivationInput,
  ValidatedSubmitRoleProposalInput,
  ValidatedWithdrawRoleProposalInput,
} from './validation';

// The domain vocabularies (types.ts is their single home; the frozen
// status/origin-kind/source-kind arrays are re-exported above through
// validation.ts).
export type {
  AlternativeConsidered,
  AlternativeConsideredInput,
  CapabilityDemand,
  CapabilityDemandInput,
  CreateRoleProposalInput,
  GapEvidenceSource,
  GapEvidenceSourceInput,
  GapEvidenceSourceKind,
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
  RoleProposalEvaluationInput,
  RoleProposalOrigin,
  RoleProposalOriginKind,
  RoleProposalStatus,
  RoleProposalSummary,
  SubmitRoleProposalInput,
  WithdrawRoleProposalInput,
} from './types';

// The frozen cross-module vocabulary this surface speaks, re-exported
// TYPE-ONLY through its owning contract (the single legal cross-module
// import, enforced by the architecture gate) so consumers never need to
// know where the union was frozen: the marketplace package state frozen
// onto submission records is consumed VERBATIM from W028.
export type { MarketplacePackageState } from '@/modules/marketplace/contract';
