// Public domain types of the contributions module (W042 — Knowledge
// Contributions).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W042):
// "Record employee knowledge contributions, validation, knowledge gain,
//  mission impact and investigation-cost avoidance."
//
// ARCHITECTURE.md §8 (frozen): "KnowledgeContribution records what
// information an employee supplied, the associated evidence, validation
// outcome, knowledge gain, goal impact and investigation cost avoided.
// RewardPolicy converts contribution value into configured rewards."
// And §7 (the loop this record lives in): "Aurum may ask an employee
// targeted questions when policy permits, record the resulting
// contribution, assess evidence quality, update the mission, and reward
// useful contributions." Lock 9: employees are first-class knowledge
// sources whose useful contributions may be rewarded under explicit
// policy — the records this module owns are what "useful" is judged from
// (W043 Rewards consumes them downstream).
//
// A contribution is ANCHORED to the knowledge-acquisition plan (W012)
// that asked the employee the question and to that plan's answered
// outcome: the contributing employee, the mission served, the targeted
// question, the answer's evidence observation and the investigation
// budget currency are all DERIVED from the validated plan at record time
// and frozen on the definition row. This is what makes the record
// auditable end-to-end (lock 41 / §24): the question came from a
// mission-driven planner decision, the answer entered as an immutable
// observation, and the contribution is the bridge between them. It is NOT
// a belief (epistemics W007) and NOT evidence (observations W004): it is
// the organizational record of WHO SUPPLIED WHAT and WHAT IT WAS WORTH.
//
// Provider neutrality (lock 16): the contributor, the affected goals, the
// validation evidence refs and the learning outcome are opaque references
// — uuid ids and/or human labels owned by their respective modules
// (people W002, goals W008, observations W004, learning W040). No
// cross-module foreign keys, no contract imports for them (the missions
// module's affected-goals precedent). The TWO validated cross-module
// links are the acquisition plan and the optional learning outcome —
// both checked readable through their contracts at write time.
//
// Storage discipline (the W040/W012 precedent): definitions, validations
// and impacts are append-only — UPDATE/DELETE/TRUNCATE are rejected by
// PostgreSQL triggers. Validations form a re-appending series (lock 12:
// contradictory evidence is retained; a later validation never rewrites
// an earlier one). The measured impact record is one per contribution,
// first write wins, frozen forever — exactly like a W040 realization.

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * Derived lifecycle of a contribution, DERIVED from the validation series
 * and the impact record (never stored on the definition row):
 *  * 'pending'      — recorded, no validation yet (§7: record → assess);
 *  * 'validated'    — latest validation outcome is 'validated', impact not
 *                     yet recorded;
 *  * 'contradicted' — latest validation outcome is 'contradicted';
 *  * 'rejected'     — latest validation outcome is 'rejected';
 *  * 'measured'     — the impact record exists (knowledge gain + mission
 *                     impact + cost avoidance frozen). The assessment
 *                     terminal state of this module; validations may still
 *                     be appended (contradiction retention, lock 12).
 */
export type ContributionStatus =
  | 'pending'
  | 'validated'
  | 'contradicted'
  | 'rejected'
  | 'measured';

/**
 * The outcome of one evidence-quality assessment (§7 "assess evidence
 * quality"; §8 "validation outcome"):
 *  * 'validated'    — the evidence supports the supplied information;
 *  * 'contradicted' — other evidence contradicts it (retained, lock 12);
 *  * 'rejected'     — the evidence does not support it (quality failed).
 */
export type ContributionValidationOutcome = 'validated' | 'contradicted' | 'rejected';

/**
 * What the contribution did to the mission it served (§8 "goal impact" /
 * the catalog's "mission impact"):
 *  * 'advanced'   — material progress toward completion;
 *  * 'resolved'   — the mission met its completion criteria;
 *  * 'no_effect'  — no material mission change.
 */
export type MissionImpactKind = 'advanced' | 'resolved' | 'no_effect';

/** Kinds of parties that can record, validate or measure (the missions vocabulary). */
export type ContributionPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/** Where validation evidence came from (opaque reference kinds). */
export type ContributionEvidenceKind =
  | 'observation'
  | 'event'
  | 'document'
  | 'report'
  | 'system'
  | 'metric';

/**
 * One avoided investigation path's action — the acquisition action
 * (W012 vocabulary) that no longer needs to run because the employee
 * answered. Mirrors knowledge-acquisition's `ACQUISITION_ACTION_KINDS`
 * by construction (validation.ts derives both type and guard from that
 * contract constant, so the vocabularies cannot drift).
 */
export type AvoidedPathAction =
  | 'ask-person'
  | 'query-system'
  | 'retrieve-document'
  | 'fetch-external'
  | 'commission-agent'
  | 'run-analysis';

// ---------------------------------------------------------------------------
// Parties, evidence refs, goal refs, avoided paths
// ---------------------------------------------------------------------------

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — the party making a contribution change must be
 * traceable (the missions actor rule).
 */
