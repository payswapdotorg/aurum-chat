// Public domain types of the automation module (W018 — Automation
// Opportunities).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W018):
// "Represent automation candidates with process evidence, frequency, cost,
//  error rate, candidate solution types, expected ROI and outcome
//  measurement."
//
// ARCHITECTURE.md §13 (frozen) defines the object this module owns:
// "AutomationOpportunity connects observed process inefficiency to solution
//  options: train employee; reassign work; hire human capability; recruit
//  agent; recruit agent team; install marketplace extension; build new
//  extension; outsource." — and the chain it completes the head of:
// `process → capability → gap → acquisition option → authorization →
//  deployment → outcome`. This module owns the links from observed process
//  evidence up to (and including) the acquisition option plus the outcome
//  measurement that will judge it; authorization, deployment and the executed
//  intervention belong to actions (W009), agents (W021+) and extensions
//  (W025+).
//
// An automation candidate is UNDERSTANDING, not reality (ARCHITECTURE.md §4:
// "Reality is immutable; understanding is mutable"). The immutable facts are
// the process findings (W016) — themselves evidence-cited reconstructions of
// immutable events (W003) and observations (W004). The candidate derived
// from them is versioned understanding in the goals/processes/capabilities
// discipline: an identity (uuid + tenant-unique IMMUTABLE name) plus an
// append-only chain of full-snapshot `automation_opportunity_versions` —
// every revision appends the next version and never rewrites history, so
// what Aurum believed about an automation candidate at any time stays
// reconstructable (§24 decision evidence).
//
// Each version carries the seven attributes the work item names:
//
//   PROCESS EVIDENCE — the process (W016) and the exact findings cited,
//     validated readable through the processes contract at write time (the
//     sanctioned `processes → automation` dependency, mirroring how learning
//     validates its originating execution through the cognition contract).
//     The processId is immutable identity content: a candidate about one
//     process cannot become a candidate about another (a different finding
//     set is a different candidate — revise the evidence list instead).
//     The process NAME is snapshotted on every version for self-containment
//     (it is the processes module's own immutable graph key, so it cannot
//     go stale). An optional capability (W017) reference names the
//     capability whose gap this acquisition option would close — validated
//     through the capabilities contract when present (the `capabilities →
//     automation` half of `processes + capabilities → automation`, lock 19).
//
//   FREQUENCY — how often the inefficient work occurs: an occurrence count
//     per period (the shared `period` also qualifies cost and expected
//     savings, so all per-period figures move together).
//
//   COST — the current cost of the work as-is, in integer minor units of an
//     ISO 4217 currency (IMPLEMENTATION-STACK §8: "Money/quantities: integer
//     minor units + ISO currency code").
//
//   ERROR RATE — the share of occurrences that end in error, in [0, 1]
//     (derivable from W016 error findings: errorCount / occurrenceCount).
//
//   CANDIDATE SOLUTION TYPES — the eight acquisition options ARCHITECTURE
//     §13 names verbatim (see `AutomationSolutionType`); at least one must
//     be a candidate. Agent recruitment (W022) reads this list through the
//     automation contract when comparing alternatives.
//
//   EXPECTED ROI — the committed prediction: expected savings per period
//     (minor units), one-time expected investment (minor units) and an
//     assessment horizon in periods. The DERIVED summary (net benefit over
//     the horizon, ROI ratio, payback) is a pure function of these
//     figures (roi.ts `expectedRoiOf`) and is never persisted (lock 10 —
//     derived intelligence, never authoritative truth; the capabilities
//     module's gap-analysis precedent).
//
//   OUTCOME MEASUREMENT — how the realized outcome will be judged: the
//     measurement plan (metric name + unit, direction, baseline, target) on
//     every version, plus an append-only observation series
//     (`automation_measurements`) of observed metric values recorded while
//     the opportunity is ACCEPTED — the ADR-0019 chain this module must
//     represent for automation interventions (baseline → expected →
//     observed; W054 capability outcome learning builds the realized-value
//     learning on top). The latest-observed summary and the deterministic
//     target-met verdict are derived on read (roi.ts), never persisted.
//
// LIFECYCLE (versioned status content, surgical transitions — the
// capabilities module's discipline): 'candidate' (minted at version 1) is
// the only status that accepts content revisions — accepting an opportunity
// commits its prediction (rewriting expected ROI after acceptance would
// destroy expected-versus-realized honesty, the learning module's frozen
// prediction argument); 'accepted' (management decided to pursue — the hand
// off to acquisition/authorization) accepts outcome measurements and
// dismissal; 'dismissed' (management rejected or abandoned the pursuit —
// retained, never erased: ADR-0019 "failed interventions are retained as
// negative evidence") accepts nothing but a reopening. Change kinds are
// service-minted: created / revised / accepted / dismissed / reopened.
//
// Provider neutrality (lock 16): audit actors and measurement evidence are
// provider-neutral references — kind + opaque id and/or human label — and
// the solution types are plain domain vocabulary. No provider SDKs, no
// channel/source objects, no cross-module foreign keys: the process,
// finding and capability references are validated uuid forward references
// owned by their modules (the missions module's affected-goals precedent,
// with the write-time readability check learning applies to its one
// validated link).

