// Implementation of the freshness module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps (`recorded_at`,
// `created_at`/`updated_at`, default `asOf`) come from the injectable clock
// and are never caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable from
// a missing record (`temporal_state_not_found` / `policy_not_found`).
//
// W006 acceptance — "version mutable relationships/beliefs and track
// observation latency, source freshness and stale-after policy" — is
// carried by these deliberate properties, all tested:
//   1. temporal revisions are APPEND-ONLY: superseding records a new
//      version and never mutates history — no update/delete operation
//      exists on the contract, and PostgreSQL triggers reject
//      UPDATE/DELETE/TRUNCATE outright (migrations/002); `version`,
//      `recordedAt`, `validTo` and `current` are system-derived, and
//      caller-supplied identity fields are rejected at validation;
//   2. every revision carries provenance — at least one supporting
//      observation that exists in THIS tenant and is readable by the
//      recording principal (lock 11: no versioned understanding without
//      evidence);
//   3. observation latency is derived from the observations contract's
//      `observedAt` (source clock) vs the service-minted `recordedAt`;
//   4. freshness classification is policy-driven and deterministic:
//      current / aging / stale against tenant-scoped stale-after policies,
//      `unknown` when no policy (or no evidence) applies.
//
// Cross-module integration: this module reads observations ONLY through
// the observations contract (getObservation / listObservations) — never
// its tables — mirroring how the people module consumes the identity
// contract. Read failures propagate per the error policy documented in
// errors.ts.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  getObservation,
  listObservations,
  MAX_LIST_LIMIT,
  ObservationsError,
  type Observation,
} from '@/modules/observations/contract';
import {
  classifyFreshness,
  evidenceAgeSeconds,
  observationLatencySeconds,
} from './classification';
import { FreshnessError } from './errors';
import {
  assertFreshnessTenantContext,
  isUuid,
  SOURCE_SUBJECT_KIND,
  validateGetTemporalStateQuery,
  validateHistoryQuery,
  validateListPoliciesQuery,
  validateObservationFreshnessQuery,
  validatePolicySubjectQuery,
  validateRecordRevisionInput,
  validateSetFreshnessPolicyInput,
  validateSourceFreshnessQuery,
  validateTemporalStateFreshnessQuery,
  type ValidatedPolicyInput,
  type ValidatedRevisionInput,
} from './validation';
import type {
  FreshnessPolicy,
  FreshnessThresholds,
  GetTemporalStateQuery,
  ListFreshnessPoliciesQuery,
  ListTemporalHistoryQuery,
  ObservationFreshness,
  ObservationFreshnessQuery,
  PolicySubjectQuery,
  RecordTemporalRevisionInput,
  SetFreshnessPolicyInput,
  SourceFreshness,
  SourceFreshnessQuery,
  TemporalRevision,
  TemporalStateFreshness,
  TemporalStateFreshnessQuery,
} from './types';

