// Implementation of the info-strategy module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; strategy and version ids are minted with
// `newId()`; `recordedAt`/`retiredAt` come from the injectable clock and
// are never caller-supplied; version numbers are minted by the system
// inside the adjustment transaction (row lock + current_version pointer
// bump — caller-supplied version numbers are impossible by shape); every
// statement is scoped by the explicit TenantContext (ADR-0001) —
// cross-tenant access is indistinguishable from a missing record
// (`strategy_not_found` / `strategy_version_not_found`; goals,
// fingerprints and unknowns validate uniformly through their owning
// contracts — no existence leak).
//
// W134 acceptance — "what to know, source choice, freshness/confidence,
// cost and escalation are represented and outcome-tunable; existing
// Unknown/LearningMission/KnowledgeAcquisition authorities remain
// canonical" — is carried by these deliberate properties, all tested:
//
//   1. THE CONTEXTUAL RULE: this service NEVER produces strategy content.
//      Every requirement, source preference, ceiling and threshold is
//      caller-supplied; defineStrategy/adjustStrategy only validate
//      shape, validate refs and record. There is no code path that could
//      hardcode a per-industry or per-task strategy.
//   2. REFS VALIDATED AT WRITE TIME: the goal must be ACTIVE (goals
//      contract), the fingerprint must be readable (context contract —
//      the strategy layer never re-derives context), and every knowledge
//      requirement's unknown must be readable (epistemics contract —
//      reference, don't duplicate the Unknown authority).
//   3. VERSIONED, IMMUTABLE HISTORY: adjustments append version N+1 with
//      the outcome evidence that justifies it; UPDATE/DELETE/TRUNCATE on
//      versions are rejected by PostgreSQL triggers. The learning loop
//      records evidence; it never rewrites it.
//   4. ONE ACTIVE STRATEGY PER SCOPE: (tenant, goal, fingerprint) —
//      enforced by a partial unique index; context-conditioned divergence
//      (same goal, different fingerprint → different strategy) is DATA,
//      and re-definition after retirement stays possible.
//
// Failure posture: cross-module reads during validation are mapped to
// typed not-found codes with uniform messages — a missing, foreign or
// unreadable ref reads exactly the same, never leaking existence.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type Queryable } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getFingerprint, ContextError } from '@/modules/context/contract';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import { getUnknown, EpistemicsError } from '@/modules/epistemics/contract';
import { InfoStrategyError } from './errors';
import {
  assertInfoStrategyTenantContext,
  validateAdjustStrategyInput,
  validateDefineStrategyInput,
  validateGetStrategyQuery,
  validateGetStrategyVersionQuery,
  validateListStrategiesQuery,
  validateListStrategyVersionsQuery,
  validateRetireStrategyInput,
  type ValidatedAdjustStrategyInput,
  type ValidatedDefineStrategyInput,
  type ValidatedListStrategiesQuery,
  type ValidatedStrategyContent,
} from './validation';
import type {
  AdjustStrategyInput,
  DefineStrategyInput,
  GetStrategyQuery,
  GetStrategyVersionQuery,
  InfoStrategy,
  InfoStrategyStatus,
  InfoStrategySummary,
  InfoStrategyVersion,
  ListStrategiesQuery,
  ListStrategyVersionsQuery,
  OutcomeEvidence,
  RetireStrategyInput,
  StrategyContent,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface StrategyRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  fingerprint_id: string;
  status: string;
  current_version: number;
  lifecycle_note: string | null;
  retired_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VersionRow extends DbRow {
  id: string;
  tenant_id: string;
  strategy_id: string;
  version: number;
  document: StrategyContent;
  outcome_evidence: OutcomeEvidence[] | null;
  note: string | null;
  derived_from: string[] | null;
  recorded_by: string;
  recorded_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapVersion(row: VersionRow): InfoStrategyVersion {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    strategyId: row.strategy_id,
    version: row.version,
    content: row.document,
    outcomeEvidence: row.outcome_evidence ?? [],
    note: row.note,
    derivedFrom: row.derived_from ?? [],
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  };
}

function assembleStrategy(row: StrategyRow, version: InfoStrategyVersion): InfoStrategy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    fingerprintId: row.fingerprint_id,
    status: row.status as InfoStrategyStatus,
    currentVersion: row.current_version,
    content: version.content,
    note: version.note,
    outcomeEvidence: version.outcomeEvidence,
    lifecycleNote: row.lifecycle_note,
    retiredAt: row.retired_at === null ? null : toIso(row.retired_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** PostgreSQL unique-violation (23505) from either db backend. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505'
  );
}

