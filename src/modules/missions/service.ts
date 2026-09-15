// Implementation of the missions module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); `recorded_at`/`created_at` come from the injectable
// clock and are never caller-supplied; every statement is scoped by the
// explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`mission_not_found` /
// `mission_version_not_found`), including on revisions and transitions.
//
// W011 acceptance is carried by these deliberate properties, all tested:
//   1. VERSIONED: a mission is an identity row (`missions`) plus an
//      append-only chain of FULL-snapshot versions (`mission_versions`).
//      Revising appends version N+1 and never mutates history — no
//      update/delete operation exists on the contract, and PostgreSQL
//      itself rejects UPDATE/DELETE/TRUNCATE on versions (and
//      DELETE/TRUNCATE on the identity) via migration 001 triggers.
//      `version`, `recorded_at`, `change_kind`, `status` (on create) and
//      `changed_by_principal` are system-minted; caller-supplied
//      identity/audit fields are rejected at validation.
//   2. AUDITABLE: every version records the quartet — who (actor party +
//      the authenticated principal from the TenantContext), when
//      (`recorded_at`), what (`change_kind` + a self-contained content
//      snapshot + the completion record on 'completed' versions) and why
//      (`rationale`, or the structured completion outcome).
//      `listMissionVersions` is the audit trail; `getMissionVersion`
//      deep-links one entry.
//   3. ORDERED: versions are 1-based and strictly increasing per mission,
//      allocated inside the mutation transaction under a row lock on the
//      mission identity (FOR UPDATE) plus an optimistic
//      `current_version = expected` guard — a concurrent writer loses
//      cleanly with `mission_conflict`, never corrupting the chain.
//   4. SURGICAL LIFECYCLE: transitions are dedicated operations
//      (`completeMission` / `abandonMission`) that append surgical versions
//      carrying their structured why (achieved confidence + outcome for
//      completion, a required reason for abandonment) — a content revision
//      can never smuggle a lifecycle change past its gate, and both
//      terminal states are dead ends (a mission is a bounded investigation,
//      not a long-lived direction; see types.ts).
//   5. GOAL/DECISION-DRIVEN (lock 8): every mission carries affected goals
//      (opaque forward references to goals module records) and, when it
//      formalizes a gap, epistemics unknowns — validated readable through
//      the epistemics contract at write time (the sanctioned
//      `epistemics → missions` dependency), exactly like epistemics checks
//      observations through the observations contract.
//
// Storage shape: `missions` carries NO content (identity + current-version
// pointer only), so the current picture and the audit trail can never
// diverge; every read of a mission joins its current version row.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import { getUnknown, EpistemicsError } from '@/modules/epistemics/contract';
import { MissionsError } from './errors';
import {
  assertMissionTenantContext,
  escapeLike,
  isUuid,
  validateAbandonMissionInput,
  validateCompleteMissionInput,
  validateCreateMissionInput,
  validateHistoryQuery,
  validateListMissionsQuery,
  validateMissionContent,
  validateReviseMissionInput,
  validateVersionQuery,
  type ValidatedCreateMissionInput,
  type ValidatedMissionContent,
  type ValidatedParty,
} from './validation';
import type {
  AbandonMissionInput,
  CompleteMissionInput,
  CreateMissionInput,
  ListMissionVersionsQuery,
  ListMissionsQuery,
  GetMissionVersionQuery,
  Mission,
  MissionActor,
  MissionCandidate,
  MissionChangeKind,
  MissionCompletion,
  MissionContent,
  MissionGoalRef,
  MissionStatus,
  MissionVersion,
  ReviseMissionInput,
} from './types';

/** Row shape of `mission_versions` (content + audit + completion columns). */
interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  mission_id: string;
  version: number | string;
  change_kind: string;
  title: string;
  knowledge_objective: string;
  affected_goals: unknown;
  unknown_ids: unknown;
  information_value: number;
  urgency: string;
  current_confidence: number;
  target_confidence: number;
  investigation_budget_amount: number | string;
  investigation_budget_currency: string;
  reward_budget_amount: number | string;
  reward_budget_currency: string;
  reward_terms: string | null;
  candidate_sources: unknown;
  completion_criteria: string;
  status: string;
  achieved_confidence: number | null;
  completion_outcome: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

