// Implementation of the execution-fabric module's public operations (see
// contract.ts).
//
// W137 — Execution Environment / Agent Computer Fabric (spec/work-items/
// WORK-ITEM-CATALOG.md §W137): vendor-neutral environment definitions,
// the lease/lifecycle state machine binding an environment to an
// agent-exchange execution run (W136), and the adapter registry behind
// the frozen W131 ExecutionAdapter capability-shape. The fabric OWNS
// execution environments; it never becomes an execution authority: no
// operation here submits, dispatches, pumps or cancels an agents-module
// execution, never drives a browser step plan itself and never decides
// an approval. The catalog's three evaluated paths (local container,
// Playwright/Chromium browser, E2B-equivalent remote sandbox) are
// ADAPTERS behind the frozen kinds, registered through the in-memory
// wiring registry (registerExecutionAdapter) and resolved at
// acquisition — vendor identity is METADATA on the descriptor, never a
// type-system citizen, never a domain value.
//
// TRANSACTION DISCIPLINE (the W134 law, binding — the agent-exchange
// exemplar): PGlite is single-connection, so every cross-module read
// (the agent-exchange plan/run gates) and every evidence gate runs on
// the BASE connection BEFORE the mutation transaction opens; each
// mutation then keeps its append + lifecycle transition atomic in ONE
// transaction whose statements touch only this module's tables. The
// one-way lifecycle transitions re-check their legality under a FOR
// UPDATE row lock (the staleness re-check — a racing transition that
// committed first owns the state). Adapter I/O (open/resume/close) is
// external to the database and therefore happens OUTSIDE every
// transaction: prepare resolves and opens first, then one transaction
// stamps the live state under the lock; a vendor-path failure stamps
// the lease 'failed' with the actionable detail (honest failure
// evidence), then refuses with the typed code.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by newId(); semantic
// timestamps come from the injectable clock; principals are
// system-captured from the explicit TenantContext; every statement is
// scoped by tenant (ADR-0001) — cross-tenant access is
// indistinguishable from missing records (uniform typed not-found, no
// existence leak).
//
// Deterministic orders (test-locked): definitions newest first
// (created_at DESC, id DESC); leases newest first (created_at DESC,
// id DESC); events, artifacts, evidence and checkpoints by
// (recorded_at ASC, id ASC) — the evidence-timeline order.

