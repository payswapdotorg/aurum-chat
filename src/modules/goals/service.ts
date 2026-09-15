// Implementation of the goals module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at`/`created_at` come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`goal_not_found` /
// `goal_version_not_found`), including on revisions.
//
// W008 acceptance — "verify goal changes are auditable" — is carried by
// these deliberate properties, all tested:
//   1. VERSIONED: a goal is an identity row (`goals`) plus an append-only
//      chain of FULL-snapshot versions (`goal_versions`). Revising appends
//      version N+1 and never mutates history — no update/delete operation
//      exists on the contract, and PostgreSQL itself rejects
//      UPDATE/DELETE/TRUNCATE on versions (and DELETE/TRUNCATE on the
//      identity) via migration 001 triggers. `version`, `recorded_at`,
//      `change_kind` and `changed_by_principal` are system-minted;
//      caller-supplied identity/audit fields are rejected at validation.
//   2. AUDITABLE: every version records the quartet — who (actor party +
//      the authenticated principal from the TenantContext), when
//      (`recorded_at`), what (`change_kind` + a self-contained content
//      snapshot: any version decodes without the others, and diffs between
//      consecutive versions reconstruct the exact change), why
//      (`rationale`). `listGoalVersions` is the audit trail;
//      `getGoalVersion` deep-links one entry.
//   3. ORDERED: versions are 1-based and strictly increasing per goal,
//      allocated inside the revision transaction under a row lock on the
//      goal identity (FOR UPDATE) plus an optimistic
//      `current_version = expected` guard — a concurrent reviser loses
//      cleanly with `goal_conflict`, never corrupting the chain.
//   4. SURGICAL LIFECYCLE: a status change must be the only change in its
//      revision (validation), an archived goal accepts nothing but
//      reactivation (service transition gate), and the change kind is
//      derived — so the audit trail never conflates content revisions with
//      archive/reactivate transitions.
//
// Storage shape: `goals` carries NO content (identity + current-version
// pointer only), so the current picture and the audit trail can never
// diverge; every read of a goal joins its current version row.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { GoalsError } from './errors';
import {
  assertGoalTenantContext,
  deriveChangeKind,
  escapeLike,
  isUuid,
  validateCreateGoalInput,
  validateGoalContent,
  validateHistoryQuery,
  validateListGoalsQuery,
  validateReviseGoalInput,
  validateVersionQuery,
  type ValidatedCreateGoalInput,
  type ValidatedGoalContent,
  type ValidatedListQuery,
  type ValidatedParty,
  type ValidatedRevisionInput,
  type ValidatedRevisionPatch,
} from './validation';
import type {
  CreateGoalInput,
  GetGoalVersionQuery,
  Goal,
  GoalActor,
  GoalChangeKind,
  GoalContent,
  GoalEvidenceSource,
  GoalHorizon,
  GoalMetric,
  GoalStatus,
  GoalVersion,
  ListGoalsQuery,
  ListGoalVersionsQuery,
  ReviseGoalInput,
} from './types';

/** Row shape of `goal_versions` (content + audit columns). */
interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  version: number | string;
  change_kind: string;
  title: string;
  objective: string;
  desired_state: string;
  metrics: unknown;
  horizon_start: Date | string | null;
  horizon_end: Date | string;
  owner: unknown;
  priority: string;
  evidence_sources: unknown;
  success_criteria: string;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the current-view join (`goals` ⋈ current `goal_versions`). */
