// Implementation of the context module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; the fingerprint id is minted with `newId()`
// so the immutable row is written in one pass; `derivedAt` comes from the
// injectable clock and is never caller-supplied; every statement is scoped
// by the explicit TenantContext (ADR-0001) — cross-tenant access is
// indistinguishable from a missing record (`fingerprint_not_found`; a
// missing, archived or foreign goal reads uniformly as `goal_not_found`
// through the goals contract — no existence leak).
//
// W134 acceptance — "Derive a ContextFingerprint from a goal + task +
// observable context input" — is carried by these deliberate properties,
// all tested:
//   1. THE NULL-SIGNAL LAW: the service delegates dimension handling
//      EXCLUSIVELY to the pure derivation (derivation.ts) — an absent
//      dimension is stored as SQL NULL and reads back as null. There is
//      no code path in this module that can fabricate a dimension value,
//      and no required-subset rule that could pressure a caller into
//      faking one.
//   2. REF VALIDATION AT WRITE TIME: the goal must exist and be ACTIVE in
//      this tenant (through the goals contract — the attention module's
//      requireActiveGoal precedent); fingerprints are derived for current
//      direction only.
//   3. APPEND-ONLY HISTORY: fingerprints are observations of context at a
//      point in time — no update/delete operation exists on the contract
//      and PostgreSQL triggers reject UPDATE/DELETE/TRUNCATE outright
//      (migrations/001), so downstream layers (info-strategy, the Lab)
//      can cite fingerprints as immutable evidence.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getGoal, GoalsError } from '@/modules/goals/contract';
import { ContextError } from './errors';
import { deriveFingerprint as derivePureFingerprint } from './derivation';
import {
  assertContextTenantContext,
  validateDerivationInput,
  validateGetFingerprintQuery,
  validateListFingerprintsQuery,
  type ValidatedDerivationInput,
  type ValidatedListFingerprintsQuery,
} from './validation';
import type {
  ContextFingerprint,
  DeriveFingerprintInput,
  GetFingerprintQuery,
  ListFingerprintsQuery,
} from './types';

// ---------------------------------------------------------------------------
// Rows and mappers
// ---------------------------------------------------------------------------