// ---------------------------------------------------------------------------
// Ref validation (write time)
// ---------------------------------------------------------------------------

/** The goal must exist and be ACTIVE in this tenant (uniform, no leak). */
async function requireActiveGoal(ctx: TenantContext, goalId: string): Promise<void> {
  let goal;
  try {
    goal = await getGoal(ctx, goalId);
  } catch (error) {
    if (error instanceof GoalsError) {
      throw new InfoStrategyError(
        'goal_not_found',
        `goal '${goalId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (goal.content.status !== 'active') {
    throw new InfoStrategyError(
      'goal_not_found',
      `goal '${goalId}' is ${goal.content.status} — strategies serve current direction only`,
    );
  }
}

/** The fingerprint must be readable in this tenant (uniform, no leak). */
async function requireFingerprint(ctx: TenantContext, fingerprintId: string): Promise<void> {
  try {
    await getFingerprint(ctx, { fingerprintId });
  } catch (error) {
    if (error instanceof ContextError) {
      throw new InfoStrategyError(
        'fingerprint_not_found',
        `context fingerprint '${fingerprintId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
}

/** Every knowledge requirement's unknown must be readable (reference,
 * never duplicate, the Unknown authority). */
async function validateUnknownRefs(
  ctx: TenantContext,
  content: ValidatedStrategyContent,
): Promise<void> {
  for (const requirement of content.knowledgeRequirements) {
    try {
      await getUnknown(ctx, { unknownId: requirement.unknownId });
    } catch (error) {
      if (error instanceof EpistemicsError) {
        throw new InfoStrategyError(
          'unknown_not_found',
          `unknown '${requirement.unknownId}' is not available in this tenant to this principal`,
        );
      }
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------
// Loaders (transaction-scoped)
// ---------------------------------------------------------------------------

async function loadStrategyRow(
  db: Queryable,
  ctx: TenantContext,
  strategyId: string,
): Promise<StrategyRow> {
  const result = await db.query<StrategyRow>(
    `SELECT * FROM info_strategies WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, strategyId],
  );
  if (result.rows.length === 0) {
    throw new InfoStrategyError(
      'strategy_not_found',
      `no strategy '${strategyId}' exists in this tenant`,
    );
  }
  return result.rows[0]!;
}

async function loadStrategyRowForUpdate(
  tx: Queryable,
  ctx: TenantContext,
  strategyId: string,
): Promise<StrategyRow> {
  const result = await tx.query<StrategyRow>(
    `SELECT * FROM info_strategies WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [ctx.tenantId, strategyId],
  );
  if (result.rows.length === 0) {
    throw new InfoStrategyError(
      'strategy_not_found',
      `no strategy '${strategyId}' exists in this tenant`,
    );
  }
  return result.rows[0]!;
}

async function loadVersionRow(
  tx: Queryable,
  ctx: TenantContext,
  strategyId: string,
  version: number,
): Promise<VersionRow> {
  const result = await tx.query<VersionRow>(
    `SELECT * FROM info_strategy_versions
       WHERE tenant_id = $1 AND strategy_id = $2 AND version = $3`,
    [ctx.tenantId, strategyId, version],
  );
  if (result.rows.length === 0) {
    throw new InfoStrategyError(
      'strategy_version_not_found',
      `version ${version} of strategy '${strategyId}' does not exist in this tenant`,
    );
  }
  return result.rows[0]!;
}

async function insertVersion(
  tx: Queryable,
  ctx: TenantContext,
  strategyId: string,
  version: number,
  content: ValidatedStrategyContent,
  outcomeEvidence: OutcomeEvidence[],
  note: string | null,
  derivedFrom: string[],
  recordedAt: Date,
): Promise<InfoStrategyVersion> {
  const id = newId();
  await tx.query(
    `INSERT INTO info_strategy_versions
       (id, tenant_id, strategy_id, version, document, outcome_evidence, note, derived_from, recorded_by, recorded_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10)`,
    [
      id,
      ctx.tenantId,
      strategyId,
      version,
      JSON.stringify(content),
      JSON.stringify(outcomeEvidence),
      note,
      JSON.stringify(derivedFrom),
      ctx.principalId,
      recordedAt,
    ],
  );
  return {
    id,
    tenantId: ctx.tenantId,
    strategyId,
    version,
    content,
    outcomeEvidence,
    note,
    derivedFrom,
    recordedBy: ctx.principalId,
    recordedAt: recordedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// defineStrategy
// ---------------------------------------------------------------------------

export async function defineStrategy(
  ctx: TenantContext,
  input: DefineStrategyInput,
): Promise<InfoStrategy> {
  assertInfoStrategyTenantContext(ctx);
  const valid: ValidatedDefineStrategyInput = validateDefineStrategyInput(input);

  await requireActiveGoal(ctx, valid.goalId);
  await requireFingerprint(ctx, valid.fingerprintId);
  await validateUnknownRefs(ctx, valid.content);

  const db = getDb();
  const existing = await db.query<StrategyRow>(
    `SELECT id FROM info_strategies
       WHERE tenant_id = $1 AND goal_id = $2 AND fingerprint_id = $3 AND status = 'active'`,
    [ctx.tenantId, valid.goalId, valid.fingerprintId],
  );
  if (existing.rows.length > 0) {
    throw new InfoStrategyError(
      'strategy_already_defined',
      `an active strategy already exists for this goal and context fingerprint in this tenant`,
    );
  }

  const strategyId = newId();
  const recordedAt = now();

  try {
    return await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO info_strategies
           (id, tenant_id, goal_id, fingerprint_id, status, current_version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'active', 1, $5, $5)`,
        [strategyId, ctx.tenantId, valid.goalId, valid.fingerprintId, recordedAt],
      );
      const version = await insertVersion(
        tx,
        ctx,
        strategyId,
        1,
        valid.content,
        [],
        valid.note,
        valid.derivedFrom,
        recordedAt,
      );
      return assembleStrategy(
        {
          id: strategyId,
          tenant_id: ctx.tenantId,
          goal_id: valid.goalId,
          fingerprint_id: valid.fingerprintId,
          status: 'active',
          current_version: 1,
          lifecycle_note: null,
          retired_at: null,
          created_at: recordedAt,
          updated_at: recordedAt,
        },
        version,
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new InfoStrategyError(
        'strategy_already_defined',
        `an active strategy already exists for this goal and context fingerprint in this tenant`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// adjustStrategy
// ---------------------------------------------------------------------------

/**
 * TRANSACTION DISCIPLINE (the house law over the embedded database): a
 * base-connection read issued while a transaction is open starves PGlite's
 * single connection (the deadlock the agents dispatch precedent documents).
 * Cross-module contract reads — the unknown refs below go through the
 * epistemics contract — therefore happen BEFORE the transaction opens, the
 * "evidence gate before any write" discipline (epistemics' recordClaim /
 * reviseBelief precedent). That gate is safe exactly because unknowns are
 * immutable, always-readable records (resolution is a one-way annotation,
 * never a delete), so a validated ref cannot dangle afterwards.
 *
 * The atomicity law is preserved: the version append and the
 * current_version pointer bump stay ONE transaction, minted under the
 * strategy row lock. Because versions are immutable (trigger-enforced), an
 * unchanged version number under the lock proves the locked current
 * content IS the content the pre-transaction gate validated — a number
 * that moved means a concurrent adjustment landed first, and the whole
 * operation re-derives and re-validates instead of recording a version
 * merged from outdated content.
 */
const MAX_ADJUSTMENT_ATTEMPTS = 3;

export async function adjustStrategy(
  ctx: TenantContext,
  input: AdjustStrategyInput,
): Promise<InfoStrategy> {
  assertInfoStrategyTenantContext(ctx);
  const valid: ValidatedAdjustStrategyInput = validateAdjustStrategyInput(input);
  const db = getDb();

  for (let attempt = 1; ; attempt += 1) {
    // --- Phase 1 (base connection, NO transaction open): the basis and ---
    // --- the evidence gate over the MERGED content's unknown refs.     ---
    const basis = await loadStrategyRow(db, ctx, valid.strategyId);
    if (basis.status === 'retired') {
      throw new InfoStrategyError(
        'strategy_retired',
        `strategy '${valid.strategyId}' is retired — the returning need is a new strategy definition`,
      );
    }
    const current = mapVersion(await loadVersionRow(db, ctx, valid.strategyId, basis.current_version));
    const merged: ValidatedStrategyContent = {
      knowledgeRequirements: valid.changes?.knowledgeRequirements ?? current.content.knowledgeRequirements,
      preferredSources: valid.changes?.preferredSources ?? current.content.preferredSources,
      costCeilings: valid.changes?.costCeilings ?? current.content.costCeilings,
      escalationThresholds: valid.changes?.escalationThresholds ?? current.content.escalationThresholds,
    };

    // Refs in the MERGED content must be readable now — including the
    // carried-over ones (an unknown recorded against a foreign tenant or
    // a missing one would silently corrupt the learning loop).
    await validateUnknownRefs(ctx, merged);

    // --- Phase 2 (the ONE transaction): append + pointer bump.        ---
    const outcome = await db.transaction(async (tx) => {
      const row = await loadStrategyRowForUpdate(tx, ctx, valid.strategyId);
      if (row.status === 'retired') {
        throw new InfoStrategyError(
          'strategy_retired',
          `strategy '${valid.strategyId}' is retired — the returning need is a new strategy definition`,
        );
      }
      // Versions are immutable, so an unchanged number under the lock
      // means the locked current content is exactly the validated basis.
      // A moved number means a concurrent adjustment won the race.
      if (row.current_version !== basis.current_version) {
        return { kind: 'stale' as const };
      }

      const nextVersion = row.current_version + 1;
      const recordedAt = now();
      const version = await insertVersion(
        tx,
        ctx,
        valid.strategyId,
        nextVersion,
        merged,
        valid.outcomeEvidence,
        valid.note,
        valid.derivedFrom,
        recordedAt,
      );
      await tx.query(
        `UPDATE info_strategies SET current_version = $3, updated_at = $4
           WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, valid.strategyId, nextVersion, recordedAt],
      );

      return {
        kind: 'adjusted' as const,
        strategy: assembleStrategy({ ...row, current_version: nextVersion, updated_at: recordedAt }, version),
      };
    });
    if (outcome.kind === 'stale') {
      if (attempt >= MAX_ADJUSTMENT_ATTEMPTS) {
        throw new Error(
          `strategy '${valid.strategyId}' kept moving under adjustment (${MAX_ADJUSTMENT_ATTEMPTS} attempts) — retry the adjustment`,
        );
      }
      continue;
    }
    return outcome.strategy;
  }
}

// ---------------------------------------------------------------------------
// retireStrategy
// ---------------------------------------------------------------------------

export async function retireStrategy(
  ctx: TenantContext,
  input: RetireStrategyInput,
): Promise<InfoStrategy> {
  assertInfoStrategyTenantContext(ctx);
  const valid = validateRetireStrategyInput(input);

  return getDb().transaction(async (tx) => {
    const row = await loadStrategyRowForUpdate(tx, ctx, valid.strategyId);
    if (row.status === 'retired') {
      throw new InfoStrategyError(
        'strategy_retired',
        `strategy '${valid.strategyId}' is already retired`,
      );
    }
    const retiredAt = now();
    await tx.query(
      `UPDATE info_strategies
         SET status = 'retired', lifecycle_note = $3, retired_at = $4, updated_at = $4
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, valid.strategyId, valid.reason, retiredAt],
    );
    const current = mapVersion(await loadVersionRow(tx, ctx, valid.strategyId, row.current_version));
    return assembleStrategy(
      {
        ...row,
        status: 'retired',
        lifecycle_note: valid.reason,
        retired_at: retiredAt,
        updated_at: retiredAt,
      },
      current,
    );
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getStrategy(ctx: TenantContext, query: GetStrategyQuery): Promise<InfoStrategy> {
  assertInfoStrategyTenantContext(ctx);
  const valid = validateGetStrategyQuery(query);
  const db = getDb();
  const rows = await db.query<StrategyRow>(
    `SELECT * FROM info_strategies WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.strategyId],
  );
  if (rows.rows.length === 0) {
    throw new InfoStrategyError(
      'strategy_not_found',
      `no strategy '${valid.strategyId}' exists in this tenant`,
    );
  }
  const row = rows.rows[0]!;
  const current = mapVersion(await loadVersionRow(db, ctx, row.id, row.current_version));
  return assembleStrategy(row, current);
}

export async function getStrategyVersion(
  ctx: TenantContext,
  query: GetStrategyVersionQuery,
): Promise<InfoStrategyVersion> {
  assertInfoStrategyTenantContext(ctx);
  const valid = validateGetStrategyVersionQuery(query);
  const db = getDb();
  // The strategy must exist in this tenant first (uniform not-found).
  const rows = await db.query<StrategyRow>(
    `SELECT id FROM info_strategies WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.strategyId],
  );
  if (rows.rows.length === 0) {
    throw new InfoStrategyError(
      'strategy_not_found',
      `no strategy '${valid.strategyId}' exists in this tenant`,
    );
  }
  return mapVersion(await loadVersionRow(db, ctx, valid.strategyId, valid.version));
}

export async function listStrategyVersions(
  ctx: TenantContext,
  query: ListStrategyVersionsQuery,
): Promise<InfoStrategyVersion[]> {
  assertInfoStrategyTenantContext(ctx);
  const valid = validateListStrategyVersionsQuery(query);
  const db = getDb();
  const rows = await db.query<StrategyRow>(
    `SELECT id FROM info_strategies WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.strategyId],
  );
  if (rows.rows.length === 0) {
    throw new InfoStrategyError(
      'strategy_not_found',
      `no strategy '${valid.strategyId}' exists in this tenant`,
    );
  }
  const versions = await db.query<VersionRow>(
    `SELECT * FROM info_strategy_versions
       WHERE tenant_id = $1 AND strategy_id = $2
       ORDER BY version ASC`,
    [ctx.tenantId, valid.strategyId],
  );
  return versions.rows.map(mapVersion);
}

export async function listStrategies(
  ctx: TenantContext,
  query?: ListStrategiesQuery,
): Promise<InfoStrategySummary[]> {
  assertInfoStrategyTenantContext(ctx);
  const valid: ValidatedListStrategiesQuery = validateListStrategiesQuery(query);

  const conditions = [`tenant_id = $1`];
  const params: unknown[] = [ctx.tenantId];
  if (valid.goalId !== null) {
    params.push(valid.goalId);
    conditions.push(`goal_id = $${params.length}`);
  }
  if (valid.fingerprintId !== null) {
    params.push(valid.fingerprintId);
    conditions.push(`fingerprint_id = $${params.length}`);
  }
  if (valid.status !== null) {
    params.push(valid.status);
    conditions.push(`status = $${params.length}`);
  }
  params.push(valid.limit);

  const rows = await getDb().query<StrategyRow & { version_count: string | number }>(
    `SELECT s.*, (SELECT count(*)::int FROM info_strategy_versions v WHERE v.tenant_id = s.tenant_id AND v.strategy_id = s.id) AS version_count
       FROM info_strategies s
       WHERE ${conditions.join(' AND ')}
       ORDER BY s.updated_at DESC, s.id DESC
       LIMIT $${params.length}`,
    params,
  );
  return rows.rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    fingerprintId: row.fingerprint_id,
    status: row.status as InfoStrategyStatus,
    currentVersion: row.current_version,
    versionCount: Number(row.version_count),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  }));
}
