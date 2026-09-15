// Typed errors of the epistemics module. Consumers catch `EpistemicsError`
// and branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`claim_not_found`, `contradiction_not_found`, `hypothesis_not_found`,
// `unknown_not_found`, `belief_not_found`) — the existence of another tenant's
// claims, contradictions, hypotheses, unknowns or beliefs must never leak
// (ADR-0001), including through evidence-reference validation paths.
//
// Error propagation across module boundaries (documented for consumers):
//  * evidence validation (`recordClaim`, `registerContradiction`,
//    `recordHypothesis`, `recordUnknown`, `formBelief`, `reviseBelief`,
//    `resolveHypothesis`, `resolveContradiction`, `resolveUnknown`) maps a
//    supporting observation that is missing, cross-tenant or principal-
//    restricted to `invalid_evidence` — unreadable evidence is
//    indistinguishable from absent evidence, mirroring the freshness
//    module's `invalid_provenance` policy;
//  * belief versioning is implemented through the freshness module's temporal
//    revision machinery (subject kind `epistemics.belief`). Its errors are
//    mapped onto this module's vocabulary because the mechanism is an
//    implementation detail of beliefs: `invalid_provenance` →
//    `invalid_evidence`; `invalid_revision_input` → `invalid_belief_input`;
//    `revision_conflict` → `belief_conflict`;
//    `temporal_state_not_found` → `belief_version_not_found`. Any other
//    FreshnessError propagates unchanged (it is by construction a caller
//    input this module already validated, so it cannot occur through this
//    contract — but nothing is silently swallowed).

export type EpistemicsErrorCode =
  | 'invalid_context'
  | 'invalid_claim_input'
  | 'invalid_contradiction_input'
  | 'invalid_hypothesis_input'
  | 'invalid_unknown_input'
  | 'invalid_belief_input'
  | 'invalid_resolution'
  | 'invalid_query'
  | 'invalid_evidence'
  | 'claim_not_found'
  | 'contradiction_not_found'
  | 'contradiction_conflict'
  | 'hypothesis_not_found'
  | 'unknown_not_found'
  | 'belief_not_found'
  | 'belief_version_not_found'
  | 'belief_conflict'
  | 'belief_retired'
  | 'belief_state_corrupt';

export class EpistemicsError extends Error {
  constructor(
    public readonly code: EpistemicsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EpistemicsError';
  }
}
