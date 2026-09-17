// ============================================================================
// contributions — the ONLY public surface of the module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W042 — Knowledge Contributions:
// "Record employee knowledge contributions, validation, knowledge gain,
//  mission impact and investigation-cost avoidance."
//
// ARCHITECTURE.md §8 (frozen): "KnowledgeContribution records what
// information an employee supplied, the associated evidence, validation
// outcome, knowledge gain, goal impact and investigation cost avoided.
// RewardPolicy converts contribution value into configured rewards." And
// §7: "Aurum may ask an employee targeted questions when policy permits,
// record the resulting contribution, assess evidence quality, update the
// mission, and reward useful contributions." Lock 9: employees are
// first-class knowledge sources.
//
//   recordContribution  — anchor ONE knowledge contribution to ONE
//      answered ask-person acquisition plan (W012): the plan is validated
//      readable through the knowledge-acquisition contract at write time
//      (the sanctioned W012 → W042 dependency), and the contributing
//      employee, the mission, the targeted question, the answer's
//      evidence observation and the investigation-budget currency are
//      DERIVED from that plan and minted by the service — a caller
//      supplies only the human summary. One contribution per acquisition
//      (UNIQUE (tenant_id, plan_id)); status is minted 'pending'.
//   validateContribution — append ONE evidence-quality assessment to the
//      contribution's validation series (§7 "assess evidence quality"):
//      outcome validated/contradicted/rejected, quality score in [0,1],
//      optional opaque evidence references. Revalidation is allowed and
//      history is never rewritten — contradictions are RETAINED
//      (lock 12); the current validation is the latest row, and
//      validations may keep arriving after the impact was frozen.
//   recordImpact   — the ONE measured impact record per contribution
//      (first write wins, frozen): the knowledge gain (mission
//      confidence before → after; the service freezes the delta — the
//      single deterministic definition is `assessKnowledgeGain`), the
//      mission impact kind, the affected goals (§8 "goal impact"), the
//      investigation cost avoided (integer minor units of the plan's
//      mission investigation-budget currency, itemized by the acquisition
//      actions that no longer need to run) and the optional learning
//      outcome (W040) that measures the mission's improvement —
//      validated readable through the learning contract at write time
//      (the sanctioned W040 → W042 dependency). Recording an impact
//      requires at least one validation first (§7's canonical order:
//      assess evidence quality, THEN update the mission).
//   getContribution / listContributions — the derived current views
//      (status ladder pending/validated/contradicted/rejected/measured),
//      filtered by mission, contributing employee, status, mission
//      impact and summary search, newest first.
//   getValidation / listValidations — one assessment deep-linked by id,
//      and one contribution's validation series ascending (the audit
//      trail).
//   summarizeContributions — the contribution-value rollup: the status
//      ladder, impact kinds, the total knowledge gain and the
//      investigation cost avoided summed PER CURRENCY, optionally
//      narrowed to one contributing employee — the surface W043 Rewards
//      ("valuable knowledge contributions") and W052 knowledge source
//      ranking (the `priorContributionValue` signal) read.
//
// There is deliberately NO operation to rewrite a contribution, rewrite a
// validation, un-measure an impact or delete anything: what an employee
// supplied, how it was assessed and what it changed are append-only
// auditable history — PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on
// all three tables via migration 001 triggers.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; access to another tenant's
// contributions or validations (including validating and measuring by
// foreign-tenant contribution id) is reported as
// `contribution_not_found` / `validation_not_found` — no existence leak.
// The acquisition-plan and learning-outcome links are uniformly
// `invalid_plan_ref` / `invalid_outcome_ref` for the same reason.
//
// Dependency posture (WORK-ITEM-DEPENDENCY-GRAPH.md: W012 + W040 → W042):
// this module imports the knowledge-acquisition contract (the plan
// anchor — the DAG's W012 edge) and the learning contract (the optional
// mission-improvement outcome link — the DAG's W040 edge) and nothing
// else. The contributor, affected goals and evidence references are
// opaque forward references owned by their modules (people W002, goals
// W008, observations W004) — no cross-module foreign keys, no contract
// imports for them (the missions module's affected-goals precedent).
// ============================================================================

export {
  getContribution,
  getValidation,
  listContributions,
  listValidations,
  recordContribution,
  recordImpact,
  summarizeContributions,
  validateContribution,
} from './service';

export { ContributionsError } from './errors';
export type { ContributionsErrorCode } from './errors';

// The knowledge-gain math — the single deterministic definition, pure and
// reusable by downstream learning surfaces (W043 Rewards and W053
// CompanyModel consume the FROZEN record this produces; the function is
// exported for verification).
export { assessKnowledgeGain } from './validation';
export type { KnowledgeGainAssessment } from './validation';

export {
  AVOIDED_PATH_ACTIONS,
  CONTRIBUTION_EVIDENCE_KINDS,
  CONTRIBUTION_PARTY_KINDS,
  CONTRIBUTION_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_AFFECTED_GOALS,
  MAX_AVOIDED_PATHS,
  MAX_AVOIDED_PATH_LABEL_LENGTH,
  MAX_COST_AMOUNT,
  MAX_EVIDENCE_REFS,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_PARTY_LABEL_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_SUMMARY_LENGTH,
  MISSION_IMPACT_KINDS,
  VALIDATION_OUTCOMES,
  escapeLike,
  isAvoidedPathAction,
  isContributionEvidenceKind,
  isContributionPartyKind,
  isContributionStatus,
  isMissionImpactKind,
  isUuid,
  isValidationOutcome,
} from './validation';

export type {
  ValidatedAvoidedPath,
  ValidatedEvidenceRef,
  ValidatedGoalRef,
  ValidatedImpactInput,
  ValidatedListQuery,
  ValidatedParty,
  ValidatedRecordInput,
  ValidatedSummarizeQuery,
  ValidatedValidationInput,
  ValidatedValidationsQuery,
} from './validation';

export type {
  AvoidedPath,
  AvoidedPathAction,
  Contribution,
  ContributionActor,
  ContributionContributor,
  ContributionEvidenceKind,
  ContributionEvidenceRef,
  ContributionEvidenceRefInput,
  ContributionGoalRef,
  ContributionGoalRefInput,
  ContributionImpact,
  ContributionParty,
  ContributionPartyInput,
  ContributionStatus,
  ContributionSummary,
  ContributionValidation,
  ContributionValidationOutcome,
  CostAvoidedBucket,
  ListContributionsQuery,
  ListValidationsQuery,
  MissionImpactKind,
  RecordContributionInput,
  RecordImpactInput,
  SummarizeContributionsQuery,
  ValidateContributionInput,
} from './types';
