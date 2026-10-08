// Typed errors of the emergent-roles module. Consumers catch
// `EmergentRolesError` and branch on `code`; messages are for
// humans/logs, never for control flow — the same discipline every
// module applies.
//
// Error vocabulary (33 codes):
//   invalid_context       — a caller forgot/malformed the explicit
//                           TenantContext (ADR-0001: the context is
//                           asserted, never ambient);
//   invalid_gap_input     — malformed recordGapEvidence input (source
//                           shape, per-kind ref rules, observation
//                           bounds, capability demand shape);
//   invalid_proposal_input — malformed createRoleProposal input (slug
//                           grammar, bounds, the recurrence floor,
//                           demand/alternative/evaluation shapes and
//                           distinctness);
//   invalid_transition_input — malformed submit/withdraw input;
//   invalid_review_input  — malformed recordProposalReview input;
//   invalid_submission_input — malformed recordMarketplaceSubmission
//                           input;
//   invalid_activation_input — malformed recordRoleActivation input;
//   invalid_query         — malformed get/list query (validation);
//   gap_evidence_not_found — uniform not-found for a missing OR
//                           foreign gap-evidence record cited by a
//                           proposal (ADR-0001: cross-tenant access is
//                           indistinguishable from missing — no
//                           existence leak);
//   gap_source_already_cited — the upstream record (outcome /
//                           recommendation / run) is already cited as
//                           gap evidence in this tenant — one upstream
//                           record is one gap (honest recurrence
//                           counting);
//   citation_demand_mismatch — a cited gap-evidence record concerns a
//                           capability the proposal does NOT demand —
//                           the cited evidence must be about the
//                           demanded capabilities (the recurrence claim
//                           stays grounded);
//   proposal_not_found    — uniform not-found for a missing OR foreign
//                           proposal id;
//   slug_taken            — the slug is already a proposal in this
//                           tenant (a changed proposal is a NEW
//                           proposal with a new slug);
//   proposal_not_submittable — submitting a proposal that is not a
//                           draft (the lifecycle is one-way);
//   proposal_not_withdrawable — withdrawing a proposal that already
//                           left the draft/under_review states;
//   proposal_not_under_review — recording a review against a proposal
//                           that is not under review (covers terminal
//                           states — the review is the one exit);
//   proposal_not_approved — creating a marketplace submission or an
//                           activation for a proposal the governed
//                           review has not APPROVED;
//   review_request_not_found — the review references an actions-module
//                           request that is missing or foreign (mapped
//                           from the actions contract);
//   review_not_decided    — the review references an action request
//                           that is still PENDING — the authority
//                           system has not decided yet, and this
//                           module records decisions only;
//   capability_ref_not_found — a demand's or a gap record's capability
//                           is missing, foreign, retired or archived
//                           (uniform — a live proposal demands live
//                           graph nodes; no existence leak);
//   recommendation_ref_not_found — the org-lab provenance (or the
//                           org-lab gap source) is missing or foreign
//                           (mapped from the org-lab contract);
//   outcome_ref_not_found — the W040 gap source is missing or foreign
//                           (mapped from the learning contract);
//   outcome_not_gap_evidence — the W040 gap source is readable but NOT
//                           settled-missed — only a settled outcome
//                           whose frozen assessment is 'missed' is a
//                           capability-gap signal;
//   plan_ref_not_found    — the W136 gap source's execution plan is
//                           missing or foreign (mapped from the
//                           agent-exchange contract);
//   run_ref_not_found     — the W136 gap source's run id is not among
//                           the plan's recorded runs;
//   run_not_gap_evidence  — the W136 gap source's run is readable but
//                           NOT failed — only a FAILED execution run
//                           is a capability-gap signal;
//   recommendation_not_gap_evidence — the W135 gap source is readable
//                           but not negatively calibrated — only a
//                           NEGATIVELY-calibrated recommendation (the
//                           Lab's own retained negative evidence) is a
//                           capability-gap signal;
//   marketplace_ref_not_found — the submission's package is not
//                           visible to this tenant (foreign, missing
//                           or pre-publication — uniform, no existence
//                           leak; the marketplace owns visibility);
//   marketplace_ref_not_agent_package — the submission's package is
//                           readable but not an AgentPackage — a role
//                           proposal materializes as the agent kind
//                           (the marketplace's §17 "same governance
//                           applies to AgentPackages");
//   lab_cannot_self_publish — THE authority separation (acceptance
//                           clause): the principal that recorded an
//                           org-lab-sourced proposal cannot be the one
//                           to record its marketplace submission — the
//                           Lab proposes, publication belongs to a
//                           governed authority above it;
//   lab_cannot_self_activate — the same separation on the acquisition
//                           side: the recording principal of an
//                           org-lab-sourced proposal cannot be the one
//                           to record its activation;
//   recruitment_ref_not_found — the activation's acquisition proposal
//                           is missing or foreign (mapped from the
//                           agent-recruitment contract);
//   recruitment_not_approved — the activation's acquisition proposal
//                           is readable but NOT approved — roles
//                           become operational through governed,
//                           approved acquisitions only.
//
// 33 codes total.

export type EmergentRolesErrorCode =
  | 'invalid_context'
  | 'invalid_gap_input'
  | 'invalid_proposal_input'
  | 'invalid_transition_input'
  | 'invalid_review_input'
  | 'invalid_submission_input'
  | 'invalid_activation_input'
  | 'invalid_query'
  | 'gap_evidence_not_found'
  | 'gap_source_already_cited'
  | 'citation_demand_mismatch'
  | 'proposal_not_found'
  | 'slug_taken'
  | 'proposal_not_submittable'
  | 'proposal_not_withdrawable'
  | 'proposal_not_under_review'
  | 'proposal_not_approved'
  | 'review_request_not_found'
  | 'review_not_decided'
  | 'capability_ref_not_found'
  | 'recommendation_ref_not_found'
  | 'outcome_ref_not_found'
  | 'outcome_not_gap_evidence'
  | 'plan_ref_not_found'
  | 'run_ref_not_found'
  | 'run_not_gap_evidence'
  | 'recommendation_not_gap_evidence'
  | 'marketplace_ref_not_found'
  | 'marketplace_ref_not_agent_package'
  | 'lab_cannot_self_publish'
  | 'lab_cannot_self_activate'
  | 'recruitment_ref_not_found'
  | 'recruitment_not_approved';

export class EmergentRolesError extends Error {
  constructor(
    public readonly code: EmergentRolesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmergentRolesError';
  }
}