/** The eight solution options ARCHITECTURE.md §13 names verbatim (TEXT + CHECK in storage). */
export type AutomationSolutionType =
  | 'train_employee'
  | 'reassign_work'
  | 'hire_human'
  | 'recruit_agent'
  | 'recruit_agent_team'
  | 'install_extension'
  | 'build_extension'
  | 'outsource';

/** The period frequency, cost and expected savings are expressed per (TEXT + CHECK in storage). */
export type AutomationPeriod = 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * Lifecycle of an automation candidate (versioned content, surgical
 * transitions):
 *  * 'candidate' — identified from process evidence; the only status that
 *    accepts content revisions (version 1 is minted here);
 *  * 'accepted'  — management decided to pursue the acquisition; the
 *    committed prediction is frozen and outcome measurements may be
 *    recorded;
 *  * 'dismissed' — management rejected or abandoned the pursuit; retained
 *    as evidence, accepts nothing but a reopening.
 */
export type AutomationStatus = 'candidate' | 'accepted' | 'dismissed';

/**
 * What kind of change one version represents — service-minted, never
 * caller-supplied (the goals module's discipline):
 *  * 'created'   — version 1 (the candidate was first represented);
 *  * 'revised'   — content change while a candidate;
 *  * 'accepted'  — surgical transition candidate → accepted;
 *  * 'dismissed' — surgical transition candidate|accepted → dismissed;
 *  * 'reopened'  — surgical transition dismissed → candidate.
 */
export type AutomationChangeKind =
  | 'created'
  | 'revised'
  | 'accepted'
  | 'dismissed'
  | 'reopened';

/**
 * Kinds of parties that can make an automation change (the audit actor).
 * The events envelope's actor vocabulary minus `source` — the same five
 * kinds the processes and capabilities modules use.
 */
export type AutomationPartyKind = 'person' | 'team' | 'agent' | 'system' | 'external';

/**
 * Which way the outcome metric moves when things go well (the learning
 * module's direction vocabulary):
 *  * 'at_least' — higher is better (realized >= target is a success);
 *  * 'at_most'  — lower is better (realized <= target is a success).
 */
export type OutcomeDirection = 'at_least' | 'at_most';

/**
 * A provider-neutral party reference (lock 16): an opaque uuid `id` owned
 * by the respective module and/or a human-readable `label`. At least one
 * must be present — whoever registers, revises or measures must be
 * traceable (the missions actor rule).
 */
