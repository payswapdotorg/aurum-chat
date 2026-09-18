// ============================================================================
// automation — the ONLY public surface of the automation module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W018 — Automation Opportunities:
// "Represent automation candidates with process evidence, frequency, cost,
//  error rate, candidate solution types, expected ROI and outcome
//  measurement."
//
//   registerOpportunity — represent one automation candidate (version 1
//      'created', status minted 'candidate'). The name is the tenant-unique
//      IMMUTABLE graph key: registering an existing name fails with
//      `opportunity_name_conflict` — revise the winner instead. The process
//      and every cited finding are validated readable through the processes
//      contract at write time (a candidate is evidence-backed, lock 19);
//      the optional capability whose gap the acquisition option would close
//      is validated through the capabilities contract
//      (`processes + capabilities → automation`). Every version carries the
//      seven attributes the work item names: process evidence, frequency
//      (count + period), cost (integer minor units + ISO currency), error
//      rate, the candidate solution types (the eight ARCHITECTURE §13
//      options), the committed expected-ROI figures and the
//      outcome-measurement plan.
//   reviseOpportunity  — append the next version. Omitted fields carry
//      over; `null` clears; a `status` change must be the only change
//      (surgical lifecycle); content changes are accepted only while the
//      candidate status holds — accepting commits the prediction, and a
//      frozen expectation is what outcome measurement is judged against.
//      `expectedVersion` guards against stale writers.
//   getOpportunity     — the current view: identity + current content +
//      the derived expected-ROI summary (roi.ts, never persisted) + the
//      derived outcome-measurement summary (count, latest observed, target
//      met) + audit summary.
//   listOpportunities  — current views, filtered (exact name, name search,
//      status, process, solution type), ordered by name.
//   getOpportunityVersion / listOpportunityVersions — the audit deep links.
//   recordMeasurement  — append one observed metric value to the
//      opportunity's outcome observation series (accepted opportunities
//      only), with actor + principal + clock + optional evidence-reference
//      provenance.
//   listMeasurements   — one opportunity's observation series, ascending.
//   getMeasurement     — one observation-series record, deep-linked by id.
//
// There is deliberately NO operation to update or delete a version, a
// measurement or an opportunity, and NO way to rewrite a name, a process
// reference or an accepted prediction: the automation candidate history is
// versioned understanding in the goals/processes/capabilities discipline —
// revisions append, transitions are surgical, dismissals retain (ADR-0019:
// "failed interventions are retained as negative evidence") — and
// PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on versions and
// measurements, and DELETE/TRUNCATE on identities, via migration 001
// triggers. The derived layer (expected ROI, latest-observed progress,
// target-met) is never stored at all: it is recomputed from the current
// records on every read (lock 10).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's automation
// candidates (including versions and measurements) is reported as
// `opportunity_not_found` / `opportunity_version_not_found` /
// `measurement_not_found`, and citing another tenant's process, finding or
// capability reads as `invalid_process_ref` / `invalid_capability_ref` —
// no existence leak.
// ============================================================================

export {
  getMeasurement,
  getOpportunity,
  getOpportunityVersion,
  listMeasurements,
  listOpportunities,
  listOpportunityVersions,
  recordMeasurement,
  registerOpportunity,
  reviseOpportunity,
} from './service';

export { AutomationError } from './errors';
export type { AutomationErrorCode } from './errors';

// The derived economics — the single deterministic definitions, pure and
// reusable by downstream surfaces (W022 agent recruitment compares
// alternatives; W054 capability outcome learning builds on these records;
// the functions are exported for verification).
export { expectedRoiOf, outcomeTargetMet } from './roi';
export type { ExpectedRoiInput } from './roi';

export {
  AUTOMATION_CHANGE_KINDS,
  AUTOMATION_EVIDENCE_KINDS,
  AUTOMATION_PARTY_KINDS,
  AUTOMATION_PERIODS,
  AUTOMATION_SOLUTION_TYPES,
  AUTOMATION_STATUSES,
  DEFAULT_LIST_LIMIT,
  MAX_EVIDENCE_REFS,
  MAX_FINDING_REFS,
  MAX_FREQUENCY_COUNT,
  MAX_LIST_LIMIT,
  MAX_METRIC_NAME_LENGTH,
  MAX_METRIC_UNIT_LENGTH,
  MAX_METRIC_VALUE,
  MAX_MONEY_MINOR,
  MAX_NAME_LENGTH,
  MAX_ROI_HORIZON_PERIODS,
  MAX_SEARCH_LENGTH,
  MAX_TEXT_LENGTH,
  OUTCOME_DIRECTIONS,
  escapeLike,
  isAutomationChangeKind,
  isAutomationEvidenceKind,
  isAutomationPartyKind,
  isAutomationPeriod,
  isAutomationSolutionType,
  isAutomationStatus,
  isOutcomeDirection,
  isUuid,
} from './validation';

export type {
  ValidatedEvidenceRef,
  ValidatedHistoryQuery,
  ValidatedListQuery,
  ValidatedMeasurementInput,
  ValidatedMeasurementQuery,
  ValidatedMeasurementsQuery,
  ValidatedOpportunityQuery,
  ValidatedOutcomePlan,
  ValidatedOutcomePlanPatch,
  ValidatedParty,
  ValidatedRegisterInput,
  ValidatedReviseInput,
  ValidatedRevisionPatch,
  ValidatedVersionQuery,
} from './validation';

export type {
  AutomationActor,
  AutomationChangeKind,
  AutomationChangeSummary,
  AutomationEvidenceKind,
  AutomationEvidenceRef,
  AutomationEvidenceRefInput,
  AutomationMeasurement,
  AutomationOpportunity,
  AutomationOpportunityVersion,
  AutomationParty,
  AutomationPartyInput,
  AutomationPartyKind,
  AutomationPeriod,
  AutomationSolutionType,
  AutomationStatus,
  ExpectedRoi,
  GetAutomationMeasurementQuery,
  GetAutomationOpportunityQuery,
  GetAutomationOpportunityVersionQuery,
  ListAutomationMeasurementsQuery,
  ListAutomationOpportunitiesQuery,
  ListAutomationOpportunityVersionsQuery,
  OutcomeDirection,
  OutcomeMeasurementSummary,
  OutcomePlan,
  OutcomePlanInput,
  OutcomePlanPatch,
  RecordAutomationMeasurementInput,
  RegisterAutomationOpportunityInput,
  ReviseAutomationOpportunityInput,
} from './types';
