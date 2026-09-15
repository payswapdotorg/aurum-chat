// Implementation of the epistemics module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()` — the belief id is minted up-front with an explicit
// `SELECT gen_random_uuid()` so the FIRST version of its statement can be
// recorded before the anchor row exists: a failed anchor insert can then
// only leave an invisible orphan revision, never a phantom belief);
// semantic timestamps (`recorded_at`, `created_at`, `detected_at`,
// `resolved_at`, `retired_at`) come from the injectable clock and are never
// caller-supplied; every statement is scoped by the explicit TenantContext
// (ADR-0001) — cross-tenant access is indistinguishable from a missing
// record (`claim_not_found` / `contradiction_not_found` /
// `hypothesis_not_found` / `unknown_not_found` / `belief_not_found`).
//
// W007 acceptance — "implement claims, beliefs, hypotheses, unknowns and
// contradictions with evidence links; verify conflicting evidence is
// retained" — is carried by these deliberate properties, all tested:
//   1. claims are APPEND-ONLY: no update/delete operation exists on the
//      contract and PostgreSQL triggers reject UPDATE/DELETE/TRUNCATE
//      outright (migrations/001) — a re-derivation is a new claim, so
//      conflicting derivations coexist;
//   2. contradictions are RETAINED (lock 12): registration is one row per
//      canonical evidence pair; the pair and the note are frozen by trigger;
//      resolution is a one-way annotation that never touches the evidence;
//   3. hypotheses and unknowns follow the same retention discipline
//      (one-way resolution, frozen identity, no deletion);
//   4. every claim, belief version and (optionally) hypothesis/unknown is
//      linked to evidence validated through the observations contract —
//      existing in THIS tenant and readable by the acting principal;
//   5. beliefs are VERSIONED working understanding: the anchor lives here,
//      the versioned statement (with observation provenance) lives in the
//      freshness module's temporal_revisions under subject kind
//      'epistemics.belief' — the wiring the freshness contract anticipates.
//
// Cross-module integration: observations are read ONLY through the
// observations contract (getObservation) and belief versioning goes ONLY
// through the freshness contract (recordTemporalRevision / getTemporalState
// / listTemporalHistory / evaluateTemporalStateFreshness) — never their
// tables. Error propagation follows the policy documented in errors.ts.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getObservation, ObservationsError } from '@/modules/observations/contract';
import {
  evaluateTemporalStateFreshness,
  FreshnessError,
  getTemporalState,
  listTemporalHistory,
  recordTemporalRevision,
  type TemporalRevision,
} from '@/modules/freshness/contract';
import { EpistemicsError } from './errors';
import {
  assertEpistemicsTenantContext,
  BELIEF_SUBJECT_KIND,
  orderEvidenceRefs,
  parseBeliefStatement,
  validateBeliefInput,
  validateGetBeliefQuery,
  validateGetClaimQuery,
  validateGetContradictionQuery,
  validateGetHypothesisQuery,
  validateGetUnknownQuery,
  validateListBeliefHistoryQuery,
  validateListBeliefsQuery,
  validateListClaimsQuery,
  validateListContradictionsQuery,
  validateListHypothesesQuery,
  validateListUnknownsQuery,
  validateRecordClaimInput,
  validateRecordHypothesisInput,
  validateRecordUnknownInput,
  validateRegisterContradictionInput,
  validateResolveContradictionInput,
  validateResolveHypothesisInput,
  validateResolveUnknownInput,
  validateRetireBeliefInput,
  validateReviseBeliefInput,
  type ValidatedBeliefInput,
} from './validation';
import type {
  Belief,
  BeliefAnchor,
  BeliefFreshness,
  BeliefVersion,
  Claim,
  Contradiction,
  EvidenceRef,
  GetClaimQuery,
  GetContradictionQuery,
  GetHypothesisQuery,
  GetUnknownQuery,
  Hypothesis,
  ListClaimsQuery,
  ListContradictionsQuery,
  ListHypothesesQuery,
  ListUnknownsQuery,
  RecordClaimInput,
  RecordHypothesisInput,
  RecordUnknownInput,
  RegisterContradictionInput,
  ResolutionRef,
  ResolveContradictionInput,
  ResolveHypothesisInput,
  ResolveUnknownInput,
  RetireBeliefInput,
  ReviseBeliefInput,
  BeliefInput,
  Unknown,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface ClaimRow extends DbRow {
  id: string;
  tenant_id: string;
  proposition: string;
  subject_kind: string | null;
  subject_id: string | null;
  confidence_value: number;
  confidence_method: string;
  confidence_basis: string | null;
  evidence_observation_ids: string[];
  rationale: string | null;
  recorded_at: Date | string;
}

interface ContradictionRow extends DbRow {
  id: string;
  tenant_id: string;
  evidence_a_kind: string;
  evidence_a_id: string;
  evidence_b_kind: string;
  evidence_b_id: string;
  note: string;
  status: string;
  detected_at: Date | string;
  resolved_at: Date | string | null;
  resolved_by_kind: string | null;
  resolved_by_id: string | null;
  resolution_note: string | null;
}

interface HypothesisRow extends DbRow {
  id: string;
  tenant_id: string;
  proposition: string;
  subject_kind: string | null;
  subject_id: string | null;
  status: string;
  supporting_observation_ids: string[];
  note: string | null;
  recorded_at: Date | string;
  resolved_at: Date | string | null;
  resolution_evidence_observation_ids: string[];
  resolution_evidence_claim_ids: string[];
  resolution_note: string | null;
}

interface UnknownRow extends DbRow {
  id: string;
  tenant_id: string;
  question: string;
  consequence: string;
  subject_kind: string | null;
  subject_id: string | null;
  status: string;
  related_observation_ids: string[];
  related_claim_ids: string[];
  related_belief_ids: string[];
  note: string | null;
  recorded_at: Date | string;
  resolved_at: Date | string | null;
  resolution_kind: string | null;
  resolution_id: string | null;
  resolution_note: string | null;
}

interface BeliefRow extends DbRow {
  id: string;
  tenant_id: string;
  subject_kind: string | null;
  subject_id: string | null;
  status: string;
  retire_reason: string | null;
  created_at: Date | string;
  retired_at: Date | string | null;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposition: row.proposition,
    subject: row.subject_kind === null ? null : { kind: row.subject_kind, id: row.subject_id! },
    confidence: {
      value: row.confidence_value,
      method: row.confidence_method,
      basis: row.confidence_basis,
    },
    evidenceObservationIds: [...(row.evidence_observation_ids ?? [])],
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapContradiction(row: ContradictionRow): Contradiction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    evidenceA: { kind: row.evidence_a_kind as EvidenceRef['kind'], id: row.evidence_a_id },
    evidenceB: { kind: row.evidence_b_kind as EvidenceRef['kind'], id: row.evidence_b_id },
    note: row.note,
    status: row.status as Contradiction['status'],
    detectedAt: toIso(row.detected_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    resolvedBy:
      row.resolved_by_kind === null
        ? null
        : { kind: row.resolved_by_kind as ResolutionRef['kind'], id: row.resolved_by_id! },
    resolutionNote: row.resolution_note,
  };
}

function mapHypothesis(row: HypothesisRow): Hypothesis {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    proposition: row.proposition,
    subject: row.subject_kind === null ? null : { kind: row.subject_kind, id: row.subject_id! },
    status: row.status as Hypothesis['status'],
    supportingObservationIds: [...(row.supporting_observation_ids ?? [])],
    note: row.note,
    recordedAt: toIso(row.recorded_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    resolutionEvidenceObservationIds: [...(row.resolution_evidence_observation_ids ?? [])],
    resolutionEvidenceClaimIds: [...(row.resolution_evidence_claim_ids ?? [])],
    resolutionNote: row.resolution_note,
  };
}

function mapUnknown(row: UnknownRow): Unknown {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    question: row.question,
    consequence: row.consequence,
    subject: row.subject_kind === null ? null : { kind: row.subject_kind, id: row.subject_id! },
    status: row.status as Unknown['status'],
    relatedObservationIds: [...(row.related_observation_ids ?? [])],
    relatedClaimIds: [...(row.related_claim_ids ?? [])],
    relatedBeliefIds: [...(row.related_belief_ids ?? [])],
    note: row.note,
    recordedAt: toIso(row.recorded_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    resolution:
      row.resolution_kind === null
        ? null
        : { kind: row.resolution_kind as ResolutionRef['kind'], id: row.resolution_id! },
    resolutionNote: row.resolution_note,
  };
}

function mapBeliefAnchor(row: BeliefRow): BeliefAnchor {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: row.subject_kind === null ? null : { kind: row.subject_kind, id: row.subject_id! },
    status: row.status as BeliefAnchor['status'],
    retireReason: row.retire_reason,
    createdAt: toIso(row.created_at),
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
  };
}