import { now } from '@/infra/clock';
import { getDb, type DbPort, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type {
  ExecutionEnvironmentKind,
  ExecutionEnvironmentDescriptor,
  SessionIsolationProperties,
} from '@/modules/execution/contract';
import {
  AgentExchangeError,
  getExecutionPlan,
  listExecutionRuns,
} from '@/modules/agent-exchange/contract';
import type { ExecutionRun } from '@/modules/agent-exchange/contract';
import { ExecutionFabricError } from './errors';
import {
  FABRIC_LEASE_ARTIFACT_SERVABLE_STATUSES,
  FABRIC_LEASE_EVIDENCE_SERVABLE_STATUSES,
  FABRIC_LEASE_CHECKPOINT_SERVABLE_STATUSES,
  FABRIC_LEASE_TERMINAL_STATUSES,
  MAX_DETAIL_CHARS,
  assertExecutionFabricTenantContext,
  fabricLeaseTransitionProblem,
  validateLeaseIdInput,
  validateAcquireFabricLeaseInput,
  validateCancelFabricLeaseInput,
  validateFailFabricLeaseInput,
  validateGetEnvironmentDefinitionQuery,
  validateGetFabricLeaseQuery,
  validateHandbackFabricLeaseInput,
  validateListArtifactHandoffsQuery,
  validateListEnvironmentDefinitionsQuery,
  validateListFabricLeasesQuery,
  validateListLeaseCheckpointsQuery,
  validateListLeaseEventsQuery,
  validateListLeaseEvidenceQuery,
  validateMarkFabricLeaseLostInput,
  validateRecordArtifactHandoffInput,
  validateRecordLeaseCheckpointInput,
  validateRecordLeaseEvidenceInput,
  validateRegisterEnvironmentDefinitionInput,
  validateReleaseFabricLeaseInput,
  validateRetireEnvironmentDefinitionInput,
  validateTakeoverFabricLeaseInput,
} from './validation';
import type {
  ValidatedAcquireInput,
  ValidatedArtifactInput,
  ValidatedCheckpointInput,
  ValidatedEvidenceInput,
  ValidatedRegisterDefinitionInput,
} from './validation';
import type {
  EnvironmentDefinition,
  FabricLease,
  FabricLeaseEvent,
  FabricLeaseStatus,
  FabricLeaseTransition,
  LeaseArtifactHandoff,
  LeaseCheckpoint,
  LeaseEvidenceRecord,
  RegisteredAdapterView,
  RegisterEnvironmentDefinitionInput,
  AcquireFabricLeaseInput,
  TakeoverFabricLeaseInput,
  HandbackFabricLeaseInput,
  MarkFabricLeaseLostInput,
  CancelFabricLeaseInput,
  ReleaseFabricLeaseInput,
  FailFabricLeaseInput,
  RecordArtifactHandoffInput,
  RecordLeaseEvidenceInput,
  RecordLeaseCheckpointInput,
  GetEnvironmentDefinitionQuery,
  ListEnvironmentDefinitionsQuery,
  GetFabricLeaseQuery,
  ListFabricLeasesQuery,
  ListLeaseEventsQuery,
  ListArtifactHandoffsQuery,
  ListLeaseEvidenceQuery,
  ListLeaseCheckpointsQuery,
} from './types';
import type { FabricAdapter } from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface DefinitionRow extends DbRow {
  id: string;
  tenant_id: string;
  def_key: string;
  display_name: string;
  kind: string;
  tenant_isolated: boolean;
  profile_scope: string;
  network_egress: string;
  credential_handling: string;
  survives_restart: boolean;
  checkpoint_level: string;
  persistent_scope: string | null;
  required_capabilities: string[];
  status: string;
  note: string | null;
  created_by: string;
  created_at: Date | string;
  retired_at: Date | string | null;
}

interface LeaseRow extends DbRow {
  id: string;
  tenant_id: string;
  definition_id: string;
  plan_id: string;
  execution_run_id: string;
  task_key: string;
  agent_id: string;
  credential_ref: string | null;
  status: string;
  adapter_id: string | null;
  session_id: string | null;
  lease_minutes: number | string;
  lease_until: Date | string | null;
  last_heartbeat_at: Date | string | null;
  opened_at: Date | string | null;
  taken_over_at: Date | string | null;
  takeover_holder: string | null;
  takeover_reason: string | null;
  authority_action_ref: string | null;
  handback_at: Date | string | null;
  handback_note: string | null;
  cancellation_requested_at: Date | string | null;
  cancel_reason: string | null;
  lost_at: Date | string | null;
  lost_detail: string | null;
  recovery_detected_at: Date | string | null;
  recovered_at: Date | string | null;
  recovered_from_checkpoint_ref: string | null;
  released_at: Date | string | null;
  release_reason: string | null;
  failed_at: Date | string | null;
  failure_detail: string | null;
  acquired_by: string;
  created_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  lease_id: string;
  kind: string;
  payload: Record<string, unknown>;
  recorded_by: string;
  recorded_at: Date | string;
}

interface ArtifactRow extends DbRow {
  id: string;
  tenant_id: string;
  lease_id: string;
  direction: string;
  artifact_ref: string;
  artifact_kind: string;
  digest: string | null;
  recorded_by: string;
  recorded_at: Date | string;
}

interface EvidenceRow extends DbRow {
  id: string;
  tenant_id: string;
  lease_id: string;
  capture_kind: string;
  artifact_ref: string;
  verification: string;
  detail: string | null;
  redaction: string;
  recorded_by: string;
  recorded_at: Date | string;
}

interface CheckpointRow extends DbRow {
  id: string;
  tenant_id: string;
  lease_id: string;
  cursor: string;
  covered_evidence_refs: string[];
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toCount(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function mapDefinition(row: DefinitionRow): EnvironmentDefinition {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    defKey: row.def_key,
    displayName: row.display_name,
    kind: row.kind as EnvironmentDefinition['kind'],
    isolation: {
      tenantIsolated: true,
      profileScope: row.profile_scope as EnvironmentDefinition['isolation']['profileScope'],
      networkEgress: row.network_egress as EnvironmentDefinition['isolation']['networkEgress'],
      credentialHandling: 'opaque-ref-only',
    },
    persistence: {
      survivesRestart: row.survives_restart,
      checkpoint: row.checkpoint_level as EnvironmentDefinition['persistence']['checkpoint'],
      persistentScope: row.persistent_scope ?? undefined,
    },
    requiredCapabilities: (row.required_capabilities ?? []) as EnvironmentDefinition['requiredCapabilities'],
    status: row.status as EnvironmentDefinition['status'],
    note: row.note,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
  };
}

function mapLease(row: LeaseRow): FabricLease {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    definitionId: row.definition_id,
    definitionKey: '',
    definitionKind: 'local',
    planId: row.plan_id,
    executionRunId: row.execution_run_id,
    taskKey: row.task_key,
    agentId: row.agent_id,
    credentialRef: row.credential_ref,
    status: row.status as FabricLeaseStatus,
    adapterId: row.adapter_id,
    sessionId: row.session_id,
    leaseMinutes: toCount(row.lease_minutes),
    leaseUntil: row.lease_until === null ? null : toIso(row.lease_until),
    lastHeartbeatAt: row.last_heartbeat_at === null ? null : toIso(row.last_heartbeat_at),
    openedAt: row.opened_at === null ? null : toIso(row.opened_at),
    takenOverAt: row.taken_over_at === null ? null : toIso(row.taken_over_at),
    takeoverHolder: row.takeover_holder as FabricLease['takeoverHolder'],
    takeoverReason: row.takeover_reason,
    authorityActionRef: row.authority_action_ref,
    handbackAt: row.handback_at === null ? null : toIso(row.handback_at),
    handbackNote: row.handback_note,
    cancellationRequestedAt:
      row.cancellation_requested_at === null ? null : toIso(row.cancellation_requested_at),
    cancelReason: row.cancel_reason,
    lostAt: row.lost_at === null ? null : toIso(row.lost_at),
    lostDetail: row.lost_detail,
    recoveryDetectedAt:
      row.recovery_detected_at === null ? null : toIso(row.recovery_detected_at),
    recoveredAt: row.recovered_at === null ? null : toIso(row.recovered_at),
    recoveredFromCheckpointRef: row.recovered_from_checkpoint_ref,
    releasedAt: row.released_at === null ? null : toIso(row.released_at),
    releaseReason: row.release_reason,
    failedAt: row.failed_at === null ? null : toIso(row.failed_at),
    failureDetail: row.failure_detail,
    acquiredBy: row.acquired_by,
    createdAt: toIso(row.created_at),
  };
}

function mapEvent(row: EventRow): FabricLeaseEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    leaseId: row.lease_id,
    kind: row.kind as FabricLeaseEvent['kind'],
    payload: row.payload ?? {},
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapArtifact(row: ArtifactRow): LeaseArtifactHandoff {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    leaseId: row.lease_id,
    direction: row.direction as LeaseArtifactHandoff['direction'],
    artifactRef: row.artifact_ref,
    artifactKind: row.artifact_kind,
    digest: row.digest,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapEvidence(row: EvidenceRow): LeaseEvidenceRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    leaseId: row.lease_id,
    captureKind: row.capture_kind as LeaseEvidenceRecord['captureKind'],
    artifactRef: row.artifact_ref,
    verification: row.verification as LeaseEvidenceRecord['verification'],
    detail: row.detail,
    redaction: 'applied',
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapCheckpoint(row: CheckpointRow): LeaseCheckpoint {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    leaseId: row.lease_id,
    cursor: row.cursor,
    coveredEvidenceRefs: row.covered_evidence_refs ?? [],
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

/** The lease read enriched with its definition's denormalized display fields. */
async function toLeaseView(db: Queryable, ctx: TenantContext, row: LeaseRow): Promise<FabricLease> {
  const lease = mapLease(row);
  const definition = await db.query<DefinitionRow>(
    `SELECT def_key, kind FROM environment_definitions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, row.definition_id],
  );
  const defRow = definition.rows[0];
  lease.definitionKey = defRow?.def_key ?? '';
  lease.definitionKind = (defRow?.kind ?? 'local') as FabricLease['definitionKind'];
  return lease;
}

// ---------------------------------------------------------------------------
// Tenant-scoped loaders (uniform not-found discipline — ADR-0001)
// ---------------------------------------------------------------------------

async function findDefinitionRow(
  db: Queryable,
  ctx: TenantContext,
  definitionId: string,
  forUpdate: boolean,
): Promise<DefinitionRow | null> {
  const result = await db.query<DefinitionRow>(
    `SELECT * FROM environment_definitions WHERE tenant_id = $1 AND id = $2${
      forUpdate ? ' FOR UPDATE' : ''
    }`,
    [ctx.tenantId, definitionId],
  );
  return result.rows[0] ?? null;
}

async function loadDefinitionRow(
  db: Queryable,
  ctx: TenantContext,
  definitionId: string,
  forUpdate: boolean,
): Promise<DefinitionRow> {
  const row = await findDefinitionRow(db, ctx, definitionId, forUpdate);
  if (row === null) {
    throw new ExecutionFabricError(
      'definition_not_found',
      `no environment definition '${definitionId}' exists in this tenant`,
    );
  }
  return row;
}

async function findLeaseRow(
  db: Queryable,
  ctx: TenantContext,
  leaseId: string,
  forUpdate: boolean,
): Promise<LeaseRow | null> {
  const result = await db.query<LeaseRow>(
    `SELECT * FROM fabric_leases WHERE tenant_id = $1 AND id = $2${forUpdate ? ' FOR UPDATE' : ''}`,
    [ctx.tenantId, leaseId],
  );
  return result.rows[0] ?? null;
}

async function loadLeaseRow(
  db: Queryable,
  ctx: TenantContext,
  leaseId: string,
  forUpdate: boolean,
): Promise<LeaseRow> {
  const row = await findLeaseRow(db, ctx, leaseId, forUpdate);
  if (row === null) {
    throw new ExecutionFabricError(
      'lease_not_found',
      `no fabric lease '${leaseId}' exists in this tenant`,
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Lifecycle error mapping — the single legality definition (validation.ts)
// drives every typed refusal; the storage guard mirrors it (defense in
// depth) and can never be reached by a legal service call.
// ---------------------------------------------------------------------------

function isTerminal(status: FabricLeaseStatus): boolean {
  return (FABRIC_LEASE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

function transitionProblemOf(
  transition: FabricLeaseTransition,
  from: FabricLeaseStatus,
): string | null {
  return fabricLeaseTransitionProblem(transition, from);
}

/** Pre-transaction lifecycle posture for a named transition. */
function assertTransitionLegal(
  transition: FabricLeaseTransition,
  from: FabricLeaseStatus,
): void {
  const problem = transitionProblemOf(transition, from);
  if (problem === null) return;
  if (isTerminal(from)) {
    throw new ExecutionFabricError('lease_already_terminal', problem);
  }
  const code = (() => {
    switch (transition) {
      case 'prepare':
        return 'lease_not_preparing' as const;
      case 'takeover':
        return 'lease_not_live' as const;
      case 'handback':
        return 'lease_not_suspended' as const;
      case 'recover':
        return 'lease_not_lost' as const;
      case 'release':
        return from === 'suspended' ? ('lease_suspended' as const) : ('invalid_transition' as const);
      default:
        return 'invalid_transition' as const;
    }
  })();
  throw new ExecutionFabricError(code, problem);
}

/** The servable-posture check for the append-only evidence operations. */
function assertServable(
  what: 'artifact' | 'evidence' | 'checkpoint',
  from: FabricLeaseStatus,
): void {
  const allowed: Record<typeof what, readonly string[]> = {
    artifact: FABRIC_LEASE_ARTIFACT_SERVABLE_STATUSES,
    evidence: FABRIC_LEASE_EVIDENCE_SERVABLE_STATUSES,
    checkpoint: FABRIC_LEASE_CHECKPOINT_SERVABLE_STATUSES,
  };
  if ((allowed[what] as readonly string[]).includes(from)) return;
  if (isTerminal(from)) {
    throw new ExecutionFabricError(
      'lease_already_terminal',
      `a ${from} lease is terminal — the lifecycle is one-way past ${from}`,
    );
  }
  throw new ExecutionFabricError(
    'invalid_transition',
    `recording ${what} requires an in-flight lease (allowed: ${allowed[what].join(', ')}) — this lease is ${from}`,
  );
}

function leaseUntilFrom(at: Date, minutes: number): Date {
  return new Date(at.getTime() + minutes * 60_000);
}

function boundedDetail(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS ? detail.slice(0, MAX_DETAIL_CHARS) : detail;
}

// ---------------------------------------------------------------------------
// The append-only event tail
// ---------------------------------------------------------------------------

async function appendEvent(
  tx: Queryable,
  ctx: TenantContext,
  leaseId: string,
  kind: FabricLeaseEvent['kind'],
  payload: Record<string, unknown>,
  recordedAt: Date,
): Promise<void> {
  await tx.query(
    `INSERT INTO fabric_lease_events
       (id, tenant_id, lease_id, kind, payload, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [newId(), ctx.tenantId, leaseId, kind, JSON.stringify(payload), ctx.principalId, recordedAt],
  );
}

// ---------------------------------------------------------------------------
// The adapter registry — in-memory wiring, never domain state (the
// migration's law: removing an adapter never touches a lease row; the
// vendor-removal clause). Registration probes the adapter (the ZCode
// completed-handshake discipline adopted by W131: a backend appears in
// discovery only after a completed handshake) and captures the honest
// descriptor; re-registering the same adapterId replaces the entry with
// a fresh generation (the generation counter — old generations never
// drift into new connections).
// ---------------------------------------------------------------------------

interface AdapterRegistration {
  adapter: FabricAdapter;
  descriptor: ExecutionEnvironmentDescriptor;
  registrationIndex: number;
}

const adapterRegistry = new Map<string, AdapterRegistration>();
let registrationCounter = 0;

export async function registerExecutionAdapter(
  adapter: FabricAdapter,
): Promise<RegisteredAdapterView> {
  const descriptor = await adapter.probe();
  registrationCounter += 1;
  const registrationIndex = registrationCounter;
  adapterRegistry.set(adapter.adapterId, { adapter, descriptor, registrationIndex });
  return { descriptor, registrationIndex };
}

/**
 * THE VENDOR-REMOVAL OPERATION: unregister an adapter. Reads of leases
 * the adapter served still work (the domain rows are untouched); prepare
 * and recover on those leases refuse with `adapter_not_registered`
 * until the adapter is re-registered — the domain contracts did not
 * change (the vendor-removal clause, test-locked).
 */
export function unregisterExecutionAdapter(adapterId: string): boolean {
  return adapterRegistry.delete(adapterId);
}

export function listRegisteredAdapters(): RegisteredAdapterView[] {
  return [...adapterRegistry.values()]
    .sort((a, b) => a.registrationIndex - b.registrationIndex)
    .map((entry) => ({ descriptor: entry.descriptor, registrationIndex: entry.registrationIndex }));
}

function requireRegisteredAdapter(adapterId: string): AdapterRegistration {
  const registration = adapterRegistry.get(adapterId);
  if (registration === undefined) {
    throw new ExecutionFabricError(
      'adapter_not_registered',
      `the adapter '${adapterId}' this lease was acquired on is no longer registered — the vendor path was removed (re-register it, or fail the lease; the domain records are untouched)`,
    );
  }
  return registration;
}

/**
 * Resolve the adapter that serves one definition: same frozen kind,
 * honest health ('available'), and every REQUIRED capability domain
 * declared supported (the honest-descriptor law — an adapter that
 * cannot serve a required domain refuses explicitly; the fabric never
 * fabricates a capability). Deterministic: the earliest-registered
 * capable adapter wins.
 */
function resolveServingAdapter(definition: DefinitionRow): AdapterRegistration {
  const serving = [...adapterRegistry.values()]
    .sort((a, b) => a.registrationIndex - b.registrationIndex)
    .filter((entry) => entry.descriptor.kind === definition.kind);
  if (serving.length === 0) {
    throw new ExecutionFabricError(
      'adapter_unavailable',
      `no registered adapter serves the '${definition.kind}' environment kind — register one before acquiring (nothing is wired by default; the fabric never fakes success)`,
    );
  }
  const healthy = serving.filter((entry) => entry.descriptor.health === 'available');
  if (healthy.length === 0) {
    throw new ExecutionFabricError(
      'adapter_unavailable',
      `every registered '${definition.kind}' adapter is currently '${serving[0]!.descriptor.health}' — the honest declaration refuses acquisition`,
    );
  }
  for (const entry of healthy) {
    const missing = definition.required_capabilities.filter(
      (domain) =>
        !entry.descriptor.capabilities.some(
          (capability) => capability.domain === domain && capability.supported,
        ),
    );
    if (missing.length === 0) return entry;
    if (entry === healthy[0]) {
      throw new ExecutionFabricError(
        'adapter_capability_unsupported',
        `the '${definition.kind}' adapter '${entry.descriptor.adapterId}' declares supported:false for required capability domain(s): ${missing.join(', ')} — the honest-descriptor law forbids fabricating the capability`,
      );
    }
  }
  throw new ExecutionFabricError(
    'adapter_capability_unsupported',
    `no available '${definition.kind}' adapter declares every required capability domain (${definition.required_capabilities.join(', ')})`,
  );
}

// ---------------------------------------------------------------------------
// The W136 evidence gates — ALWAYS on the base connection, BEFORE the
// mutation transaction (the W134 law). The exchange's reads are
// plan-scoped; the fabric consumes them read-only and never leaks
// existence across tenants.
// ---------------------------------------------------------------------------

/**
 * The plan must be readable in this tenant and ACTIVE — the fabric
 * serves in-flight orchestration only (a completed/abandoned plan
 * acquires no new environments).
 */
async function requireActiveExchangePlan(ctx: TenantContext, planId: string): Promise<void> {
  let plan;
  try {
    plan = await getExecutionPlan(ctx, { planId });
  } catch (error) {
    if (error instanceof AgentExchangeError) {
      throw new ExecutionFabricError(
        'exchange_plan_not_found',
        `execution plan '${planId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (plan.status !== 'active') {
    throw new ExecutionFabricError(
      'exchange_plan_not_found',
      `execution plan '${planId}' is ${plan.status} — the fabric serves in-flight orchestration only`,
    );
  }
}

/**
 * The execution run must be recorded on the named plan and readable in
 * this tenant. HONEST LIMITATION (documented in WORK-NOTES): the
 * exchange's read surface exposes the plan's run tail as an
 * oldest-first bounded list (limit 1..500, no offset read), so the gate
 * resolves the run within the plan's first 500 recorded runs — deeper
 * histories need a W136-integration read op (recorded as the open
 * composition question).
 */
async function requireExecutionRunOnPlan(
  ctx: TenantContext,
  planId: string,
  executionRunId: string,
): Promise<ExecutionRun> {
  const runs = await listExecutionRuns(ctx, { planId, limit: 500 });
  const run = runs.find((entry) => entry.id === executionRunId);
  if (run === undefined) {
    throw new ExecutionFabricError(
      'execution_run_not_found',
      `execution run '${executionRunId}' is not recorded on plan '${planId}' in this tenant`,
    );
  }
  return run;
}

// ---------------------------------------------------------------------------
// Environment definitions
// ---------------------------------------------------------------------------

export async function registerEnvironmentDefinition(
  ctx: TenantContext,
  input: RegisterEnvironmentDefinitionInput,
): Promise<EnvironmentDefinition> {
  assertExecutionFabricTenantContext(ctx);
  const valid: ValidatedRegisterDefinitionInput = validateRegisterEnvironmentDefinitionInput(input);
  const db = getDb();

  const existing = await db.query<DefinitionRow>(
    `SELECT id FROM environment_definitions WHERE tenant_id = $1 AND def_key = $2`,
    [ctx.tenantId, valid.defKey],
  );
  if (existing.rows.length > 0) {
    throw new ExecutionFabricError(
      'definition_key_taken',
      `defKey '${valid.defKey}' is already registered in this tenant — a changed definition is a NEW definition under a NEW key`,
    );
  }

  const definitionId = newId();
  const createdAt = now();
  await db.query(
    `INSERT INTO environment_definitions
       (id, tenant_id, def_key, display_name, kind, tenant_isolated, profile_scope,
        network_egress, credential_handling, survives_restart, checkpoint_level,
        persistent_scope, required_capabilities, status, note, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, true, $6, $7, 'opaque-ref-only', $8, $9, $10, $11, 'active', $12, $13, $14)`,
    [
      definitionId,
      ctx.tenantId,
      valid.defKey,
      valid.displayName,
      valid.kind,
      valid.profileScope,
      valid.networkEgress,
      valid.survivesRestart,
      valid.checkpoint,
      valid.persistentScope,
      valid.requiredCapabilities,
      valid.note,
      ctx.principalId,
      createdAt,
    ],
  );

  return getEnvironmentDefinition(ctx, { definitionId });
}

export async function retireEnvironmentDefinition(
  ctx: TenantContext,
  input: { definitionId: string },
): Promise<EnvironmentDefinition> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateRetireEnvironmentDefinitionInput(input);
  const db = getDb();

  // Pre-transaction posture (uniform not-found + one-way check).
  const existing = await loadDefinitionRow(db, ctx, valid.definitionId, false);
  if (existing.status !== 'active') {
    throw new ExecutionFabricError(
      'definition_already_retired',
      `environment definition '${valid.definitionId}' is already retired — the lifecycle is one-way, terminal`,
    );
  }

  const retiredAt = now();
  await db.transaction(async (tx) => {
    const row = await loadDefinitionRow(tx, ctx, valid.definitionId, true);
    if (row.status !== 'active') {
      // The staleness re-check: a racing retirement owns the terminal state.
      throw new ExecutionFabricError(
        'definition_already_retired',
        `environment definition '${valid.definitionId}' is already retired — the lifecycle is one-way, terminal`,
      );
    }
    await tx.query(
      `UPDATE environment_definitions
         SET status = 'retired', retired_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.definitionId, retiredAt],
    );
  });

  return getEnvironmentDefinition(ctx, { definitionId: valid.definitionId });
}

// ---------------------------------------------------------------------------
// acquireFabricLease — the environment joins ONE execution run
// ---------------------------------------------------------------------------

export async function acquireFabricLease(
  ctx: TenantContext,
  input: AcquireFabricLeaseInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid: ValidatedAcquireInput = validateAcquireFabricLeaseInput(input);
  const db = getDb();

  // ---- EVERY gate BEFORE the transaction (the W134/W135 law) ----
  const definition = await loadDefinitionRow(db, ctx, valid.definitionId, false);
  if (definition.status !== 'active') {
    throw new ExecutionFabricError(
      'definition_retired',
      `environment definition '${definition.def_key}' is retired — existing leases continue; new ones refuse`,
    );
  }
  await requireActiveExchangePlan(ctx, valid.planId);
  const run = await requireExecutionRunOnPlan(ctx, valid.planId, valid.executionRunId);
  const resolved = resolveServingAdapter(definition);

  const leaseId = newId();
  const createdAt = now();

  // ---- ONE transaction: definition staleness re-check under the lock,
  // then the lease append + its 'acquired' event (an atomic pair) ----
  await db.transaction(async (tx) => {
    const fresh = await loadDefinitionRow(tx, ctx, valid.definitionId, true);
    if (fresh.status !== 'active') {
      throw new ExecutionFabricError(
        'definition_retired',
        `environment definition '${fresh.def_key}' retired while the lease was being acquired — the lifecycle is one-way`,
      );
    }
    await tx.query(
      `INSERT INTO fabric_leases
         (id, tenant_id, definition_id, plan_id, execution_run_id, task_key, agent_id,
          credential_ref, status, adapter_id, lease_minutes, acquired_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'preparing', $9, $10, $11, $12)`,
      [
        leaseId,
        ctx.tenantId,
        valid.definitionId,
        valid.planId,
        valid.executionRunId,
        run.taskKey,
        run.agentId,
        valid.credentialRef,
        resolved.descriptor.adapterId,
        valid.leaseMinutes,
        ctx.principalId,
        createdAt,
      ],
    );
    await appendEvent(tx, ctx, leaseId, 'acquired', {
      definitionKey: fresh.def_key,
      definitionKind: fresh.kind,
      planId: valid.planId,
      executionRunId: valid.executionRunId,
      taskKey: run.taskKey,
      agentId: run.agentId,
      adapterId: resolved.descriptor.adapterId,
      leaseMinutes: valid.leaseMinutes,
    }, createdAt);
  });

  return getFabricLease(ctx, { leaseId });
}

// ---------------------------------------------------------------------------
// prepareFabricLease — the adapter opens the disposable session
// ---------------------------------------------------------------------------

export async function prepareFabricLease(
  ctx: TenantContext,
  input: { leaseId: string },
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateLifecycleLeaseId(input);
  const db = getDb();

  // Pre-transaction posture.
  const lease = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('prepare', lease.status as FabricLeaseStatus);
  const definition = await loadDefinitionRow(db, ctx, lease.definition_id, false);
  const registration = requireRegisteredAdapter(lease.adapter_id ?? '');

  // Adapter I/O OUTSIDE every transaction (external to the database).
  let session;
  try {
    session = await registration.adapter.open({
      tenantId: ctx.tenantId,
      environmentKind: definition.kind as ExecutionEnvironmentKind,
      profileScope: definition.profile_scope as SessionIsolationProperties['profileScope'],
      credentialRef: lease.credential_ref ?? undefined,
      subjectRef: lease.id,
    });
  } catch (error) {
    await stampVendorFailure(db, ctx, valid.leaseId, 'prepare', error);
    throw new ExecutionFabricError(
      'adapter_open_failed',
      `the adapter failed to open the session: ${String(error instanceof Error ? error.message : error)}`,
    );
  }

  const at = now();
  const leaseUntil = leaseUntilFrom(at, toCount(lease.lease_minutes));
  try {
    await db.transaction(async (tx) => {
      const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
      const problem = transitionProblemOf('prepare', row.status as FabricLeaseStatus);
      if (problem !== null) {
        throw new ExecutionFabricError(
          isTerminal(row.status as FabricLeaseStatus) ? 'lease_already_terminal' : 'lease_not_preparing',
          problem,
        );
      }
      await tx.query(
        `UPDATE fabric_leases
           SET status = 'live', session_id = $3, opened_at = $4, lease_until = $5,
               last_heartbeat_at = $4
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.leaseId, session.sessionId, at, leaseUntil],
      );
      await appendEvent(tx, ctx, valid.leaseId, 'prepared', {
        sessionId: session.sessionId,
        leaseUntil: leaseUntil.toISOString(),
      }, at);
    });
  } catch (error) {
    if (error instanceof ExecutionFabricError) {
      // A racing terminal transition owns the lease: the freshly opened
      // disposable session is closed best-effort (sessions are
      // disposable; the lease is the durable truth).
      await closeSessionBestEffort(registration.adapter, session.sessionId, 'prepare-raced');
    }
    throw error;
  }

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

/**
 * The vendor-path failure stamp: an open/resume that threw parks the
 * lease 'failed' with the actionable detail (honest failure evidence),
 * then the caller refuses with the typed code. A racing terminal
 * transition wins — nothing is stamped on a terminal row.
 */
async function stampVendorFailure(
  db: DbPort,
  ctx: TenantContext,
  leaseId: string,
  phase: 'prepare' | 'recover',
  error: unknown,
): Promise<void> {
  const detail = boundedDetail(
    `${phase} vendor-path failure: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, leaseId, true);
    const problem = transitionProblemOf('fail', row.status as FabricLeaseStatus);
    if (problem !== null) return; // a racing transition owns the state
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'failed', failed_at = $3, failure_detail = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, leaseId, at, detail],
    );
    await appendEvent(tx, ctx, leaseId, 'failure', { detail, phase }, at);
  });
}

async function closeSessionBestEffort(
  adapter: FabricAdapter,
  sessionId: string,
  reason: string,
): Promise<void> {
  try {
    await adapter.close(sessionId, reason);
  } catch {
    // Vendor-path cleanup after (or beside) a committed domain state is
    // best-effort: the evidence tail already holds the domain truth and
    // a vendor close failure never resurrects or re-opens a lease
    // (documented ruling — sessions are disposable by contract).
  }
}

function validateLifecycleLeaseId(input: { leaseId: string }): { leaseId: string } {
  return validateLeaseIdInput(input, 'invalid_lifecycle_input');
}

// ---------------------------------------------------------------------------
// takeover / handback — the human control cycle (W131 'Take control')
// ---------------------------------------------------------------------------

export async function takeoverFabricLease(
  ctx: TenantContext,
  input: TakeoverFabricLeaseInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateTakeoverInput(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('takeover', existing.status as FabricLeaseStatus);

  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    const problem = transitionProblemOf('takeover', row.status as FabricLeaseStatus);
    if (problem !== null) {
      throw new ExecutionFabricError(
        isTerminal(row.status as FabricLeaseStatus) ? 'lease_already_terminal' : 'lease_not_live',
        problem,
      );
    }
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'suspended', taken_over_at = $3, takeover_holder = 'human',
             takeover_reason = $4, authority_action_ref = $5
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, at, valid.reason, valid.authorityActionRef],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'takeover', {
      reason: valid.reason,
      authorityActionRef: valid.authorityActionRef,
      sessionId: row.session_id,
    }, at);
  });

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

