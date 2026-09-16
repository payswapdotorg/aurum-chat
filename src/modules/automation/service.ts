// Implementation of the automation module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`opportunity_not_found` / `opportunity_version_not_found`
// / `measurement_not_found`), including on versions and measurements.
//
// W018 acceptance — "Represent automation candidates with process evidence,
// frequency, cost, error rate, candidate solution types, expected ROI and
// outcome measurement" — is carried by these deliberate properties, all
// tested:
//   1. EVIDENCE-BACKED: every candidate names ONE process (W016) and cites
//      its findings — the ONLY process evidence input is the processes
//      contract (`getProcess` / `getProcessFinding`), never its tables, so
//      a missing, malformed or foreign-tenant process/finding uniformly
//      reads `invalid_process_ref` (the learning module's origin-ref
//      discipline). The optional capability (W017) whose gap the
//      acquisition option would close is validated the same way through the
//      capabilities contract (`processes + capabilities → automation`,
//      lock 19). The processId is immutable identity content — the revise
//      input has no key for it.
//   2. VERSIONED UNDERSTANDING: an opportunity is an identity (uuid +
//      tenant-unique immutable name) plus an append-only chain of
//      full-snapshot versions. Revising appends version N+1; no
//      update/delete operation exists on the contract, and PostgreSQL
//      itself rejects UPDATE/DELETE/TRUNCATE on versions and on
//      measurements, and DELETE/TRUNCATE on identities (migration 001
//      triggers).
//   3. SURGICAL LIFECYCLE: status transitions (candidate → accepted,
//      candidate|accepted → dismissed, dismissed → reopened) are the only
//      change in their version; content revisions happen only while the
//      candidate status holds — accepting commits the prediction, and a
//      frozen expectation is what outcome measurement is judged against
//      (the learning module's no-rewritten-predictions argument).
//   4. DERIVED ROI, NEVER PERSISTED: the expected-ROI summary (net benefit
//      over the horizon, ROI ratio, payback) and the outcome-measurement
//      progress (latest observed, target-met verdict) are pure functions of
//      the current records (roi.ts), recomputed on every read (lock 10).
//   5. MEASUREMENTS ARE EVIDENCE: observed metric values are append-only
//      rows with actor + principal + clock + optional evidence-reference
//      provenance, recordable only while the opportunity is accepted.
//   6. CONCURRENCY: the version append runs inside one transaction that
//      holds the identity row lock (FOR UPDATE) and advances the pointer
//      under an optimistic `current_version = expected` guard — a losing
//      writer fails cleanly with `opportunity_conflict`, and an explicit
//      `expectedVersion` mismatch refuses before anything is written.
//
// Storage shape: `automation_opportunities` (identity + current-version
// pointer; the only mutable column is the pointer) +
// `automation_opportunity_versions` (the append-only candidate snapshots) +
// `automation_measurements` (the append-only outcome observation series).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getCapability, CapabilitiesError } from '@/modules/capabilities/contract';
import { getProcess, getProcessFinding, ProcessesError } from '@/modules/processes/contract';
import { expectedRoiOf, outcomeTargetMet } from './roi';
import { AutomationError } from './errors';
import {
  assertAutomationTenantContext,
  escapeLike,
  isUuid,
  validateHistoryQuery,
  validateListQuery,
  validateMeasurementInput,
  validateMeasurementQuery,
  validateMeasurementsQuery,
  validateOpportunityQuery,
  validateRegisterInput,
  validateReviseInput,
  validateVersionQuery,
  type ValidatedEvidenceRef,
  type ValidatedOutcomePlanPatch,
  type ValidatedParty,
  type ValidatedRegisterInput,
  type ValidatedReviseInput,
} from './validation';
import type {
  AutomationMeasurement,
  AutomationOpportunity,
  AutomationOpportunityVersion,
  AutomationStatus,
  AutomationChangeKind,
  GetAutomationMeasurementQuery,
  GetAutomationOpportunityQuery,
  GetAutomationOpportunityVersionQuery,
  ListAutomationMeasurementsQuery,
  ListAutomationOpportunitiesQuery,
  ListAutomationOpportunityVersionsQuery,
  OutcomePlan,
  RegisterAutomationOpportunityInput,
  RecordAutomationMeasurementInput,
  ReviseAutomationOpportunityInput,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  opportunity_id: string;
  version: number | string;
  change_kind: string;
  name: string;
  status: string;
  process_id: string;
  process_name: string;
  finding_ids: unknown;
  capability_id: string | null;
  capability_name: string | null;
  description: string | null;
  frequency_count: number | string;
  period: string;
  currency: string;
  current_cost_minor: number | string | bigint;
  error_rate: number;
  solution_types: unknown;
  expected_savings_minor: number | string | bigint;
  expected_investment_minor: number | string | bigint;
  roi_horizon_periods: number | string;
  outcome: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the current-view join (opportunities ⋈ current versions). */
interface OpportunityRow extends VersionRow {
  opportunity_id: string; // aliased ao.id (shadows the version-row id via the select list)
  opportunity_tenant_id: string;
  opportunity_created_at: Date | string;
}

interface MeasurementRow extends DbRow {
  id: string;
  tenant_id: string;
  opportunity_id: string;
  value: number;
  note: string | null;
  evidence: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  recorded_by_principal: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

/** bigint money columns arrive as string (pg) / number — normalize to number. */
function toMoney(value: number | string | bigint): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

/** jsonb arrays arrive parsed on both backends; storage is write-validated. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapActorOf(row: {
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
}): AutomationOpportunityVersion['actor'] {
  return {
    kind: row.actor_kind as AutomationOpportunityVersion['actor']['kind'], // CHECK-constrained
    id: row.actor_id,
    label: row.actor_label,
  };
}

function mapVersion(row: VersionRow): AutomationOpportunityVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    opportunityId: row.opportunity_id,
    version: toInt(row.version),
    changeKind: row.change_kind as AutomationOpportunityVersion['changeKind'], // CHECK-constrained
    name: row.name,
    status: row.status as AutomationStatus, // CHECK-constrained
    process: { id: row.process_id, name: row.process_name },
    findingIds: stringArray(row.finding_ids),
    capability:
      row.capability_id === null
        ? null
        : { id: row.capability_id, name: row.capability_name! }, // CHECK: named together
    description: row.description,
    frequencyCount: toInt(row.frequency_count),
    period: row.period as AutomationOpportunityVersion['period'], // CHECK-constrained
    currency: row.currency,
    currentCostMinor: toMoney(row.current_cost_minor),
    errorRate: row.error_rate,
    // write-validated vocabularies; canonical order is preserved by storage
    solutionTypes: stringArray(row.solution_types) as AutomationOpportunityVersion['solutionTypes'],
    expectedSavingsMinor: toMoney(row.expected_savings_minor),
    expectedInvestmentMinor: toMoney(row.expected_investment_minor),
    roiHorizonPeriods: toInt(row.roi_horizon_periods),
    outcome: row.outcome as OutcomePlan, // write-validated jsonb object
    actor: mapActorOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapEvidence(value: unknown): AutomationMeasurement['evidence'] {
  if (!Array.isArray(value)) return [];
  return value as AutomationMeasurement['evidence']; // write-validated shape
}

function mapMeasurement(row: MeasurementRow): AutomationMeasurement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    opportunityId: row.opportunity_id,
    value: row.value,
    note: row.note,
    evidence: mapEvidence(row.evidence),
    actor: {
      kind: row.actor_kind as AutomationMeasurement['actor']['kind'], // CHECK-constrained
      id: row.actor_id,
      label: row.actor_label,
    },
    recordedByPrincipal: row.recorded_by_principal,
    recordedAt: toIso(row.recorded_at),
  };
}

function opportunityNotFound(opportunityId: string): AutomationError {
  return new AutomationError(
    'opportunity_not_found',
    `automation opportunity '${opportunityId}' does not exist in this tenant`,
  );
}

function versionNotFound(opportunityId: string, version: number): AutomationError {
  return new AutomationError(
    'opportunity_version_not_found',
    `version ${version} of automation opportunity '${opportunityId}' does not exist in this tenant`,
  );
}

function measurementNotFound(measurementId: string): AutomationError {
  return new AutomationError(
    'measurement_not_found',
    `outcome measurement '${measurementId}' does not exist in this tenant`,
  );
}

/** True when `error` is a PostgreSQL unique violation naming `table`. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/**
 * The legal lifecycle transitions (see types.ts): candidate → accepted,
 * candidate | accepted → dismissed, dismissed → reopened. Returns the
 * service-minted change kind, or null when the transition is illegal
 * (including accepted → candidate and any no-op).
 */
function transitionKind(
  from: AutomationStatus,
  to: AutomationStatus,
): AutomationChangeKind | null {
  if (from === to) return null;
  if (from === 'candidate' && to === 'accepted') return 'accepted';
  if (to === 'dismissed') return 'dismissed'; // candidate | accepted → dismissed
  if (from === 'dismissed' && to === 'candidate') return 'reopened';
  return null; // accepted → candidate, and nothing else exists
}

// ---------------------------------------------------------------------------
// Cross-module reference validation (through the sibling CONTRACTS only)
// ---------------------------------------------------------------------------

/**
 * The sanctioned `processes → automation` dependency: the cited process
 * must exist and be readable in this tenant, verified through the processes
 * contract — never its tables. Missing, malformed and foreign-tenant
 * process ids are uniformly `invalid_process_ref` (no existence leak).
 * Returns the process's immutable name for the version snapshot.
 */
async function validateProcessRef(ctx: TenantContext, processId: string): Promise<string> {
  try {
    const process = await getProcess(ctx, processId);
    return process.name;
  } catch (error) {
    if (error instanceof ProcessesError) {
      throw new AutomationError(
        'invalid_process_ref',
        `process '${processId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/**
 * Every cited process finding must be readable in this tenant AND belong to
 * the cited process (findings of another process — including a
 * foreign-tenant one — are uniformly `invalid_process_ref`).
 */
async function validateFindingRefs(
  ctx: TenantContext,
  processId: string,
  findingIds: readonly string[],
): Promise<void> {
  for (const findingId of findingIds) {
    try {
      const finding = await getProcessFinding(ctx, { findingId });
      if (finding.processId !== processId) {
        throw new AutomationError(
          'invalid_process_ref',
          `process finding '${findingId}' does not belong to process '${processId}'`,
        );
      }
    } catch (error) {
      if (error instanceof AutomationError) throw error;
      if (error instanceof ProcessesError) {
        throw new AutomationError(
          'invalid_process_ref',
          `process finding '${findingId}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }
}

/**
 * The `capabilities → automation` half of `processes + capabilities →
 * automation` (lock 19): the optional capability whose gap this acquisition
 * option would close must be readable in this tenant, verified through the
 * capabilities contract. Returns the capability's immutable name for the
 * version snapshot.
 */
async function validateCapabilityRef(ctx: TenantContext, capabilityId: string): Promise<string> {
  try {
    const capability = await getCapability(ctx, capabilityId);
    return capability.name;
  } catch (error) {
    if (error instanceof CapabilitiesError) {
      throw new AutomationError(
        'invalid_capability_ref',
        `capability '${capabilityId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Shared SQL of the version append
// ---------------------------------------------------------------------------

async function versionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    opportunityId: string;
    version: number;
    changeKind: AutomationChangeKind;
    name: string;
    status: AutomationStatus;
    processId: string;
    processName: string;
    findingIds: string[];
    capabilityId: string | null;
    capabilityName: string | null;
    description: string | null;
    frequencyCount: number;
    period: AutomationOpportunityVersion['period'];
    currency: string;
    currentCostMinor: number;
    errorRate: number;
    solutionTypes: string[];
    expectedSavingsMinor: number;
    expectedInvestmentMinor: number;
    roiHorizonPeriods: number;
    outcome: OutcomePlan;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<VersionRow>> {
  return tx.query<VersionRow>(
    `INSERT INTO automation_opportunity_versions (
       tenant_id, opportunity_id, version, change_kind, name, status,
       process_id, process_name, finding_ids, capability_id, capability_name, description,
       frequency_count, period, currency, current_cost_minor, error_rate, solution_types,
       expected_savings_minor, expected_investment_minor, roi_horizon_periods, outcome,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9::jsonb, $10, $11, $12,
       $13, $14, $15, $16, $17, $18::jsonb,
       $19, $20, $21, $22::jsonb,
       $23, $24, $25, $26, $27, $28::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.opportunityId,
      params.version,
      params.changeKind,
      params.name,
      params.status,
      params.processId,
      params.processName,
      JSON.stringify(params.findingIds),
      params.capabilityId,
      params.capabilityName,
      params.description,
      params.frequencyCount,
      params.period,
      params.currency,
      params.currentCostMinor,
      params.errorRate,
      JSON.stringify(params.solutionTypes),
      params.expectedSavingsMinor,
      params.expectedInvestmentMinor,
      params.roiHorizonPeriods,
      JSON.stringify(params.outcome),
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

/** Loads the current version row of one opportunity inside `tx` (tenant-scoped). */
async function loadCurrentVersion(
  tx: Queryable,
  ctx: TenantContext,
  opportunityId: string,
): Promise<VersionRow> {
  const rows = await tx.query<VersionRow>(
    `SELECT aov.* FROM automation_opportunity_versions aov
       INNER JOIN automation_opportunities ao
         ON ao.id = aov.opportunity_id AND ao.tenant_id = aov.tenant_id
      WHERE aov.tenant_id = $1 AND aov.opportunity_id = $2 AND aov.version = ao.current_version`,
    [ctx.tenantId, opportunityId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw opportunityNotFound(opportunityId);
  return row;
}

/** A read-only pre-pass of the current version (no lock) for revision planning. */
async function readCurrentVersion(
  ctx: TenantContext,
  opportunityId: string,
): Promise<AutomationOpportunityVersion> {
  const row = await loadCurrentVersion(getDb(), ctx, opportunityId);
  return mapVersion(row);
}

// ---------------------------------------------------------------------------
// Measurement summaries (the derived outcome-measurement state)
// ---------------------------------------------------------------------------

/** Per-opportunity series summary: count + latest measurement row. */
interface SeriesSummary {
  count: number;
  latestRow: MeasurementRow | null;
}

async function measurementSummaries(
  q: Queryable,
  ctx: TenantContext,
  opportunityIds: readonly string[],
): Promise<Map<string, SeriesSummary>> {
  const out = new Map<string, SeriesSummary>();
  if (opportunityIds.length === 0) return out;
  const counts = await q.query<{ opportunity_id: string; n: number | string }>(
    `SELECT opportunity_id, count(*) AS n FROM automation_measurements
      WHERE tenant_id = $1 AND opportunity_id = ANY($2::uuid[])
      GROUP BY opportunity_id`,
    [ctx.tenantId, [...opportunityIds]],
  );
  for (const row of counts.rows) {
    out.set(row.opportunity_id, { count: toInt(row.n), latestRow: null });
  }
  // Latest per opportunity: recorded_at DESC, id DESC is the series's
  // canonical order (the learning module's measurement ordering).
  const latest = await q.query<MeasurementRow>(
    `SELECT DISTINCT ON (opportunity_id) * FROM automation_measurements
      WHERE tenant_id = $1 AND opportunity_id = ANY($2::uuid[])
      ORDER BY opportunity_id, recorded_at DESC, id DESC`,
    [ctx.tenantId, [...opportunityIds]],
  );
  for (const row of latest.rows) {
    const entry = out.get(row.opportunity_id) ?? { count: 0, latestRow: null };
    entry.latestRow = row;
    out.set(row.opportunity_id, entry);
  }
  return out;
}

/** Assembles the derived current view from an identity + current version + series. */
function assembleOpportunity(
  identity: { id: string; tenantId: string; createdAt: Date | string },
  version: AutomationOpportunityVersion,
  series: SeriesSummary | undefined,
): AutomationOpportunity {
  const latest = series?.latestRow !== undefined && series.latestRow !== null
    ? mapMeasurement(series.latestRow)
    : null;
  const count = series?.count ?? 0;
  return {
    id: identity.id,
    tenantId: identity.tenantId,
    name: version.name,
    version: version.version,
    status: version.status,
    process: version.process,
    findingIds: version.findingIds,
    capability: version.capability,
    description: version.description,
    frequencyCount: version.frequencyCount,
    period: version.period,
    currency: version.currency,
    currentCostMinor: version.currentCostMinor,
    errorRate: version.errorRate,
    solutionTypes: version.solutionTypes,
    expectedSavingsMinor: version.expectedSavingsMinor,
    expectedInvestmentMinor: version.expectedInvestmentMinor,
    roiHorizonPeriods: version.roiHorizonPeriods,
    expectedRoi: expectedRoiOf({
      currency: version.currency,
      period: version.period,
      expectedSavingsMinor: version.expectedSavingsMinor,
      expectedInvestmentMinor: version.expectedInvestmentMinor,
      roiHorizonPeriods: version.roiHorizonPeriods,
    }),
    outcome: version.outcome,
    outcomeMeasurements: {
      measurementCount: count,
      latest,
      progress:
        latest === null
          ? null
          : {
              baseline: version.outcome.baseline,
              target: version.outcome.target,
              latest: latest.value,
              direction: version.outcome.direction,
              targetMet: outcomeTargetMet(
                version.outcome.direction,
                version.outcome.target,
                latest.value,
              ),
            },
    },
    createdAt: toIso(identity.createdAt),
    updatedAt: version.recordedAt,
    lastChange: {
      kind: version.changeKind,
      actor: version.actor,
      changedByPrincipal: version.changedByPrincipal,
      rationale: version.rationale,
      recordedAt: version.recordedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// registerOpportunity
// ---------------------------------------------------------------------------

export async function registerOpportunity(
  ctx: TenantContext,
  input: RegisterAutomationOpportunityInput,
): Promise<AutomationOpportunity> {
  assertAutomationTenantContext(ctx);
  const valid: ValidatedRegisterInput = validateRegisterInput(input);

  // --- cross-module evidence validation (before any write, the learning
  //     module's origin-ref discipline) ---
  const processName = await validateProcessRef(ctx, valid.processId);
  await validateFindingRefs(ctx, valid.processId, valid.findingIds);
  const capabilityName =
    valid.capabilityId === null ? null : await validateCapabilityRef(ctx, valid.capabilityId);

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Identity row first (id minted by PostgreSQL); version 1 follows in
    // the same transaction — an opportunity never exists without its
    // initial representation. The name is the immutable tenant-unique key.
    let created: DbResult<{ id: string; created_at: Date | string }>;
    try {
      created = await tx.query<{ id: string; created_at: Date | string }>(
        `INSERT INTO automation_opportunities (tenant_id, name, created_at) VALUES ($1, $2, $3)
           RETURNING id, created_at`,
        [ctx.tenantId, valid.name, recordedAt],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'automation_opportunities')) {
        throw new AutomationError(
          'opportunity_name_conflict',
          `an automation opportunity named '${valid.name}' already exists in this tenant; revise it instead of registering the name again`,
        );
      }
      throw error;
    }
    const identity = created.rows[0]!;

    const inserted = await versionInsert(tx, {
      tenantId: ctx.tenantId,
      opportunityId: identity.id,
      version: 1,
      changeKind: 'created',
      name: valid.name,
      status: 'candidate', // candidates are candidates upon registration
      processId: valid.processId,
      processName,
      findingIds: valid.findingIds,
      capabilityId: valid.capabilityId,
      capabilityName,
      description: valid.description,
      frequencyCount: valid.frequencyCount,
      period: valid.period,
      currency: valid.currency,
      currentCostMinor: valid.currentCostMinor,
      errorRate: valid.errorRate,
      solutionTypes: valid.solutionTypes,
      expectedSavingsMinor: valid.expectedSavingsMinor,
      expectedInvestmentMinor: valid.expectedInvestmentMinor,
      roiHorizonPeriods: valid.roiHorizonPeriods,
      outcome: valid.outcome,
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapVersion(inserted.rows[0]!);

    return assembleOpportunity(
      { id: identity.id, tenantId: ctx.tenantId, createdAt: identity.created_at },
      version,
      undefined, // no measurements can exist at version 1
    );
  });
}

// ---------------------------------------------------------------------------
// reviseOpportunity
// ---------------------------------------------------------------------------

export async function reviseOpportunity(
  ctx: TenantContext,
  input: ReviseAutomationOpportunityInput,
): Promise<AutomationOpportunity> {
  assertAutomationTenantContext(ctx);
  const valid: ValidatedReviseInput = validateReviseInput(input);

  if (!isUuid(valid.opportunityId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw opportunityNotFound(valid.opportunityId);
  }

  // --- cross-module evidence validation for the patched references. The
  //     process is immutable identity content, so the pre-read's process id
  //     is authoritative regardless of concurrency (learning's pre-tx
  //     origin-ref discipline). ---
  const currentPre = await readCurrentVersion(ctx, valid.opportunityId);
  if (valid.patch.findingIds !== undefined) {
    await validateFindingRefs(ctx, currentPre.process.id, valid.patch.findingIds);
  }
  let capabilityName: string | null | undefined;
  if (valid.patch.capabilityId !== undefined && valid.patch.capabilityId !== null) {
    capabilityName = await validateCapabilityRef(ctx, valid.patch.capabilityId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Row lock on the identity: concurrent revisers of one opportunity
    // serialize here, which is what keeps the version chain gapless.
    const locked = await tx.query<{
      id: string;
      current_version: number | string;
      created_at: Date | string;
    }>(
      `SELECT id, current_version, created_at FROM automation_opportunities
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.opportunityId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw opportunityNotFound(valid.opportunityId);
    const currentVersionNumber = toInt(identity.current_version);

    if (valid.expectedVersion !== null && valid.expectedVersion !== currentVersionNumber) {
      throw new AutomationError(
        'opportunity_conflict',
        `automation opportunity '${valid.opportunityId}' is at version ${currentVersionNumber}, not the expected ${valid.expectedVersion}; re-read it and retry`,
      );
    }

    const current = mapVersion(await loadCurrentVersion(tx, ctx, valid.opportunityId));

    // --- lifecycle transition gate (surgical, service-level) ---
    const patch = valid.patch;
    if (patch.status !== undefined && patch.status === current.status) {
      throw new AutomationError(
        'invalid_transition',
        `automation opportunity '${valid.opportunityId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    const nextStatus = patch.status ?? current.status;
    if (nextStatus !== current.status) {
      if (transitionKind(current.status, nextStatus) === null) {
        throw new AutomationError(
          'invalid_transition',
          `cannot move automation opportunity '${valid.opportunityId}' from '${current.status}' to '${nextStatus}' (legal transitions: candidate → accepted, candidate|accepted → dismissed, dismissed → reopened)`,
        );
      }
    }
    // Content changes are accepted only while the candidate status holds:
    // accepting commits the prediction (a frozen expectation is what
    // outcome measurement is judged against), and a dismissed record is
    // retained evidence — reopen to re-estimate.
    const contentChanged = valid.changed.some((field) => field !== 'status');
    if (contentChanged && current.status !== 'candidate') {
      throw new AutomationError(
        'invalid_transition',
        `automation opportunity '${valid.opportunityId}' is ${current.status} — its committed prediction is frozen; reopen it before re-estimating`,
      );
    }

    // --- merge patch into the current content (undefined = carry over,
    //     null = clear — the goals module's tri-state discipline) ---
    const capabilityId =
      patch.capabilityId !== undefined ? patch.capabilityId : current.capability?.id ?? null;
    const resolvedCapabilityName =
      patch.capabilityId === undefined
        ? current.capability?.name ?? null
        : patch.capabilityId === null
          ? null
          : capabilityName!;
    const description = patch.description !== undefined ? patch.description : current.description;
    const findingIds = patch.findingIds !== undefined ? patch.findingIds : current.findingIds;
    const frequencyCount =
      patch.frequencyCount !== undefined ? patch.frequencyCount : current.frequencyCount;
    const period = patch.period !== undefined ? patch.period : current.period;
    const currency = patch.currency !== undefined ? patch.currency : current.currency;
    const currentCostMinor =
      patch.currentCostMinor !== undefined ? patch.currentCostMinor : current.currentCostMinor;
    const errorRate = patch.errorRate !== undefined ? patch.errorRate : current.errorRate;
    const solutionTypes =
      patch.solutionTypes !== undefined ? patch.solutionTypes : current.solutionTypes;
    const expectedSavingsMinor =
      patch.expectedSavingsMinor !== undefined
        ? patch.expectedSavingsMinor
        : current.expectedSavingsMinor;
    const expectedInvestmentMinor =
      patch.expectedInvestmentMinor !== undefined
        ? patch.expectedInvestmentMinor
        : current.expectedInvestmentMinor;
    const roiHorizonPeriods =
      patch.roiHorizonPeriods !== undefined
        ? patch.roiHorizonPeriods
        : current.roiHorizonPeriods;
    const outcomePatch: ValidatedOutcomePlanPatch = patch.outcome ?? {};
    const outcome: OutcomePlan = {
      metricName: outcomePatch.metricName ?? current.outcome.metricName,
      metricUnit: outcomePatch.metricUnit ?? current.outcome.metricUnit,
      direction: outcomePatch.direction ?? current.outcome.direction,
      baseline: outcomePatch.baseline ?? current.outcome.baseline,
      target: outcomePatch.target ?? current.outcome.target,
    };

    const changeKind: AutomationChangeKind =
      nextStatus === current.status
        ? 'revised'
        : transitionKind(current.status, nextStatus)!; // pre-validated above

    const nextVersionNumber = currentVersionNumber + 1;
    // Optimistic guard: the pointer moves exactly one step from the version
    // this revision was based on (defense in depth on top of the row lock).
    const moved = await tx.query(
      `UPDATE automation_opportunities SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.opportunityId, nextVersionNumber, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new AutomationError(
        'opportunity_conflict',
        'a concurrent revision moved this automation opportunity forward; re-read it and retry',
      );
    }

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        opportunityId: valid.opportunityId,
        version: nextVersionNumber,
        changeKind,
        name: current.name, // immutable graph key
        status: nextStatus,
        processId: current.process.id, // immutable identity content
        processName: current.process.name,
        findingIds,
        capabilityId,
        capabilityName: resolvedCapabilityName,
        description,
        frequencyCount,
        period,
        currency,
        currentCostMinor,
        errorRate,
        solutionTypes,
        expectedSavingsMinor,
        expectedInvestmentMinor,
        roiHorizonPeriods,
        outcome,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'automation_opportunity_versions')) {
        throw new AutomationError(
          'opportunity_conflict',
          'a concurrent revision appended this version number first; re-read the opportunity and retry',
        );
      }
      throw error;
    }
    const version = mapVersion(inserted.rows[0]!);
    const series = (await measurementSummaries(tx, ctx, [valid.opportunityId])).get(
      valid.opportunityId,
    );

    return assembleOpportunity(
      {
        id: identity.id,
        tenantId: ctx.tenantId,
        createdAt: identity.created_at,
      },
      version,
      series,
    );
  });
}

// ---------------------------------------------------------------------------
// recordMeasurement
// ---------------------------------------------------------------------------

export async function recordMeasurement(
  ctx: TenantContext,
  input: RecordAutomationMeasurementInput,
): Promise<AutomationMeasurement> {
  assertAutomationTenantContext(ctx);
  const valid = validateMeasurementInput(input);

  if (!isUuid(valid.opportunityId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw opportunityNotFound(valid.opportunityId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Lock the identity: the measurement append serializes against a
    // concurrent status change (which holds the same lock), and the
    // opportunity must be accepted — the committed prediction is what
    // observed values are judged against.
    const locked = await tx.query<{ id: string }>(
      `SELECT id FROM automation_opportunities WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.opportunityId],
    );
    if (locked.rows.length === 0) throw opportunityNotFound(valid.opportunityId);
    const current = mapVersion(await loadCurrentVersion(tx, ctx, valid.opportunityId));
    if (current.status !== 'accepted') {
      throw new AutomationError(
        'invalid_transition',
        `automation opportunity '${valid.opportunityId}' is ${current.status} — outcome measurements are recorded against accepted opportunities (accept the candidate first; a dismissed pursuit is retained evidence)`,
      );
    }

    const inserted = await tx.query<MeasurementRow>(
      `INSERT INTO automation_measurements (
         tenant_id, opportunity_id, value, note, evidence,
         actor_kind, actor_id, actor_label, recorded_by_principal, recorded_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::timestamptz)
       RETURNING *`,
      [
        ctx.tenantId,
        valid.opportunityId,
        valid.value,
        valid.note,
        JSON.stringify(valid.evidence satisfies ValidatedEvidenceRef[]),
        valid.actor.kind,
        valid.actor.id,
        valid.actor.label,
        ctx.principalId,
        recordedAt,
      ],
    );
    return mapMeasurement(inserted.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const OPPORTUNITY_VIEW_FROM = `FROM automation_opportunities ao
  INNER JOIN automation_opportunity_versions aov
    ON aov.opportunity_id = ao.id AND aov.tenant_id = ao.tenant_id AND aov.version = ao.current_version`;

export async function getOpportunity(
  ctx: TenantContext,
  query: GetAutomationOpportunityQuery,
): Promise<AutomationOpportunity> {
  assertAutomationTenantContext(ctx);
  const valid = validateOpportunityQuery(query);
  if (!isUuid(valid.opportunityId)) throw opportunityNotFound(valid.opportunityId);

  const rows = await getDb().query<OpportunityRow>(
    `SELECT ao.id AS opportunity_id, ao.tenant_id AS opportunity_tenant_id,
            ao.created_at AS opportunity_created_at, aov.*
     ${OPPORTUNITY_VIEW_FROM}
      WHERE ao.tenant_id = $1 AND ao.id = $2`,
    [ctx.tenantId, valid.opportunityId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw opportunityNotFound(valid.opportunityId);

  const series = (await measurementSummaries(getDb(), ctx, [valid.opportunityId])).get(
    valid.opportunityId,
  );
  return assembleOpportunity(
    {
      id: row.opportunity_id,
      tenantId: row.opportunity_tenant_id,
      createdAt: row.opportunity_created_at,
    },
    mapVersion(row),
    series,
  );
}

export async function listOpportunities(
  ctx: TenantContext,
  query: ListAutomationOpportunitiesQuery,
): Promise<AutomationOpportunity[]> {
  assertAutomationTenantContext(ctx);
  const valid = validateListQuery(query);

  const conditions: string[] = ['ao.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.name !== null) add('ao.name = $#', valid.name);
  if (valid.search !== null) {
    // escaped substring match on the name — caller text is never a wildcard
    // pattern (the missions module's ILIKE discipline).
    add("ao.name ILIKE '%' || $# || '%' ESCAPE '\\'", escapeLike(valid.search));
  }
  if (valid.status !== null) add('aov.status = $#', valid.status);
  if (valid.processId !== null) add('aov.process_id = $#', valid.processId);
  if (valid.solutionType !== null) {
    // jsonb array containment: the candidate's solution-type list must
    // include the requested option.
    add('aov.solution_types @> $#::jsonb', JSON.stringify([valid.solutionType]));
  }
  params.push(valid.limit);

  const rows = await getDb().query<OpportunityRow>(
    `SELECT ao.id AS opportunity_id, ao.tenant_id AS opportunity_tenant_id,
            ao.created_at AS opportunity_created_at, aov.*
     ${OPPORTUNITY_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ao.name
      LIMIT $${params.length}`,
    params,
  );

  const series = await measurementSummaries(
    getDb(),
    ctx,
    rows.rows.map((row) => row.opportunity_id),
  );
  return rows.rows.map((row) =>
    assembleOpportunity(
      {
        id: row.opportunity_id,
        tenantId: row.opportunity_tenant_id,
        createdAt: row.opportunity_created_at,
      },
      mapVersion(row),
      series.get(row.opportunity_id),
    ),
  );
}

export async function getOpportunityVersion(
  ctx: TenantContext,
  query: GetAutomationOpportunityVersionQuery,
): Promise<AutomationOpportunityVersion> {
  assertAutomationTenantContext(ctx);
  const valid = validateVersionQuery(query);
  if (!isUuid(valid.opportunityId)) throw opportunityNotFound(valid.opportunityId);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM automation_opportunity_versions
      WHERE tenant_id = $1 AND opportunity_id = $2 AND version = $3`,
    [ctx.tenantId, valid.opportunityId, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) throw versionNotFound(valid.opportunityId, valid.version);
  return mapVersion(row);
}

export async function listOpportunityVersions(
  ctx: TenantContext,
  query: ListAutomationOpportunityVersionsQuery,
): Promise<AutomationOpportunityVersion[]> {
  assertAutomationTenantContext(ctx);
  const valid = validateHistoryQuery(query);
  if (!isUuid(valid.opportunityId)) throw opportunityNotFound(valid.opportunityId);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM automation_opportunity_versions
      WHERE tenant_id = $1 AND opportunity_id = $2
      ORDER BY version ASC`,
    [ctx.tenantId, valid.opportunityId],
  );
  if (rows.rows.length === 0) throw opportunityNotFound(valid.opportunityId);
  return rows.rows.map(mapVersion);
}

export async function getMeasurement(
  ctx: TenantContext,
  query: GetAutomationMeasurementQuery,
): Promise<AutomationMeasurement> {
  assertAutomationTenantContext(ctx);
  const valid = validateMeasurementQuery(query);
  if (!isUuid(valid.measurementId)) throw measurementNotFound(valid.measurementId);

  const rows = await getDb().query<MeasurementRow>(
    `SELECT * FROM automation_measurements WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.measurementId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw measurementNotFound(valid.measurementId);
  return mapMeasurement(row);
}

export async function listMeasurements(
  ctx: TenantContext,
  query: ListAutomationMeasurementsQuery,
): Promise<AutomationMeasurement[]> {
  assertAutomationTenantContext(ctx);
  const valid = validateMeasurementsQuery(query);
  if (!isUuid(valid.opportunityId)) throw opportunityNotFound(valid.opportunityId);

  const rows = await getDb().query<MeasurementRow>(
    `SELECT * FROM automation_measurements
      WHERE tenant_id = $1 AND opportunity_id = $2
      ORDER BY recorded_at ASC, id ASC`,
    [ctx.tenantId, valid.opportunityId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such opportunity in this tenant" from "an accepted
    // opportunity without measurements" — a foreign-tenant opportunity id
    // reads the same as a missing one either way; the explicit check keeps
    // the error honest (the learning module's pattern).
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM automation_opportunities WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.opportunityId],
    );
    if (exists.rows.length === 0) throw opportunityNotFound(valid.opportunityId);
  }
  return rows.rows.map(mapMeasurement);
}