/** Row shape of the current-view join (`missions` ⋈ current `mission_versions`). */
interface MissionRow extends DbRow {
  mission_id: string;
  mission_tenant_id: string;
  mission_created_at: Date | string;
  version_number: number | string;
  change_kind: string;
  title: string;
  knowledge_objective: string;
  affected_goals: unknown;
  unknown_ids: unknown;
  information_value: number;
  urgency: string;
  current_confidence: number;
  target_confidence: number;
  investigation_budget_amount: number | string;
  investigation_budget_currency: string;
  reward_budget_amount: number | string;
  reward_budget_currency: string;
  reward_terms: string | null;
  candidate_sources: unknown;
  completion_criteria: string;
  status: string;
  achieved_confidence: number | null;
  completion_outcome: string | null;
  actor_kind: string;
  actor_id: string | null;
  actor_label: string | null;
  changed_by_principal: string;
  rationale: string | null;
  recorded_at: Date | string;
}

// The current-view join, shared by getMission and listMissions. Column
// aliases pin the MissionRow shape; every filter is parameterized by the
// caller's tenant.
const CURRENT_VIEW_FROM = `FROM missions m
  INNER JOIN mission_versions mv
    ON mv.mission_id = m.id AND mv.tenant_id = m.tenant_id AND mv.version = m.current_version`;

const CURRENT_VIEW_COLUMNS = `SELECT
    m.id AS mission_id, m.tenant_id AS mission_tenant_id, m.created_at AS mission_created_at,
    mv.version AS version_number, mv.change_kind,
    mv.title, mv.knowledge_objective, mv.affected_goals, mv.unknown_ids,
    mv.information_value, mv.urgency, mv.current_confidence, mv.target_confidence,
    mv.investigation_budget_amount, mv.investigation_budget_currency,
    mv.reward_budget_amount, mv.reward_budget_currency, mv.reward_terms,
    mv.candidate_sources, mv.completion_criteria, mv.status,
    mv.achieved_confidence, mv.completion_outcome,
    mv.actor_kind, mv.actor_id, mv.actor_label,
    mv.changed_by_principal, mv.rationale, mv.recorded_at`;

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toInt(value: number | string): number {
  return typeof value === 'string' ? Number(value) : value;
}

function mapParty(row: { actor_kind: string; actor_id: string | null; actor_label: string | null }): MissionActor {
  return {
    kind: row.actor_kind as MissionActor['kind'], // CHECK-constrained by migration 001
    id: row.actor_id,
    label: row.actor_label,
  };
}

/** jsonb columns arrive parsed on both backends; storage is write-validated. */
function mapGoalRefs(value: unknown): MissionGoalRef[] {
  return Array.isArray(value) ? (value as MissionGoalRef[]) : [];
}

function mapUnknownIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : [];
}

function mapCandidates(value: unknown): MissionCandidate[] {
  return Array.isArray(value) ? (value as MissionCandidate[]) : [];
}

function mapCompletion(row: { achieved_confidence: number | null; completion_outcome: string | null }): MissionCompletion | null {
  // The completion-record CHECK guarantees the pair is either present
  // together (on 'completed' versions) or absent.
  return row.achieved_confidence === null
    ? null
    : { achievedConfidence: row.achieved_confidence, outcome: row.completion_outcome };
}

function mapContent(row: {
  title: string;
  knowledge_objective: string;
  affected_goals: unknown;
  unknown_ids: unknown;
  information_value: number;
  urgency: string;
  current_confidence: number;
  target_confidence: number;
  investigation_budget_amount: number | string;
  investigation_budget_currency: string;
  reward_budget_amount: number | string;
  reward_budget_currency: string;
  reward_terms: string | null;
  candidate_sources: unknown;
  completion_criteria: string;
  status: string;
}): MissionContent {
  return {
    title: row.title,
    knowledgeObjective: row.knowledge_objective,
    affectedGoals: mapGoalRefs(row.affected_goals),
    unknownIds: mapUnknownIds(row.unknown_ids),
    informationValue: row.information_value,
    urgency: row.urgency as MissionContent['urgency'], // CHECK-constrained
    currentConfidence: row.current_confidence,
    targetConfidence: row.target_confidence,
    investigationBudget: {
      amount: toInt(row.investigation_budget_amount),
      currency: row.investigation_budget_currency,
    },
    rewardBudget: {
      amount: toInt(row.reward_budget_amount),
      currency: row.reward_budget_currency,
    },
    rewardTerms: row.reward_terms,
    candidateSources: mapCandidates(row.candidate_sources),
    completionCriteria: row.completion_criteria,
    status: row.status as MissionStatus, // CHECK-constrained
  };
}