export async function handbackFabricLease(
  ctx: TenantContext,
  input: HandbackFabricLeaseInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateHandbackInput(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('handback', existing.status as FabricLeaseStatus);

  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    const problem = transitionProblemOf('handback', row.status as FabricLeaseStatus);
    if (problem !== null) {
      throw new ExecutionFabricError(
        isTerminal(row.status as FabricLeaseStatus)
          ? 'lease_already_terminal'
          : 'lease_not_suspended',
        problem,
      );
    }
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'live', handback_at = $3, handback_note = $4, takeover_holder = NULL
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, at, valid.note],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'handback', {
      note: valid.note,
      sessionId: row.session_id,
    }, at);
  });

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

// ---------------------------------------------------------------------------
// heartbeat — the live lease renews its window
// ---------------------------------------------------------------------------

export async function heartbeatFabricLease(
  ctx: TenantContext,
  input: { leaseId: string },
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateLifecycleLeaseId(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  if (existing.status !== 'live') {
    if (isTerminal(existing.status as FabricLeaseStatus)) {
      throw new ExecutionFabricError(
        'lease_already_terminal',
        `a ${existing.status} lease is terminal — the lifecycle is one-way past ${existing.status}`,
      );
    }
    throw new ExecutionFabricError(
      'lease_not_live',
      `heartbeat requires a live lease — this lease is ${existing.status}`,
    );
  }

  const at = now();
  const leaseUntil = leaseUntilFrom(at, toCount(existing.lease_minutes));
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    if (row.status !== 'live') {
      throw new ExecutionFabricError(
        isTerminal(row.status as FabricLeaseStatus) ? 'lease_already_terminal' : 'lease_not_live',
        `heartbeat requires a live lease — this lease is ${row.status}`,
      );
    }
    await tx.query(
      `UPDATE fabric_leases
         SET lease_until = $3, last_heartbeat_at = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, leaseUntil, at],
    );
  });

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

// ---------------------------------------------------------------------------
// markFabricLeaseLost — lease death parks (NOT terminal)
// ---------------------------------------------------------------------------

export async function markFabricLeaseLost(
  ctx: TenantContext,
  input: MarkFabricLeaseLostInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateMarkLostInput(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('markLost', existing.status as FabricLeaseStatus);

  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    const problem = transitionProblemOf('markLost', row.status as FabricLeaseStatus);
    if (problem !== null) {
      throw new ExecutionFabricError(
        isTerminal(row.status as FabricLeaseStatus) ? 'lease_already_terminal' : 'invalid_transition',
        problem,
      );
    }
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'lost', lost_at = $3, lost_detail = $4, takeover_holder = NULL
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, at, valid.detail],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'loss', {
      detail: valid.detail,
      sessionId: row.session_id,
    }, at);
  });

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

// ---------------------------------------------------------------------------
// recoverFabricLease — a FRESH session from the checkpoint
// ---------------------------------------------------------------------------

export async function recoverFabricLease(
  ctx: TenantContext,
  input: { leaseId: string },
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateLifecycleLeaseId(input);
  const db = getDb();

  // Pre-transaction posture.
  const lease = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('recover', lease.status as FabricLeaseStatus);
  const definition = await loadDefinitionRow(db, ctx, lease.definition_id, false);
  const registration = requireRegisteredAdapter(lease.adapter_id ?? '');

  // PERSISTENCE WHERE REQUIRED: a durable-checkpoint lease must have a
  // recorded checkpoint to resume from (the resume truth exists before
  // a fresh session replays from it).
  const checkpoint = await latestCheckpoint(db, ctx, valid.leaseId);
  if (checkpoint === null && definition.checkpoint_level === 'durable-checkpoint') {
    throw new ExecutionFabricError(
      'checkpoint_required',
      `the definition '${definition.def_key}' declares durable-checkpoint persistence — recovery requires a recorded checkpoint to resume from (none exists on this lease)`,
    );
  }
  const resumeRef = checkpoint?.cursor ?? lease.session_id ?? '';

  // Adapter I/O OUTSIDE every transaction.
  let session;
  try {
    session = await registration.adapter.resume(resumeRef);
  } catch (error) {
    await stampVendorFailure(db, ctx, valid.leaseId, 'recover', error);
    throw new ExecutionFabricError(
      'adapter_resume_failed',
      `the adapter failed to resume from '${resumeRef}': ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const at = now();
  const leaseUntil = leaseUntilFrom(at, toCount(lease.lease_minutes));
  try {
    await db.transaction(async (tx) => {
      const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
      const problem = transitionProblemOf('recover', row.status as FabricLeaseStatus);
      if (problem !== null) {
        throw new ExecutionFabricError(
          isTerminal(row.status as FabricLeaseStatus) ? 'lease_already_terminal' : 'lease_not_lost',
          problem,
        );
      }
      // The checkpoint tail is append-only, so the latest checkpoint can
      // only have GROWN since the pre-transaction read — re-derive the
      // resume ref under the lock so the stamp names what actually
      // existed at commit time.
      const freshCheckpoint = await latestCheckpoint(tx, ctx, valid.leaseId);
      const freshRef = freshCheckpoint?.cursor ?? row.session_id ?? '';
      await tx.query(
        `UPDATE fabric_leases
           SET status = 'live', session_id = $3, lost_at = NULL, lost_detail = NULL,
               recovery_detected_at = $4, recovered_at = $4,
               recovered_from_checkpoint_ref = $5, lease_until = $6, last_heartbeat_at = $4
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.leaseId, session.sessionId, at, freshRef, leaseUntil],
      );
      await appendEvent(tx, ctx, valid.leaseId, 'recovery', {
        sessionId: session.sessionId,
        recoveredFromCheckpointRef: freshRef,
        coveredEvidenceRefs: freshCheckpoint?.coveredEvidenceRefs ?? [],
      }, at);
    });
  } catch (error) {
    if (error instanceof ExecutionFabricError) {
      await closeSessionBestEffort(registration.adapter, session.sessionId, 'recover-raced');
    }
    throw error;
  }

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

async function latestCheckpoint(
  db: Queryable,
  ctx: TenantContext,
  leaseId: string,
): Promise<CheckpointRow | null> {
  const result = await db.query<CheckpointRow>(
    `SELECT * FROM fabric_lease_checkpoints
       WHERE tenant_id = $1 AND lease_id = $2
       ORDER BY recorded_at DESC, id DESC LIMIT 1`,
    [ctx.tenantId, leaseId],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// cancel / release / fail — the terminals
// ---------------------------------------------------------------------------

export async function cancelFabricLease(
  ctx: TenantContext,
  input: CancelFabricLeaseInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateCancelInput(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('cancel', existing.status as FabricLeaseStatus);

  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    const problem = transitionProblemOf('cancel', row.status as FabricLeaseStatus);
    if (problem !== null) {
      throw new ExecutionFabricError('lease_already_terminal', problem);
    }
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'cancelled', cancellation_requested_at = $3, cancel_reason = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, at, valid.reason],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'cancellation', {
      reason: valid.reason,
      sessionId: row.session_id,
    }, at);
  });

  // Fabric-executed cancellation closes the environment itself (no
  // cooperative window). Best-effort after the committed domain state;
  // a removed vendor never blocks cancellation (the vendor-removal law).
  if (existing.session_id !== null && existing.adapter_id !== null) {
    const registration = adapterRegistry.get(existing.adapter_id);
    if (registration !== undefined) {
      await closeSessionBestEffort(
        registration.adapter,
        existing.session_id,
        `cancelled: ${valid.reason}`,
      );
    }
  }

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

export async function releaseFabricLease(
  ctx: TenantContext,
  input: ReleaseFabricLeaseInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateReleaseInput(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('release', existing.status as FabricLeaseStatus);

  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    const problem = transitionProblemOf('release', row.status as FabricLeaseStatus);
    if (problem !== null) {
      throw new ExecutionFabricError(
        row.status === 'suspended'
          ? 'lease_suspended'
          : isTerminal(row.status as FabricLeaseStatus)
            ? 'lease_already_terminal'
            : 'invalid_transition',
        problem,
      );
    }
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'released', released_at = $3, release_reason = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, at, valid.reason],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'release', {
      reason: valid.reason,
      sessionId: row.session_id,
    }, at);
  });

  // The clean close: best-effort vendor cleanup after the committed
  // domain state (the same ruling as cancellation).
  if (existing.session_id !== null && existing.adapter_id !== null) {
    const registration = adapterRegistry.get(existing.adapter_id);
    if (registration !== undefined) {
      await closeSessionBestEffort(
        registration.adapter,
        existing.session_id,
        `released: ${valid.reason}`,
      );
    }
  }

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

export async function failFabricLease(
  ctx: TenantContext,
  input: FailFabricLeaseInput,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateFailInput(input);
  const db = getDb();

  const existing = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertTransitionLegal('fail', existing.status as FabricLeaseStatus);

  const at = now();
  await db.transaction(async (tx) => {
    const row = await loadLeaseRow(tx, ctx, valid.leaseId, true);
    const problem = transitionProblemOf('fail', row.status as FabricLeaseStatus);
    if (problem !== null) {
      throw new ExecutionFabricError('lease_already_terminal', problem);
    }
    await tx.query(
      `UPDATE fabric_leases
         SET status = 'failed', failed_at = $3, failure_detail = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.leaseId, at, valid.detail],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'failure', {
      detail: valid.detail,
      phase: 'explicit-report',
    }, at);
  });

  return getFabricLease(ctx, { leaseId: valid.leaseId });
}

// ---------------------------------------------------------------------------
// Artifact handoff / evidence / checkpoints (append-only evidence)
// ---------------------------------------------------------------------------

export async function recordArtifactHandoff(
  ctx: TenantContext,
  input: RecordArtifactHandoffInput,
): Promise<LeaseArtifactHandoff> {
  assertExecutionFabricTenantContext(ctx);
  const valid: ValidatedArtifactInput = validateRecordArtifactHandoffInput(input);
  const db = getDb();

  const lease = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertServable('artifact', lease.status as FabricLeaseStatus);

  const artifactId = newId();
  const recordedAt = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO fabric_lease_artifacts
         (id, tenant_id, lease_id, direction, artifact_ref, artifact_kind, digest,
          recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        artifactId,
        ctx.tenantId,
        valid.leaseId,
        valid.direction,
        valid.artifactRef,
        valid.artifactKind,
        valid.digest,
        ctx.principalId,
        recordedAt,
      ],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'artifact', {
      direction: valid.direction,
      artifactRef: valid.artifactRef,
      artifactKind: valid.artifactKind,
      digest: valid.digest,
    }, recordedAt);
  });

  const row = await db.query<ArtifactRow>(
    `SELECT * FROM fabric_lease_artifacts WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, artifactId],
  );
  return mapArtifact(row.rows[0]!);
}

export async function recordLeaseEvidence(
  ctx: TenantContext,
  input: RecordLeaseEvidenceInput,
): Promise<LeaseEvidenceRecord> {
  assertExecutionFabricTenantContext(ctx);
  const valid: ValidatedEvidenceInput = validateRecordLeaseEvidenceInput(input);
  const db = getDb();

  const lease = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertServable('evidence', lease.status as FabricLeaseStatus);

  const evidenceId = newId();
  const recordedAt = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO fabric_lease_evidence
         (id, tenant_id, lease_id, capture_kind, artifact_ref, verification, detail,
          redaction, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'applied', $8, $9)`,
      [
        evidenceId,
        ctx.tenantId,
        valid.leaseId,
        valid.captureKind,
        valid.artifactRef,
        valid.verification,
        valid.detail,
        ctx.principalId,
        recordedAt,
      ],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'evidence', {
      captureKind: valid.captureKind,
      artifactRef: valid.artifactRef,
      verification: valid.verification,
    }, recordedAt);
  });

  const row = await db.query<EvidenceRow>(
    `SELECT * FROM fabric_lease_evidence WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, evidenceId],
  );
  return mapEvidence(row.rows[0]!);
}

export async function recordLeaseCheckpoint(
  ctx: TenantContext,
  input: RecordLeaseCheckpointInput,
): Promise<LeaseCheckpoint> {
  assertExecutionFabricTenantContext(ctx);
  const valid: ValidatedCheckpointInput = validateRecordLeaseCheckpointInput(input);
  const db = getDb();

  const lease = await loadLeaseRow(db, ctx, valid.leaseId, false);
  assertServable('checkpoint', lease.status as FabricLeaseStatus);

  const checkpointId = newId();
  const recordedAt = now();
  await db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO fabric_lease_checkpoints
         (id, tenant_id, lease_id, cursor, covered_evidence_refs, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        checkpointId,
        ctx.tenantId,
        valid.leaseId,
        valid.cursor,
        valid.coveredEvidenceRefs,
        ctx.principalId,
        recordedAt,
      ],
    );
    await appendEvent(tx, ctx, valid.leaseId, 'checkpoint', {
      cursor: valid.cursor,
      coveredEvidenceRefs: valid.coveredEvidenceRefs,
    }, recordedAt);
  });

  const row = await db.query<CheckpointRow>(
    `SELECT * FROM fabric_lease_checkpoints WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, checkpointId],
  );
  return mapCheckpoint(row.rows[0]!);
}

