// ============================================================================
// simulator — the ONLY public surface of the simulator module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W056 — Longitudinal Company Simulator:
// "Implement the synthetic company simulator: employees, teams, CRM/ERP-like
//  systems, messages, projects, suppliers, goals, processes, external events
//  and hidden consequential facts; run month 1/3/6/12/24 scenarios per
//  LONGITUDINAL-BENCHMARK.md; prove repeated work improves source routing,
//  unknown resolution efficiency or recommendation quality; prove no
//  cross-tenant or hidden-ground-truth leakage. Dependencies: W053, W054,
//  W055."
//
// MODULE PLACEMENT: `simulator` is the module this work order assigns to
// W056 (the work order's "Modules you OWN (create/extend): simulator +
// tests/longitudinal/**"), following the W055 `quality` placement precedent
// — it is the benchmark instrument beside the learning layer, and it owns
// no business concept any other module claims.
//
//   materializeCompany — build ONE seeded synthetic company through the
//      ordinary module contracts: employees (people + employments +
//      verified linked channel identities — the caller's principal must
//      hold the identity attest/link authorities, because linking verified
//      identities is a privileged act), teams and projects (world
//      entities), suppliers (world entities + the supplier registry),
//      CRM/ERP-like systems of record (registered source connections with
//      OPAQUE credential references), the management goal, the seeded
//      order-to-cash event history reconstructed into a real process record
//      (W016) with its bottleneck, and the month 1..24 hidden consequential
//      facts (ground truth) in the simulator's own tenant-scoped tables.
//      The same seed always materializes the same company; a seed is
//      unique per tenant. `startMonth` (1..24, default 1) is the
//      COLD-START lever: the company begins its life at that month, so a
//      fresh instance that starts working at month N faces month N's
//      information environment with zero history and zero learning.
//
//   advanceMonth — ONE month of synthetic company life + the canonical
//      intelligence loop over it, entirely through module contracts:
//      observe (reading observation + claim + employee messages + external
//      event) → attend (unprompted goal-gap discovery, W051) → plan/acquire
//      (mission menu, planner signals composed from the PUBLIC design plus
//      the W053 CompanyModel learned priors — rankCandidates is the only
//      learning channel, so improvement is attributable to recorded
//      CompanyModel updates) → the world answers (the oracle answers from
//      the chosen source's HIDDEN quality — the sanctioned evidence
//      channel) → the mission resolves (outcome settled on its final
//      evidence) → intervene (W054 recordIntervention → settle →
//      realizeIntervention, the recorded intervention prior) → learn
//      (experienced instances: ONE recorded CompanyModel update teaching
//      every queried source's reliability and the intervention
//      effectiveness, linked to the month's settled outcomes and answer
//      evidence) → judge (the oracle records ground-truth quality
//      judgments, W055) → measure (the end-of-month quality snapshot, all
//      nine metric families). The month's observable behavior is returned
//      as the MonthReport and recorded append-only.
//
//   getCompany — the public company view (identities and labels only; NO
//      hidden values).
//   revealGroundTruth — the EVALUATION surface: the hidden consequential
//      facts of one month (marker, true answer, consequentiality, hidden
//      source qualities, intervention truth). This exists for the
//      benchmark harness and verification; the driver that runs the
//      intelligence loop never consumes it (the loop's planner signals are
//      a pure function of the public design and the CompanyModel ranking).
//   listMonthReports — the recorded month history of one company.
//
// The frozen reference company design (structure, authorities, costs,
// hidden qualities, thresholds) is a fixed, hand-tuned template so the
// benchmark's exact arithmetic holds (the cold start walks exactly 7
// investigation steps; the experienced instance exactly 1 from month 2;
// the intervention calibration error 1.5 → 0.45 → 0.15); the seed varies
// every identity-bearing surface. See world.ts for the constants.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; another tenant's company — including
// its hidden facts — is indistinguishable from a missing one
// (`company_not_found` — no existence leak). Cross-tenant and
// hidden-ground-truth leakage are asserted by the longitudinal benchmark
// (tests/longitudinal) and by this module's own integration tests.
// ============================================================================

export {
  advanceMonth,
  getCompany,
  listMonthReports,
  materializeCompany,
  revealGroundTruth,
} from './service';

export { SimulatorError } from './errors';
export type { SimulatorErrorCode } from './errors';

// The pure synthetic-company engine — the single deterministic definition of
// the seeded world (world.ts), reusable by the benchmark harness and
// unit-testable in isolation (the discovery.ts / ranking.ts / metrics.ts
// precedent). composePlannerSignals is the benchmark's learned-signal
// composition; interventionExpectation is the recommendation-quality leg's
// expectation math; nextPriorConfidence is the recorded-assertion
// confidence schedule.
export {
  BENCHMARK_MONTHS,
  BOTTLENECK_THRESHOLD_SECONDS,
  MATERIALITY_POLICY,
  MISSION_BUDGET,
  NEUTRAL_SIGNAL,
  READING_DRIVER_CONFIDENCE,
  READING_ENVELOPE,
  REWARD_BUDGET,
  SOURCE_RANK_POLICY,
  TOTAL_MONTHS,
  composePlannerSignals,
  deriveCompanyDesign,
  interventionExpectation,
  mulberry32,
  nextPriorConfidence,
} from './world';
export type {
  CompanyDesign,
  EmployeeDesign,
  MonthScenario,
  SystemDesign,
} from './world';

export {
  assertSimulatorTenantContext,
  validateAdvanceInput,
  validateCompanyQuery,
  validateMaterializeInput,
  validateRevealQuery,
} from './validation';

export type {
  AdvanceMonthInput,
  GetCompanyQuery,
  GroundTruthReveal,
  MaterializeCompanyInput,
  MonthAcquisition,
  MonthReport,
  RevealGroundTruthQuery,
  SimCompanyView,
} from './types';