function mapBeliefVersion(revision: TemporalRevision): BeliefVersion {
  return {
    version: revision.version,
    statement: parseBeliefStatement(revision.state),
    provenance: { observationIds: [...revision.provenance.observationIds] },
    validFrom: revision.validFrom,
    validTo: revision.validTo,
    recordedAt: revision.recordedAt,
    current: revision.current,
    rationale: revision.rationale,
  };
}

function mapBelief(anchor: BeliefAnchor, revision: TemporalRevision): Belief {
  return {
    ...anchor,
    ...mapBeliefVersion(revision),
  };
}

// ---------------------------------------------------------------------------
// Cross-module error mapping (freshness machinery is internal to beliefs)
// ---------------------------------------------------------------------------

/** Maps a FreshnessError from the belief-versioning machinery onto this module's vocabulary. */
function mapFreshnessError(error: unknown): Error {
  if (error instanceof FreshnessError) {
    switch (error.code) {
      case 'invalid_provenance':
        return new EpistemicsError('invalid_evidence', error.message);
      case 'invalid_revision_input':
        return new EpistemicsError('invalid_belief_input', error.message);
      case 'revision_conflict':
        return new EpistemicsError('belief_conflict', error.message);
      case 'temporal_state_not_found':
        return new EpistemicsError('belief_version_not_found', error.message);
      default:
        return error;
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** True when `error` is a PostgreSQL unique violation naming `table`. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

// ---------------------------------------------------------------------------
// Evidence validation (through the owning modules' contracts)
// ---------------------------------------------------------------------------

/**
 * Every supporting observation must exist in THIS tenant and be readable by
 * the acting principal. Cross-tenant and restricted evidence are uniformly
 * `invalid_evidence` — no existence leak. Observations are immutable, so a
 * validated link cannot dangle afterwards (DELETE is impossible by trigger).
 */
async function validateObservationRefs(ctx: TenantContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await getObservation(ctx, id);
    } catch (error) {
      if (error instanceof ObservationsError) {
        throw new EpistemicsError(
          'invalid_evidence',
          `supporting observation '${id}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }
}

/** Referenced claims must exist in THIS tenant (this module's own records). */
async function validateClaimRefs(ctx: TenantContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await getDb().query<{ id: string }>(
    `SELECT id FROM claims WHERE tenant_id = $1 AND id = ANY($2)`,
    [ctx.tenantId, ids],
  );
  const found = new Set(rows.rows.map((row) => row.id));
  for (const id of ids) {
    if (!found.has(id)) {
      throw new EpistemicsError(
        'invalid_evidence',
        `referenced claim '${id}' is not available in this tenant`,
      );
    }
  }
}

/** Referenced belief anchors must exist in THIS tenant. */
async function validateBeliefRefs(ctx: TenantContext, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await getDb().query<{ id: string }>(
    `SELECT id FROM beliefs WHERE tenant_id = $1 AND id = ANY($2)`,
    [ctx.tenantId, ids],
  );
  const found = new Set(rows.rows.map((row) => row.id));
  for (const id of ids) {
    if (!found.has(id)) {
      throw new EpistemicsError(
        'invalid_evidence',
        `referenced belief '${id}' is not available in this tenant`,
      );
    }
  }
}

/** One evidence reference (observation or claim) for contradictions. */
async function validateEvidenceRef(ctx: TenantContext, ref: EvidenceRef): Promise<void> {
  if (ref.kind === 'observation') return validateObservationRefs(ctx, [ref.id]);
  return validateClaimRefs(ctx, [ref.id]);
}

/** One resolution reference (belief, claim or observation). */
async function validateResolutionRef(ctx: TenantContext, ref: ResolutionRef): Promise<void> {
  if (ref.kind === 'observation') return validateObservationRefs(ctx, [ref.id]);
  if (ref.kind === 'claim') return validateClaimRefs(ctx, [ref.id]);
  return validateBeliefRefs(ctx, [ref.id]);
}

// ---------------------------------------------------------------------------
// Claims — immutable evidence-derived propositions
// ---------------------------------------------------------------------------

export async function recordClaim(ctx: TenantContext, input: RecordClaimInput): Promise<Claim> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateRecordClaimInput(input);

  // Evidence gate before the write: claims are never derived from nothing
  // and never from unreadable evidence (lock 11 discipline for propositions).
  await validateObservationRefs(ctx, valid.evidenceObservationIds);

  const recordedAt = now();
  const inserted = await getDb().query<ClaimRow>(
    `INSERT INTO claims (
       tenant_id, proposition, subject_kind, subject_id,
       confidence_value, confidence_method, confidence_basis,
       evidence_observation_ids, rationale, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.proposition,
      valid.subject?.kind ?? null,
      valid.subject?.id ?? null,
      valid.confidence.value,
      valid.confidence.method,
      valid.confidence.basis,
      JSON.stringify(valid.evidenceObservationIds),
      valid.rationale,
      recordedAt,
    ],
  );
  return mapClaim(inserted.rows[0]!);
}

export async function getClaim(ctx: TenantContext, query: GetClaimQuery): Promise<Claim> {
  assertEpistemicsTenantContext(ctx);
  const claimId = validateGetClaimQuery(query);
  const rows = await getDb().query<ClaimRow>(
    `SELECT * FROM claims WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, claimId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EpistemicsError('claim_not_found', `no claim '${claimId}' exists in this tenant`);
  }
  return mapClaim(row);
}

export async function listClaims(ctx: TenantContext, query: ListClaimsQuery): Promise<Claim[]> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateListClaimsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`subject_kind = $${params.length}`);
  }
  if (valid.subjectId !== null) {
    params.push(valid.subjectId);
    conditions.push(`subject_id = $${params.length}`);
  }
  if (valid.evidenceObservationId !== null) {
    params.push(JSON.stringify([valid.evidenceObservationId]));
    conditions.push(`evidence_observation_ids @> $${params.length}::jsonb`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<ClaimRow>(
    `SELECT * FROM claims WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapClaim);
}

// ---------------------------------------------------------------------------
// Contradictions — retained conflicts between two evidence references
// ---------------------------------------------------------------------------

export async function registerContradiction(
  ctx: TenantContext,
  input: RegisterContradictionInput,
): Promise<Contradiction> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateRegisterContradictionInput(input);

  // Canonical pair order — the same ordering the SQL canonical-order CHECK
  // enforces — so one unordered pair maps to exactly one row per tenant.
  const [evidenceA, evidenceB] = orderEvidenceRefs(valid.left, valid.right);

  // Both sides must be readable evidence in THIS tenant: a contradiction
  // between unreadable (cross-tenant / restricted) evidence is uniformly
  // `invalid_evidence` — no existence leak.
  await validateEvidenceRef(ctx, evidenceA);
  await validateEvidenceRef(ctx, evidenceB);

  const detectedAt = now();
  let inserted: DbResult<ContradictionRow>;
  try {
    inserted = await getDb().query<ContradictionRow>(
      `INSERT INTO contradictions (
         tenant_id, evidence_a_kind, evidence_a_id,
         evidence_b_kind, evidence_b_id, note, detected_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        ctx.tenantId,
        evidenceA.kind,
        evidenceA.id,
        evidenceB.kind,
        evidenceB.id,
        valid.note,
        detectedAt,
      ],
    );
  } catch (error) {
    if (isDuplicateKeyOn(error, 'contradictions')) {
      // One contradiction record per evidence pair, per tenant: the pair is
      // already retained — the caller must look at what is recorded.
      throw new EpistemicsError(
        'contradiction_conflict',
        'this evidence pair is already registered as contradictory in this tenant',
      );
    }
    throw error;
  }
  return mapContradiction(inserted.rows[0]!);
}

export async function getContradiction(
  ctx: TenantContext,
  query: GetContradictionQuery,
): Promise<Contradiction> {
  assertEpistemicsTenantContext(ctx);
  const contradictionId = validateGetContradictionQuery(query);
  const rows = await getDb().query<ContradictionRow>(
    `SELECT * FROM contradictions WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, contradictionId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EpistemicsError(
      'contradiction_not_found',
      `no contradiction '${contradictionId}' exists in this tenant`,
    );
  }
  return mapContradiction(row);
}

export async function listContradictions(
  ctx: TenantContext,
  query: ListContradictionsQuery,
): Promise<Contradiction[]> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateListContradictionsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.evidenceRef !== null) {
    params.push(valid.evidenceRef.kind, valid.evidenceRef.id);
    const kindPlaceholder = `$${params.length - 1}`;
    const idPlaceholder = `$${params.length}`;
    conditions.push(
      `((evidence_a_kind = ${kindPlaceholder} AND evidence_a_id = ${idPlaceholder})
        OR (evidence_b_kind = ${kindPlaceholder} AND evidence_b_id = ${idPlaceholder}))`,
    );
  }
  params.push(valid.limit);
  const rows = await getDb().query<ContradictionRow>(
    `SELECT * FROM contradictions WHERE ${conditions.join(' AND ')}
       ORDER BY detected_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapContradiction);
}

export async function resolveContradiction(
  ctx: TenantContext,
  input: ResolveContradictionInput,
): Promise<Contradiction> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateResolveContradictionInput(input);

  if (valid.resolvedBy !== null) await validateResolutionRef(ctx, valid.resolvedBy);

  const existing = await getContradiction(ctx, { contradictionId: valid.contradictionId });
  if (existing.status === 'resolved') {
    throw new EpistemicsError(
      'invalid_resolution',
      `contradiction '${valid.contradictionId}' is already resolved — resolutions are one-way (retained, never rewritten)`,
    );
  }

  // One-way transition guarded twice: WHERE status='open' handles the
  // concurrent case; the retention trigger enforces it at the storage layer.
  const resolvedAt = now();
  const updated = await getDb().query<ContradictionRow>(
    `UPDATE contradictions
       SET status = 'resolved', resolved_at = $3,
           resolved_by_kind = $4, resolved_by_id = $5, resolution_note = $6
       WHERE tenant_id = $1 AND id = $2 AND status = 'open'
       RETURNING *`,
    [
      ctx.tenantId,
      valid.contradictionId,
      resolvedAt,
      valid.resolvedBy?.kind ?? null,
      valid.resolvedBy?.id ?? null,
      valid.note,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    // Lost a race with a concurrent resolution: resolutions are one-way.
    throw new EpistemicsError(
      'invalid_resolution',
      `contradiction '${valid.contradictionId}' was resolved concurrently — resolutions are one-way`,
    );
  }
  return mapContradiction(row);
}

// ---------------------------------------------------------------------------
// Hypotheses — unresolved explanations
// ---------------------------------------------------------------------------

export async function recordHypothesis(
  ctx: TenantContext,
  input: RecordHypothesisInput,
): Promise<Hypothesis> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateRecordHypothesisInput(input);

  // Supporting evidence is optional (a hypothesis may precede its evidence),
  // but whatever it cites must be readable in-tenant.
  await validateObservationRefs(ctx, valid.supportingObservationIds);

  const recordedAt = now();
  const inserted = await getDb().query<HypothesisRow>(
    `INSERT INTO hypotheses (
       tenant_id, proposition, subject_kind, subject_id,
       supporting_observation_ids, note, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.proposition,
      valid.subject?.kind ?? null,
      valid.subject?.id ?? null,
      JSON.stringify(valid.supportingObservationIds),
      valid.note,
      recordedAt,
    ],
  );
  return mapHypothesis(inserted.rows[0]!);
}

export async function getHypothesis(
  ctx: TenantContext,
  query: GetHypothesisQuery,
): Promise<Hypothesis> {
  assertEpistemicsTenantContext(ctx);
  const hypothesisId = validateGetHypothesisQuery(query);
  const rows = await getDb().query<HypothesisRow>(
    `SELECT * FROM hypotheses WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, hypothesisId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EpistemicsError(
      'hypothesis_not_found',
      `no hypothesis '${hypothesisId}' exists in this tenant`,
    );
  }
  return mapHypothesis(row);
}

export async function listHypotheses(
  ctx: TenantContext,
  query: ListHypothesesQuery,
): Promise<Hypothesis[]> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateListHypothesesQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`subject_kind = $${params.length}`);
  }
  if (valid.subjectId !== null) {
    params.push(valid.subjectId);
    conditions.push(`subject_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<HypothesisRow>(
    `SELECT * FROM hypotheses WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapHypothesis);
}

export async function resolveHypothesis(
  ctx: TenantContext,
  input: ResolveHypothesisInput,
): Promise<Hypothesis> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateResolveHypothesisInput(input);

  await validateObservationRefs(ctx, valid.evidenceObservationIds);
  await validateClaimRefs(ctx, valid.evidenceClaimIds);

  const existing = await getHypothesis(ctx, { hypothesisId: valid.hypothesisId });
  if (existing.status !== 'open') {
    throw new EpistemicsError(
      'invalid_resolution',
      `hypothesis '${valid.hypothesisId}' is already ${existing.status} — hypothesis resolutions are one-way (retained, never rewritten)`,
    );
  }

  const resolvedAt = now();
  const updated = await getDb().query<HypothesisRow>(
    `UPDATE hypotheses
       SET status = $3, resolved_at = $4,
           resolution_evidence_observation_ids = $5,
           resolution_evidence_claim_ids = $6,
           resolution_note = $7
       WHERE tenant_id = $1 AND id = $2 AND status = 'open'
       RETURNING *`,
    [
      ctx.tenantId,
      valid.hypothesisId,
      valid.outcome,
      resolvedAt,
      JSON.stringify(valid.evidenceObservationIds),
      JSON.stringify(valid.evidenceClaimIds),
      valid.note,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new EpistemicsError(
      'invalid_resolution',
      `hypothesis '${valid.hypothesisId}' was resolved concurrently — resolutions are one-way`,
    );
  }
  return mapHypothesis(row);
}

// ---------------------------------------------------------------------------
// Unknowns — consequential gaps in knowledge
// ---------------------------------------------------------------------------

export async function recordUnknown(
  ctx: TenantContext,
  input: RecordUnknownInput,
): Promise<Unknown> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateRecordUnknownInput(input);

  // Everything the unknown relates to must be readable in this tenant.
  await validateObservationRefs(ctx, valid.relatedObservationIds);
  await validateClaimRefs(ctx, valid.relatedClaimIds);
  await validateBeliefRefs(ctx, valid.relatedBeliefIds);

  const recordedAt = now();
  const inserted = await getDb().query<UnknownRow>(
    `INSERT INTO unknowns (
       tenant_id, question, consequence, subject_kind, subject_id,
       related_observation_ids, related_claim_ids, related_belief_ids,
       note, recorded_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      ctx.tenantId,
      valid.question,
      valid.consequence,
      valid.subject?.kind ?? null,
      valid.subject?.id ?? null,
      JSON.stringify(valid.relatedObservationIds),
      JSON.stringify(valid.relatedClaimIds),
      JSON.stringify(valid.relatedBeliefIds),
      valid.note,
      recordedAt,
    ],
  );
  return mapUnknown(inserted.rows[0]!);
}

export async function getUnknown(ctx: TenantContext, query: GetUnknownQuery): Promise<Unknown> {
  assertEpistemicsTenantContext(ctx);
  const unknownId = validateGetUnknownQuery(query);
  const rows = await getDb().query<UnknownRow>(
    `SELECT * FROM unknowns WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, unknownId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EpistemicsError('unknown_not_found', `no unknown '${unknownId}' exists in this tenant`);
  }
  return mapUnknown(row);
}

export async function listUnknowns(
  ctx: TenantContext,
  query: ListUnknownsQuery,
): Promise<Unknown[]> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateListUnknownsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`subject_kind = $${params.length}`);
  }
  if (valid.subjectId !== null) {
    params.push(valid.subjectId);
    conditions.push(`subject_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<UnknownRow>(
    `SELECT * FROM unknowns WHERE ${conditions.join(' AND ')}
       ORDER BY recorded_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapUnknown);
}

export async function resolveUnknown(
  ctx: TenantContext,
  input: ResolveUnknownInput,
): Promise<Unknown> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateResolveUnknownInput(input);

  if (valid.resolution !== null) await validateResolutionRef(ctx, valid.resolution);

  const existing = await getUnknown(ctx, { unknownId: valid.unknownId });
  if (existing.status === 'resolved') {
    throw new EpistemicsError(
      'invalid_resolution',
      `unknown '${valid.unknownId}' is already resolved — resolutions are one-way (retained, never rewritten)`,
    );
  }

  const resolvedAt = now();
  const updated = await getDb().query<UnknownRow>(
    `UPDATE unknowns
       SET status = 'resolved', resolved_at = $3,
           resolution_kind = $4, resolution_id = $5, resolution_note = $6
       WHERE tenant_id = $1 AND id = $2 AND status = 'open'
       RETURNING *`,
    [
      ctx.tenantId,
      valid.unknownId,
      resolvedAt,
      valid.resolution?.kind ?? null,
      valid.resolution?.id ?? null,
      valid.note,
    ],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new EpistemicsError(
      'invalid_resolution',
      `unknown '${valid.unknownId}' was resolved concurrently — resolutions are one-way`,
    );
  }
  return mapUnknown(row);
}

// ---------------------------------------------------------------------------
// Beliefs — versioned current working understanding
// ---------------------------------------------------------------------------

async function loadBeliefAnchor(ctx: TenantContext, beliefId: string): Promise<BeliefAnchor> {
  const rows = await getDb().query<BeliefRow>(
    `SELECT * FROM beliefs WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, beliefId],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new EpistemicsError('belief_not_found', `no belief '${beliefId}' exists in this tenant`);
  }
  return mapBeliefAnchor(row);
}

/** Records a belief version through the freshness machinery (W006 wiring). */
async function recordBeliefVersion(
  ctx: TenantContext,
  beliefId: string,
  valid: ValidatedBeliefInput,
): Promise<TemporalRevision> {
  try {
    return await recordTemporalRevision(ctx, {
      subjectKind: BELIEF_SUBJECT_KIND,
      subjectId: beliefId,
      state: valid.statement,
      validFrom: valid.validFrom,
      observationIds: valid.supportingObservationIds,
      rationale: valid.rationale,
    });
  } catch (error) {
    throw mapFreshnessError(error);
  }
}

export async function formBelief(ctx: TenantContext, input: BeliefInput): Promise<Belief> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateBeliefInput(input);

  // Evidence gate before any write (both the claims it weighs and the
  // observations on the version's provenance — lock 11).
  await validateObservationRefs(ctx, valid.supportingObservationIds);
  await validateClaimRefs(ctx, valid.statement.supportingClaimIds);

  // Mint the belief id up-front (still by the database): the FIRST version
  // of the statement is recorded before the anchor exists, so a failure can
  // only leave an invisible orphan revision — never a phantom belief that
  // lists without a statement.
  const minted = await getDb().query<{ id: string }>(`SELECT gen_random_uuid() AS id`);
  const beliefId = minted.rows[0]!.id;
  const revision = await recordBeliefVersion(ctx, beliefId, valid);

  const createdAt = now();
  const inserted = await getDb().query<BeliefRow>(
    `INSERT INTO beliefs (id, tenant_id, subject_kind, subject_id, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
    [beliefId, ctx.tenantId, valid.subject?.kind ?? null, valid.subject?.id ?? null, createdAt],
  );
  return mapBelief(mapBeliefAnchor(inserted.rows[0]!), revision);
}

export async function reviseBelief(
  ctx: TenantContext,
  input: ReviseBeliefInput,
): Promise<Belief> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateReviseBeliefInput(input);

  const anchor = await loadBeliefAnchor(ctx, valid.beliefId);
  if (anchor.status !== 'active') {
    throw new EpistemicsError(
      'belief_retired',
      `belief '${valid.beliefId}' is retired — retired beliefs are terminal and cannot be revised`,
    );
  }

  await validateObservationRefs(ctx, valid.supportingObservationIds);
  await validateClaimRefs(ctx, valid.statement.supportingClaimIds);

  // Appends the next version (strictly increasing validFrom is enforced by
  // the temporal machinery and mapped to invalid_belief_input here).
  const revision = await recordBeliefVersion(ctx, valid.beliefId, valid);
  return mapBelief(anchor, revision);
}

export async function retireBelief(
  ctx: TenantContext,
  input: RetireBeliefInput,
): Promise<BeliefAnchor> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateRetireBeliefInput(input);

  const anchor = await loadBeliefAnchor(ctx, valid.beliefId);
  if (anchor.status !== 'active') {
    throw new EpistemicsError(
      'belief_retired',
      `belief '${valid.beliefId}' is already retired — retirement is one-way`,
    );
  }

  // One-way transition guarded twice: WHERE status='active' handles the
  // concurrent case; the lifecycle trigger enforces it at the storage layer.
  const retiredAt = now();
  const updated = await getDb().query<BeliefRow>(
    `UPDATE beliefs
       SET status = 'retired', retired_at = $3, retire_reason = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'active'
       RETURNING *`,
    [ctx.tenantId, valid.beliefId, retiredAt, valid.rationale],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    throw new EpistemicsError(
      'belief_retired',
      `belief '${valid.beliefId}' was retired concurrently — retirement is one-way`,
    );
  }
  return mapBeliefAnchor(row);
}

export async function getBelief(
  ctx: TenantContext,
  query: Parameters<typeof validateGetBeliefQuery>[0],
): Promise<Belief> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateGetBeliefQuery(query);

  const anchor = await loadBeliefAnchor(ctx, valid.beliefId);
  try {
    const revision = await getTemporalState(ctx, {
      subjectKind: BELIEF_SUBJECT_KIND,
      subjectId: valid.beliefId,
      asOf: valid.asOf === null ? undefined : valid.asOf.toISOString(),
    });
    return mapBelief(anchor, revision);
  } catch (error) {
    throw mapFreshnessError(error);
  }
}

export async function listBeliefs(
  ctx: TenantContext,
  query: Parameters<typeof validateListBeliefsQuery>[0],
): Promise<BeliefAnchor[]> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateListBeliefsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  if (valid.subjectKind !== null) {
    params.push(valid.subjectKind);
    conditions.push(`subject_kind = $${params.length}`);
  }
  if (valid.subjectId !== null) {
    params.push(valid.subjectId);
    conditions.push(`subject_id = $${params.length}`);
  }
  params.push(valid.limit);
  const rows = await getDb().query<BeliefRow>(
    `SELECT * FROM beliefs WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map(mapBeliefAnchor);
}

export async function listBeliefHistory(
  ctx: TenantContext,
  query: Parameters<typeof validateListBeliefHistoryQuery>[0],
): Promise<BeliefVersion[]> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateListBeliefHistoryQuery(query);

  await loadBeliefAnchor(ctx, valid.beliefId);
  const revisions = await listTemporalHistory(ctx, {
    subjectKind: BELIEF_SUBJECT_KIND,
    subjectId: valid.beliefId,
  });
  return revisions.map(mapBeliefVersion);
}

export async function evaluateBeliefFreshness(
  ctx: TenantContext,
  query: Parameters<typeof validateGetBeliefQuery>[0],
): Promise<BeliefFreshness> {
  assertEpistemicsTenantContext(ctx);
  const valid = validateGetBeliefQuery(query);

  await loadBeliefAnchor(ctx, valid.beliefId);
  try {
    return await evaluateTemporalStateFreshness(ctx, {
      subjectKind: BELIEF_SUBJECT_KIND,
      subjectId: valid.beliefId,
      asOf: valid.asOf === null ? undefined : valid.asOf.toISOString(),
    });
  } catch (error) {
    throw mapFreshnessError(error);
  }
}