// ---------------------------------------------------------------------------
// Reads (deterministic orders; uniform not-found; tenant-scoped)
// ---------------------------------------------------------------------------

export async function getEnvironmentDefinition(
  ctx: TenantContext,
  query: GetEnvironmentDefinitionQuery,
): Promise<EnvironmentDefinition> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateGetEnvironmentDefinitionQuery(query);
  const row = await loadDefinitionRow(getDb(), ctx, valid.definitionId, false);
  return mapDefinition(row);
}

export async function listEnvironmentDefinitions(
  ctx: TenantContext,
  query?: ListEnvironmentDefinitionsQuery,
): Promise<EnvironmentDefinition[]> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateListEnvironmentDefinitionsQuery(query);
  const db = getDb();
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM environment_definitions WHERE tenant_id = $1`;
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  if (valid.kind !== null) {
    params.push(valid.kind);
    sql += ` AND kind = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await db.query<DefinitionRow>(sql, params);
  return rows.rows.map(mapDefinition);
}

export async function getFabricLease(
  ctx: TenantContext,
  query: GetFabricLeaseQuery,
): Promise<FabricLease> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateGetFabricLeaseQuery(query);
  const db = getDb();
  const row = await loadLeaseRow(db, ctx, valid.leaseId, false);
  return toLeaseView(db, ctx, row);
}

