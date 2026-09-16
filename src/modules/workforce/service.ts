// Implementation of the workforce module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at`/`decided_at` come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`role_not_found` /
// `assignment_not_found` / `signal_not_found` / `assessment_not_found` /
// `decision_not_found` and their version counterparts), including on
// versions and decisions, and on registrations against foreign-tenant ids.
//
// W019 acceptance — "Assess workload, role/capability fit, performance
// signals and staffing needs while preserving alternative explanations and
// human decision authority" — is carried by these deliberate properties,
// all tested:
//   1. OBSERVED BEHAVIOR IS SEPARATED FROM INTERPRETATION: signals and
//      role expectations/assignments are the evidence side; `assessWorkforce`
//      computes the interpretation deterministically (assessment.ts) from
//      the current records and appends it as a self-contained version
//      snapshot. Nothing computed is ever trusted from a caller, and no
//      input can inject computed content (validation rejects unknown keys).
//   2. THE §14 CHAIN IS THE RECORD SHAPE: every assessment version carries
//      its evidence citations (considered signal ids + cited observation
//      ids), the computed assessment, the ALTERNATIVE EXPLANATIONS and
//      ALTERNATIVES (generated + stated), the recommendation with its
//      module-minted employment-impact classification, the confidence, and
//      the options it was computed under — an employment-impacting result
//      is reconstructable end to end (lock 37).
//   3. LOCK 20 IS ENFORCED TWICE: the service validation rejects an
//      employment-impacting recommendation without preserved uncertainty
//      (confidence < 1), alternative explanations (≥ 1), alternatives
//      (≥ 2 distinct kinds) or evidence (≥ 1 reference); migration 001's
//      CHECK constraints reject the same shapes at the storage level, so
//      even a future module bypassing the service cannot persist an
//      unguarded employment-impacting assessment.
//   4. LOCK 21 IS STRUCTURAL: there is no operation that changes
//      employment, executes a recommendation or even marks one executed.
//      The chain's terminus is `recordDecision` — an append-only, one-per-
//      version record of an authorized HUMAN decision (decider kind
//      'person', 'workforce:decide' authority claim, first decision wins).
//   5. THE CAPABILITY GRAPH IS READ THROUGH ITS CONTRACT: the employee's
//      supplies are loaded via the capabilities module's `listSupplies`
//      (the documented W017→W019 integration point) — never its tables —
//      so role/capability fit is grounded in the same graph W017 maintains.
//   6. HISTORY IS APPEND-ONLY: every append runs inside one transaction
//      that holds the identity row lock (FOR UPDATE) and advances the
//      pointer under an optimistic `current_version = expected` guard — a
//      losing writer fails cleanly with `assessment_conflict` (and the
//      capabilities module's conflict discipline for roles/assignments) —
//      and PostgreSQL itself rejects UPDATE/DELETE/TRUNCATE on versions,
//      signals and decisions (and DELETE/TRUNCATE on identities) via
//      migration 001 triggers.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { listSupplies } from '@/modules/capabilities/contract';
import { WorkforceError } from './errors';
import {
  computeWorkforceAssessment,
  findEmploymentGuardViolation,
  isEmploymentImpacting,
  isRecommendationGrounded,
  mergeAlternatives,
  type AssignmentInput,
} from './assessment';
import {
  assertWorkforceTenantContext,
  escapeLike,
  isUuid,
  MAX_ASSIGNMENTS_PER_ASSESSMENT,
  MAX_REQUIRED_CAPABILITIES_PER_ASSESSMENT,
  MAX_SIGNALS_PER_ASSESSMENT,
  MAX_SUPPLIES_PER_ASSESSMENT,
  requireWorkforceDecisionAuthority,
  validateAssessWorkforceInput,
  validateAssignRoleInput,
  validateAssessmentHistoryQuery,
  validateAssessmentVersionQuery,
  validateAssignmentHistoryQuery,
  validateAssignmentVersionQuery,
  validateGetDecisionQuery,
  validateGetSignalQuery,
  validateListAssignmentsQuery,
  validateListAssessmentsQuery,
  validateListDecisionsQuery,
  validateListRolesQuery,
  validateListSignalsQuery,
  validateRecordDecisionInput,
  validateRecordSignalInput,
  validateRegisterRoleInput,
  validateReviseAssignmentInput,
  validateReviseRoleInput,
  validateRoleHistoryQuery,
  validateRoleVersionQuery,
  type ValidatedEmployee,
  type ValidatedParty,
  type ValidatedRequirements,
} from './validation';
import type {
  AlternativeExplanation,
  AssessmentAlternative,
  AssessmentContent,
  AssessmentScope,
  AssignRoleInput,
  AssessWorkforceInput,
  CapabilityFitDetail,
  GetDecisionQuery,
  GetSignalQuery,
  ListAssignmentsQuery,
  ListAssessmentsQuery,
  ListDecisionsQuery,
  ListRolesQuery,
  ListSignalsQuery,
  RecordDecisionInput,
  RecordSignalInput,
  RegisterRoleInput,
  ReviseAssignmentInput,
  ReviseRoleInput,
  RoleAssignment,
  RoleAssignmentSummary,
  RoleAssignmentVersion,
  RoleCapabilityRequirement,
  RoleExpectation,
  RoleExpectationVersion,
  WorkforceAssessment,
  WorkforceAssessmentVersion,
  WorkforceDecision,
  WorkforceRecordStatus,
  WorkforceSignal,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

/** jsonb arrays arrive parsed on both backends; storage is write-validated. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

interface RoleVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  role_id: string;
  version: number | string;
  change_kind: string;
  role_key: string;
  title: string | null;
  description: string | null;
  required_capabilities: unknown;
  expected_weekly_hours: number;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the role current-view join (identities ⋈ current versions). */
interface RoleRow extends DbRow {
  role_id: string;
  role_tenant_id: string;
  role_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  role_key: string;
  title: string | null;
  description: string | null;
  required_capabilities: unknown;
  expected_weekly_hours: number;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface AssignmentVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  assignment_id: string;
  role_id: string;
  version: number | string;
  change_kind: string;
  employee_id: string;
  employee_label: string | null;
  allocation: number;
  status: string;
  evidence_observation_ids: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the assignment current-view join (assignments ⋈ current versions ⋈ roles). */
interface AssignmentRow extends DbRow {
  assignment_id: string;
  assignment_tenant_id: string;
  assignment_created_at: Date | string;
  role_id: string;
  role_key: string;
  role_status: string;
  version_number: number | string;
  change_kind: string;
  employee_id: string;
  employee_label: string | null;
  allocation: number;
  status: string;
  evidence_observation_ids: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface SignalRow extends DbRow {
  id: string;
  tenant_id: string;
  employee_key: string;
  employee_id: string;
  employee_label: string | null;
  kind: string;
  value: number;
  evidence_observation_ids: unknown;
  note: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

interface AssessmentVersionRow extends DbRow {
  id: string;
  tenant_id: string;
  assessment_id: string;
  version: number | string;
  change_kind: string;
  employee_id: string;
  employee_label: string | null;
  workload: unknown;
  fit: unknown;
  performance: unknown;
  staffing: unknown;
  scope: unknown;
  adverse_findings: unknown;
  alternative_explanations: unknown;
  alternatives: unknown;
  recommendation_kind: string;
  recommendation_text: string;
  employment_impacting: boolean;
  confidence: number;
  window_weeks: number | string;
  workload_margin: number;
  performance_strong: number;
  performance_satisfactory: number;
  considered_signal_ids: unknown;
  evidence_observation_ids: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the assessment current-view join (identities ⋈ current versions). */
interface AssessmentRow extends DbRow {
  assessment_id: string;
  assessment_tenant_id: string;
  assessment_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  employee_id: string;
  employee_label: string | null;
  workload: unknown;
  fit: unknown;
  performance: unknown;
  staffing: unknown;
  scope: unknown;
  adverse_findings: unknown;
  alternative_explanations: unknown;
  alternatives: unknown;
  recommendation_kind: string;
  recommendation_text: string;
  employment_impacting: boolean;
  confidence: number;
  window_weeks: number | string;
  workload_margin: number;
  performance_strong: number;
  performance_satisfactory: number;
  considered_signal_ids: unknown;
  evidence_observation_ids: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface DecisionRow extends DbRow {
  id: string;
  tenant_id: string;
  assessment_id: string;
  assessment_version: number | string;
  decision: string;
  decider_kind: string;
  decider_id: string;
  decider_label: string | null;
  decided_by_principal: string;
  rationale: string | null;
  follow_up_note: string | null;
  decided_at: Date | string;
}

function mapActorOf(row: {
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
}): RoleExpectationVersion['actor'] {
  return {
    kind: row.actor_kind as RoleExpectationVersion['actor']['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

function mapChangeOf(row: {
  change_kind: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}): RoleExpectation['lastChange'] {
  return {
    kind: row.change_kind as RoleExpectation['lastChange']['kind'], // CHECK-constrained
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

// -- jsonb coercers (write-validated by validation.ts + CHECK constraints) --

function asRequirements(value: unknown): RoleCapabilityRequirement[] {
  if (!Array.isArray(value)) return [];
  const out: RoleCapabilityRequirement[] = [];
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (
        typeof record.capabilityId === 'string' &&
        (typeof record.minLevel === 'number' || record.minLevel === undefined)
      ) {
        out.push({
          capabilityId: record.capabilityId,
          minLevel: typeof record.minLevel === 'number' ? record.minLevel : 0,
        });
      }
    }
  }
  return out;
}

function asFitDetails(value: unknown): CapabilityFitDetail[] {
  if (!Array.isArray(value)) return [];
  const out: CapabilityFitDetail[] = [];
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.capabilityId === 'string' && typeof record.requiredLevel === 'number') {
        out.push({
          capabilityId: record.capabilityId,
          requiredLevel: record.requiredLevel,
          suppliedLevel: typeof record.suppliedLevel === 'number' ? record.suppliedLevel : null,
          met: record.met === true,
        });
      }
    }
  }
  return out;
}

function asExplanations(value: unknown): AlternativeExplanation[] {
  if (!Array.isArray(value)) return [];
  const out: AlternativeExplanation[] = [];
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.text === 'string') {
        out.push({
          text: record.text,
          source: record.source === 'stated' ? 'stated' : 'generated',
        });
      }
    }
  }
  return out;
}

function asAlternatives(value: unknown): AssessmentAlternative[] {
  if (!Array.isArray(value)) return [];
  const out: AssessmentAlternative[] = [];
  for (const entry of value) {
    if (typeof entry === 'object' && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.kind === 'string' && typeof record.description === 'string') {
        out.push({
          kind: record.kind as AssessmentAlternative['kind'], // CHECK-constrained vocabulary on write
          description: record.description,
          source: record.source === 'stated' ? 'stated' : 'generated',
        });
      }
    }
  }
  return out;
}

function asScope(value: unknown): AssessmentScope {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const count = (candidate: unknown): number =>
      typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
    return {
      consideredActiveAssignmentCount: count(record.consideredActiveAssignmentCount),
      excludedRetiredRoleAssignmentCount: count(record.excludedRetiredRoleAssignmentCount),
      unconsideredAssignmentOverflowCount: count(record.unconsideredAssignmentOverflowCount),
      requiredCapabilityCount: count(record.requiredCapabilityCount),
      requiredCapabilityOverflowCount: count(record.requiredCapabilityOverflowCount),
    };
  }
  return {
    consideredActiveAssignmentCount: 0,
    excludedRetiredRoleAssignmentCount: 0,
    unconsideredAssignmentOverflowCount: 0,
    requiredCapabilityCount: 0,
    requiredCapabilityOverflowCount: 0,
  };
}

/** Assembles the self-contained assessment content from a version row. */
function mapContent(row: {
  workload: unknown;
  fit: unknown;
  performance: unknown;
  staffing: unknown;
  scope: unknown;
  adverse_findings: unknown;
  alternative_explanations: unknown;
  alternatives: unknown;
  recommendation_kind: string;
  recommendation_text: string;
  employment_impacting: boolean;
  confidence: number;
  window_weeks: number | string;
  workload_margin: number;
  performance_strong: number;
  performance_satisfactory: number;
  considered_signal_ids: unknown;
  evidence_observation_ids: unknown;
}): AssessmentContent {
  const fitDetails = asFitDetails(
    typeof row.fit === 'object' && row.fit !== null
      ? (row.fit as Record<string, unknown>).details
      : undefined,
  );
  const fitRecord =
    typeof row.fit === 'object' && row.fit !== null && !Array.isArray(row.fit)
      ? (row.fit as Record<string, unknown>)
      : {};
  const workloadRecord =
    typeof row.workload === 'object' && row.workload !== null && !Array.isArray(row.workload)
      ? (row.workload as Record<string, unknown>)
      : {};
  const performanceRecord =
    typeof row.performance === 'object' && row.performance !== null && !Array.isArray(row.performance)
      ? (row.performance as Record<string, unknown>)
      : {};
  const staffingRecord =
    typeof row.staffing === 'object' && row.staffing !== null && !Array.isArray(row.staffing)
      ? (row.staffing as Record<string, unknown>)
      : {};
  return {
    workload: {
      status: (workloadRecord.status ?? 'insufficient_evidence') as AssessmentContent['workload']['status'],
      totalAllocation: typeof workloadRecord.totalAllocation === 'number' ? workloadRecord.totalAllocation : 0,
      committedWeeklyHours:
        typeof workloadRecord.committedWeeklyHours === 'number' ? workloadRecord.committedWeeklyHours : 0,
      observedWeeklyHours:
        typeof workloadRecord.observedWeeklyHours === 'number' ? workloadRecord.observedWeeklyHours : null,
      workloadSignalCount:
        typeof workloadRecord.workloadSignalCount === 'number' ? workloadRecord.workloadSignalCount : 0,
      margin: typeof workloadRecord.margin === 'number' ? workloadRecord.margin : row.workload_margin,
    },
    fit: {
      status: (fitRecord.status ?? 'unknown') as AssessmentContent['fit']['status'],
      requiredCount: typeof fitRecord.requiredCount === 'number' ? fitRecord.requiredCount : fitDetails.length,
      metCount: typeof fitRecord.metCount === 'number' ? fitRecord.metCount : fitDetails.filter((d) => d.met).length,
      details: fitDetails,
      unmet: fitDetails.filter((detail) => !detail.met),
    },
    performance: {
      status: (performanceRecord.status ?? 'insufficient_evidence') as AssessmentContent['performance']['status'],
      score: typeof performanceRecord.score === 'number' ? performanceRecord.score : null,
      signalCount: typeof performanceRecord.signalCount === 'number' ? performanceRecord.signalCount : 0,
      strongThreshold: row.performance_strong,
      satisfactoryThreshold: row.performance_satisfactory,
    },
    staffing: {
      status: (staffingRecord.status ?? 'unknown') as AssessmentContent['staffing']['status'],
      neededWeeklyHoursReduction:
        typeof staffingRecord.neededWeeklyHoursReduction === 'number'
          ? staffingRecord.neededWeeklyHoursReduction
          : null,
      surplusWeeklyHours:
        typeof staffingRecord.surplusWeeklyHours === 'number' ? staffingRecord.surplusWeeklyHours : null,
    },
    scope: asScope(row.scope),
    adverseFindings: stringArray(row.adverse_findings),
    alternativeExplanations: asExplanations(row.alternative_explanations),
    alternatives: asAlternatives(row.alternatives),
    recommendation: {
      kind: row.recommendation_kind as AssessmentContent['recommendation']['kind'], // CHECK-constrained
      text: row.recommendation_text,
      employmentImpacting: row.employment_impacting === true,
    },
    confidence: row.confidence,
    options: {
      windowWeeks: toInt(row.window_weeks),
      workloadMargin: row.workload_margin,
      performanceStrong: row.performance_strong,
      performanceSatisfactory: row.performance_satisfactory,
    },
    consideredSignalIds: stringArray(row.considered_signal_ids),
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
  };
}

function mapRoleVersion(row: RoleVersionRow): RoleExpectationVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    roleId: row.role_id,
    version: toInt(row.version),
    changeKind: row.change_kind as RoleExpectationVersion['changeKind'], // CHECK-constrained
    roleKey: row.role_key,
    title: row.title,
    description: row.description,
    requiredCapabilities: asRequirements(row.required_capabilities),
    expectedWeeklyHours: row.expected_weekly_hours,
    status: row.status as RoleExpectationVersion['status'], // CHECK-constrained
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapAssignmentVersion(row: AssignmentVersionRow): RoleAssignmentVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assignmentId: row.assignment_id,
    roleId: row.role_id,
    version: toInt(row.version),
    changeKind: row.change_kind as RoleAssignmentVersion['changeKind'], // CHECK-constrained
    employee: { id: row.employee_id, label: row.employee_label },
    allocation: row.allocation,
    status: row.status as RoleAssignmentVersion['status'], // CHECK-constrained
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapAssessmentVersion(row: AssessmentVersionRow): WorkforceAssessmentVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assessmentId: row.assessment_id,
    version: toInt(row.version),
    changeKind: row.change_kind as WorkforceAssessmentVersion['changeKind'], // CHECK-constrained
    employee: { id: row.employee_id, label: row.employee_label },
    content: mapContent(row),
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapSignal(row: SignalRow): WorkforceSignal {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employee: { id: row.employee_id, label: row.employee_label },
    kind: row.kind as WorkforceSignal['kind'], // CHECK-constrained
    value: row.value,
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    actor: mapActorOf(row),
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapDecision(row: DecisionRow): WorkforceDecision {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    assessmentId: row.assessment_id,
    assessmentVersion: toInt(row.assessment_version),
    decision: row.decision as WorkforceDecision['decision'], // CHECK-constrained
    decider: { kind: 'person', id: row.decider_id, label: row.decider_label },
    decidedByPrincipal: row.decided_by_principal,
    rationale: row.rationale,
    followUpNote: row.follow_up_note,
    decidedAt: toIso(row.decided_at),
  };
}

function mapRole(row: RoleRow, assignmentSummary: RoleAssignmentSummary): RoleExpectation {
  return {
    id: row.role_id,
    tenantId: row.role_tenant_id,
    roleKey: row.role_key,
    version: toInt(row.version_number),
    title: row.title,
    description: row.description,
    requiredCapabilities: asRequirements(row.required_capabilities),
    expectedWeeklyHours: row.expected_weekly_hours,
    status: row.status as RoleExpectation['status'], // CHECK-constrained
    assignmentSummary,
    createdAt: toIso(row.role_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function mapAssignment(row: AssignmentRow): RoleAssignment {
  return {
    id: row.assignment_id,
    tenantId: row.assignment_tenant_id,
    roleId: row.role_id,
    role: {
      id: row.role_id,
      roleKey: row.role_key,
      status: row.role_status as RoleAssignment['role']['status'], // CHECK-constrained
    },
    employee: { id: row.employee_id, label: row.employee_label },
    version: toInt(row.version_number),
    allocation: row.allocation,
    status: row.status as RoleAssignment['status'], // CHECK-constrained
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    note: row.note,
    createdAt: toIso(row.assignment_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

function mapAssessment(
  row: AssessmentRow,
  extras: { versionCount: number; decisionCount: number; decision: WorkforceDecision | null },
): WorkforceAssessment {
  return {
    id: row.assessment_id,
    tenantId: row.assessment_tenant_id,
    employee: { id: row.employee_id, label: row.employee_label },
    version: toInt(row.version_number),
    changeKind: row.change_kind as WorkforceAssessment['changeKind'], // CHECK-constrained
    content: mapContent(row),
    versionCount: extras.versionCount,
    decisionCount: extras.decisionCount,
    decision: extras.decision,
    createdAt: toIso(row.assessment_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: mapChangeOf(row),
  };
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function roleNotFound(roleId: string): WorkforceError {
  return new WorkforceError('role_not_found', `role '${roleId}' does not exist in this tenant`);
}

function assignmentNotFound(assignmentId: string): WorkforceError {
  return new WorkforceError(
    'assignment_not_found',
    `assignment '${assignmentId}' does not exist in this tenant`,
  );
}

function signalNotFound(signalId: string): WorkforceError {
  return new WorkforceError('signal_not_found', `signal '${signalId}' does not exist in this tenant`);
}

function assessmentNotFound(assessmentId: string): WorkforceError {
  return new WorkforceError(
    'assessment_not_found',
    `assessment '${assessmentId}' does not exist in this tenant`,
  );
}

function decisionNotFound(decisionId: string): WorkforceError {
  return new WorkforceError('decision_not_found', `decision '${decisionId}' does not exist in this tenant`);
}

/** True when `error` is a PostgreSQL unique violation naming `table`. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/** Service-derived change kind of a lifecycle/content revision (goals discipline). */
function deriveChangeKind(
  currentStatus: WorkforceRecordStatus,
  nextStatus: WorkforceRecordStatus,
): 'revised' | 'retired' | 'reactivated' {
  if (currentStatus === 'active' && nextStatus === 'retired') return 'retired';
  if (currentStatus === 'retired' && nextStatus === 'active') return 'reactivated';
  return 'revised';
}

// ---------------------------------------------------------------------------
// Shared SQL of the version appends
// ---------------------------------------------------------------------------

async function roleVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    roleId: string;
    version: number;
    changeKind: RoleExpectationVersion['changeKind'];
    roleKey: string;
    title: string | null;
    description: string | null;
    requiredCapabilities: ValidatedRequirements;
    expectedWeeklyHours: number;
    status: WorkforceRecordStatus;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<RoleVersionRow>> {
  return tx.query<RoleVersionRow>(
    `INSERT INTO role_expectation_versions (
       tenant_id, role_id, version, change_kind, role_key, title, description,
       required_capabilities, expected_weekly_hours, status,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16::timestamptz)
     RETURNING *`,
    [
      params.tenantId,
      params.roleId,
      params.version,
      params.changeKind,
      params.roleKey,
      params.title,
      params.description,
      JSON.stringify(params.requiredCapabilities),
      params.expectedWeeklyHours,
      params.status,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

async function assignmentVersionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    assignmentId: string;
    roleId: string;
    version: number;
    changeKind: RoleAssignmentVersion['changeKind'];
    employee: ValidatedEmployee;
    allocation: number;
    status: WorkforceRecordStatus;
    evidenceObservationIds: string[];
    note: string | null;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<AssignmentVersionRow>> {
  return tx.query<AssignmentVersionRow>(
    `INSERT INTO role_assignment_versions (
       tenant_id, assignment_id, role_id, version, change_kind,
       employee_id, employee_label, allocation, status, evidence_observation_ids, note,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17::timestamptz)
     RETURNING *`,
    [
      params.tenantId,
      params.assignmentId,
      params.roleId,
      params.version,
      params.changeKind,
      params.employee.id,
      params.employee.label,
      params.allocation,
      params.status,
      JSON.stringify(params.evidenceObservationIds),
      params.note,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

// ---------------------------------------------------------------------------
// Current-view SQL fragments
// ---------------------------------------------------------------------------

const ROLE_VIEW_FROM = `FROM role_expectations re
  INNER JOIN role_expectation_versions rv
    ON rv.role_id = re.id AND rv.tenant_id = re.tenant_id AND rv.version = re.current_version`;

const ROLE_VIEW_COLUMNS = `SELECT
    re.id AS role_id, re.tenant_id AS role_tenant_id, re.created_at AS role_created_at,
    rv.version AS version_number, rv.change_kind, rv.role_key, rv.title, rv.description,
    rv.required_capabilities, rv.expected_weekly_hours, rv.status,
    rv.actor_kind, rv.actor_id, rv.actor_label,
    rv.changed_by_principal, rv.rationale, rv.recorded_at`;

const ASSIGNMENT_VIEW_FROM = `FROM role_assignments ra
  INNER JOIN role_assignment_versions rav
    ON rav.assignment_id = ra.id AND rav.tenant_id = ra.tenant_id AND rav.version = ra.current_version
  INNER JOIN role_expectations re
    ON re.id = ra.role_id AND re.tenant_id = ra.tenant_id
  INNER JOIN role_expectation_versions rv
    ON rv.role_id = re.id AND rv.tenant_id = re.tenant_id AND rv.version = re.current_version`;

const ASSIGNMENT_VIEW_COLUMNS = `SELECT
    ra.id AS assignment_id, ra.tenant_id AS assignment_tenant_id, ra.created_at AS assignment_created_at,
    ra.role_id, rv.role_key, rv.status AS role_status,
    rav.version AS version_number, rav.change_kind,
    rav.employee_id, rav.employee_label, rav.allocation, rav.status,
    rav.evidence_observation_ids, rav.note,
    rav.actor_kind, rav.actor_id, rav.actor_label,
    rav.changed_by_principal, rav.rationale, rav.recorded_at`;

const ASSESSMENT_VIEW_FROM = `FROM workforce_assessments wa
  INNER JOIN workforce_assessment_versions wav
    ON wav.assessment_id = wa.id AND wav.tenant_id = wa.tenant_id AND wav.version = wa.current_version`;

const ASSESSMENT_VIEW_COLUMNS = `SELECT
    wa.id AS assessment_id, wa.tenant_id AS assessment_tenant_id, wa.created_at AS assessment_created_at,
    wav.version AS version_number, wav.change_kind,
    wav.employee_id, wav.employee_label,
    wav.workload, wav.fit, wav.performance, wav.staffing, wav.scope,
    wav.adverse_findings, wav.alternative_explanations, wav.alternatives,
    wav.recommendation_kind, wav.recommendation_text, wav.employment_impacting, wav.confidence,
    wav.window_weeks, wav.workload_margin, wav.performance_strong, wav.performance_satisfactory,
    wav.considered_signal_ids, wav.evidence_observation_ids,
    wav.actor_kind, wav.actor_id, wav.actor_label,
    wav.changed_by_principal, wav.rationale, wav.recorded_at`;

/**
 * Assignment summaries of the CURRENT versions for a page of roles
 * (the capabilities module's currentSummaries precedent).
 */
async function currentAssignmentSummaries(
  q: Queryable,
  ctx: TenantContext,
  roleIds: string[],
): Promise<Map<string, RoleAssignmentSummary>> {
  const summaries = new Map<string, RoleAssignmentSummary>();
  if (roleIds.length === 0) return summaries;
  const rows = await q.query<{ role_id: string; status: string; n: number | string }>(
    `SELECT ra.role_id, rav.status, count(*) AS n
       FROM role_assignments ra
       INNER JOIN role_assignment_versions rav
         ON rav.assignment_id = ra.id AND rav.tenant_id = ra.tenant_id AND rav.version = ra.current_version
      WHERE ra.tenant_id = $1 AND ra.role_id = ANY($2::uuid[])
      GROUP BY ra.role_id, rav.status`,
    [ctx.tenantId, roleIds],
  );
  for (const row of rows.rows) {
    const entry = summaries.get(row.role_id) ?? { activeCount: 0, retiredCount: 0 };
    if (row.status === 'active') entry.activeCount += toInt(row.n);
    else entry.retiredCount += toInt(row.n);
    summaries.set(row.role_id, entry);
  }
  return summaries;
}

/** Loads the current version row of one role inside `tx` (tenant-scoped). */
async function loadCurrentRoleVersion(
  tx: Queryable,
  ctx: TenantContext,
  roleId: string,
): Promise<RoleVersionRow> {
  const rows = await tx.query<RoleVersionRow>(
    `SELECT rv.* FROM role_expectation_versions rv
       INNER JOIN role_expectations re ON re.id = rv.role_id AND re.tenant_id = rv.tenant_id
      WHERE rv.tenant_id = $1 AND rv.role_id = $2 AND rv.version = re.current_version`,
    [ctx.tenantId, roleId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw roleNotFound(roleId);
  return row;
}

// ---------------------------------------------------------------------------
// Roles — register / revise
// ---------------------------------------------------------------------------

export async function registerRole(
  ctx: TenantContext,
  input: RegisterRoleInput,
): Promise<RoleExpectation> {
  assertWorkforceTenantContext(ctx);
  const valid = validateRegisterRoleInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Identity row first (id minted by PostgreSQL); version 1 follows in the
    // same transaction. The role key is the immutable tenant-unique key.
    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO role_expectations (tenant_id, role_key, created_at) VALUES ($1, $2, $3)
           RETURNING id, created_at`,
        [ctx.tenantId, valid.roleKey, recordedAt],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'role_expectations')) {
        throw new WorkforceError(
          'role_key_conflict',
          `a role keyed '${valid.roleKey}' already exists in this tenant; revise it instead of registering the key again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await roleVersionInsert(tx, {
      tenantId: ctx.tenantId,
      roleId: identity.id,
      version: 1,
      changeKind: 'created',
      roleKey: valid.roleKey,
      title: valid.title,
      description: valid.description,
      requiredCapabilities: valid.requiredCapabilities,
      expectedWeeklyHours: valid.expectedWeeklyHours,
      status: 'active', // roles are active upon registration
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapRoleVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      roleKey: version.roleKey,
      version: version.version,
      title: version.title,
      description: version.description,
      requiredCapabilities: version.requiredCapabilities,
      expectedWeeklyHours: version.expectedWeeklyHours,
      status: version.status,
      assignmentSummary: { activeCount: 0, retiredCount: 0 },
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

export async function reviseRole(ctx: TenantContext, input: ReviseRoleInput): Promise<RoleExpectation> {
  assertWorkforceTenantContext(ctx);
  const valid = validateReviseRoleInput(input);
  if (!isUuid(valid.roleId)) throw roleNotFound(valid.roleId);

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Row lock on the identity: concurrent revisers of one role serialize
    // here, which is what keeps the version chain gapless.
    const locked = await tx.query<{
      id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, current_version, created_at FROM role_expectations
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.roleId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw roleNotFound(valid.roleId);
    const currentVersionNumber = toInt(identity.current_version);

    const current = mapRoleVersion(await loadCurrentRoleVersion(tx, ctx, valid.roleId));

    // --- lifecycle transition gate (surgical, service-level) ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new WorkforceError(
        'invalid_transition',
        `role '${valid.roleId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.status === 'retired' && patch.status !== 'active') {
      throw new WorkforceError(
        'invalid_transition',
        `role '${valid.roleId}' is retired — the only accepted change is a reactivation (status: 'active')`,
      );
    }
    if (
      patch.status !== undefined &&
      (patch.title !== undefined ||
        patch.description !== undefined ||
        patch.requiredCapabilities !== undefined ||
        patch.expectedWeeklyHours !== undefined)
    ) {
      throw new WorkforceError(
        'invalid_transition',
        `a status revision of role '${valid.roleId}' must be surgical — combine no other change with it`,
      );
    }

    // --- merge patch into the current content (undefined = carry over,
    //     null = clear — the goals module's tri-state discipline) ---
    const title = patch.title !== undefined ? patch.title : current.title;
    const description = patch.description !== undefined ? patch.description : current.description;
    const requiredCapabilities =
      patch.requiredCapabilities !== undefined
        ? patch.requiredCapabilities
        : current.requiredCapabilities.map((requirement) => ({
            capabilityId: requirement.capabilityId,
            minLevel: requirement.minLevel,
          }));
    const expectedWeeklyHours =
      patch.expectedWeeklyHours !== undefined
        ? patch.expectedWeeklyHours
        : current.expectedWeeklyHours;
    const nextStatus = patch.status ?? current.status;
    const changeKind = deriveChangeKind(current.status, nextStatus);

    const nextVersion = currentVersionNumber + 1;
    // Optimistic guard: the pointer moves exactly one step from the version
    // this revision was based on (defense in depth on top of the row lock).
    const moved = await tx.query(
      `UPDATE role_expectations SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.roleId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new WorkforceError(
        'role_key_conflict',
        'a concurrent revision moved this role forward; re-read it and retry',
      );
    }

    let inserted: DbResult<RoleVersionRow>;
    try {
      inserted = await roleVersionInsert(tx, {
        tenantId: ctx.tenantId,
        roleId: valid.roleId,
        version: nextVersion,
        changeKind,
        roleKey: current.roleKey, // immutable graph key
        title,
        description,
        requiredCapabilities,
        expectedWeeklyHours,
        status: nextStatus,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'role_expectation_versions')) {
        throw new WorkforceError(
          'role_key_conflict',
          'a concurrent revision appended this version number first; re-read the role and retry',
        );
      }
      throw error;
    }
    const version = mapRoleVersion(inserted.rows[0]!);
    const summaries = await currentAssignmentSummaries(tx, ctx, [valid.roleId]);
    const summary = summaries.get(valid.roleId);

    return {
      id: valid.roleId,
      tenantId: ctx.tenantId,
      roleKey: version.roleKey,
      version: version.version,
      title: version.title,
      description: version.description,
      requiredCapabilities: version.requiredCapabilities,
      expectedWeeklyHours: version.expectedWeeklyHours,
      status: version.status,
      assignmentSummary: summary ?? { activeCount: 0, retiredCount: 0 },
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Assignments — assign / revise
// ---------------------------------------------------------------------------

export async function assignRole(ctx: TenantContext, input: AssignRoleInput): Promise<RoleAssignment> {
  assertWorkforceTenantContext(ctx);
  const valid = validateAssignRoleInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Lock the role identity: the assignment append serializes against a
    // concurrent role retirement (which holds the same lock), and the role
    // must exist and be active — a retired role is out of the operating
    // scope and accepts no new assignment.
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM role_expectations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.roleId],
    );
    if (locked.rows.length === 0) throw roleNotFound(valid.roleId);
    const current = mapRoleVersion(await loadCurrentRoleVersion(tx, ctx, valid.roleId));
    if (current.status !== 'active') {
      throw new WorkforceError(
        'invalid_transition',
        `role '${valid.roleId}' is retired — a retired role accepts no new assignment; reactivate it first`,
      );
    }

    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO role_assignments (
             tenant_id, role_id, employee_key, employee_id, employee_label, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, created_at`,
        [
          ctx.tenantId,
          valid.roleId,
          valid.employee.id,
          valid.employee.id,
          valid.employee.label,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'role_assignments')) {
        throw new WorkforceError(
          'assignment_conflict',
          `this employee is already assigned to role '${valid.roleId}' in this tenant; revise the assignment instead of assigning the pair again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await assignmentVersionInsert(tx, {
      tenantId: ctx.tenantId,
      assignmentId: identity.id,
      roleId: valid.roleId,
      version: 1,
      changeKind: 'assigned',
      employee: valid.employee,
      allocation: valid.allocation,
      status: 'active', // assignments are active upon assignment
      evidenceObservationIds: valid.evidenceObservationIds,
      note: valid.note,
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapAssignmentVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      roleId: valid.roleId,
      role: { id: valid.roleId, roleKey: current.roleKey, status: current.status },
      employee: version.employee,
      version: version.version,
      allocation: version.allocation,
      status: version.status,
      evidenceObservationIds: version.evidenceObservationIds,
      note: version.note,
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

export async function reviseAssignment(
  ctx: TenantContext,
  input: ReviseAssignmentInput,
): Promise<RoleAssignment> {
  assertWorkforceTenantContext(ctx);
  const valid = validateReviseAssignmentInput(input);
  if (!isUuid(valid.assignmentId)) throw assignmentNotFound(valid.assignmentId);

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Lock the assignment identity; serialize against concurrent revision.
    const locked = await tx.query<{
      id: string;
      role_id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, role_id, current_version, created_at FROM role_assignments
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.assignmentId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw assignmentNotFound(valid.assignmentId);
    const currentVersionNumber = toInt(identity.current_version);

    const rows = await tx.query<AssignmentVersionRow>(
      `SELECT rav.* FROM role_assignment_versions rav
        INNER JOIN role_assignments ra ON ra.id = rav.assignment_id AND ra.tenant_id = rav.tenant_id
       WHERE rav.tenant_id = $1 AND rav.assignment_id = $2 AND rav.version = ra.current_version`,
      [ctx.tenantId, valid.assignmentId],
    );
    const currentRow = rows.rows[0];
    if (currentRow === undefined) throw assignmentNotFound(valid.assignmentId);
    const current = mapAssignmentVersion(currentRow);

    // --- lifecycle transition gate (surgical, service-level) ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new WorkforceError(
        'invalid_transition',
        `assignment '${valid.assignmentId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.status === 'retired' && patch.status !== 'active') {
      throw new WorkforceError(
        'invalid_transition',
        `assignment '${valid.assignmentId}' is retired — the only accepted change is a reactivation (status: 'active')`,
      );
    }
    if (
      patch.status !== undefined &&
      (patch.allocation !== undefined ||
        patch.evidenceObservationIds !== undefined ||
        patch.note !== undefined)
    ) {
      throw new WorkforceError(
        'invalid_transition',
        `a status revision of assignment '${valid.assignmentId}' must be surgical — combine no other change with it`,
      );
    }

    // --- merge patch into the current content ---
    const allocation = patch.allocation !== undefined ? patch.allocation : current.allocation;
    const evidenceObservationIds =
      patch.evidenceObservationIds !== undefined
        ? patch.evidenceObservationIds
        : current.evidenceObservationIds;
    const note = patch.note !== undefined ? patch.note : current.note;
    const nextStatus = patch.status ?? current.status;
    const changeKind = deriveChangeKind(current.status, nextStatus);

    const nextVersion = currentVersionNumber + 1;
    const moved = await tx.query(
      `UPDATE role_assignments SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.assignmentId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new WorkforceError(
        'assignment_conflict',
        'a concurrent revision moved this assignment forward; re-read it and retry',
      );
    }

    let inserted: DbResult<AssignmentVersionRow>;
    try {
      inserted = await assignmentVersionInsert(tx, {
        tenantId: ctx.tenantId,
        assignmentId: valid.assignmentId,
        roleId: identity.role_id,
        version: nextVersion,
        changeKind,
        employee: current.employee, // immutable identity content
        allocation,
        status: nextStatus,
        evidenceObservationIds,
        note,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'role_assignment_versions')) {
        throw new WorkforceError(
          'assignment_conflict',
          'a concurrent revision appended this version number first; re-read the assignment and retry',
        );
      }
      throw error;
    }
    const version = mapAssignmentVersion(inserted.rows[0]!);

    // The role reference of the current view (role key/status may have
    // moved on since the assignment was made — the view is always honest).
    const role = await loadCurrentRoleVersion(tx, ctx, identity.role_id);

    return {
      id: valid.assignmentId,
      tenantId: ctx.tenantId,
      roleId: identity.role_id,
      role: {
        id: identity.role_id,
        roleKey: role.role_key,
        status: role.status as RoleAssignment['role']['status'],
      },
      employee: version.employee,
      version: version.version,
      allocation: version.allocation,
      status: version.status,
      evidenceObservationIds: version.evidenceObservationIds,
      note: version.note,
      createdAt: toIso(identity.created_at),
      updatedAt: version.recordedAt,
      lastChange: {
        kind: version.changeKind,
        actor: version.actor,
        changedByPrincipal: version.changedByPrincipal,
        rationale: version.rationale,
        recordedAt: version.recordedAt,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export async function recordSignal(
  ctx: TenantContext,
  input: RecordSignalInput,
): Promise<WorkforceSignal> {
  assertWorkforceTenantContext(ctx);
  const valid = validateRecordSignalInput(input);
  const recordedAt = now();

  const inserted = await getDb().query<SignalRow>(
    `INSERT INTO workforce_signals (
       tenant_id, employee_key, employee_id, employee_label, kind, value,
       evidence_observation_ids, note, actor_kind, actor_id, actor_label,
       recorded_by_principal, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13::timestamptz)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.employee.id,
      valid.employee.id,
      valid.employee.label,
      valid.kind,
      valid.value,
      JSON.stringify(valid.evidenceObservationIds),
      valid.note,
      valid.actor.kind,
      valid.actor.id,
      valid.actor.label,
      ctx.principalId,
      recordedAt,
    ],
  );
  return mapSignal(inserted.rows[0]!);
}

export async function getSignal(ctx: TenantContext, query: GetSignalQuery): Promise<WorkforceSignal> {
  assertWorkforceTenantContext(ctx);
  const valid = validateGetSignalQuery(query);
  const rows = await getDb().query<SignalRow>(
    `SELECT * FROM workforce_signals WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.signalId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw signalNotFound(valid.signalId);
  return mapSignal(row);
}

export async function listSignals(
  ctx: TenantContext,
  query: ListSignalsQuery,
): Promise<WorkforceSignal[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateListSignalsQuery(query);

  const conditions: string[] = ['s.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.employeeId !== null) add('s.employee_key = $#', valid.employeeId);
  if (valid.kind !== null) add('s.kind = $#', valid.kind);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<SignalRow>(
    `SELECT s.* FROM workforce_signals s
      WHERE ${conditions.join(' AND ')}
      ORDER BY s.recorded_at DESC, s.id DESC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapSignal);
}

// ---------------------------------------------------------------------------
// Assessment — the §14 chain
// ---------------------------------------------------------------------------

/** Loads the current active assignments of one employee with their roles' current expectations. */
async function loadActiveAssignmentsWithRoles(
  ctx: TenantContext,
  employeeKey: string,
): Promise<AssignmentInput[]> {
  const rows = await getDb().query<{
    assignment_id: string;
    allocation: number;
    role_id: string;
    role_key: string;
    role_status: string;
    expected_weekly_hours: number;
    required_capabilities: unknown;
  }>(
    `SELECT ra.id AS assignment_id, rav.allocation,
            re.id AS role_id, rv.role_key, rv.status AS role_status,
            rv.expected_weekly_hours, rv.required_capabilities
       FROM role_assignments ra
       INNER JOIN role_assignment_versions rav
         ON rav.assignment_id = ra.id AND rav.tenant_id = ra.tenant_id AND rav.version = ra.current_version
       INNER JOIN role_expectations re
         ON re.id = ra.role_id AND re.tenant_id = ra.tenant_id
       INNER JOIN role_expectation_versions rv
         ON rv.role_id = re.id AND rv.tenant_id = re.tenant_id AND rv.version = re.current_version
      WHERE ra.tenant_id = $1 AND ra.employee_key = $2 AND rav.status = 'active'
      ORDER BY rav.recorded_at ASC, ra.id ASC`,
    [ctx.tenantId, employeeKey],
  );
  return rows.rows.map((row) => ({
    assignmentId: row.assignment_id,
    allocation: row.allocation,
    role: {
      id: row.role_id,
      roleKey: row.role_key,
      status: row.role_status as AssignmentInput['role']['status'], // CHECK-constrained
      expectedWeeklyHours: row.expected_weekly_hours,
      requiredCapabilities: asRequirements(row.required_capabilities).map((requirement) => ({
        capabilityId: requirement.capabilityId,
        minLevel: requirement.minLevel,
      })),
    },
  }));
}

/** Loads the signals of one employee and kind inside the window (newest first, bounded). */
async function loadWindowSignals(
  ctx: TenantContext,
  employeeKey: string,
  kind: 'workload' | 'performance',
  cutoff: Date,
): Promise<{ id: string; kind: 'workload' | 'performance'; value: number }[]> {
  const rows = await getDb().query<{ id: string; kind: string; value: number }>(
    `SELECT id, kind, value FROM workforce_signals
      WHERE tenant_id = $1 AND employee_key = $2 AND kind = $3 AND recorded_at >= $4::timestamptz
      ORDER BY recorded_at DESC, id DESC
      LIMIT $5`,
    [ctx.tenantId, employeeKey, kind, cutoff, MAX_SIGNALS_PER_ASSESSMENT],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    kind: row.kind as 'workload' | 'performance',
    value: row.value,
  }));
}

export async function assessWorkforce(
  ctx: TenantContext,
  input: AssessWorkforceInput,
): Promise<WorkforceAssessment> {
  assertWorkforceTenantContext(ctx);
  const valid = validateAssessWorkforceInput(input);
  const recordedAt = now();

  // --- gather the observed records (the evidence side) ---
  const allActiveAssignments = await loadActiveAssignmentsWithRoles(ctx, valid.employee.id);
  const activeAssignments = allActiveAssignments.filter(
    (assignment) => assignment.role.status === 'active',
  );
  const excludedRetiredRoleAssignmentCount =
    allActiveAssignments.length - activeAssignments.length;
  const consideredAssignments = activeAssignments.slice(0, MAX_ASSIGNMENTS_PER_ASSESSMENT);
  const unconsideredAssignmentOverflowCount =
    activeAssignments.length - consideredAssignments.length;

  const cutoff = new Date(
    recordedAt.getTime() - valid.options.windowWeeks * 7 * 24 * 60 * 60 * 1000,
  );
  const workloadSignals = await loadWindowSignals(
    ctx,
    valid.employee.id,
    'workload',
    cutoff,
  );
  const performanceSignals = await loadWindowSignals(
    ctx,
    valid.employee.id,
    'performance',
    cutoff,
  );

  // The employee's capability supplies, read through the capabilities
  // module's contract (the documented W017→W019 integration point — never
  // its tables). Supplier ids align with the people-module employee ids
  // both modules reference opaquely.
  const suppliesRows = await listSupplies(ctx, {
    supplierKind: 'employee',
    supplierId: valid.employee.id,
    status: 'active',
    limit: MAX_SUPPLIES_PER_ASSESSMENT,
  });
  const supplies = suppliesRows.map((supply) => ({
    capabilityId: supply.capabilityId,
    level: supply.level,
  }));

  // --- compute the interpretation (deterministic, pure) ---
  const computation = computeWorkforceAssessment({
    assignments: consideredAssignments,
    excludedRetiredRoleAssignmentCount,
    unconsideredAssignmentOverflowCount,
    workloadSignals,
    performanceSignals,
    supplies,
    options: valid.options,
    maxRequiredCapabilities: MAX_REQUIRED_CAPABILITIES_PER_ASSESSMENT,
  });

  // --- merge the caller's additions after the generated ones ---
  const alternativeExplanations: AlternativeExplanation[] = [
    ...computation.generatedExplanations,
    ...valid.additionalAlternativeExplanations.map((entry) => ({
      text: entry.text,
      source: 'stated' as const,
    })),
  ];
  const alternatives = mergeAlternatives(
    computation.generatedAlternatives,
    valid.additionalAlternatives.map((entry) => ({
      kind: entry.kind,
      description: entry.description,
      source: 'stated' as const,
    })),
  );

  const employmentImpacting = isEmploymentImpacting(valid.recommendationKind);

  // --- lock 20 / adverse-grounding guards (service level; the storage
  //     CHECK constraints mirror them as defense in depth) ---
  const guardViolation = findEmploymentGuardViolation({
    recommendationKind: valid.recommendationKind,
    confidence: valid.confidence,
    alternativeExplanations,
    alternatives,
    evidenceReferenceCount:
      computation.consideredSignalIds.length + valid.evidenceObservationIds.length,
  });
  if (guardViolation !== null) {
    const requirement =
      guardViolation === 'confidence'
        ? "confidence < 1 (uncertainty must be preserved — an employment-impacting result is never certain)"
        : guardViolation === 'explanations'
          ? 'at least one alternative explanation'
          : guardViolation === 'alternatives'
            ? 'at least two distinct alternatives (courses of action)'
            : 'at least one evidence reference (considered signals or cited observations)';
    throw new WorkforceError(
      'employment_guard',
      `an employment-impacting recommendation ('${valid.recommendationKind}') requires ${requirement} (ARCHITECTURE-LOCK 20)`,
    );
  }
  if (!isRecommendationGrounded(valid.recommendationKind, computation.adverseFindings)) {
    throw new WorkforceError(
      'ungrounded_recommendation',
      `a '${valid.recommendationKind}' recommendation must be grounded in at least one adverse computed finding; this assessment computed none (workload ${computation.workload.status}, fit ${computation.fit.status}, performance ${computation.performance.status}, staffing ${computation.staffing.status})`,
    );
  }

  const content: AssessmentContent = {
    workload: computation.workload,
    fit: computation.fit,
    performance: computation.performance,
    staffing: computation.staffing,
    scope: computation.scope,
    adverseFindings: computation.adverseFindings,
    alternativeExplanations,
    alternatives,
    recommendation: {
      kind: valid.recommendationKind,
      text: valid.recommendationText,
      employmentImpacting,
    },
    confidence: valid.confidence,
    options: valid.options,
    consideredSignalIds: computation.consideredSignalIds,
    evidenceObservationIds: valid.evidenceObservationIds,
  };

  // --- append the version (one identity per employee, gapless chain) ---
  return getDb().transaction(async (tx) => {
    const locked = await tx.query<{
      id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, current_version, created_at FROM workforce_assessments
        WHERE tenant_id = $1 AND employee_key = $2 FOR UPDATE`,
      [ctx.tenantId, valid.employee.id],
    );
    const identity = locked.rows[0];

    let assessmentId: string;
    let createdAt: Date | string;
    let nextVersion: number;
    let changeKind: 'issued' | 'reassessed';
    if (identity === undefined) {
      try {
        const created = await tx.query<{ id: string; created_at: Date | string }>(
          `INSERT INTO workforce_assessments (tenant_id, employee_key, employee_id, employee_label, created_at)
             VALUES ($1, $2, $3, $4, $5)
           RETURNING id, created_at`,
          [ctx.tenantId, valid.employee.id, valid.employee.id, valid.employee.label, recordedAt],
        );
        assessmentId = created.rows[0]!.id;
        createdAt = created.rows[0]!.created_at;
        nextVersion = 1;
        changeKind = 'issued';
      } catch (error) {
        if (isDuplicateKeyOn(error, 'workforce_assessments')) {
          throw new WorkforceError(
            'assessment_conflict',
            'a concurrent assessment of this employee was recorded first; re-read it and retry',
          );
        }
        throw error;
      }
    } else {
      assessmentId = identity.id;
      createdAt = identity.created_at;
      nextVersion = toInt(identity.current_version) + 1;
      changeKind = 'reassessed';
      const moved = await tx.query(
        `UPDATE workforce_assessments SET current_version = $3, employee_label = $4
          WHERE tenant_id = $1 AND id = $2 AND current_version = $5`,
        [ctx.tenantId, assessmentId, nextVersion, valid.employee.label, nextVersion - 1],
      );
      if (moved.rowCount === 0) {
        throw new WorkforceError(
          'assessment_conflict',
          'a concurrent assessment moved this employee forward; re-read it and retry',
        );
      }
    }

    let inserted: DbResult<AssessmentVersionRow>;
    try {
      inserted = await tx.query<AssessmentVersionRow>(
        `INSERT INTO workforce_assessment_versions (
           tenant_id, assessment_id, version, change_kind, employee_id, employee_label,
           workload, fit, performance, staffing, scope,
           adverse_findings, alternative_explanations, alternatives,
           recommendation_kind, recommendation_text, employment_impacting, confidence,
           window_weeks, workload_margin, performance_strong, performance_satisfactory,
           considered_signal_ids, evidence_observation_ids,
           actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb,
           $12::jsonb, $13::jsonb, $14::jsonb,
           $15, $16, $17, $18,
           $19, $20, $21, $22,
           $23::jsonb, $24::jsonb,
           $25, $26, $27, $28, $29, $30::timestamptz
         ) RETURNING *`,
        [
          ctx.tenantId,
          assessmentId,
          nextVersion,
          changeKind,
          valid.employee.id,
          valid.employee.label,
          JSON.stringify(content.workload),
          JSON.stringify(content.fit),
          JSON.stringify(content.performance),
          JSON.stringify(content.staffing),
          JSON.stringify(content.scope),
          JSON.stringify(content.adverseFindings),
          JSON.stringify(content.alternativeExplanations),
          JSON.stringify(content.alternatives),
          content.recommendation.kind,
          content.recommendation.text,
          content.recommendation.employmentImpacting,
          content.confidence,
          content.options.windowWeeks,
          content.options.workloadMargin,
          content.options.performanceStrong,
          content.options.performanceSatisfactory,
          JSON.stringify(content.consideredSignalIds),
          JSON.stringify(content.evidenceObservationIds),
          valid.actor.kind,
          valid.actor.id,
          valid.actor.label,
          ctx.principalId,
          valid.rationale,
          recordedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'workforce_assessment_versions')) {
        throw new WorkforceError(
          'assessment_conflict',
          'a concurrent assessment appended this version number first; re-read the assessment and retry',
        );
      }
      throw error;
    }
    const row = inserted.rows[0]!;

    const decisionCount = await tx.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM workforce_decisions WHERE tenant_id = $1 AND assessment_id = $2`,
      [ctx.tenantId, assessmentId],
    );

    return {
      id: assessmentId,
      tenantId: ctx.tenantId,
      employee: { id: valid.employee.id, label: valid.employee.label },
      version: nextVersion,
      changeKind,
      content,
      versionCount: nextVersion, // gapless chain by construction
      decisionCount: toInt(decisionCount.rows[0]!.n),
      decision: null,
      createdAt: toIso(createdAt),
      updatedAt: toIso(row.recorded_at),
      lastChange: {
        kind: changeKind,
        actor: {
          kind: valid.actor.kind as RoleExpectationVersion['actor']['kind'],
          id: valid.actor.id,
          label: valid.actor.label,
        },
        changedByPrincipal: ctx.principalId,
        rationale: valid.rationale,
        recordedAt: toIso(row.recorded_at),
      },
    };
  });
}

/** Decision + counts of a page of assessments (grouped queries, no N+1). */
async function assessmentExtras(
  q: Queryable,
  ctx: TenantContext,
  rows: AssessmentRow[],
): Promise<Map<string, { decisionCount: number; decision: WorkforceDecision | null }>> {
  const extras = new Map<string, { decisionCount: number; decision: WorkforceDecision | null }>();
  if (rows.length === 0) return extras;
  const ids = rows.map((row) => row.assessment_id);

  const counts = await q.query<{ assessment_id: string; n: number | string }>(
    `SELECT assessment_id, count(*) AS n FROM workforce_decisions
      WHERE tenant_id = $1 AND assessment_id = ANY($2::uuid[])
      GROUP BY assessment_id`,
    [ctx.tenantId, ids],
  );
  for (const row of counts.rows) {
    extras.set(row.assessment_id, { decisionCount: toInt(row.n), decision: null });
  }
  for (const row of rows) {
    if (!extras.has(row.assessment_id)) {
      extras.set(row.assessment_id, { decisionCount: 0, decision: null });
    }
  }

  // The decision on each assessment's CURRENT version, if any.
  const decisions = await q.query<DecisionRow>(
    `SELECT wd.* FROM workforce_decisions wd
       INNER JOIN workforce_assessments wa
         ON wa.id = wd.assessment_id AND wa.tenant_id = wd.tenant_id
      WHERE wd.tenant_id = $1 AND wd.assessment_id = ANY($2::uuid[])
        AND wd.assessment_version = wa.current_version`,
    [ctx.tenantId, ids],
  );
  for (const row of decisions.rows) {
    const entry = extras.get(row.assessment_id);
    if (entry !== undefined) entry.decision = mapDecision(row);
  }
  return extras;
}

export async function getAssessment(
  ctx: TenantContext,
  assessmentId: string,
): Promise<WorkforceAssessment> {
  assertWorkforceTenantContext(ctx);
  if (!isUuid(assessmentId)) throw assessmentNotFound(assessmentId);
  const rows = await getDb().query<AssessmentRow>(
    `${ASSESSMENT_VIEW_COLUMNS} ${ASSESSMENT_VIEW_FROM}
      WHERE wa.tenant_id = $1 AND wa.id = $2`,
    [ctx.tenantId, assessmentId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw assessmentNotFound(assessmentId);
  const extras = await assessmentExtras(getDb(), ctx, [row]);
  const extra = extras.get(row.assessment_id)!;
  return mapAssessment(row, {
    versionCount: toInt(row.version_number), // gapless chain by construction
    decisionCount: extra.decisionCount,
    decision: extra.decision,
  });
}

export async function listAssessments(
  ctx: TenantContext,
  query: ListAssessmentsQuery,
): Promise<WorkforceAssessment[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateListAssessmentsQuery(query);

  const conditions: string[] = ['wa.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.employeeId !== null) add('wav.employee_id = $#', valid.employeeId);
  if (valid.employmentImpacting !== null) {
    add('wav.employment_impacting = $#', valid.employmentImpacting);
  }
  if (valid.recommendationKind !== null) add('wav.recommendation_kind = $#', valid.recommendationKind);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<AssessmentRow>(
    `${ASSESSMENT_VIEW_COLUMNS} ${ASSESSMENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY wa.employee_key ASC, wa.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  if (rows.rows.length === 0) return [];
  const extras = await assessmentExtras(getDb(), ctx, rows.rows);
  return rows.rows.map((row) => {
    const extra = extras.get(row.assessment_id)!;
    return mapAssessment(row, {
      versionCount: toInt(row.version_number),
      decisionCount: extra.decisionCount,
      decision: extra.decision,
    });
  });
}

export async function getAssessmentVersion(
  ctx: TenantContext,
  query: { assessmentId: string; version: number },
): Promise<WorkforceAssessmentVersion> {
  assertWorkforceTenantContext(ctx);
  const valid = validateAssessmentVersionQuery(query);
  const rows = await getDb().query<AssessmentVersionRow>(
    `SELECT * FROM workforce_assessment_versions WHERE tenant_id = $1 AND assessment_id = $2 AND version = $3`,
    [ctx.tenantId, valid.id, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new WorkforceError(
      'assessment_version_not_found',
      `version ${valid.version} of assessment '${valid.id}' does not exist in this tenant`,
    );
  }
  return mapAssessmentVersion(row);
}

export async function listAssessmentVersions(
  ctx: TenantContext,
  query: { assessmentId: string },
): Promise<WorkforceAssessmentVersion[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateAssessmentHistoryQuery(query);
  const rows = await getDb().query<AssessmentVersionRow>(
    `SELECT * FROM workforce_assessment_versions WHERE tenant_id = $1 AND assessment_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.id],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such assessment in this tenant" from "an assessment
    // without history" (impossible by construction).
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM workforce_assessments WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.id],
    );
    if (exists.rows.length === 0) throw assessmentNotFound(valid.id);
  }
  return rows.rows.map(mapAssessmentVersion);
}

// ---------------------------------------------------------------------------
// Human decisions (the chain's terminus)
// ---------------------------------------------------------------------------

export async function recordDecision(
  ctx: TenantContext,
  input: RecordDecisionInput,
): Promise<WorkforceDecision> {
  // The authority claim gate comes first: this is a HUMAN decision under
  // the tenant's authority model (the actions module's claim discipline).
  requireWorkforceDecisionAuthority(ctx);
  const valid = validateRecordDecisionInput(input);
  const decidedAt = now();

  return getDb().transaction(async (tx) => {
    // Lock the assessment identity: the decision serializes against a
    // concurrent re-assessment, and the assessment must exist here.
    const locked = await tx.query<{
      id: string;
      current_version: number | string;
    }>(
      `SELECT id, current_version FROM workforce_assessments
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.assessmentId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw assessmentNotFound(valid.assessmentId);

    const targetVersion =
      valid.version !== null ? valid.version : toInt(identity.current_version);

    // The decision must attach to an existing version of this assessment.
    const versionExists = await tx.query<{ id: string }>(
      `SELECT id FROM workforce_assessment_versions
        WHERE tenant_id = $1 AND assessment_id = $2 AND version = $3`,
      [ctx.tenantId, valid.assessmentId, targetVersion],
    );
    if (versionExists.rows.length === 0) {
      throw new WorkforceError(
        'assessment_version_not_found',
        `version ${targetVersion} of assessment '${valid.assessmentId}' does not exist in this tenant`,
      );
    }

    let inserted: DbResult<DecisionRow>;
    try {
      inserted = await tx.query<DecisionRow>(
        `INSERT INTO workforce_decisions (
           tenant_id, assessment_id, assessment_version, decision,
           decider_kind, decider_id, decider_label, decided_by_principal,
           rationale, follow_up_note, decided_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.assessmentId,
          targetVersion,
          valid.decision,
          'person', // human decision authority — the only decider kind
          valid.decider.id,
          valid.decider.label,
          ctx.principalId,
          valid.rationale,
          valid.followUpNote,
          decidedAt,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'workforce_decisions')) {
        throw new WorkforceError(
          'already_decided',
          `version ${targetVersion} of assessment '${valid.assessmentId}' already carries a decision — the first human decision is terminal; a changed course is a new assessment version and a decision on it`,
        );
      }
      throw error;
    }
    return mapDecision(inserted.rows[0]!);
  });
}

export async function getDecision(
  ctx: TenantContext,
  query: GetDecisionQuery,
): Promise<WorkforceDecision> {
  assertWorkforceTenantContext(ctx);
  const valid = validateGetDecisionQuery(query);
  const rows = await getDb().query<DecisionRow>(
    `SELECT * FROM workforce_decisions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.decisionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw decisionNotFound(valid.decisionId);
  return mapDecision(row);
}

export async function listDecisions(
  ctx: TenantContext,
  query: ListDecisionsQuery,
): Promise<WorkforceDecision[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateListDecisionsQuery(query);

  const conditions: string[] = ['d.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.assessmentId !== null) add('d.assessment_id = $#', valid.assessmentId);
  if (valid.decisionKind !== null) add('d.decision = $#', valid.decisionKind);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<DecisionRow>(
    `SELECT d.* FROM workforce_decisions d
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.decided_at ASC, d.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapDecision);
}

// ---------------------------------------------------------------------------
// Reads — roles / assignments / versions
// ---------------------------------------------------------------------------

export async function getRole(ctx: TenantContext, roleId: string): Promise<RoleExpectation> {
  assertWorkforceTenantContext(ctx);
  if (!isUuid(roleId)) throw roleNotFound(roleId);
  const rows = await getDb().query<RoleRow>(
    `${ROLE_VIEW_COLUMNS} ${ROLE_VIEW_FROM}
      WHERE re.tenant_id = $1 AND re.id = $2`,
    [ctx.tenantId, roleId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw roleNotFound(roleId);
  const summaries = await currentAssignmentSummaries(getDb(), ctx, [roleId]);
  return mapRole(row, summaries.get(roleId) ?? { activeCount: 0, retiredCount: 0 });
}

export async function listRoles(ctx: TenantContext, query: ListRolesQuery): Promise<RoleExpectation[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateListRolesQuery(query);

  const conditions: string[] = ['re.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.search !== null) {
    add('rv.role_key ILIKE $#', `%${escapeLike(valid.search)}%`);
  }
  if (valid.status !== null) add('rv.status = $#', valid.status);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<RoleRow>(
    `${ROLE_VIEW_COLUMNS} ${ROLE_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY rv.role_key ASC, re.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  if (rows.rows.length === 0) return [];
  const summaries = await currentAssignmentSummaries(
    getDb(),
    ctx,
    rows.rows.map((row) => row.role_id),
  );
  return rows.rows.map((row) =>
    mapRole(row, summaries.get(row.role_id) ?? { activeCount: 0, retiredCount: 0 }),
  );
}

export async function getRoleVersion(
  ctx: TenantContext,
  query: { roleId: string; version: number },
): Promise<RoleExpectationVersion> {
  assertWorkforceTenantContext(ctx);
  const valid = validateRoleVersionQuery(query);
  const rows = await getDb().query<RoleVersionRow>(
    `SELECT * FROM role_expectation_versions WHERE tenant_id = $1 AND role_id = $2 AND version = $3`,
    [ctx.tenantId, valid.id, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new WorkforceError(
      'role_version_not_found',
      `version ${valid.version} of role '${valid.id}' does not exist in this tenant`,
    );
  }
  return mapRoleVersion(row);
}

export async function listRoleVersions(
  ctx: TenantContext,
  query: { roleId: string },
): Promise<RoleExpectationVersion[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateRoleHistoryQuery(query);
  const rows = await getDb().query<RoleVersionRow>(
    `SELECT * FROM role_expectation_versions WHERE tenant_id = $1 AND role_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.id],
  );
  if (rows.rows.length === 0) {
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM role_expectations WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.id],
    );
    if (exists.rows.length === 0) throw roleNotFound(valid.id);
  }
  return rows.rows.map(mapRoleVersion);
}

export async function getAssignment(
  ctx: TenantContext,
  assignmentId: string,
): Promise<RoleAssignment> {
  assertWorkforceTenantContext(ctx);
  if (!isUuid(assignmentId)) throw assignmentNotFound(assignmentId);
  const rows = await getDb().query<AssignmentRow>(
    `${ASSIGNMENT_VIEW_COLUMNS} ${ASSIGNMENT_VIEW_FROM}
      WHERE ra.tenant_id = $1 AND ra.id = $2`,
    [ctx.tenantId, assignmentId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw assignmentNotFound(assignmentId);
  return mapAssignment(row);
}

export async function listAssignments(
  ctx: TenantContext,
  query: ListAssignmentsQuery,
): Promise<RoleAssignment[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateListAssignmentsQuery(query);

  const conditions: string[] = ['ra.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };
  if (valid.roleId !== null) add('ra.role_id = $#', valid.roleId);
  if (valid.employeeId !== null) add('ra.employee_key = $#', valid.employeeId);
  if (valid.status !== null) add('rav.status = $#', valid.status);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<AssignmentRow>(
    `${ASSIGNMENT_VIEW_COLUMNS} ${ASSIGNMENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ra.role_id ASC, ra.employee_key ASC, ra.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapAssignment);
}

export async function getAssignmentVersion(
  ctx: TenantContext,
  query: { assignmentId: string; version: number },
): Promise<RoleAssignmentVersion> {
  assertWorkforceTenantContext(ctx);
  const valid = validateAssignmentVersionQuery(query);
  const rows = await getDb().query<AssignmentVersionRow>(
    `SELECT * FROM role_assignment_versions WHERE tenant_id = $1 AND assignment_id = $2 AND version = $3`,
    [ctx.tenantId, valid.id, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new WorkforceError(
      'assignment_version_not_found',
      `version ${valid.version} of assignment '${valid.id}' does not exist in this tenant`,
    );
  }
  return mapAssignmentVersion(row);
}

export async function listAssignmentVersions(
  ctx: TenantContext,
  query: { assignmentId: string },
): Promise<RoleAssignmentVersion[]> {
  assertWorkforceTenantContext(ctx);
  const valid = validateAssignmentHistoryQuery(query);
  const rows = await getDb().query<AssignmentVersionRow>(
    `SELECT * FROM role_assignment_versions WHERE tenant_id = $1 AND assignment_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.id],
  );
  if (rows.rows.length === 0) {
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM role_assignments WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.id],
    );
    if (exists.rows.length === 0) throw assignmentNotFound(valid.id);
  }
  return rows.rows.map(mapAssignmentVersion);
}