function mapVersion(row: VersionRow): MissionVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    version: toInt(row.version),
    changeKind: row.change_kind as MissionChangeKind, // CHECK-constrained
    content: mapContent(row),
    completion: mapCompletion(row),
    actor: mapParty(row),
    changedByPrincipal: row.changed_by_principal,
    rationale: row.rationale,
    recordedAt: toIso(row.recorded_at),
  };
}

function mapMission(row: MissionRow): Mission {
  return {
    id: row.mission_id,
    tenantId: row.mission_tenant_id,
    version: toInt(row.version_number),
    content: mapContent(row),
    completion: mapCompletion(row),
    createdAt: toIso(row.mission_created_at),
    updatedAt: toIso(row.recorded_at),
    lastChange: {
      kind: row.change_kind as MissionChangeKind, // CHECK-constrained
      actor: mapParty(row),
      changedByPrincipal: row.changed_by_principal,
      rationale: row.rationale,
      recordedAt: toIso(row.recorded_at),
    },
  };
}

function missionNotFound(missionId: string): MissionsError {
  return new MissionsError('mission_not_found', `mission '${missionId}' does not exist in this tenant`);
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
 * merged result is re-validated wholesale by `validateMissionContent`, so
 * the inferred (persisted-shape) typing is exactly what the merge needs.
 */
function contentOf(version: MissionVersion) {
  return {
    title: version.content.title,
    knowledgeObjective: version.content.knowledgeObjective,
    affectedGoals: version.content.affectedGoals,
    unknownIds: version.content.unknownIds,
    informationValue: version.content.informationValue,
    urgency: version.content.urgency,
    currentConfidence: version.content.currentConfidence,
    targetConfidence: version.content.targetConfidence,
    investigationBudget: version.content.investigationBudget,
    rewardBudget: version.content.rewardBudget,
    rewardTerms: version.content.rewardTerms,
    candidateSources: version.content.candidateSources,
    completionCriteria: version.content.completionCriteria,
  };
}

/**
 * Cross-module unknown validation (the sanctioned `epistemics → missions`
 * dependency): every unknown a mission claims to close must exist and be
 * readable in this tenant, verified through the epistemics contract —
 * never its tables. Missing, malformed and foreign-tenant unknown ids are
 * uniformly `invalid_unknown_ref` (no existence leak); unknowns cannot be
 * deleted (epistemics is append-only), so a validated link cannot dangle.
 */
async function validateUnknownRefs(ctx: TenantContext, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      await getUnknown(ctx, { unknownId: id });
    } catch (error) {
      if (error instanceof EpistemicsError) {
        throw new MissionsError(
          'invalid_unknown_ref',
          `unknown '${id}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }
}

/**
 * The content columns `versionInsert` writes — any validated (fresh) or
 * stored (carried-over) snapshot satisfies this shape; status is a separate
 * parameter because it belongs to the version, not the content merge.
 */
type VersionContent = Omit<MissionContent, 'status'>;

/**
 * The SQL value tuple of one version row (content + audit + optional
 * completion), shared by every append path.
 */
function versionInsert(
  tx: Queryable,
  params: {
    tenantId: string;
    missionId: string;
    version: number;
    changeKind: MissionChangeKind;
    content: VersionContent;
    status: MissionStatus;
    completion: MissionCompletion | null;
    actor: ValidatedParty;
    principalId: string;
    rationale: string | null;
    recordedAt: Date;
  },
): Promise<DbResult<VersionRow>> {
  return tx.query<VersionRow>(
    `INSERT INTO mission_versions (
       tenant_id, mission_id, version, change_kind,
       title, knowledge_objective, affected_goals, unknown_ids,
       information_value, urgency, current_confidence, target_confidence,
       investigation_budget_amount, investigation_budget_currency,
       reward_budget_amount, reward_budget_currency, reward_terms,
       candidate_sources, completion_criteria, status,
       achieved_confidence, completion_outcome,
       actor_kind, actor_id, actor_label, changed_by_principal, rationale, recorded_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7::jsonb, $8::jsonb,
       $9, $10, $11, $12,
       $13, $14, $15, $16, $17,
       $18::jsonb, $19, $20,
       $21, $22,
       $23, $24, $25, $26, $27, $28::timestamptz
     ) RETURNING *`,
    [
      params.tenantId,
      params.missionId,
      params.version,
      params.changeKind,
      params.content.title,
      params.content.knowledgeObjective,
      JSON.stringify(params.content.affectedGoals),
      JSON.stringify(params.content.unknownIds),
      params.content.informationValue,
      params.content.urgency,
      params.content.currentConfidence,
      params.content.targetConfidence,
      params.content.investigationBudget.amount,
      params.content.investigationBudget.currency,
      params.content.rewardBudget.amount,
      params.content.rewardBudget.currency,
      params.content.rewardTerms,
      JSON.stringify(params.content.candidateSources),
      params.content.completionCriteria,
      params.status,
      params.completion === null ? null : params.completion.achievedConfidence,
      params.completion === null ? null : params.completion.outcome,
      params.actor.kind,
      params.actor.id,
      params.actor.label,
      params.principalId,
      params.rationale,
      params.recordedAt,
    ],
  );
}

/** The current-view Mission object assembled from a freshly appended version. */
function missionOf(
  missionId: string,
  tenantId: string,
  createdAt: Date | string,
  version: MissionVersion,
): Mission {
  return {
    id: missionId,
    tenantId,
    version: version.version,
    content: version.content,
    completion: version.completion,
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
// createMission
// ---------------------------------------------------------------------------

export async function createMission(ctx: TenantContext, input: CreateMissionInput): Promise<Mission> {
  assertMissionTenantContext(ctx);
  const valid: ValidatedCreateMissionInput = validateCreateMissionInput(input);
  if (valid.content.unknownIds.length > 0) {
    await validateUnknownRefs(ctx, valid.content.unknownIds);
  }
  const recordedAt = now();

  return getDb().transaction(async (tx) => {
    // Identity row first (id minted by PostgreSQL); version 1 follows in the
    // same transaction — a mission never exists without its initial
    // definition. created_at comes from the injectable clock
    // (IMPLEMENTATION-STACK §8), never from the database clock.
    const created = await tx.query<{ id: string; created_at: Date | string }>(
      `INSERT INTO missions (tenant_id, created_at) VALUES ($1, $2) RETURNING id, created_at`,
      [ctx.tenantId, recordedAt],
    );
    const identity = created.rows[0]!;

    const inserted = await versionInsert(tx, {
      tenantId: ctx.tenantId,
      missionId: identity.id,
      version: 1,
      changeKind: 'created',
      content: valid.content,
      status: 'active', // missions are active upon definition (see types.ts)
      completion: null,
      actor: valid.actor,
      principalId: ctx.principalId,
      rationale: valid.rationale,
      recordedAt,
    });
    const version = mapVersion(inserted.rows[0]!);

    return missionOf(identity.id, ctx.tenantId, identity.created_at, version);
  });
}

// ---------------------------------------------------------------------------
// Shared mutation core (revise / complete / abandon)
// ---------------------------------------------------------------------------

/** Loads the current version row of one mission inside `tx` (tenant-scoped). */
async function loadCurrentVersion(
  tx: Queryable,
  ctx: TenantContext,
  missionId: string,
): Promise<VersionRow> {
  const rows = await tx.query<VersionRow>(
    `SELECT mv.* FROM mission_versions mv
       INNER JOIN missions m ON m.id = mv.mission_id AND m.tenant_id = mv.tenant_id
      WHERE mv.tenant_id = $1 AND mv.mission_id = $2 AND mv.version = m.current_version`,
    [ctx.tenantId, missionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw missionNotFound(missionId);
  return row;
}

/**
 * Locks the mission identity (FOR UPDATE — concurrent writers serialize
 * here, which is what keeps the version chain gapless) and returns the
 * identity row, or `mission_not_found` (uniform for missing, malformed
 * and foreign-tenant ids).
 */
async function lockMission(
  tx: Queryable,
  ctx: TenantContext,
  missionId: string,
): Promise<{ id: string; current_version: number | string; created_at: Date | string }> {
  const locked = await tx.query<{ id: string; current_version: number | string; created_at: Date | string }>(
    `SELECT id, current_version, created_at FROM missions
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.tenantId, missionId],
  );
  const identity = locked.rows[0];
  if (identity === undefined) throw missionNotFound(missionId);
  return identity;
}

/**
 * Advances the current-version pointer exactly one step from the version
 * this mutation was based on. 0 rows → a concurrent writer won (defense
 * in depth on top of the row lock) → `mission_conflict`.
 */
async function advancePointer(
  tx: Queryable,
  ctx: TenantContext,
  missionId: string,
  fromVersion: number,
  toVersion: number,
): Promise<void> {
  const moved = await tx.query(
    `UPDATE missions SET current_version = $3
      WHERE tenant_id = $1 AND id = $2 AND current_version = $4`,
    [ctx.tenantId, missionId, toVersion, fromVersion],
  );
  if (moved.rowCount === 0) {
    throw new MissionsError(
      'mission_conflict',
      'a concurrent change moved this mission forward; re-read the mission and retry',
    );
  }
}

// ---------------------------------------------------------------------------
// reviseMission
// ---------------------------------------------------------------------------

export async function reviseMission(ctx: TenantContext, input: ReviseMissionInput): Promise<Mission> {
  assertMissionTenantContext(ctx);
  const valid = validateReviseMissionInput(input);

  if (!isUuid(valid.missionId)) {
    // Malformed ids are indistinguishable from missing missions (no leak).
    throw missionNotFound(valid.missionId);
  }
  if (valid.patch.unknownIds !== undefined && valid.patch.unknownIds.length > 0) {
    await validateUnknownRefs(ctx, valid.patch.unknownIds);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const identity = await lockMission(tx, ctx, valid.missionId);
    const currentVersionNumber = toInt(identity.current_version);

    const currentRow = await loadCurrentVersion(tx, ctx, valid.missionId);
    const current = mapVersion(currentRow);

    // --- lifecycle gate: only active missions accept content revisions ---
    if (current.content.status !== 'active') {
      throw new MissionsError(
        'invalid_transition',
        `mission '${valid.missionId}' is ${current.content.status} — a ${current.content.status} mission is terminal; define a new mission instead`,
      );
    }

    // --- merge patch into the current content ---
    const patch = valid.patch;
    const merged = {
      title: patch.title ?? current.content.title,
      knowledgeObjective: patch.knowledgeObjective ?? current.content.knowledgeObjective,
      affectedGoals: patch.affectedGoals ?? current.content.affectedGoals,
      unknownIds: patch.unknownIds ?? current.content.unknownIds,
      informationValue: patch.informationValue ?? current.content.informationValue,
      urgency: patch.urgency ?? current.content.urgency,
      currentConfidence: patch.currentConfidence ?? current.content.currentConfidence,
      targetConfidence: patch.targetConfidence ?? current.content.targetConfidence,
      investigationBudget: patch.investigationBudget ?? current.content.investigationBudget,
      rewardBudget: patch.rewardBudget ?? current.content.rewardBudget,
      rewardTerms: patch.rewardTerms !== undefined ? patch.rewardTerms : current.content.rewardTerms,
      candidateSources: patch.candidateSources ?? current.content.candidateSources,
      completionCriteria: patch.completionCriteria ?? current.content.completionCriteria,
    };
    // The merged snapshot passes the SAME validator as a fresh create —
    // the confidence gap rule holds on every version. A merged-content
    // violation is reported as a revision problem (the events module's
    // query-wrapper precedent for code remapping).
    let content: ValidatedMissionContent;
    try {
      content = validateMissionContent(merged);
    } catch (error) {
      if (error instanceof MissionsError && error.code === 'invalid_mission_input') {
        throw new MissionsError('invalid_revision_input', error.message);
      }
      throw error;
    }

    const nextVersion = currentVersionNumber + 1;
    await advancePointer(tx, ctx, valid.missionId, currentVersionNumber, nextVersion);

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        missionId: valid.missionId,
        version: nextVersion,
        changeKind: 'revised',
        content,
        status: 'active',
        completion: null,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.rationale,
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'mission_versions')) {
        throw new MissionsError(
          'mission_conflict',
          'a concurrent change appended this version number first; re-read the mission and retry',
        );
      }
      throw error;
    }
    const version = mapVersion(inserted.rows[0]!);

    return missionOf(valid.missionId, ctx.tenantId, identity.created_at, version);
  });
}