export async function listFabricLeases(
  ctx: TenantContext,
  query?: ListFabricLeasesQuery,
): Promise<FabricLease[]> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateListFabricLeasesQuery(query);
  const db = getDb();
  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM fabric_leases WHERE tenant_id = $1`;
  if (valid.executionRunId !== null) {
    params.push(valid.executionRunId);
    sql += ` AND execution_run_id = $${params.length}`;
  }
  if (valid.definitionId !== null) {
    params.push(valid.definitionId);
    sql += ` AND definition_id = $${params.length}`;
  }
  if (valid.status !== null) {
    params.push(valid.status);
    sql += ` AND status = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY created_at DESC, id DESC LIMIT $${params.length}`;
  const rows = await db.query<LeaseRow>(sql, params);
  const views: FabricLease[] = [];
  for (const row of rows.rows) {
    views.push(await toLeaseView(db, ctx, row));
  }
  return views;
}

export async function listLeaseEvents(
  ctx: TenantContext,
  query: ListLeaseEventsQuery,
): Promise<FabricLeaseEvent[]> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateListLeaseEventsQuery(query);
  const db = getDb();
  await loadLeaseRow(db, ctx, valid.leaseId, false);
  const params: unknown[] = [ctx.tenantId, valid.leaseId];
  let sql = `SELECT * FROM fabric_lease_events WHERE tenant_id = $1 AND lease_id = $2`;
  if (valid.kind !== null) {
    params.push(valid.kind);
    sql += ` AND kind = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;
  const rows = await db.query<EventRow>(sql, params);
  return rows.rows.map(mapEvent);
}