interface FingerprintRow extends DbRow {
  id: string;
  tenant_id: string;
  goal_id: string;
  task_title: string | null;
  task_kind: string | null;
  season: unknown;
  duration: unknown;
  staffing: unknown;
  workload: string | null;
  capabilities: unknown;
  environment: unknown;
  constraints: unknown;
  evidence_freshness: unknown;
  additional_signals: Record<string, string> | null;
  derived_from: string[] | null;
  derived_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapFingerprint(row: FingerprintRow): ContextFingerprint {
  const task =
    row.task_title === null && row.task_kind === null
      ? null
      : { title: row.task_title, kind: row.task_kind };
  return {
    fingerprintId: row.id,
    tenantId: row.tenant_id,
    goalId: row.goal_id,
    task,
    season: (row.season ?? null) as ContextFingerprint['season'],
    duration: (row.duration ?? null) as ContextFingerprint['duration'],
    staffing: (row.staffing ?? null) as ContextFingerprint['staffing'],
    workload: (row.workload ?? null) as ContextFingerprint['workload'],
    capabilities: (row.capabilities ?? null) as ContextFingerprint['capabilities'],
    environment: (row.environment ?? null) as ContextFingerprint['environment'],
    constraints: (row.constraints ?? null) as ContextFingerprint['constraints'],
    evidenceFreshness: (row.evidence_freshness ?? null) as ContextFingerprint['evidenceFreshness'],
    additionalSignals: row.additional_signals ?? {},
    derivedFrom: row.derived_from ?? [],
    derivedAt: toIso(row.derived_at),
  };
}

// ---------------------------------------------------------------------------
// Ref validation (write time)
// ---------------------------------------------------------------------------

/**
 * The goal a fingerprint is derived for must exist and be ACTIVE in this
 * tenant (uniform, no leak) — the attention module's requireActiveGoal
 * precedent. Archived goals read exactly like foreign or missing ones.
 */
async function requireActiveGoal(ctx: TenantContext, goalId: string): Promise<void> {
  let goal;
  try {
    goal = await getGoal(ctx, goalId);
  } catch (error) {
    if (error instanceof GoalsError) {
      throw new ContextError(
        'goal_not_found',
        `goal '${goalId}' is not available in this tenant to this principal`,
      );
    }
    throw error;
  }
  if (goal.content.status !== 'active') {
    throw new ContextError(
      'goal_not_found',
      `goal '${goalId}' is ${goal.content.status} — fingerprints are derived for current direction only`,
    );
  }
}

// ---------------------------------------------------------------------------
// deriveFingerprint / getFingerprint / listFingerprints
// ---------------------------------------------------------------------------

export async function deriveFingerprint(
  ctx: TenantContext,
  input: DeriveFingerprintInput,
): Promise<ContextFingerprint> {
  assertContextTenantContext(ctx);
  const valid: ValidatedDerivationInput = validateDerivationInput(input);
  await requireActiveGoal(ctx, valid.goalId);

  const fingerprintId = newId();
  const derivedAt = now().toISOString();
  const fingerprint = derivePureFingerprint(
    {
      fingerprintId,
      tenantId: ctx.tenantId,
      goalId: valid.goalId,
      task: valid.task,
      derivedFrom: valid.derivedFrom,
      derivedAt,
    },
    valid.observations,
  );

  await getDb().query(
    `INSERT INTO context_fingerprints
       (id, tenant_id, goal_id, task_title, task_kind,
        season, duration, staffing, workload, capabilities, environment,
        constraints, evidence_freshness, additional_signals, derived_from, derived_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10::jsonb, $11::jsonb,
             $12::jsonb, $13::jsonb, $14::jsonb, $15::jsonb, $16)`,
    [
      fingerprint.fingerprintId,
      fingerprint.tenantId,
      fingerprint.goalId,
      fingerprint.task === null ? null : fingerprint.task.title,
      fingerprint.task === null ? null : fingerprint.task.kind,
      fingerprint.season === null ? null : JSON.stringify(fingerprint.season),
      fingerprint.duration === null ? null : JSON.stringify(fingerprint.duration),
      fingerprint.staffing === null ? null : JSON.stringify(fingerprint.staffing),
      fingerprint.workload,
      fingerprint.capabilities === null ? null : JSON.stringify(fingerprint.capabilities),
      fingerprint.environment === null ? null : JSON.stringify(fingerprint.environment),
      fingerprint.constraints === null ? null : JSON.stringify(fingerprint.constraints),
      fingerprint.evidenceFreshness === null ? null : JSON.stringify(fingerprint.evidenceFreshness),
      JSON.stringify(fingerprint.additionalSignals),
      JSON.stringify(fingerprint.derivedFrom),
      derivedAt,
    ],
  );
  return fingerprint;
}

export async function getFingerprint(
  ctx: TenantContext,
  query: GetFingerprintQuery,
): Promise<ContextFingerprint> {
  assertContextTenantContext(ctx);
  const valid = validateGetFingerprintQuery(query);
  const result = await getDb().query<FingerprintRow>(
    `SELECT * FROM context_fingerprints WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, valid.fingerprintId],
  );
  if (result.rows.length === 0) {
    throw new ContextError(
      'fingerprint_not_found',
      `no fingerprint '${valid.fingerprintId}' exists in this tenant`,
    );
  }
  return mapFingerprint(result.rows[0]!);
}

export async function listFingerprints(
  ctx: TenantContext,
  query?: ListFingerprintsQuery,
): Promise<ContextFingerprint[]> {
  assertContextTenantContext(ctx);
  const valid: ValidatedListFingerprintsQuery = validateListFingerprintsQuery(query);

  const params: unknown[] = [ctx.tenantId];
  let sql = `SELECT * FROM context_fingerprints WHERE tenant_id = $1`;
  if (valid.goalId !== null) {
    params.push(valid.goalId);
    sql += ` AND goal_id = $${params.length}`;
  }
  params.push(valid.limit);
  sql += ` ORDER BY derived_at DESC, id DESC LIMIT $${params.length}`;

  const rows = await getDb().query<FingerprintRow>(sql, params);
  return rows.rows.map(mapFingerprint);
}
