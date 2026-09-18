// Public domain types of the simulator module (W056 — Longitudinal Company
// Simulator).
//
// The work item (spec/work-items/WORK-ITEM-CATALOG.md, W056):
// "Implement the synthetic company simulator: employees, teams, CRM/ERP-like
//  systems, messages, projects, suppliers, goals, processes, external events
//  and hidden consequential facts; run month 1/3/6/12/24 scenarios per
//  LONGITUDINAL-BENCHMARK.md; prove repeated work improves source routing,
//  unknown resolution efficiency or recommendation quality; prove no
//  cross-tenant or hidden-ground-truth leakage. Dependencies: W053, W054,
//  W055."
//
// The simulator is a BENCHMARK INSTRUMENT, not business truth: it
// materializes a deterministic synthetic company through the ordinary
// module contracts (people, identity, world, sources, suppliers, goals,
// events, processes), drives the canonical intelligence loop over a
// simulated month timeline (observe → goal-gap discovery → mission →
// acquisition planning → world answers → mission outcome → intervention →
// recorded CompanyModel learning → ground-truth judgments → quality
// snapshot), and keeps the hidden consequential facts in its own
// tenant-scoped tables where the reasoning layer never reads them.
//
// Read models deliberately carry NO hidden values: a MonthReport describes
// observable behavior (which source was chosen, how many steps, which
// records were created); the hidden qualities, drivers and markers are
// readable ONLY through `revealGroundTruth` — the evaluation surface the
// benchmark harness (tests/longitudinal) and the oracle use.

/** Input shape of `materializeCompany`. */
export interface MaterializeCompanyInput {
  /** Integer seed — the same seed materializes the same company. */
  seed: number;
  /** Optional display name; defaults to the design's seeded company name. */
  name?: string | null;
  /**
   * The month the company's life begins at (1..24, default 1): the
   * company has existed through startMonth−1 and the first advanced month
   * presents that month's scenario. This is the COLD-START lever of the
   * longitudinal benchmark — a fresh Aurum instance that starts working
   * on the company at month N faces month N's information environment
   * with zero history and zero learning.
   */
  startMonth?: number | null;
}

/** The public view of one materialized synthetic company (no hidden values). */
export interface SimCompanyView {
  id: string;
  tenantId: string;
  seed: number;
  name: string;
  /** How many months have been advanced (0 = fresh company). */
  currentMonth: number;
  /** The public design surface the driver publishes (names, labels, costs). */
  employees: ReadonlyArray<{
    personId: string;
    fullName: string;
    title: string;
    department: string;
  }>;
  systems: ReadonlyArray<{
    sourceId: string;
    key: string;
    label: string;
    provider: string;
    costMinor: number;
  }>;
  goalId: string;
  processId: string;
  supplierIds: string[];
  projectEntityIds: string[];
  teamEntityIds: string[];
  /** ISO 8601 — when the company was materialized. */
  createdAt: string;
}

/** One executed acquisition step of a month (observable behavior only). */
export interface MonthAcquisition {
  planId: string;
  chosen: { kind: 'person' | 'system'; id: string; label: string };
  action: string;
  outcome: 'answered' | 'unavailable' | 'failed' | null;
  /** The observation the answer recorded ('answered' only). */
  evidenceObservationId: string | null;
}

/** Input shape of `advanceMonth`. */
export interface AdvanceMonthInput {
  companyId: string;
  /**
   * The Aurum instance's learning posture: whether the driver records the
   * month's CompanyModel update (source reliabilities and the intervention
   * prior, each linked to the month's settled outcomes and answer
   * evidence) after the month's work — the EXPERIENCED instance of the
   * longitudinal benchmark. `false` runs the same month with no recorded
   * learning (the cold-start and no-learning control instances).
   */
  learning: boolean;
  /** Whether the oracle records ground-truth quality judgments (default true). */
  judgments?: boolean;
  /** Whether the driver computes the end-of-month quality snapshot (default true). */
  snapshot?: boolean;
}

/** The observable record of one advanced month. */
export interface MonthReport {
  companyId: string;
  tenantId: string;
  month: number;
  topic: string;
  /** The evaluation window the month's records fell in (ISO 8601). */
  windowFrom: string;
  windowTo: string;
  /** The month's observable evidence (all created through contracts). */
  evidence: {
    readingObservationId: string;
    readingClaimId: string;
    messageIds: string[];
    externalEventId: string;
  };
  /** The month's goal-gap discovery run and its promoted candidates. */
  discoveryRunId: string;
  promotedCandidates: ReadonlyArray<{
    candidateId: string;
    gapKey: string;
    missionId: string;
    unknownId: string;
  }>;
  /** The acquisition walk (one entry per planned step, in order). */
  acquisitions: MonthAcquisition[];
  /** The mission the month resolved, if it resolved. */
  resolution: {
    missionId: string;
    achievedConfidence: number;
    missionOutcomeId: string;
  } | null;
  /** The month's capability intervention (recommendation leg). */
  intervention: {
    recommendationOutcomeId: string;
    interventionId: string;
    expected: number;
  } | null;
  /** The recorded CompanyModel update (experienced instances only). */
  learningUpdateId: string | null;
  /** The oracle's ground-truth judgment records. */
  judgmentIds: string[];
  /** The end-of-month quality snapshot. */
  snapshotId: string | null;
  /** Derived observable behavior: how many plans the walk needed. */
  steps: number;
  /** Derived observable behavior: the walk's first chosen candidate. */
  firstChoice: { kind: 'person' | 'system'; id: string; label: string } | null;
}

/** Query shape of `getCompany`. */
export interface GetCompanyQuery {
  companyId: string;
}

/** Query shape of `revealGroundTruth` (evaluation surface). */
export interface RevealGroundTruthQuery {
  companyId: string;
  /** 1..TOTAL_MONTHS. */
  month: number;
}

/** The hidden ground truth of one month — evaluation evidence only. */
export interface GroundTruthReveal {
  companyId: string;
  tenantId: string;
  month: number;
  topic: string;
  /** The leak-detection sentinel (must never appear outside simulator tables). */
  marker: string;
  /** The month's true answer (what a sufficient investigation reveals). */
  answerText: string;
  /** Whether the month's discovered gap is consequential. */
  consequential: boolean;
  /** The minimal hidden quality a first-choice source needs to be 'correct'. */
  firstChoiceCorrectThreshold: number;
  /** Every candidate source's hidden answer quality (ground truth). */
  hiddenQualities: ReadonlyArray<{
    key: 'person' | 'system';
    id: string;
    label: string;
    quality: number;
  }>;
  /** The intervention's hidden realized value and the cold base expectation. */
  intervention: {
    baseExpectation: number;
    realizedValue: number;
    name: string;
  };
}