export async function listArtifactHandoffs(
  ctx: TenantContext,
  query: ListArtifactHandoffsQuery,
): Promise<LeaseArtifactHandoff[]> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateListArtifactHandoffsQuery(query);
  const db = getDb();
  await loadLeaseRow(db, ctx, valid.leaseId, false);
  const params: unknown[] = [ctx.tenantId, valid.leaseId];
  let sql = `SELECT * FROM fabric_lease_artifacts WHERE tenant_id = $1 AND lease_id = $2`;
  if (valid.direction !== null) {
    params.push(valid.direction);
    sql += ` AND direction = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;
  const rows = await db.query<ArtifactRow>(sql, params);
  return rows.rows.map(mapArtifact);
}

export async function listLeaseEvidence(
  ctx: TenantContext,
  query: ListLeaseEvidenceQuery,
): Promise<LeaseEvidenceRecord[]> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateListLeaseEvidenceQuery(query);
  const db = getDb();
  await loadLeaseRow(db, ctx, valid.leaseId, false);
  const params: unknown[] = [ctx.tenantId, valid.leaseId];
  let sql = `SELECT * FROM fabric_lease_evidence WHERE tenant_id = $1 AND lease_id = $2`;
  if (valid.captureKind !== null) {
    params.push(valid.captureKind);
    sql += ` AND capture_kind = $${params.length}`;
  }
  if (valid.verification !== null) {
    params.push(valid.verification);
    sql += ` AND verification = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;
  const rows = await db.query<EvidenceRow>(sql, params);
  return rows.rows.map(mapEvidence);
}