interface PolicyRow extends DbRow {
  id: string;
  tenant_id: string;
  subject_kind: string;
  subject_id: string | null;
  stale_after_seconds: number;
  aging_after_seconds: number | null;
  max_latency_seconds: number | null;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RevisionRow extends DbRow {
  id: string;
  tenant_id: string;
  subject_kind: string;
  subject_id: string;
  version: number;
  state: unknown;
  valid_from: Date | string;
  recorded_at: Date | string;
  provenance_observation_ids: string[];
  rationale: string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapPolicy(row: PolicyRow): FreshnessPolicy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    staleAfterSeconds: row.stale_after_seconds,
    agingAfterSeconds: row.aging_after_seconds,
    maxLatencySeconds: row.max_latency_seconds,
    note: row.note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapRevision(row: RevisionRow, validTo: string | null, current: boolean): TemporalRevision {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    version: row.version,
    state: row.state,
    validFrom: toIso(row.valid_from),
    validTo,
    recordedAt: toIso(row.recorded_at),
    current,
    provenance: {
      observationIds: [...(row.provenance_observation_ids ?? [])],
    },
    rationale: row.rationale,
  };
}

function thresholdsOf(policy: FreshnessPolicy | null): FreshnessThresholds | null {
  if (policy === null) return null;
  return { staleAfterSeconds: policy.staleAfterSeconds, agingAfterSeconds: policy.agingAfterSeconds };
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Stale-after policies
// ---------------------------------------------------------------------------

/** Exact-key policy lookup (no default fallback); null when absent. */
async function lookupPolicy(
  ctx: TenantContext,
  subjectKind: string,
  subjectId: string | null,
): Promise<FreshnessPolicy | null> {
  const rows =
    subjectId === null
      ? await getDb().query<PolicyRow>(
          `SELECT * FROM freshness_policies
             WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id IS NULL`,
          [ctx.tenantId, subjectKind],
        )
      : await getDb().query<PolicyRow>(
          `SELECT * FROM freshness_policies
             WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3`,
          [ctx.tenantId, subjectKind, subjectId],
        );
  const row = rows.rows[0];
  return row === undefined ? null : mapPolicy(row);
}

export async function setFreshnessPolicy(
  ctx: TenantContext,
  input: SetFreshnessPolicyInput,
): Promise<FreshnessPolicy> {
  assertFreshnessTenantContext(ctx);
  const valid: ValidatedPolicyInput = validateSetFreshnessPolicyInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const existing =
      valid.subjectId === null
        ? await tx.query<{ id: string }>(
            `SELECT id FROM freshness_policies
               WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id IS NULL`,
            [ctx.tenantId, valid.subjectKind],
          )
        : await tx.query<{ id: string }>(
            `SELECT id FROM freshness_policies
               WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3`,
            [ctx.tenantId, valid.subjectKind, valid.subjectId],
          );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<PolicyRow>(
        `UPDATE freshness_policies
           SET stale_after_seconds = $2, aging_after_seconds = $3, max_latency_seconds = $4,
               note = $5, updated_at = $6
           WHERE tenant_id = $1 AND id = $7
           RETURNING *`,
        [
          ctx.tenantId,
          valid.staleAfterSeconds,
          valid.agingAfterSeconds,
          valid.maxLatencySeconds,
          valid.note,
          timestamp,
          existingId,
        ],
      );
      return mapPolicy(updated.rows[0]!);
    }
    let inserted: DbResult<PolicyRow>;
    try {
      inserted = await tx.query<PolicyRow>(
        `INSERT INTO freshness_policies (
           tenant_id, subject_kind, subject_id,
           stale_after_seconds, aging_after_seconds, max_latency_seconds,
           note, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.subjectKind,
          valid.subjectId,
          valid.staleAfterSeconds,
          valid.agingAfterSeconds,
          valid.maxLatencySeconds,
          valid.note,
          timestamp,
          timestamp,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'freshness_policies')) {
        throw new FreshnessError(
          'policy_conflict',
          'a policy for this subject was created concurrently; retry the set operation',
        );
      }
      throw error;
    }
    return mapPolicy(inserted.rows[0]!);
  });
}

export async function getFreshnessPolicy(
  ctx: TenantContext,
  query: PolicySubjectQuery,
): Promise<FreshnessPolicy> {
  assertFreshnessTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  const policy = await lookupPolicy(ctx, valid.subjectKind, valid.subjectId);
  if (policy === null) {
    throw new FreshnessError(
      'policy_not_found',
      `no stale-after policy for subject '${valid.subjectKind}/${valid.subjectId ?? 'default'}' exists in this tenant`,
    );
  }
  return policy;
}

export async function resolveFreshnessPolicy(
  ctx: TenantContext,
  query: PolicySubjectQuery,
): Promise<FreshnessPolicy | null> {
  assertFreshnessTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  if (valid.subjectId !== null) {
    const specific = await lookupPolicy(ctx, valid.subjectKind, valid.subjectId);
    if (specific !== null) return specific;
  }
  return lookupPolicy(ctx, valid.subjectKind, null);
}

export async function listFreshnessPolicies(
  ctx: TenantContext,
  query: ListFreshnessPoliciesQuery,
): Promise<FreshnessPolicy[]> {
  assertFreshnessTenantContext(ctx);
  const valid = validateListPoliciesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`subject_kind = $${params.length}`);
  }
  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM freshness_policies WHERE ${conditions.join(' AND ')}
       ORDER BY subject_kind ASC, subject_id ASC NULLS FIRST, id ASC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapPolicy);
}

// ---------------------------------------------------------------------------
// Temporal state — versioning of mutable understanding
// ---------------------------------------------------------------------------

export async function recordTemporalRevision(
  ctx: TenantContext,
  input: RecordTemporalRevisionInput,
): Promise<TemporalRevision> {
  assertFreshnessTenantContext(ctx);
  const valid: ValidatedRevisionInput = validateRecordRevisionInput(input);

  // Provenance gate: every supporting observation must exist in THIS tenant
  // and be readable by the recording principal. Cross-tenant and restricted
  // evidence are uniformly `invalid_provenance` — no existence leak. The
  // checks run before the write; observations are immutable, so the
  // evidence cannot disappear afterwards (DELETE is impossible by trigger).
  for (const observationId of valid.observationIds) {
    try {
      await getObservation(ctx, observationId);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new FreshnessError(
          'invalid_provenance',
          `supporting observation '${observationId}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const latest = await tx.query<Pick<RevisionRow, 'version' | 'valid_from'>>(
      `SELECT version, valid_from FROM temporal_revisions
         WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3
         ORDER BY version DESC LIMIT 1`,
      [ctx.tenantId, valid.subjectKind, valid.subjectId],
    );
    const latestRow = latest.rows[0];
    let nextVersion = 1;
    if (latestRow !== undefined) {
      nextVersion = latestRow.version + 1;
      const latestValidFrom = toIso(latestRow.valid_from);
      if (Date.parse(valid.validFrom) <= Date.parse(latestValidFrom)) {
        throw new FreshnessError(
          'invalid_revision_input',
          `validFrom must be strictly after the latest revision's validFrom (${latestValidFrom}) — a subject's revisions form a strictly increasing valid-time chain`,
        );
      }
    }

    let inserted: DbResult<RevisionRow>;
    try {
      inserted = await tx.query<RevisionRow>(
        `INSERT INTO temporal_revisions (
           tenant_id, subject_kind, subject_id, version, state,
           valid_from, recorded_at, provenance_observation_ids, rationale
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.subjectKind,
          valid.subjectId,
          nextVersion,
          JSON.stringify(valid.state),
          new Date(valid.validFrom),
          recordedAt,
          JSON.stringify(valid.observationIds),
          valid.rationale,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'temporal_revisions')) {
        // A concurrent append won the race on (subject, version) or
        // (subject, valid_from) — history is never rewritten, so the loser
        // re-reads and retries.
        throw new FreshnessError(
          'revision_conflict',
          'a concurrent revision was appended for this subject; re-read the history and retry',
        );
      }
      throw error;
    }
    return mapRevision(inserted.rows[0]!, null, true);
  });
}

export async function getTemporalState(
  ctx: TenantContext,
  query: GetTemporalStateQuery,
): Promise<TemporalRevision> {
  assertFreshnessTenantContext(ctx);
  const valid = validateGetTemporalStateQuery(query);
  const asOf = valid.asOf ?? now();
  const db = getDb();

  const resolved = await db.query<RevisionRow>(
    `SELECT * FROM temporal_revisions
       WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3 AND valid_from <= $4
       ORDER BY valid_from DESC, version DESC LIMIT 1`,
    [ctx.tenantId, valid.subjectKind, valid.subjectId, asOf],
  );
  const row = resolved.rows[0];
  if (row === undefined) {
    throw new FreshnessError(
      'temporal_state_not_found',
      `no revision of subject '${valid.subjectKind}/${valid.subjectId}' is valid as of ${asOf.toISOString()} in this tenant`,
    );
  }

  // Derived interval end + current flag: the next revision (strictly later
  // valid_from — uniqueness guarantees no ties). No later revision → this
  // is the open-ended latest understanding.
  const next = await db.query<Pick<RevisionRow, 'valid_from'>>(
    `SELECT valid_from FROM temporal_revisions
       WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3 AND valid_from > $4
       ORDER BY valid_from ASC LIMIT 1`,
    [ctx.tenantId, valid.subjectKind, valid.subjectId, row.valid_from],
  );
  const nextFrom = next.rows[0]?.valid_from;
  const validTo = nextFrom === undefined ? null : toIso(nextFrom);
  return mapRevision(row, validTo, validTo === null);
}

export async function listTemporalHistory(
  ctx: TenantContext,
  query: ListTemporalHistoryQuery,
): Promise<TemporalRevision[]> {
  assertFreshnessTenantContext(ctx);
  const valid = validateHistoryQuery(query);
  const rows = await getDb().query<RevisionRow>(
    `SELECT * FROM temporal_revisions
       WHERE tenant_id = $1 AND subject_kind = $2 AND subject_id = $3
       ORDER BY valid_from ASC, version ASC`,
    [ctx.tenantId, valid.subjectKind, valid.subjectId],
  );
  return rows.rows.map((row, index) => {
    const next = rows.rows[index + 1];
    const validTo = next === undefined ? null : toIso(next.valid_from);
    return mapRevision(row, validTo, validTo === null);
  });
}

// ---------------------------------------------------------------------------
// Freshness evaluation
// ---------------------------------------------------------------------------

export async function evaluateObservationFreshness(
  ctx: TenantContext,
  query: ObservationFreshnessQuery,
): Promise<ObservationFreshness> {
  assertFreshnessTenantContext(ctx);
  const valid = validateObservationFreshnessQuery(query);

  // Read through the observations contract (tenant-scoped, permission-
  // honoring). Its ObservationsError propagates unchanged — see errors.ts.
  const observation = await getObservation(ctx, valid.observationId);

  const evaluatedAt = valid.asOf ?? now();
  const latencySeconds = observationLatencySeconds(observation.observedAt, observation.recordedAt);
  const ageSeconds = evidenceAgeSeconds(observation.observedAt, toIso(evaluatedAt));

  // Policy resolution: source-specific first (a source record id), then the
  // observation-kind default.
  let policy: FreshnessPolicy | null = null;
  if (observation.source.id !== null && isUuid(observation.source.id)) {
    policy = await lookupPolicy(ctx, SOURCE_SUBJECT_KIND, observation.source.id);
  }
  if (policy === null) {
    policy = await lookupPolicy(ctx, observation.kind, null);
  }

  const status = classifyFreshness(thresholdsOf(policy), ageSeconds);
  const latencyExceeded =
    policy !== null && policy.maxLatencySeconds !== null && latencySeconds > policy.maxLatencySeconds;

  return {
    observationId: observation.id,
    tenantId: observation.tenantId,
    kind: observation.kind,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    evaluatedAt: toIso(evaluatedAt),
    latencySeconds,
    ageSeconds,
    status,
    policy,
    latencyExceeded,
  };
}

export async function evaluateSourceFreshness(
  ctx: TenantContext,
  query: SourceFreshnessQuery,
): Promise<SourceFreshness> {
  assertFreshnessTenantContext(ctx);
  const valid = validateSourceFreshnessQuery(query);

  const evaluatedAt = valid.asOf ?? now();

  // The source's evidence window: its latest observations by commit time,
  // read through the observations contract (principal-visibility honored).
  // The window is bounded by the contract's MAX_LIST_LIMIT (500) — enough
  // for W006's foundation scope; the source gateway (W036, which depends
  // on W004+W006) owns checkpointed freshness for high-volume sources.
  const feed = await listObservations(ctx, {
    sourceKind: valid.sourceKind,
    sourceId: valid.sourceId,
    limit: MAX_LIST_LIMIT,
  });

  // The feed is ordered by recordedAt DESC; source freshness is driven by
  // the NEWEST observed evidence, which is not necessarily the first row
  // (backfilled or clock-skewed sources commit old observations last).
  let latest: Observation | null = null;
  let latencySum = 0;
  let latencyMax = 0;
  for (const observation of feed) {
    if (latest === null || Date.parse(observation.observedAt) > Date.parse(latest.observedAt)) {
      latest = observation;
    }
    const latency = observationLatencySeconds(observation.observedAt, observation.recordedAt);
    latencySum += latency;
    latencyMax = Math.max(latencyMax, latency);
  }

  const policy = await resolveFreshnessPolicy(ctx, {
    subjectKind: SOURCE_SUBJECT_KIND,
    subjectId: valid.sourceId,
  });

  const ageSeconds =
    latest === null ? null : evidenceAgeSeconds(latest.observedAt, toIso(evaluatedAt));
  const status =
    latest === null || ageSeconds === null
      ? 'unknown'
      : classifyFreshness(thresholdsOf(policy), ageSeconds);

  return {
    sourceKind: valid.sourceKind,
    sourceId: valid.sourceId,
    tenantId: ctx.tenantId,
    evaluatedAt: toIso(evaluatedAt),
    latestObservationId: latest?.id ?? null,
    latestObservedAt: latest?.observedAt ?? null,
    latestRecordedAt: latest?.recordedAt ?? null,
    ageSeconds,
    status,
    policy,
    observationsConsidered: feed.length,
    maxObservedLatencySeconds: feed.length === 0 ? null : latencyMax,
    avgObservedLatencySeconds:
      feed.length === 0 ? null : latencySum / feed.length,
  };
}

export async function evaluateTemporalStateFreshness(
  ctx: TenantContext,
  query: TemporalStateFreshnessQuery,
): Promise<TemporalStateFreshness> {
  assertFreshnessTenantContext(ctx);
  const valid = validateTemporalStateFreshnessQuery(query);

  const evaluatedAt = valid.asOf ?? now();
  const revision = await getTemporalState(ctx, {
    subjectKind: valid.subjectKind,
    subjectId: valid.subjectId,
    asOf: toIso(evaluatedAt),
  });

  // Partial view over the provenance (the observations module's lineage
  // precedent): supporting evidence the caller may not read is skipped,
  // never leaked and never fails the evaluation.
  let evidenceObservedAt: string | null = null;
  let supportingObservations = 0;
  for (const observationId of revision.provenance.observationIds) {
    try {
      const observation = await getObservation(ctx, observationId);
      supportingObservations += 1;
      if (
        evidenceObservedAt === null ||
        Date.parse(observation.observedAt) > Date.parse(evidenceObservedAt)
      ) {
        evidenceObservedAt = observation.observedAt;
      }
    } catch (error) {
      if (error instanceof ObservationsError) continue; // unreadable evidence is skipped
      throw error;
    }
  }

  const policy = await resolveFreshnessPolicy(ctx, {
    subjectKind: valid.subjectKind,
    subjectId: valid.subjectId,
  });

  const ageSeconds =
    evidenceObservedAt === null ? null : evidenceAgeSeconds(evidenceObservedAt, toIso(evaluatedAt));
  const status =
    ageSeconds === null ? 'unknown' : classifyFreshness(thresholdsOf(policy), ageSeconds);

  return {
    subjectKind: valid.subjectKind,
    subjectId: valid.subjectId,
    tenantId: revision.tenantId,
    revision,
    evaluatedAt: toIso(evaluatedAt),
    evidenceObservedAt,
    supportingObservations,
    recordedObservations: revision.provenance.observationIds.length,
    ageSeconds,
    status,
    policy,
  };
}