export interface ContributionParty {
  kind: ContributionPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `ContributionParty`. */
export interface ContributionPartyInput {
  kind: ContributionPartyKind;
  id?: string | null;
  label?: string | null;
}

/** The party that made one contribution change (`ContributionParty`). */
export type ContributionActor = ContributionParty;

/**
 * One opaque evidence reference supporting a validation — where the
 * assessment's evidence came from. The reference carries an opaque uuid
 * `id` and/or a human label (at least one — evidence must be traceable).
 * Deliberately unvalidated beyond shape: no sanctioned dependency owns
 * these references for the contributions module.
 */
export interface ContributionEvidenceRef {
  kind: ContributionEvidenceKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `ContributionEvidenceRef`. */
export interface ContributionEvidenceRefInput {
  kind: ContributionEvidenceKind;
  id?: string | null;
  label?: string | null;
}

/**
 * One affected-goal reference (§8 "goal impact"): an opaque uuid forward
 * reference to a goals module (W008) record plus an optional human label
 * (the missions module's precedent). The mission the contribution served
 * is already on the definition (derived from the plan); affected goals
 * record WHICH goals felt the impact.
 */
export interface ContributionGoalRef {
  goalId: string;
  label?: string | null;
}

/** Input shape of `ContributionGoalRef`. */
export interface ContributionGoalRefInput {
  goalId: string;
  label?: string | null;
}

/**
 * One avoided investigation path: the acquisition action that no longer
 * needs to run, its human label and its estimated cost (integer minor
 * units of the contribution's budget currency). Indicative itemization of
 * the impact's `avoidedCost` — no arithmetic coupling is enforced (the
 * total is the authoritative figure).
 */
export interface AvoidedPath {
  action: AvoidedPathAction;
  label: string;
  estimatedCost: number;
}

/** Input shape of `AvoidedPath`. */
export interface AvoidedPathInput {
  action: AvoidedPathAction;
  label: string;
  estimatedCost: number;
}

// ---------------------------------------------------------------------------
// recordContribution
// ---------------------------------------------------------------------------

/**
 * Input shape of `recordContribution`. Only the acquisition plan id (the
 * anchor) and the human summary are essential: the contributing employee,
 * the mission, the targeted question, the answer's evidence observation
 * and the budget currency are DERIVED from the validated plan and minted
 * by the service — a caller can never forge them.
 */
export interface RecordContributionInput {
  /** The answered ask-person acquisition plan (W012) this contribution answers. */
  planId: string;
  /** What the employee supplied, summarized (bounded human text). */
  summary: string;
  /** Optional context recorded on the definition. */
  note?: string | null;
  /** Who/what records the contribution (audit trail). */
  actor: ContributionPartyInput;
}

// ---------------------------------------------------------------------------
// validateContribution
// ---------------------------------------------------------------------------

/** Input shape of `validateContribution` (appends to the validation series). */
export interface ValidateContributionInput {
  contributionId: string;
  /** The evidence-quality assessment outcome. */
  outcome: ContributionValidationOutcome;
  /** The assessed evidence quality, a comparable score in [0, 1]. */
  quality: number;
  /** Optional opaque evidence references supporting the assessment. */
  evidence?: ContributionEvidenceRefInput[];
  /** Optional context. */
  note?: string | null;
  /** Who/what validates (audit trail). */
  actor: ContributionPartyInput;
}

// ---------------------------------------------------------------------------
// recordImpact
// ---------------------------------------------------------------------------

/**
 * Input shape of `recordImpact` (the one measured impact record per
 * contribution; first write wins). The knowledge gain is NOT
 * caller-supplied: the service freezes `confidenceAfter −
 * confidenceBefore` (validation.ts `assessKnowledgeGain` is the single
 * deterministic definition).
 */
export interface RecordImpactInput {
  contributionId: string;
  /** What the contribution did to the mission it served. */
  missionImpact: MissionImpactKind;
  /** The mission's confidence before the contribution was applied, [0, 1]. */
  confidenceBefore: number;
  /** The mission's confidence after the contribution was applied, [0, 1]. */
  confidenceAfter: number;
  /** Defaults to `[]` (opaque forward references to goals W008 records). */
  affectedGoals?: ContributionGoalRefInput[];
  /**
   * The investigation cost avoided: integer MINOR UNITS of the
   * contribution's budget currency (denominated by the plan's mission
   * investigation budget — the service guarantees the pairing).
   */
  avoidedCost: number;
  /** Defaults to `[]` (the acquisition actions that no longer need to run). */
  avoidedPaths?: AvoidedPathInput[];
  /**
   * The learning-module outcome (W040) that measures the mission's
   * improvement — validated readable through the learning contract at
   * write time (the sanctioned W040 → W042 dependency). Optional.
   */
  outcomeId?: string | null;
  /** Optional context recorded on the frozen record. */
  note?: string | null;
  /** Who/what records the impact (audit trail). */
  actor: ContributionPartyInput;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** One append-only evidence-quality assessment (the validation series). */
export interface ContributionValidation {
  id: string;
  tenantId: string;
  contributionId: string;
  outcome: ContributionValidationOutcome;
  quality: number;
  evidence: ContributionEvidenceRef[];
  note: string | null;
  actor: ContributionActor;
  /** The authenticated TenantContext principal that committed the assessment. */
  recordedByPrincipal: string;
  /** ISO 8601 — when Aurum committed this assessment (service clock). */
  recordedAt: string;
}

/**
 * The ONE frozen measured-impact record of a contribution: knowledge gain,
 * mission impact, affected goals, investigation cost avoided and the
 * optional learning outcome link. First write wins; never recomputed.
 */
export interface ContributionImpact {
  missionImpact: MissionImpactKind;
  confidenceBefore: number;
  confidenceAfter: number;
  /** Frozen at record time: confidenceAfter − confidenceBefore. */
  knowledgeGain: number;
  affectedGoals: ContributionGoalRef[];
  /** Integer minor units of the contribution's budget currency. */
  avoidedCost: number;
  avoidedPaths: AvoidedPath[];
  /** The learning-module outcome that measures the mission's improvement, if linked. */
  outcomeId: string | null;
  note: string | null;
  actor: ContributionActor;
  /** The authenticated TenantContext principal that committed the record. */
  recordedByPrincipal: string;
  /** ISO 8601 — when Aurum committed this record (service clock). */
  recordedAt: string;
}

/**
 * The contributing employee: an opaque people-module (W002) person
 * forward reference DERIVED from the acquisition plan's chosen candidate —
 * a uuid `id` (the planner only selects resolvable persons) plus the
 * candidate's human label.
 */
export interface ContributionContributor {
  id: string;
  label: string | null;
}

/**
 * The current view of a knowledge contribution: the immutable definition
 * (anchor + derived fields + summary), the derived lifecycle status, the
 * latest validation (the current assessment), the validation-series
 * summary and the frozen measured impact, if any.
 */
export interface Contribution {
  id: string;
  tenantId: string;
  /** The answered ask-person acquisition plan (W012) this contribution answers. */
  planId: string;
  /** The mission the acquisition served (derived from the plan). */
  missionId: string;
  /** The observation (W004) carrying the supplied information (derived from the plan's answered outcome). */
  evidenceObservationId: string;
  /** The employee who supplied the knowledge (derived from the plan's chosen person). */
  contributor: ContributionContributor;
  /** The targeted question the employee answered (derived from the plan). */
  question: string;
  /** The investigation-budget currency of the mission (derived from the plan). */
  budgetCurrency: string;
  /** What the employee supplied, summarized. */
  summary: string;
  note: string | null;
  /** Derived: see `ContributionStatus`. */
  status: ContributionStatus;
  /** The LATEST validation (current evidence-quality assessment); null while pending. */
  validation: ContributionValidation | null;
  /** How many validations the series holds. */
  validationCount: number;
  /** The frozen measured impact; null until recorded. */
  impact: ContributionImpact | null;
  /** The authenticated TenantContext principal that recorded the contribution. */
  recordedByPrincipal: string;
  /** ISO 8601 — when Aurum committed the definition (service clock). */
  recordedAt: string;
  /** Who recorded the contribution (audit trail). */
  actor: ContributionActor;
}

/** Query shape of `listContributions` (over the derived current views). */
export interface ListContributionsQuery {
  /** Contributions serving one mission. */
  missionId?: string;
  /** Contributions from one contributing employee. */
  personId?: string;
  status?: ContributionStatus;
  /** Only meaningful for measured contributions. */
  missionImpact?: MissionImpactKind;
  /** Case-insensitive substring on the summary. */
  search?: string;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `listValidations`. */
export interface ListValidationsQuery {
  contributionId: string;
}

/**
 * One currency bucket of `summarizeContributions` — the investigation
 * cost avoided is money (integer minor units), so it is summed ONLY per
 * ISO currency (the W042/W012 money convention; no cross-currency
 * arithmetic exists).
 */
export interface CostAvoidedBucket {
  currency: string;
  /** How many measured contributions carry this currency. */
  contributions: number;
  /** Sum of avoided costs over those contributions (minor units). */
  avoidedCost: number;
}

/**
 * The contribution-value rollup W043 Rewards (explicit reward policies
 * over "valuable knowledge contributions") and W052 knowledge source
 * ranking (the `priorContributionValue` signal) read. Status counts
 * partition contributions by the derived ladder; the impact fields cover
 * the measured set; `totalKnowledgeGain` is the arithmetic sum of frozen
 * confidence deltas (unitless, so summation is honest).
 */
export interface ContributionSummary {
  total: number;
  pending: number;
  validated: number;
  contradicted: number;
  rejected: number;
  measured: number;
  missionsAdvanced: number;
  missionsResolved: number;
  noEffect: number;
  totalKnowledgeGain: number;
  /** One bucket per currency present among measured contributions, sorted. */
  costAvoidedByCurrency: CostAvoidedBucket[];
}

/** Query shape of `summarizeContributions`. */
export interface SummarizeContributionsQuery {
  /** Narrow the rollup to one contributing employee; omitted = everyone. */
  personId?: string;
}
