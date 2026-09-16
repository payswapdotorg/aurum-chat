// ============================================================================
// attention — the ONLY public surface of the attention module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W051 — Unprompted Unknown Discovery (the frozen module map's L2
// `attention`; spec/work-items/WORK-ITEM-CATALOG.md):
// "Implement goal-gap discovery per ADR-0017: material goal/evidence gaps
//  create candidate unknowns without a user question; candidate unknowns
//  contain impact, urgency, confidence gap and information value; only
//  material unknowns become missions; discovery is evidence-linked and
//  auditable; end-to-end synthetic proof exists."
// Dependencies: W007 (epistemics), W008 (goals), W011 (missions), W013
// (cognition) — this module imports those four contracts (plus the
// observations contract for the evidence gate, the epistemics module's
// own validation precedent); W052 source ranking and W055 quality
// measurement build on THIS contract afterwards.
//
//   getDiscoveryPolicy — the effective materiality policy: the tenant row
//      or the built-in floor, with its source. The policy gate's
//      configuration.
//   setDiscoveryPolicy — set (replace) the tenant's policy. Requires the
//      'attention:administer' authority claim (the notifications module's
//      administer-claim precedent). Thresholds are [0, 1]; missionPolicy
//      'auto' releases material candidates into missions inside
//      discovery, 'manual' requires the explicit materialization call;
//      the budgets discovery-launched missions may spend/reward are
//      policy-owned.
//   discoverGoalGap — THE unprompted discovery (ADR-0017): one goal/evidence
//      gap evaluation with NO user question anywhere in the input. The
//      application validates the goal (readable + ACTIVE + metric-scoped),
//      the cognitive execution link (when the loop produced the
//      evaluation), the evidence basis (readable observations + claims),
//      decides MATERIALLY deterministically (materiality.ts) against the
//      effective policy, and records the candidate unknown with impact,
//      urgency, confidence gap and information value. Under 'auto'
//      mission policy a material candidate materializes in the same call:
//      the epistemic unknown (W007 recordUnknown — question, consequence,
//      subject 'goals.goal', evidence links) and the LearningMission (W011
//      createMission — objective, affected goals, unknown, information
//      value, urgency, confidence gap, policy budgets, acquisition
//      paths), both linked back on the frozen candidate row. Re-registering
//      the same gap is `candidate_conflict` (look at what is recorded —
//      the contradictions module's canonical-pair precedent).
//   materializeCandidate — the explicit policy-gate release: launch the
//      unknown + mission for a MATERIAL candidate (manual policy or any
//      re-drive). Immaterial candidates NEVER materialize (ADR-0017's
//      core invariant); materialized is terminal; the goal must still be
//      active. Application-owned, auditable, retry-safe.
//   getCandidateUnknown / listCandidateUnknowns — the auditable discovery
//      surface: one record deep-linked by id (which goal, which evidence,
//      which decision impact, which policy thresholds, which unknown and
//      mission it became), and the feed filtered by status / goal /
//      urgency / proposer / cognitive execution / missing-knowledge
//      search, urgency-ranked (critical first).
//
// There is deliberately NO operation to update or erase a discovery, to
// re-decide materiality, to un-materialize, or to create a mission from
// an immaterial candidate: identity, evidence links, the materiality
// decision and the audit quartet are frozen after insert (storage-level
// triggers, migrations/001), the only legal mutation is the one-way
// material -> materialized transition the service itself drives, and
// DELETE/TRUNCATE are rejected outright — a discovery record is retained
// evidence of how an unknown came to exist (§24 reconstructability).
// The materiality POLICY is an updatable management control (the actions
// module's authority-policy precedent): its past decisions are
// snapshotted immutably on every candidate, so changing the policy never
// rewrites why a past discovery was material or immaterial.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext
// and is tenant-scoped at the SQL layer; another tenant's candidates and
// policies are indistinguishable from missing ones
// (`candidate_not_found` / built-in default policy), and referenced goals,
// executions and evidence that are not readable in this tenant are
// uniformly `invalid_reference` / `invalid_evidence` — no existence leak.
// ============================================================================

export {
  discoverGoalGap,
  getCandidateUnknown,
  getDiscoveryPolicy,
  listCandidateUnknowns,
  materializeCandidate,
  setDiscoveryPolicy,
} from './service';

export { AttentionError } from './errors';
export type { AttentionErrorCode } from './errors';

// The deterministic materiality gate and the unknown/mission derivations —
// pure, reusable and unit-testable in isolation (the cognition module's
// loop.ts/signals.ts precedent), exported for downstream modules (W052
// knowledge source ranking, W055 quality measurement) and tests.
export {
  BUILT_IN_DISCOVERY_POLICY,
  DEFAULT_INVESTIGATION_BUDGET,
  DEFAULT_MIN_DECISION_IMPACT,
  DEFAULT_MIN_INFORMATION_VALUE,
  DEFAULT_MISSION_POLICY,
  DEFAULT_REWARD_BUDGET,
  GOAL_GAP_SUBJECT_KIND,
  deriveMissionDefinition,
  deriveUnknownRecord,
  evaluateMateriality,
  urgencyRank,
} from './materiality';
export type {
  MaterialityInputs,
  MaterialityThresholds,
} from './materiality';

export {
  ACQUISITION_PATH_KINDS,
  ATTENTION_AUTHORITY_ADMINISTER,
  CANDIDATE_UNKNOWN_STATUSES,
  DEFAULT_LIST_LIMIT,
  GAP_PROPOSER_KINDS,
  GAP_URGENCIES,
  MAX_ACQUISITION_PATHS,
  MAX_BUDGET_AMOUNT,
  MAX_EVIDENCE_CLAIMS,
  MAX_EVIDENCE_OBSERVATIONS,
  MAX_IMPACT_DESCRIPTION_CHARS,
  MAX_LIST_LIMIT,
  MAX_METRIC_NAME_CHARS,
  MAX_MISSING_KNOWLEDGE_CHARS,
  MAX_PROPOSER_LABEL_CHARS,
  MAX_PROPOSER_NOTE_CHARS,
  MAX_SEARCH_CHARS,
  MISSION_POLICY_MODES,
  canAdministerDiscoveryPolicy,
  escapeLike,
  isAcquisitionPathKind,
  isCandidateUnknownStatus,
  isGapProposerKind,
  isGapUrgency,
  isMissionPolicyMode,
  isUuid,
} from './validation';

export type {
  ValidatedDiscoveryInput,
  ValidatedListQuery,
  ValidatedPolicyInput,
} from './validation';

export type {
  AcquisitionPath,
  AcquisitionPathInput,
  CandidateMaterialization,
  CandidateUnknown,
  CandidateUnknownStatus,
  DiscoverGoalGapInput,
  DiscoveryBudget,
  DiscoveryBudgetInput,
  DiscoveryPolicy,
  EffectiveDiscoveryPolicy,
  GapProposer,
  GapProposerInput,
  GapProposerKind,
  GapUrgency,
  GetCandidateUnknownQuery,
  ListCandidateUnknownsQuery,
  MaterialityDecision,
  MaterializeCandidateInput,
  MissionPolicyMode,
  SetDiscoveryPolicyInput,
} from './types';