// ---------------------------------------------------------------------------
// completeMission (active → completed, terminal)
// ---------------------------------------------------------------------------

export async function completeMission(
  ctx: TenantContext,
  input: CompleteMissionInput,
): Promise<Mission> {
  assertMissionTenantContext(ctx);
  const valid = validateCompleteMissionInput(input);

  if (!isUuid(valid.missionId)) {
    throw missionNotFound(valid.missionId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const identity = await lockMission(tx, ctx, valid.missionId);
    const currentVersionNumber = toInt(identity.current_version);

    const currentRow = await loadCurrentVersion(tx, ctx, valid.missionId);
    const current = mapVersion(currentRow);

    if (current.content.status !== 'active') {
      throw new MissionsError(
        'invalid_transition',
        `mission '${valid.missionId}' is ${current.content.status} — only an active mission can be completed`,
      );
    }

    const nextVersion = currentVersionNumber + 1;
    await advancePointer(tx, ctx, valid.missionId, currentVersionNumber, nextVersion);

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        missionId: valid.missionId,
        version: nextVersion,
        changeKind: 'completed',
        content: contentOf(current), // frozen content snapshot
        status: 'completed',
        completion: { achievedConfidence: valid.achievedConfidence, outcome: valid.outcome },
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: null, // the completion's why is the structured outcome itself
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'mission_versions')) {
        throw new MissionsError(
          'mission_conflict',
          'a concurrent change appended this version number first; re-read the mission and retry',
        );
      }
      throw error;
    }
    const version = mapVersion(inserted.rows[0]!);

    return missionOf(valid.missionId, ctx.tenantId, identity.created_at, version);
  });
}