export interface AutomationParty {
  kind: AutomationPartyKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `AutomationParty`. */
export interface AutomationPartyInput {
  kind: AutomationPartyKind;
  id?: string | null;
  label?: string | null;
}

/** The party that made one automation change (`AutomationParty`; separate name for readers). */
export type AutomationActor = AutomationParty;

/**
 * One opaque evidence reference on a measurement — where the observed value
 * came from. Kinds cover the canonical evidence surfaces (W004 observations,
 * W003 events, documents, reports, business systems, metric streams); the
 * reference carries an opaque uuid `id` and/or a human label (at least one —
 * evidence must be traceable). Deliberately unvalidated beyond shape: the
 * owning modules stay non-dependencies of this one (the learning module's
 * measurement-evidence precedent).
 */
export type AutomationEvidenceKind =
  | 'observation'
  | 'event'
  | 'document'
  | 'report'
  | 'system'
  | 'metric';

/** One evidence reference of a measurement. */
export interface AutomationEvidenceRef {
  kind: AutomationEvidenceKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `AutomationEvidenceRef`. */
export interface AutomationEvidenceRefInput {
  kind: AutomationEvidenceKind;
  id?: string | null;
  label?: string | null;
}

// ---------------------------------------------------------------------------
// Expected ROI (the derived summary — never persisted)
// ---------------------------------------------------------------------------

/**
 * The deterministic expected-ROI summary of one version's committed
 * figures — computed by roi.ts `expectedRoiOf` on every read and never
 * persisted (lock 10; the capabilities module's gap-analysis precedent).
 * All money figures are minor units of the version's currency.
 */
export interface ExpectedRoi {
  currency: string;
  period: AutomationPeriod;
  /** Expected savings per period (the committed input). */
  expectedSavingsMinor: number;
  /** One-time expected investment (the committed input). */
  expectedInvestmentMinor: number;
  /** Assessment horizon in periods (the committed input). */
  horizonPeriods: number;
  /** savings × horizon − investment (minor units). */
  expectedNetBenefitMinor: number;
  /**
   * net benefit / investment. Null when the expected investment is 0 — an
   * ROI ratio is undefined without an outlay.
   */
  expectedRoiRatio: number | null;
  /**
   * investment / savings, in periods. 0 when there is no outlay to recover;
   * null when the expected savings are 0 (the investment never pays back).
   */
  expectedPaybackPeriods: number | null;
}

// ---------------------------------------------------------------------------
// Outcome measurement
// ---------------------------------------------------------------------------

/**
 * The measurement plan every version carries — how the realized outcome of
 * this candidate will be judged (ADR-0019's baseline and expected outcome,
 * represented for automation interventions): which metric is watched, in
 * which unit, which way is good, the value before any intervention and the
 * committed post-intervention target.
 */
export interface OutcomePlan {
  metricName: string;
  metricUnit: string;
  direction: OutcomeDirection;
  baseline: number;
  target: number;
}

/** Input shape of `OutcomePlan`. */
export interface OutcomePlanInput {
  metricName: string;
  metricUnit: string;
  direction: OutcomeDirection;
  baseline: number;
  target: number;
}

/**
 * The patch shape of a measurement plan inside a revision (undefined
 * fields carry over — a partial re-estimate while the opportunity is still
 * a candidate).
 */
export interface OutcomePlanPatch {
  metricName?: string;
  metricUnit?: string;
  direction?: OutcomeDirection;
  baseline?: number;
  target?: number;
}

/** One append-only observed value of an opportunity's outcome metric. */
export interface AutomationMeasurement {
  id: string;
  tenantId: string;
  opportunityId: string;
  /** The observed metric value (in the plan's unit). */
  value: number;
  note: string | null;
  evidence: AutomationEvidenceRef[];
  actor: AutomationActor;
  /** The authenticated TenantContext principal that recorded the value. */
  recordedByPrincipal: string;
  /** ISO 8601 — when Aurum committed this observation (service clock). */
  recordedAt: string;
}

/**
 * The derived outcome-measurement summary of the current view: how much has
 * been observed, the latest observed value, and — once anything has been —
 * the deterministic distance-to-target verdict (roi.ts `outcomeTargetMet`).
 */
export interface OutcomeMeasurementSummary {
  measurementCount: number;
  latest: AutomationMeasurement | null;
  /** Null while nothing has been measured. */
  progress: {
    baseline: number;
    target: number;
    latest: number;
    direction: OutcomeDirection;
    /** latest meets the target under the plan's direction. */
    targetMet: boolean;
  } | null;
}

// ---------------------------------------------------------------------------
// Registration / revision
// ---------------------------------------------------------------------------

/** Input shape of `registerOpportunity` (status is minted 'candidate'). */
export interface RegisterAutomationOpportunityInput {
  /** Tenant-unique graph key; immutable after registration (1..200 chars). */
  name: string;
  /** The process (W016) whose findings justify this candidate — validated readable at write time. */
  processId: string;
  /**
   * The process findings (W016) cited as evidence (1..32, deduplicated) —
   * each validated readable and belonging to `processId` at write time.
   */
  findingIds: string[];
  /**
   * Optional capability (W017) whose gap this acquisition option would
   * close — validated readable through the capabilities contract when
   * present (`processes + capabilities → automation`).
   */
  capabilityId?: string | null;
  /** Optional human description (≤ 2000 chars). */
  description?: string | null;
  /** How often the inefficient work occurs per `period` (integer ≥ 1). */
  frequencyCount: number;
  period: AutomationPeriod;
  /** ISO 4217 currency code of all money figures of this opportunity. */
  currency: string;
  /** Current cost of the work as-is, per period (integer minor units ≥ 0). */
  currentCostMinor: number;
  /** Share of occurrences that end in error, in [0, 1]. */
  errorRate: number;
  /** The candidate solution types (1..8, deduplicated). */
  solutionTypes: AutomationSolutionType[];
  /** Expected savings per period (integer minor units ≥ 0). */
  expectedSavingsMinor: number;
  /** One-time expected investment (integer minor units ≥ 0). */
  expectedInvestmentMinor: number;
  /** Assessment horizon in periods (integer ≥ 1). */
  roiHorizonPeriods: number;
  /** How the realized outcome will be judged. */
  outcome: OutcomePlanInput;
  /** Who registered the candidate (audit trail). */
  actor: AutomationPartyInput;
  /** Why — optional, recorded on version 1. */
  rationale?: string | null;
}

/** Patch shape of `reviseOpportunity` (undefined = carry over, null = clear). */
export interface ReviseAutomationOpportunityInput {
  opportunityId: string;
  capabilityId?: string | null;
  description?: string | null;
  /** Replaces the cited evidence list wholesale (validated again). */
  findingIds?: string[];
  frequencyCount?: number;
  period?: AutomationPeriod;
  currency?: string;
  currentCostMinor?: number;
  errorRate?: number;
  solutionTypes?: AutomationSolutionType[];
  expectedSavingsMinor?: number;
  expectedInvestmentMinor?: number;
  roiHorizonPeriods?: number;
  /** Partial measurement-plan re-estimate (undefined fields carry over). */
  outcome?: OutcomePlanPatch;
  /** Lifecycle change; must be the only change in its revision (surgical). */
  status?: AutomationStatus;
  /**
   * Optimistic concurrency: when set, the revision must build on this
   * version number. A mismatch fails with `opportunity_conflict` — never a
   * silent overwrite of expectations.
   */
  expectedVersion?: number;
  actor: AutomationPartyInput;
  rationale?: string | null;
}

/** Input shape of `recordMeasurement` (accepted opportunities only). */
export interface RecordAutomationMeasurementInput {
  opportunityId: string;
  /** The observed metric value. */
  value: number;
  note?: string | null;
  /** Optional opaque evidence references (where the value came from). */
  evidence?: AutomationEvidenceRefInput[];
  actor: AutomationPartyInput;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * The current view of an automation opportunity: identity + the current
 * version's full content + the derived expected-ROI summary + the derived
 * outcome-measurement summary + audit summary. The version history lives on
 * `getOpportunityVersion` / `listOpportunityVersions`.
 */
export interface AutomationOpportunity {
  id: string;
  tenantId: string;
  /** Immutable graph key, unique per tenant. */
  name: string;
  /** Current version number. */
  version: number;
  status: AutomationStatus;
  /** The process whose findings justify this candidate (name snapshotted). */
  process: { id: string; name: string };
  /** The process findings cited as evidence. */
  findingIds: string[];
  /** The capability whose gap this acquisition option would close, if named. */
  capability: { id: string; name: string } | null;
  description: string | null;
  frequencyCount: number;
  period: AutomationPeriod;
  currency: string;
  currentCostMinor: number;
  errorRate: number;
  solutionTypes: AutomationSolutionType[];
  expectedSavingsMinor: number;
  expectedInvestmentMinor: number;
  roiHorizonPeriods: number;
  /** Derived from the current version's committed figures (never persisted). */
  expectedRoi: ExpectedRoi;
  /** The current measurement plan. */
  outcome: OutcomePlan;
  /** Derived from the append-only measurement series (never persisted). */
  outcomeMeasurements: OutcomeMeasurementSummary;
  /** ISO 8601 — when the identity was created (version 1 commit). */
  createdAt: string;
  /** ISO 8601 — when the current version was committed. */
  updatedAt: string;
  /** Audit summary of the change that produced the current version. */
  lastChange: AutomationChangeSummary;
}

/** Audit summary shared by the current view and the change kinds. */
export interface AutomationChangeSummary {
  kind: AutomationChangeKind;
  actor: AutomationActor;
  changedByPrincipal: string;
  rationale: string | null;
  recordedAt: string;
}

/** One append-only version of an automation opportunity — the audit record (self-contained). */
export interface AutomationOpportunityVersion {
  /** Version-row id (distinct from the opportunity identity). */
  id: string;
  tenantId: string;
  opportunityId: string;
  /** 1-based, strictly increasing per opportunity; service-minted. */
  version: number;
  changeKind: AutomationChangeKind;
  /** Always the identity's immutable name (snapshotted for self-containment). */
  name: string;
  status: AutomationStatus;
  process: { id: string; name: string };
  findingIds: string[];
  capability: { id: string; name: string } | null;
  description: string | null;
  frequencyCount: number;
  period: AutomationPeriod;
  currency: string;
  currentCostMinor: number;
  errorRate: number;
  solutionTypes: AutomationSolutionType[];
  expectedSavingsMinor: number;
  expectedInvestmentMinor: number;
  roiHorizonPeriods: number;
  outcome: OutcomePlan;
  actor: AutomationActor;
  changedByPrincipal: string;
  rationale: string | null;
  /** ISO 8601 — when Aurum committed this version (service clock). */
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Query shape of `getOpportunity`. */
export interface GetAutomationOpportunityQuery {
  opportunityId: string;
}

/** Query shape of `listOpportunities` (over CURRENT versions only). */
export interface ListAutomationOpportunitiesQuery {
  /** Exact name match. */
  name?: string;
  /** Case-insensitive substring on the name. */
  search?: string;
  status?: AutomationStatus;
  /** Only candidates citing this process. */
  processId?: string;
  /** Only candidates where this solution type is an option. */
  solutionType?: AutomationSolutionType;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getOpportunityVersion`. */
export interface GetAutomationOpportunityVersionQuery {
  opportunityId: string;
  /** 1-based version number. */
  version: number;
}

/** Query shape of `listOpportunityVersions`. */
export interface ListAutomationOpportunityVersionsQuery {
  opportunityId: string;
}

/** Query shape of `listMeasurements` (the observation series, ascending). */
export interface ListAutomationMeasurementsQuery {
  opportunityId: string;
}

/** Query shape of `getMeasurement`. */
export interface GetAutomationMeasurementQuery {
  measurementId: string;
}
