// Implementation of the processes module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at` comes from the injectable clock and
// is never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`process_not_found` / `process_version_not_found` /
// `finding_not_found`), including on versions and findings.
//
// W016 acceptance — "Reconstruct processes from events/observations; detect
// bottlenecks, duplication, handoffs, manual effort and errors" — is
// carried by these deliberate properties, all tested:
//   1. RECONSTRUCTION IS EVIDENCE-DRIVEN: the ONLY inputs to a process
//      version are the immutable events (W003) and observations (W004) read
//      THROUGH their contracts — never their tables. Events are pulled per
//      declared type with the per-tenant sequence cursor (the canonical
//      replay order the events module guarantees); observations per
//      declared kind, bounded by that contract's list cap (the freshness
//      module's documented window precedent — `observationWindowTruncated`
//      records when the bound was hit).
//   2. RECONSTRUCTION IS VERSIONED UNDERSTANDING: a process is an identity
//      plus an append-only chain of full-snapshot versions. Reconstructing
//      an existing name appends version N+1; no update/delete operation
//      exists on the contract, and PostgreSQL itself rejects
//      UPDATE/DELETE/TRUNCATE on versions (and findings) and DELETE/
//      TRUNCATE on the identity (migration 001 triggers).
//   3. DETECTION IS DETERMINISTIC: findings are a pure function of the
//      reconstructed model + the stored detection options
//      (reconstruction.ts / detection.ts), so a stored version plus its
//      evidence scope is reproducible — and every finding cites the exact
//      event/observation ids that justify it (lock 11).
//   4. DETECTION IS NOT JUDGEMENT: findings describe how work flows
//      (bottlenecks, duplication, handoffs, manual effort, errors) — never
//      employee performance; workforce intelligence (W019) owns
//      assessments, with alternative explanations.
//   5. CONCURRENCY: the version append runs inside one transaction that
//      holds the identity row lock (FOR UPDATE) and advances the pointer
//      under an optimistic `current_version = expected` guard — a losing
//      writer fails cleanly with `process_conflict`, and an explicit
//      `expectedVersion` mismatch refuses before any evidence is read.
//
// Storage shape: `processes` (identity + current-version pointer; the only
// mutable column is the pointer) + `process_versions` (the append-only
// reconstruction snapshots) + `process_findings` (the append-only,
// evidence-cited findings of one version).

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  listEvents,
  MAX_LIST_LIMIT as EVENTS_PAGE,
  type Event,
} from '@/modules/events/contract';
import {
  listObservations,
  MAX_LIST_LIMIT as OBSERVATIONS_PAGE,
  type Observation,
} from '@/modules/observations/contract';
import { detectFindings, FINDING_KIND_RANK } from './detection';
import { ProcessesError } from './errors';
import {
  reconstructProcessModel,
  type ActivityOccurrence,
} from './reconstruction';
import {
  assertProcessTenantContext,
  escapeLike,
  isUuid,
  MAX_FINDINGS_PER_VERSION,
  validateFindingQuery,
  validateFindingsQuery,
  validateHistoryQuery,
  validateListProcessesQuery,
  validateReconstructProcessInput,
  validateVersionQuery,
  type ValidatedFindingQuery,
  type ValidatedFindingsQuery,
  type ValidatedHistoryQuery,
  type ValidatedListQuery,
  type ValidatedParty,
  type ValidatedReconstructionInput,
  type ValidatedVersionQuery,
} from './validation';
import type {
  GetProcessFindingQuery,
  GetProcessVersionQuery,
  ListProcessFindingsQuery,
  ListProcessesQuery,
  ListProcessVersionsQuery,
  Process,
  ProcessChangeKind,
  ProcessEdge,
  ProcessFinding,
  ProcessFindingCounts,
  ProcessFindingKind,
  ProcessParty,
  ProcessScope,
  ProcessStats,
  ProcessStep,
  ProcessVariant,
  ProcessVersion,
  ReconstructProcessInput,
  ReconstructionOptions,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mapping
// ---------------------------------------------------------------------------

interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  process_id: string;
  version: number | string;
  change_kind: string;
  name: string;
  event_types: unknown;
  observation_kinds: unknown;
  case_key_candidates: unknown;
  occurred_from: Date | string | null;
  occurred_to: Date | string | null;
  world_entity_id: string | null;
  steps: unknown;
  edges: unknown;
  variants: unknown;
  stats: unknown;
  options: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the current-view join (processes ⋈ current process_versions). */
interface ProcessRow extends DbRow {
  process_id: string;
  process_tenant_id: string;
  process_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  version_name: string;
  event_types: unknown;
  observation_kinds: unknown;
  case_key_candidates: unknown;
  occurred_from: Date | string | null;
  occurred_to: Date | string | null;
  world_entity_id: string | null;
  stats: unknown;
  options: unknown;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

interface FindingRow extends DbRow {
  id: string;
  tenant_id: string;
  process_id: string;
  version: number | string;
  kind: string;
  subject: string;
  summary: string;
  metrics: unknown;
  evidence_event_ids: unknown;
  evidence_observation_ids: unknown;
  confidence: number;
  detected_by_principal: string;
  detected_at: Date | string;
}

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

function mapScope(row: {
  event_types: unknown;
  observation_kinds: unknown;
  case_key_candidates: unknown;
  occurred_from: Date | string | null;
  occurred_to: Date | string | null;
  world_entity_id: string | null;
}): ProcessScope {
  return {
    eventTypes: stringArray(row.event_types),
    observationKinds: stringArray(row.observation_kinds),
    caseKeyCandidates: stringArray(row.case_key_candidates),
    occurredFrom: row.occurred_from === null ? null : toIso(row.occurred_from),
    occurredTo: row.occurred_to === null ? null : toIso(row.occurred_to),
    worldEntityId: row.world_entity_id,
  };
}

function mapOptions(value: unknown): ReconstructionOptions {
  // Write-validated by this module; the shape is fixed by migration 001's
  // jsonb object CHECK + the version snapshot discipline.
  return value as ReconstructionOptions;
}

function mapStats(value: unknown): ProcessStats {
  return value as ProcessStats;
}

function mapSteps(value: unknown): ProcessStep[] {
  return Array.isArray(value) ? (value as ProcessStep[]) : [];
}

function mapEdges(value: unknown): ProcessEdge[] {
  return Array.isArray(value) ? (value as ProcessEdge[]) : [];
}

function mapVariants(value: unknown): ProcessVariant[] {
  return Array.isArray(value) ? (value as ProcessVariant[]) : [];
}

function mapPartyOf(row: { actor_kind: string; actor_id: string | null; actor_label: string | null }): ProcessParty {
  return {
    kind: row.actor_kind as ProcessParty['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

function mapVersion(row: VersionRow): ProcessVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    processId: row.process_id,
    version: toInt(row.version),
    changeKind: row.change_kind as ProcessChangeKind, // CHECK-constrained by migration 001
    name: row.name,
    scope: mapScope(row),
    steps: mapSteps(row.steps),
    edges: mapEdges(row.edges),
    variants: mapVariants(row.variants),
    stats: mapStats(row.stats),
    options: mapOptions(row.options),
    actor: mapPartyOf(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapFinding(row: FindingRow): ProcessFinding {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    processId: row.process_id,
    version: toInt(row.version),
    kind: row.kind as ProcessFindingKind, // CHECK-constrained by migration 001
    subject: row.subject,
    summary: row.summary,
    metrics: (row.metrics ?? {}) as Record<string, unknown>,
    evidenceEventIds: stringArray(row.evidence_event_ids),
    evidenceObservationIds: stringArray(row.evidence_observation_ids),
    confidence: row.confidence,
    detectedByPrincipal: row.detected_by_principal,
    detectedAt: toIso(row.detected_at),
  };
}

function emptyFindingCounts(): ProcessFindingCounts {
  return { bottleneck: 0, duplication: 0, handoff: 0, manualEffort: 0, error: 0 };
}

function countFindings(kinds: Iterable<ProcessFindingKind>): ProcessFindingCounts {
  const counts = emptyFindingCounts();
  for (const kind of kinds) {
    if (kind === 'bottleneck') counts.bottleneck += 1;
    else if (kind === 'duplication') counts.duplication += 1;
    else if (kind === 'handoff') counts.handoff += 1;
    else if (kind === 'manual_effort') counts.manualEffort += 1;
    else counts.error += 1;
  }
  return counts;
}

function processNotFound(processId: string): ProcessesError {
  return new ProcessesError(
    'process_not_found',
    `process '${processId}' does not exist in this tenant`,
  );
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

// ---------------------------------------------------------------------------
// Evidence gathering (through the events / observations CONTRACTS only)
// ---------------------------------------------------------------------------

function eventOccurrenceOf(event: Event): ActivityOccurrence {
  return {
    // W003: the correlation id groups every event of one logical flow — the
    // process case. (Always present: explicit, inherited or self.)
    caseId: event.correlationId,
    activityType: event.type,
    actorKind: event.actor.kind, // same five-kind vocabulary (types.ts)
    actorId: event.actor.id ?? null,
    actorLabel: event.actor.label ?? null,
    occurredAtMs: Date.parse(event.occurredAt),
    occurredAtIso: event.occurredAt,
    evidenceKind: 'event',
    evidenceId: event.id,
    eventSequence: event.sequence,
  };
}

/**
 * The case id of one observation: the first case-key candidate present on
 * its payload with a string/finite-number value. No candidate (or no plain
 * object payload) → the observation is its own single-activity case: it
 * still feeds step, manual-effort and error statistics, never flow edges.
 */
function observationCaseIdOf(observation: Observation, candidates: readonly string[]): string {
  if (isPlainObject(observation.payload)) {
    for (const key of candidates) {
      const value = observation.payload[key];
      if (typeof value === 'string' && value.trim() !== '') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    }
  }
  return `observation:${observation.id}`;
}

function observationOccurrenceOf(
  observation: Observation,
  candidates: readonly string[],
): ActivityOccurrence {
  return {
    caseId: observationCaseIdOf(observation, candidates),
    activityType: observation.kind,
    actorKind: observation.source.kind, // same five-kind vocabulary (types.ts)
    actorId: observation.source.id ?? null,
    actorLabel: observation.source.label ?? null,
    occurredAtMs: Date.parse(observation.observedAt),
    occurredAtIso: observation.observedAt,
    evidenceKind: 'observation',
    evidenceId: observation.id,
    eventSequence: null,
  };
}

/**
 * Pull the scope's events through the events contract, per declared type,
 * paging by the per-tenant sequence cursor (the canonical replay order).
 * Exceeding `maxEvents` refuses with `reconstruction_too_large` — evidence
 * is never silently dropped.
 */
async function gatherEventOccurrences(
  ctx: TenantContext,
  scope: ProcessScope,
  maxEvents: number,
): Promise<ActivityOccurrence[]> {
  const occurrences: ActivityOccurrence[] = [];
  for (const type of scope.eventTypes) {
    let cursor: number | undefined = undefined;
    for (;;) {
      const page = await listEvents(ctx, {
        type,
        occurredFrom: scope.occurredFrom ?? undefined,
        occurredTo: scope.occurredTo ?? undefined,
        sequenceFrom: cursor,
        order: 'asc',
        limit: EVENTS_PAGE,
      });
      if (page.length === 0) break;
      for (const event of page) {
        occurrences.push(eventOccurrenceOf(event));
      }
      if (occurrences.length > maxEvents) {
        throw new ProcessesError(
          'reconstruction_too_large',
          `the event evidence in scope exceeds options.maxEvents (${maxEvents}) — narrow the occurrence window or the event types, or raise maxEvents within its cap`,
        );
      }
      if (page.length < EVENTS_PAGE) break;
      cursor = page[page.length - 1]!.sequence + 1;
    }
  }
  return occurrences;
}

/**
 * Pull the scope's observations through the observations contract, per
 * declared kind, bounded by that contract's list cap (latest first by
 * recorded time — no cursor exists on that surface). A kind hitting the cap
 * sets `truncated` so the version records the bound honestly.
 */
async function gatherObservationOccurrences(
  ctx: TenantContext,
  scope: ProcessScope,
): Promise<{ occurrences: ActivityOccurrence[]; truncated: boolean }> {
  const occurrences: ActivityOccurrence[] = [];
  let truncated = false;
  for (const kind of scope.observationKinds) {
    const page = await listObservations(ctx, {
      kind,
      observedFrom: scope.occurredFrom ?? undefined,
      observedTo: scope.occurredTo ?? undefined,
      limit: OBSERVATIONS_PAGE,
    });
    if (page.length === OBSERVATIONS_PAGE) truncated = true;
    for (const observation of page) {
      occurrences.push(observationOccurrenceOf(observation, scope.caseKeyCandidates));
    }
  }
  return { occurrences, truncated };
}

// ---------------------------------------------------------------------------
// Shared SQL of the version append
// ---------------------------------------------------------------------------

/**
 * The SQL value tuple of one version row (full snapshot), shared by every
 * append path.
 */
function versionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    processId: string;
    version: number;
    changeKind: ProcessChangeKind;
    name: string;
    scope: ProcessScope;
    model: { steps: ProcessStep[]; edges: ProcessEdge[]; variants: ProcessVariant[]; stats: ProcessStats };
    options: ReconstructionOptions;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<VersionRow>> {
  const scope = params.scope;
  return tx.query<VersionRow>(
    `INSERT INTO process_versions (
       tenant_id, process_id, version, change_kind, name,
       event_types, observation_kinds, case_key_candidates, occurred_from, occurred_to, world_entity_id,
       steps, edges, variants, stats, options,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6::jsonb, $7::jsonb, $8::jsonb, $9::timestamptz, $10::timestamptz, $11,
       $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
       $17, $18, $19, $20, $21, $22::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.processId,
      params.version,
      params.changeKind,
      params.name,
      JSON.stringify(scope.eventTypes),
      JSON.stringify(scope.observationKinds),
      JSON.stringify(scope.caseKeyCandidates),
      scope.occurredFrom === null ? null : new Date(scope.occurredFrom),
      scope.occurredTo === null ? null : new Date(scope.occurredTo),
      scope.worldEntityId,
      JSON.stringify(params.model.steps),
      JSON.stringify(params.model.edges),
      JSON.stringify(params.model.variants),
      JSON.stringify(params.model.stats),
      JSON.stringify(params.options),
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

/** The finding rows of one version append (evidence-cited, append-only). */
async function findingsInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    processId: string;
    version: number;
    principalId: string;
    detectedAt: Date;
    findings: {
      kind: ProcessFindingKind;
      subject: string;
      summary: string;
      metrics: Record<string, unknown>;
      evidenceEventIds: string[];
      evidenceObservationIds: string[];
      confidence: number;
    }[];
  },
): Promise<void> {
  for (const finding of params.findings) {
    await tx.query(
      `INSERT INTO process_findings (
         tenant_id, process_id, version, kind, subject, summary, metrics,
         evidence_event_ids, evidence_observation_ids, confidence,
         detected_by_principal, detected_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::timestamptz)`,
      [
        params.tenantId,
        params.processId,
        params.version,
        finding.kind,
        finding.subject,
        finding.summary,
        JSON.stringify(finding.metrics),
        JSON.stringify(finding.evidenceEventIds),
        JSON.stringify(finding.evidenceObservationIds),
        finding.confidence,
        params.principalId,
        params.detectedAt,
      ],
    );
  }
}

/** The current-view Process assembled from a freshly appended version. */
function processOf(
  processId: string,
  tenantId: string,
  createdAt: Date | string,
  version: ProcessVersion,
  findingCounts: ProcessFindingCounts,
): Process {
  return {
    id: processId,
    tenantId,
    name: version.name,
    version: version.version,
    scope: version.scope,
    stats: version.stats,
    options: version.options,
    findingCounts,
    createdAt: toIso(createdAt),
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
// reconstructProcess
// ---------------------------------------------------------------------------

export async function reconstructProcess(
  ctx: TenantContext,
  input: ReconstructProcessInput,
): Promise<Process> {
  assertProcessTenantContext(ctx);
  const valid: ValidatedReconstructionInput = validateReconstructProcessInput(input);

  // --- evidence gathering (through the sibling contracts) ---
  const eventOccurrences = await gatherEventOccurrences(ctx, valid.scope, valid.options.maxEvents);
  const { occurrences: observationOccurrences, truncated } =
    await gatherObservationOccurrences(ctx, valid.scope);
  const occurrences = [...eventOccurrences, ...observationOccurrences];

  // --- pure reconstruction + detection ---
  const model = reconstructProcessModel(occurrences, truncated);
  const detection = detectFindings(model, occurrences, valid.options);
  if (detection.findings.length > MAX_FINDINGS_PER_VERSION) {
    throw new ProcessesError(
      'reconstruction_too_large',
      `the evidence in scope produced ${detection.findings.length} findings (cap ${MAX_FINDINGS_PER_VERSION}) — narrow the occurrence window or the declared activity types`,
    );
  }
  model.stats.errorCount = detection.errorCount;

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Lock-or-create the identity by (tenant, name). The row lock serializes
    // version appends per process, which keeps the chain gapless.
    const locked = await tx.query<{ id: string; current_version: number | string; created_at: Date | string }>(
      `SELECT id, current_version, created_at FROM processes
         WHERE tenant_id = $1 AND name = $2 FOR UPDATE`,
      [ctx.tenantId, valid.name],
    );
    let identity = locked.rows[0];
    let version: number;
    let changeKind: ProcessChangeKind;

    if (identity === undefined) {
      if (valid.expectedVersion !== null) {
        // The caller expected an existing process at that version; none
        // exists in this tenant (missing and foreign-tenant read alike).
        throw processNotFound(valid.name);
      }
      let created: DbResult<{ id: string; current_version: number | string; created_at: Date | string }>;
      try {
        created = await tx.query<{ id: string; current_version: number | string; created_at: Date | string }>(
          `INSERT INTO processes (tenant_id, name, created_at) VALUES ($1, $2, $3)
             RETURNING id, current_version, created_at`,
          [ctx.tenantId, valid.name, recordedAt],
        );
      } catch (error) {
        if (isDuplicateKeyOn(error, 'processes')) {
          throw new ProcessesError(
            'process_name_conflict',
            `a process named '${valid.name}' was created concurrently in this tenant; re-read it and reconstruct again`,
          );
        }
        throw error;
      }
      identity = created.rows[0]!;
      version = 1;
      changeKind = 'created';
    } else {
      const currentVersion = toInt(identity.current_version);
      if (valid.expectedVersion !== null && valid.expectedVersion !== currentVersion) {
        throw new ProcessesError(
          'process_conflict',
          `expected version ${valid.expectedVersion} but process '${valid.name}' is at version ${currentVersion}; re-read the process and retry`,
        );
      }
      version = currentVersion + 1;
      changeKind = 'reconstructed';
      // Optimistic pointer advance (defense in depth on top of the row lock).
      const moved = await tx.query(
        `UPDATE processes SET current_version = $3
           WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
        [ctx.tenantId, identity.id, version, currentVersion],
      );
      if (moved.rowCount === 0) {
        throw new ProcessesError(
          'process_conflict',
          'a concurrent reconstruction moved this process forward; re-read it and retry',
        );
      }
    }

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        processId: identity.id,
        version,
        changeKind,
        name: valid.name,
        scope: valid.scope,
        model,
        options: valid.options,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'process_versions')) {
        throw new ProcessesError(
          'process_conflict',
          'a concurrent reconstruction appended this version number first; re-read the process and retry',
        );
      }
      throw error;
    }
    const versionRow = mapVersion(inserted.rows[0]!);

    await findingsInsert(tx, {
      tenantId: ctx.tenantId,
      processId: identity.id,
      version,
      principalId: ctx.principalId,
      detectedAt: recordedAt,
      findings: detection.findings,
    });

    return processOf(
      identity.id,
      ctx.tenantId,
      identity.created_at,
      versionRow,
      countFindings(detection.findings.map((finding) => finding.kind)),
    );
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const CURRENT_VIEW_FROM = `FROM processes p
  INNER JOIN process_versions pv
    ON pv.process_id = p.id AND pv.tenant_id = p.tenant_id AND pv.version = p.current_version`;

const CURRENT_VIEW_COLUMNS = `SELECT
    p.id AS process_id, p.tenant_id AS process_tenant_id, p.created_at AS process_created_at,
    pv.version AS version_number, pv.change_kind, pv.name AS version_name,
    pv.event_types, pv.observation_kinds, pv.case_key_candidates,
    pv.occurred_from, pv.occurred_to, pv.world_entity_id,
    pv.stats, pv.options,
    pv.actor_kind, pv.actor_id, pv.actor_label,
    pv.changed_by_principal, pv.rationale, pv.recorded_at`;

function mapProcess(row: ProcessRow, findingCounts: ProcessFindingCounts): Process {
  return {
    id: row.process_id,
    tenantId: row.process_tenant_id,
    name: row.version_name,
    version: toInt(row.version_number),
    scope: mapScope(row),
    stats: mapStats(row.stats),
    options: mapOptions(row.options),
    findingCounts,
    createdAt: toIso(row.process_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: {
      kind: row.change_kind as ProcessChangeKind, // CHECK-constrained by migration 001
      actor: mapPartyOf(row),
      changedByPrincipal: row.changed_by_principal,
      rationale: row.rationale,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

/**
 * Finding counts of each process's CURRENT version, in one query — the
 * join pins `pf.version = p.current_version` per process.
 */
async function currentFindingCounts(
  ctx: TenantContext,
  processIds: string[],
): Promise<Map<string, ProcessFindingCounts>> {
  const counts = new Map<string, ProcessFindingCounts>();
  if (processIds.length === 0) return counts;
  const rows = await getDb().query<{ process_id: string; kind: string; n: number | string }>(
    `SELECT pf.process_id, pf.kind, count(*) AS n
       FROM process_findings pf
       INNER JOIN processes p
         ON p.id = pf.process_id AND p.tenant_id = pf.tenant_id AND pf.version = p.current_version
      WHERE pf.tenant_id = $1 AND pf.process_id = ANY($2::uuid[])
      GROUP BY pf.process_id, pf.kind`,
    [ctx.tenantId, processIds],
  );
  for (const row of rows.rows) {
    const bucket = counts.get(row.process_id) ?? emptyFindingCounts();
    if (row.kind === 'bottleneck') bucket.bottleneck = toInt(row.n);
    else if (row.kind === 'duplication') bucket.duplication = toInt(row.n);
    else if (row.kind === 'handoff') bucket.handoff = toInt(row.n);
    else if (row.kind === 'manual_effort') bucket.manualEffort = toInt(row.n);
    else bucket.error = toInt(row.n);
    counts.set(row.process_id, bucket);
  }
  return counts;
}

export async function getProcess(ctx: TenantContext, processId: string): Promise<Process> {
  assertProcessTenantContext(ctx);
  if (!isUuid(processId)) {
    // Malformed ids are indistinguishable from missing records (no leak).
    throw processNotFound(processId);
  }
  const rows = await getDb().query<ProcessRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE p.tenant_id = $1 AND p.id = $2`,
    [ctx.tenantId, processId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw processNotFound(processId);
  const counts = (await currentFindingCounts(ctx, [row.process_id])).get(row.process_id);
  return mapProcess(row, counts ?? emptyFindingCounts());
}

export async function listProcesses(
  ctx: TenantContext,
  query: ListProcessesQuery,
): Promise<Process[]> {
  assertProcessTenantContext(ctx);
  const valid: ValidatedListQuery = validateListProcessesQuery(query);

  const conditions: string[] = ['p.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.name !== null) add('p.name = $#', valid.name);
  if (valid.search !== null) {
    // escaped substring match on the name — caller text is never a wildcard
    // pattern (the missions module's ILIKE discipline).
    add("p.name ILIKE '%' || $# || '%' ESCAPE '\\'", escapeLike(valid.search));
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<ProcessRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY pv.name ASC, p.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  if (rows.rows.length === 0) return [];
  const counts = await currentFindingCounts(ctx, rows.rows.map((row) => row.process_id));
  return rows.rows.map((row) => mapProcess(row, counts.get(row.process_id) ?? emptyFindingCounts()));
}

export async function getProcessVersion(
  ctx: TenantContext,
  query: GetProcessVersionQuery,
): Promise<ProcessVersion> {
  assertProcessTenantContext(ctx);
  const valid: ValidatedVersionQuery = validateVersionQuery(query);
  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM process_versions WHERE tenant_id = $1 AND process_id = $2 AND version = $3`,
    [ctx.tenantId, valid.processId, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ProcessesError(
      'process_version_not_found',
      `version ${valid.version} of process '${valid.processId}' does not exist in this tenant`,
    );
  }
  return mapVersion(row);
}

export async function listProcessVersions(
  ctx: TenantContext,
  query: ListProcessVersionsQuery,
): Promise<ProcessVersion[]> {
  assertProcessTenantContext(ctx);
  const valid: ValidatedHistoryQuery = validateHistoryQuery(query);
  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM process_versions WHERE tenant_id = $1 AND process_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.processId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such process in this tenant" from "a process without
    // history" (impossible by construction) — a foreign-tenant process id
    // reads the same as a missing one either way.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM processes WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.processId],
    );
    if (exists.rows.length === 0) throw processNotFound(valid.processId);
  }
  return rows.rows.map(mapVersion);
}

export async function listProcessFindings(
  ctx: TenantContext,
  query: ListProcessFindingsQuery,
): Promise<ProcessFinding[]> {
  assertProcessTenantContext(ctx);
  const valid: ValidatedFindingsQuery = validateFindingsQuery(query);

  // Resolve the target version: explicit, or the process's current one.
  let version = valid.version;
  if (version === null) {
    const current = await getDb().query<{ current_version: number | string }>(
      `SELECT current_version FROM processes WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.processId],
    );
    const row = current.rows[0];
    if (row === undefined) throw processNotFound(valid.processId);
    version = toInt(row.current_version);
  }

  const conditions: string[] = ['pf.tenant_id = $1', 'pf.process_id = $2', 'pf.version = $3'];
  const params: unknown[] = [ctx.tenantId, valid.processId, version];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.kind !== null) add('pf.kind = $#', valid.kind);
  if (valid.minConfidence > 0) add('pf.confidence >= $#', valid.minConfidence);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // The canonical finding order (detection's kind rank, then subject) —
  // the CASE enumerates the CHECK-constrained kind values only.
  const rows = await getDb().query<FindingRow>(
    `SELECT * FROM process_findings pf WHERE ${conditions.join(' AND ')}
      ORDER BY CASE pf.kind
                 WHEN 'bottleneck' THEN ${FINDING_KIND_RANK.bottleneck}
                 WHEN 'duplication' THEN ${FINDING_KIND_RANK.duplication}
                 WHEN 'handoff' THEN ${FINDING_KIND_RANK.handoff}
                 WHEN 'manual_effort' THEN ${FINDING_KIND_RANK.manual_effort}
                 ELSE ${FINDING_KIND_RANK.error}
               END ASC, pf.subject ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapFinding);
}

export async function getProcessFinding(
  ctx: TenantContext,
  query: GetProcessFindingQuery,
): Promise<ProcessFinding> {
  assertProcessTenantContext(ctx);
  const valid: ValidatedFindingQuery = validateFindingQuery(query);
  const rows = await getDb().query<FindingRow>(
    `SELECT * FROM process_findings WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.findingId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new ProcessesError(
      'finding_not_found',
      `finding '${valid.findingId}' does not exist in this tenant`,
    );
  }
  return mapFinding(row);
}