export async function listLeaseCheckpoints(
  ctx: TenantContext,
  query: ListLeaseCheckpointsQuery,
): Promise<LeaseCheckpoint[]> {
  assertExecutionFabricTenantContext(ctx);
  const valid = validateListLeaseCheckpointsQuery(query);
  const db = getDb();
  await loadLeaseRow(db, ctx, valid.leaseId, false);
  const params: unknown[] = [ctx.tenantId, valid.leaseId, valid.limit];
  const sql = `SELECT * FROM fabric_lease_checkpoints
     WHERE tenant_id = $1 AND lease_id = $2
     ORDER BY recorded_at ASC, id ASC LIMIT $${params.length}`;
  const rows = await db.query<CheckpointRow>(sql, params);
  return rows.rows.map(mapCheckpoint);
}

// ---------------------------------------------------------------------------
// Input validator wrappers (typed code per operation family)
// ---------------------------------------------------------------------------

function validateTakeoverInput(input: TakeoverFabricLeaseInput): {
  leaseId: string;
  reason: string;
  authorityActionRef: string | null;
} {
  return validateTakeoverFabricLeaseInput(input);
}

function validateHandbackInput(input: HandbackFabricLeaseInput): {
  leaseId: string;
  note: string | null;
} {
  return validateHandbackFabricLeaseInput(input);
}

function validateMarkLostInput(input: MarkFabricLeaseLostInput): {
  leaseId: string;
  detail: string;
} {
  return validateMarkFabricLeaseLostInput(input);
}

function validateCancelInput(input: CancelFabricLeaseInput): { leaseId: string; reason: string } {
  return validateCancelFabricLeaseInput(input);
}

function validateReleaseInput(input: ReleaseFabricLeaseInput): { leaseId: string; reason: string } {
  return validateReleaseFabricLeaseInput(input);
}

function validateFailInput(input: FailFabricLeaseInput): { leaseId: string; detail: string } {
  return validateFailFabricLeaseInput(input);
}