interface GoalRow extends DbRow {
  goal_id: string;
  goal_tenant_id: string;
  goal_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  title: string;
  objective: string;
  desired_state: string;
  metrics: unknown;
  horizon_start: Date | string | null;
  horizon_end: Date | string;
  owner: unknown;
  priority: string;
  evidence_sources: unknown;
  success_criteria: string;
  status: string;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

// The current-view join, shared by getGoal and listGoals. Column aliases pin
// the GoalRow shape; every filter is parameterized by the caller's tenant.
const CURRENT_VIEW_FROM = `FROM goals g
  INNER JOIN goal_versions gv
    ON gv.goal_id = g.id AND gv.tenant_id = g.tenant_id AND gv.version = g.current_version`;

const CURRENT_VIEW_COLUMNS = `SELECT
    g.id AS goal_id, g.tenant_id AS goal_tenant_id, g.created_at AS goal_created_at,
    gv.version AS version_number, gv.change_kind,
    gv.title, gv.objective, gv.desired_state, gv.metrics,
    gv.horizon_start, gv.horizon_end, gv.owner, gv.priority,
    gv.evidence_sources, gv.success_criteria, gv.status,
    gv.actor_kind, gv.actor_id, gv.actor_label,
    gv.changed_by_principal, gv.rationale, gv.recorded_at`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function mapHorizon(row: { horizon_start: Date | string | null; horizon_end: Date | string }): GoalHorizon {
  return {
    start: row.horizon_start === null ? null : toIso(row.horizon_start),
    end: toIso(row.horizon_end),
  };
}

function mapParty(row: { actor_kind: string; actor_id: string | null; actor_label: string | null }): GoalActor {
  return {
    kind: row.actor_kind as GoalActor['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapMetrics(value: unknown): GoalMetric[] {
  return Array.isArray(value) ? (value as GoalMetric[]) : [];
}

function mapEvidenceSources(value: unknown): GoalEvidenceSource[] {
  return Array.isArray(value) ? (value as GoalEvidenceSource[]) : [];
}

function mapContent(row: {
  title: string;
  objective: string;
  desired_state: string;
  metrics: unknown;
  horizon_start: Date | string | null;
  horizon_end: Date | string;
  owner: unknown;
  priority: string;
  evidence_sources: unknown;
  success_criteria: string;
  status: string;
}): GoalContent {
  return {
    title: row.title,
    objective: row.objective,
    desiredState: row.desired_state,
    metrics: mapMetrics(row.metrics),
    horizon: mapHorizon(row),
    owner: row.owner as GoalContent['owner'], // shape guaranteed at write time
    priority: row.priority as GoalContent['priority'], // CHECK-constrained
    evidenceSources: mapEvidenceSources(row.evidence_sources),
    successCriteria: row.success_criteria,
    status: row.status as GoalStatus, // CHECK-constrained
  };
}

function mapVersion(row: VersionRow): GoalVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    version: toInt(row.version),
    changeKind: row.change_kind as GoalChangeKind, // CHECK-constrained
    content: mapContent(row),
    actor: mapParty(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapGoal(row: GoalRow): Goal {
  return {
    id: row.goal_id,
    tenantId: row.goal_tenant_id,
    version: toInt(row.version_number),
    content: mapContent(row),
    createdAt: toIso(row.goal_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: {
      kind: row.change_kind as GoalChangeKind, // CHECK-constrained
      actor: mapParty(row),
      changedByPrincipal: row.changed_by_principal,
      rationale: row.rationale,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

function goalNotFound(goalId: string): GoalsError {
  return new GoalsError('goal_not_found', `goal '${goalId}' does not exist in this tenant`);
}

/** True when `error` is a PostgreSQL unique violation on `table`'s constraints. */
function isDuplicateKeyOn(error: unknown, table: string): boolean {
  return (
    error instanceof Error &&
    /duplicate key value/i.test(error.message) &&
    error.message.includes(table)
  );
}

/**
 * Storage → loose content view used as the merge base of a revision. The
 * merged result is re-validated wholesale by `validateGoalContent`, so the
 * inferred (persisted-shape) typing is exactly what the merge needs.
 */
function contentOf(version: GoalVersion) {
  return {
    title: version.content.title,
    objective: version.content.objective,
    desiredState: version.content.desiredState,
    metrics: version.content.metrics,
    horizonStart: version.content.horizon.start,
    horizonEnd: version.content.horizon.end,
    owner: version.content.owner,
    priority: version.content.priority,
    evidenceSources: version.content.evidenceSources,
    successCriteria: version.content.successCriteria,
  };
}

/**
 * The SQL value tuple of one version row (content + audit), shared by the
 * create and revise append paths.
 */
function versionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    goalId: string;
    version: number;
    changeKind: GoalChangeKind;
    content: ValidatedCreateGoalInput['content'];
    status: GoalStatus;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<VersionRow>> {
  return tx.query<VersionRow>(
    `INSERT INTO goal_versions (
       tenant_id, goal_id, version, change_kind,
       title, objective, desired_state, metrics,
       horizon_start, horizon_end, owner, priority,
       evidence_sources, success_criteria, status,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8::jsonb,
       $9::timestamptz, $10::timestamptz, $11::jsonb, $12,
       $13::jsonb, $14, $15,
       $16, $17, $18, $19, $20, $21::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.goalId,
      params.version,
      params.changeKind,
      params.content.title,
      params.content.objective,
      params.content.desiredState,
      JSON.stringify(params.content.metrics),
      params.content.horizonStart === null ? null : new Date(params.content.horizonStart),
      new Date(params.content.horizonEnd),
      JSON.stringify(params.content.owner),
      params.content.priority,
      JSON.stringify(params.content.evidenceSources),
      params.content.successCriteria,
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

// ---------------------------------------------------------------------------
// createGoal
// ---------------------------------------------------------------------------

export async function createGoal(ctx: TenantContext, input: CreateGoalInput): Promise<Goal> {
  assertGoalTenantContext(ctx);
  const valid: ValidatedCreateGoalInput = validateCreateGoalInput(input);
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Identity row first (id minted by PostgreSQL); version 1 follows in the
    // same transaction — a goal never exists without its initial definition.
    // created_at comes from the injectable clock (IMPLEMENTATION-STACK §8),
    // never from the database clock.
    const created = await tx.query<{ id: string; created_at: Date | string }>(
      `INSERT INTO goals (tenant_id, created_at) VALUES ($1, $2) RETURNING id, created_at`,
      [ctx.tenantId, recordedAt],
    );
    const identity = created.rows[0]!;

    const inserted = await versionInsert(tx, {
      tenantId: ctx.tenantId,
      goalId: identity.id,
      version: 1,
      changeKind: 'created',
      content: valid.content,
      status: 'active', // goals are active upon definition (see types.ts)
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapVersion(inserted.rows[0]!);

    return {
      id: identity.id,
      tenantId: ctx.tenantId,
      version: version.version,
      content: version.content,
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
// reviseGoal
// ---------------------------------------------------------------------------

/** Loads the current version row of one goal inside `tx` (tenant-scoped). */
async function loadCurrentVersion(
  tx: Queryable,
  ctx: TenantContext,
  goalId: string,
): Promise<VersionRow> {
  const rows = await tx.query<VersionRow>(
    `SELECT gv.* FROM goal_versions gv
       INNER JOIN goals g ON g.id = gv.goal_id AND g.tenant_id = gv.tenant_id
      WHERE gv.tenant_id = $1 AND gv.goal_id = $2 AND gv.version = g.current_version`,
    [ctx.tenantId, goalId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw goalNotFound(goalId);
  return row;
}

export async function reviseGoal(ctx: TenantContext, input: ReviseGoalInput): Promise<Goal> {
  assertGoalTenantContext(ctx);
  const valid: ValidatedRevisionInput = validateReviseGoalInput(input);

  if (!isUuid(valid.goalId)) {
    // Malformed ids are indistinguishable from missing goals (no leak).
    throw goalNotFound(valid.goalId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    // Row lock on the goal identity: concurrent revisers of one goal
    // serialize here, which is what keeps the version chain gapless.
    const locked = await tx.query<{ id: string; current_version: number | string; created_at: Date | string }>(
      `SELECT id, current_version, created_at FROM goals
        WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
      [ctx.tenantId, valid.goalId],
    );
    const identity = locked.rows[0];
    if (identity === undefined) throw goalNotFound(valid.goalId);
    const currentVersionNumber = toInt(identity.current_version);

    const currentRow = await loadCurrentVersion(tx, ctx, valid.goalId);
    const current = mapVersion(currentRow);
    const currentContent = contentOf(current);

    // --- lifecycle transition gate (surgical, service-level) ---
    const patch: ValidatedRevisionPatch = valid.patch;
    if (patch.status !== undefined && patch.status === current.content.status) {
      throw new GoalsError(
        'invalid_transition',
        `goal '${valid.goalId}' is already ${patch.status} — a status revision must change the lifecycle`,
      );
    }
    if (current.content.status === 'archived') {
      if (patch.status !== 'active') {
        throw new GoalsError(
          'invalid_transition',
          `goal '${valid.goalId}' is archived — the only accepted change is a reactivation (status: 'active'); archive rationale lives on the archival version`,
        );
      }
    }

    // --- merge patch into the current content ---
    const merged = {
      title: patch.title ?? currentContent.title,
      objective: patch.objective ?? currentContent.objective,
      desiredState: patch.desiredState ?? currentContent.desiredState,
      metrics: patch.metrics ?? currentContent.metrics,
      horizonStart: patch.horizonStart !== undefined ? patch.horizonStart : currentContent.horizonStart,
      horizonEnd: patch.horizonEnd ?? currentContent.horizonEnd,
      owner: patch.owner ?? currentContent.owner,
      priority: patch.priority ?? currentContent.priority,
      evidenceSources: patch.evidenceSources ?? currentContent.evidenceSources,
      successCriteria: patch.successCriteria ?? currentContent.successCriteria,
    };
    // The merged snapshot passes the SAME validator as a fresh create —
    // cross-field invariants (horizon ordering) hold on every version. A
    // merged-content violation is reported as a revision problem (the
    // events module's query-wrapper precedent for code remapping).
    let content: ValidatedGoalContent;
    try {
      content = validateGoalContent(merged);
    } catch (error) {
      if (error instanceof GoalsError && error.code === 'invalid_goal_input') {
        throw new GoalsError('invalid_revision_input', error.message);
      }
      throw error;
    }
    const nextStatus: GoalStatus = patch.status ?? current.content.status;
    const changeKind = deriveChangeKind(current.content.status, nextStatus);

    const nextVersion = currentVersionNumber + 1;

    // Optimistic guard: the pointer moves exactly one step from the version
    // this revision was based on. 0 rows → a concurrent reviser won (defense
    // in depth on top of the row lock).
    const moved = await tx.query(
      `UPDATE goals SET current_version = $3
        WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
      [ctx.tenantId, valid.goalId, nextVersion, currentVersionNumber],
    );
    if (moved.rowCount === 0) {
      throw new GoalsError(
        'goal_conflict',
        'a concurrent revision moved this goal forward; re-read the goal and retry',
      );
    }

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        goalId: valid.goalId,
        version: nextVersion,
        changeKind,
        content,
        status: nextStatus,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'goal_versions')) {
        throw new GoalsError(
          'goal_conflict',
          'a concurrent revision appended this version number first; re-read the goal and retry',
        );
      }
      throw error;
    }
    const version = mapVersion(inserted.rows[0]!);

    return {
      id: valid.goalId,
      tenantId: ctx.tenantId,
      version: version.version,
      content: version.content,
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
// Reads
// ---------------------------------------------------------------------------

export async function getGoal(ctx: TenantContext, goalId: string): Promise<Goal> {
  assertGoalTenantContext(ctx);
  if (!isUuid(goalId)) throw goalNotFound(goalId);

  const rows = await getDb().query<GoalRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE g.tenant_id = $1 AND g.id = $2`,
    [ctx.tenantId, goalId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw goalNotFound(goalId);
  return mapGoal(row);
}

export async function getGoalVersion(
  ctx: TenantContext,
  query: GetGoalVersionQuery,
): Promise<GoalVersion> {
  assertGoalTenantContext(ctx);
  const valid = validateVersionQuery(query);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM goal_versions WHERE tenant_id = $1 AND goal_id = $2 AND version = $3`,
    [ctx.tenantId, valid.goalId, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new GoalsError(
      'goal_version_not_found',
      `version ${valid.version} of goal '${valid.goalId}' does not exist in this tenant`,
    );
  }
  return mapVersion(row);
}

export async function listGoalVersions(
  ctx: TenantContext,
  query: ListGoalVersionsQuery,
): Promise<GoalVersion[]> {
  assertGoalTenantContext(ctx);
  const valid = validateHistoryQuery(query);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM goal_versions WHERE tenant_id = $1 AND goal_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.goalId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such goal in this tenant" from "goal without history"
    // (impossible by construction) — a foreign-tenant goal id reads the same
    // as a missing one either way; the explicit check keeps the error honest.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM goals WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.goalId],
    );
    if (exists.rows.length === 0) throw goalNotFound(valid.goalId);
  }
  return rows.rows.map(mapVersion);
}

export async function listGoals(ctx: TenantContext, query: ListGoalsQuery): Promise<Goal[]> {
  assertGoalTenantContext(ctx);
  const valid: ValidatedListQuery = validateListGoalsQuery(query);

  const conditions: string[] = ['g.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.status !== null) add('gv.status = $#', valid.status);
  if (valid.priority !== null) add('gv.priority = $#', valid.priority);
  if (valid.ownerKind !== null) {
    add(`gv.owner->>'kind' = $#`, valid.ownerKind);
    if (valid.ownerId !== null) add(`gv.owner->>'id' = $#`, valid.ownerId);
  }
  if (valid.horizonEndFrom !== null) add('gv.horizon_end >= $#', valid.horizonEndFrom);
  if (valid.horizonEndTo !== null) add('gv.horizon_end <= $#', valid.horizonEndTo);
  if (valid.search !== null) {
    // escaped substring match — caller text is never a wildcard pattern
    add(`gv.title ILIKE '%' || $# || '%' ESCAPE '\\'`, escapeLike(valid.search));
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Priority rank (critical first) is the management ordering; title and id
  // make it deterministic. Direction is validated two-value SQL, the rank
  // CASE enumerates the CHECK-constrained priority values only.
  const rows = await getDb().query<GoalRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE gv.priority
                 WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4
               END ASC,
               gv.title ASC, g.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapGoal);
}
