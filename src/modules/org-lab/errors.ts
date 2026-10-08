// Typed errors of the org-lab module. Consumers catch `OrgLabError` and
// branch on `code`; messages are for humans/logs, never for control flow —
// the same discipline every module applies.
//
// Error vocabulary (18 codes):
//   invalid_context       — a caller forgot/malformed the explicit
//                           TenantContext (ADR-0001: the context is
//                           asserted, never ambient);
//   invalid_candidate_input — malformed registerCandidate input (node
//                           shapes, edge endpoints, applicability shapes,
//                           purposes on non-body nodes, ...);
//   invalid_query         — malformed get/list/search query (validation);
//   candidate_not_found   — uniform not-found for a missing OR foreign
//                           candidate id (ADR-0001: cross-tenant access is
//                           indistinguishable from missing — no existence
//                           leak);
//   candidate_slug_taken  — the tenant-unique slug is already in use
//                           (UNIQUE(tenant_id, slug) mapped to the typed
//                           code);
//   candidate_retired     — retiring an already-retired candidate (the
//                           lifecycle is one-way);
//   node_ref_not_found    — an agent-body node references a body that is
//                           missing or foreign (mapped from the agent-body
//                           contract's uniform not-found);
//   node_ref_inactive     — an agent-body node references a retired body
//                           (a fresh design references live bodies);
//   invalid_recommendation_input — malformed recordRecommendation input
//                           (dispositions, rejection-reason discipline,
//                           criterion/score shapes, bounds);
//   recommendation_not_found — uniform not-found for a missing or foreign
//                           recommendation id;
//   recommendation_already_calibrated — calibrating a recommendation whose
//                           calibration already exists (one per
//                           recommendation, terminal);
//   invalid_calibration_input — malformed recordCalibration input;
//   invalid_outcome_ref   — an expected outcome is missing, foreign, or
//                           not in the required state (OPEN at record
//                           time, SETTLED at calibration time — an
//                           abandoned outcome never realizes and can never
//                           calibrate); uniform, no existence leak;
//   goal_not_found        — the goal is missing, foreign or not ACTIVE
//                           (mapped from the goals contract);
//   fingerprint_not_found — the fingerprint is missing or foreign (mapped
//                           from the context contract);
//   fingerprint_goal_mismatch — the fingerprint is readable but was derived
//                           for a DIFFERENT goal — a search/recommendation
//                           for goal G under goal H's context is incoherent;
//   strategy_not_found    — the optional info-strategy link is missing or
//                           foreign (mapped from the info-strategy
//                           contract);
//   evaluation_ref_not_found — a cited agent evaluation (W024) is missing
//                           or foreign (mapped from the agent-evaluation
//                           contract).

export type OrgLabErrorCode =
  | 'invalid_context'
  | 'invalid_candidate_input'
  | 'invalid_query'
  | 'candidate_not_found'
  | 'candidate_slug_taken'
  | 'candidate_retired'
  | 'node_ref_not_found'
  | 'node_ref_inactive'
  | 'invalid_recommendation_input'
  | 'recommendation_not_found'
  | 'recommendation_already_calibrated'
  | 'invalid_calibration_input'
  | 'invalid_outcome_ref'
  | 'goal_not_found'
  | 'fingerprint_not_found'
  | 'fingerprint_goal_mismatch'
  | 'strategy_not_found'
  | 'evaluation_ref_not_found';

export class OrgLabError extends Error {
  constructor(
    public readonly code: OrgLabErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OrgLabError';
  }
}