// ---------------------------------------------------------------------------
// abandonMission (active → abandoned, terminal)
// ---------------------------------------------------------------------------

export async function abandonMission(
  ctx: TenantContext,
  input: AbandonMissionInput,
): Promise<Mission> {
  assertMissionTenantContext(ctx);
  const valid = validateAbandonMissionInput(input);

  if (!isUuid(valid.missionId)) {
    throw missionNotFound(valid.missionId);
  }

  const recordedAt = now();
  return getDb().transaction(async (tx) => {
    const identity = await lockMission(tx, ctx, valid.missionId);
    const currentVersionNumber = toInt(identity.current_version);

    const currentRow = await loadCurrentVersion(tx, ctx, valid.missionId);
    const current = mapVersion(currentRow);

    if (current.content.status !== 'active') {
      throw new MissionsError(
        'invalid_transition',
        `mission '${valid.missionId}' is ${current.content.status} — only an active mission can be abandoned`,
      );
    }

    const nextVersion = currentVersionNumber + 1;
    await advancePointer(tx, ctx, valid.missionId, currentVersionNumber, nextVersion);

    let inserted: DbResult<VersionRow>;
    try {
      inserted = await versionInsert(tx, {
        tenantId: ctx.tenantId,
        missionId: valid.missionId,
        version: nextVersion,
        changeKind: 'abandoned',
        content: contentOf(current), // frozen content snapshot
        status: 'abandoned',
        completion: null,
        actor: valid.actor,
        principalId: ctx.principalId,
        rationale: valid.reason, // a terminal transition records its why
        recordedAt,
      });
    } catch (error) {
      if (isDuplicateKeyOn(error, 'mission_versions')) {
        throw new MissionsError(
          'mission_conflict',
          'a concurrent change appended this version number first; re-read the mission and retry',
        );
      }
      throw error;
    }
    const version = mapVersion(inserted.rows[0]!);

    return missionOf(valid.missionId, ctx.tenantId, identity.created_at, version);
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getMission(ctx: TenantContext, missionId: string): Promise<Mission> {
  assertMissionTenantContext(ctx);
  if (!isUuid(missionId)) throw missionNotFound(missionId);

  const rows = await getDb().query<MissionRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE m.tenant_id = $1 AND m.id = $2`,
    [ctx.tenantId, missionId],
  );
  const row = rows.rows[0];
  if (row === undefined) throw missionNotFound(missionId);
  return mapMission(row);
}

export async function getMissionVersion(
  ctx: TenantContext,
  query: GetMissionVersionQuery,
): Promise<MissionVersion> {
  assertMissionTenantContext(ctx);
  const valid = validateVersionQuery(query);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM mission_versions WHERE tenant_id = $1 AND mission_id = $2 AND version = $3`,
    [ctx.tenantId, valid.missionId, valid.version],
  );
  const row = rows.rows[0];
  if (row === undefined) {
    throw new MissionsError(
      'mission_version_not_found',
      `version ${valid.version} of mission '${valid.missionId}' does not exist in this tenant`,
    );
  }
  return mapVersion(row);
}

export async function listMissionVersions(
  ctx: TenantContext,
  query: ListMissionVersionsQuery,
): Promise<MissionVersion[]> {
  assertMissionTenantContext(ctx);
  const valid = validateHistoryQuery(query);

  const rows = await getDb().query<VersionRow>(
    `SELECT * FROM mission_versions WHERE tenant_id = $1 AND mission_id = $2 ORDER BY version ASC`,
    [ctx.tenantId, valid.missionId],
  );
  if (rows.rows.length === 0) {
    // Distinguish "no such mission in this tenant" from "mission without
    // history" (impossible by construction) — a foreign-tenant mission id
    // reads the same as a missing one either way; the explicit check keeps
    // the error honest.
    const exists = await getDb().query<{ id: string }>(
      `SELECT id FROM missions WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.missionId],
    );
    if (exists.rows.length === 0) throw missionNotFound(valid.missionId);
  }
  return rows.rows.map(mapVersion);
}

export async function listMissions(ctx: TenantContext, query: ListMissionsQuery): Promise<Mission[]> {
  assertMissionTenantContext(ctx);
  const valid = validateListMissionsQuery(query);

  const conditions: string[] = ['m.tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.status !== null) add('mv.status = $#', valid.status);
  if (valid.urgency !== null) add('mv.urgency = $#', valid.urgency);
  if (valid.affectedGoalId !== null) {
    // jsonb containment: matches any affected-goal entry carrying this id.
    add('mv.affected_goals @> $#::jsonb', JSON.stringify([{ goalId: valid.affectedGoalId }]));
  }
  if (valid.unknownId !== null) {
    // a jsonb array of scalars "contains" the scalar itself
    add('mv.unknown_ids @> $#::jsonb', JSON.stringify(valid.unknownId));
  }
  if (valid.candidateKind !== null) {
    const candidate =
      valid.candidateId === null
        ? { kind: valid.candidateKind }
        : { kind: valid.candidateKind, id: valid.candidateId };
    add('mv.candidate_sources @> $#::jsonb', JSON.stringify([candidate]));
  }
  if (valid.search !== null) {
    // escaped substring match on the title OR the knowledge objective —
    // caller text is never a wildcard pattern. The same placeholder is
    // referenced twice ($n in both arms), which SQL allows.
    params.push(escapeLike(valid.search));
    const placeholder = `$${params.length}`;
    conditions.push(
      `(mv.title ILIKE '%' || ${placeholder} || '%' ESCAPE '\\'
        OR mv.knowledge_objective ILIKE '%' || ${placeholder} || '%' ESCAPE '\\')`,
    );
  }

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  // Urgency rank (critical first) is the management ordering; title and id
  // make it deterministic. Direction is validated two-value SQL, the rank
  // CASE enumerates the CHECK-constrained urgency values only.
  const rows = await getDb().query<MissionRow>(
    `${CURRENT_VIEW_COLUMNS} ${CURRENT_VIEW_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY CASE mv.urgency
                 WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4
               END ASC,
               mv.title ASC, m.id ASC
      LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapMission);
}
