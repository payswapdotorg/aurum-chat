// Implementation of the actions module's public operations (see
// contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); timestamps (`requested_at`, `decided_at`,
// `created_at`/`updated_at`) come from the injectable clock and are never
// caller-supplied; every statement is scoped by the explicit
// TenantContext (ADR-0001) — cross-tenant access is indistinguishable
// from a missing record (`action_request_not_found` / `policy_not_found`).
//
// W009 acceptance — "OBSERVE/ANALYZE/RECOMMEND/ASK/PROPOSE/EXECUTE
// authority matrix and deterministic approval gates" — is carried by
// these deliberate properties, all tested:
//   1. the matrix is tenant-scoped policy DATA (per action kind, with a
//      tenant-wide default row and a built-in floor) and the gate
//      evaluation is the PURE `evaluateAuthorityMatrix` — the same
//      (policy state, kind, level) always yields the same outcome. No
//      LLM, clock, randomness or principal identity participates in the
//      evaluation (lock 10 mirrored: authority is application-owned);
//   2. resolution is total and ordered: kind row → tenant-default row →
//      built-in default, and the resolution trail is RECORDED on every
//      request (`evaluation`) so any gate decision is reconstructable
//      (ARCHITECTURE.md §24);
//   3. the approval gates are deterministic state machines: `allowed` →
//      status `approved` with an immediate POLICY decision row,
//      `forbidden` → status `rejected` with a POLICY rejection row, and
//      `approval_required` → status `pending` until exactly one human
//      decision lands (first decision wins; the request's substantive
//      fields are immutable history — only the decision state moves, and
//      PostgreSQL triggers enforce both);
//   4. separation of duties: the requesting principal can never decide
//      its own request, and deciding requires the `actions:approve`
//      (or kind-scoped `actions:approve:<kind>`) authority claim —
//      Aurum's proposals are decided by authorized humans, not by Aurum
//      (ARCHITECTURE.md §14/§15, GOVERNANCE.md "high-impact actions are
//      policy-gated").
//
// Claim-gated writes: `setAuthorityPolicy` requires `actions:administer`
// — the matrix is the tenant's security control surface, so a plain
// member must not be able to weaken its own approval gates. Reads (the
// Approvals surface of the management control tower, §21) are visible to
// every tenant member, like the freshness module's policies.

import { now } from '@/infra/clock';
import { getDb, type DbRow, type DbResult, type Queryable } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  ACTIONS_AUTHORITY_ADMINISTER,
  builtInDefaultMatrix,
  canAdminister,
  canApprove,
  evaluateAuthorityMatrix,
  kindScopedApproveClaim,
  policyDecisionForOutcome,
  statusForOutcome,
} from './matrix';
import type {
  AuthorityLevel,
  AuthorityOutcome,
  PolicyResolutionSource,
} from './matrix';
import type {
  AuthorityPolicy,
} from './types';
import { ActionsError } from './errors';
import {
  assertActionsTenantContext,
  validateAuthorizeActionInput,
  validateDecideApprovalInput,
  validateEvaluateAuthorityQuery,
  validateGetActionRequestQuery,
  validateListActionRequestsQuery,
  validateListApprovalDecisionsQuery,
  validateListPoliciesQuery,
  validatePolicySubjectQuery,
  validateSetAuthorityPolicyInput,
  type ValidatedAuthorizeInput,
  type ValidatedDecideInput,
  type ValidatedPolicyInput,
} from './validation';
import type {
  ActionRequest,
  ApprovalDecision,
  AuthorityEvaluation,
  AuthorizeActionInput,
  DecideApprovalInput,
  EvaluateAuthorityQuery,
  GetActionRequestQuery,
  ListActionRequestsQuery,
  ListApprovalDecisionsQuery,
  ListAuthorityPoliciesQuery,
  PolicySubjectQuery,
  ResolvedAuthorityPolicy,
  SetAuthorityPolicyInput,
} from './types';

interface PolicyRow extends DbRow {
  id: string;
  tenant_id: string;
  action_kind: string | null;
  // jsonb arrays constrained to the six-level vocabulary by the table's
  // CHECK constraints and validation trigger (migrations/001).
  approval_levels: AuthorityLevel[];
  forbidden_levels: AuthorityLevel[];
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RequestRow extends DbRow {
  id: string;
  tenant_id: string;
  action_kind: string;
  authority_level: AuthorityLevel;
  payload: unknown;
  justification: string | null;
  requested_by: string;
  requested_at: Date | string;
  idempotency_key: string | null;
  outcome: AuthorityOutcome;
  resolved_via: PolicyResolutionSource;
  policy_snapshot: unknown;
  status: 'pending' | 'approved' | 'rejected';
  decided_at: Date | string | null;
  updated_at: Date | string;
}

interface DecisionRow extends DbRow {
  id: string;
  tenant_id: string;
  request_id: string;
  decision: 'approve' | 'reject';
  decided_by: 'policy' | 'principal';
  principal_id: string | null;
  note: string | null;
  decided_at: Date | string;
}

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapPolicy(row: PolicyRow): AuthorityPolicy {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actionKind: row.action_kind,
    approvalLevels: [...(row.approval_levels ?? [])],
    forbiddenLevels: [...(row.forbidden_levels ?? [])],
    note: row.note,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * The evaluation snapshot is written by this module (a serialized
 * AuthorityPolicy), so reading it back is a cast, not a parse. It
 * deliberately snapshots the policy AS IT DECIDED — later policy edits
 * never rewrite what gated an already-recorded request.
 */
function snapshotToPolicy(snapshot: unknown): AuthorityPolicy {
  return snapshot as AuthorityPolicy;
}

function mapRequest(row: RequestRow): ActionRequest {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    actionKind: row.action_kind,
    authorityLevel: row.authority_level,
    payload: row.payload,
    justification: row.justification,
    requestedBy: row.requested_by,
    requestedAt: toIso(row.requested_at),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    evaluation: {
      outcome: row.outcome,
      resolvedVia: row.resolved_via,
      policy: row.policy_snapshot === null ? null : snapshotToPolicy(row.policy_snapshot),
    },
  };
}

function mapDecision(row: DecisionRow): ApprovalDecision {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requestId: row.request_id,
    decision: row.decision,
    decidedBy: row.decided_by,
    principalId: row.principal_id,
    note: row.note,
    decidedAt: toIso(row.decided_at),
  };
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
// The authority matrix (tenant policy)
// ---------------------------------------------------------------------------

/** Exact-key policy lookup (no default fallback); null when absent. */
async function lookupPolicy(
  ctx: TenantContext,
  actionKind: string | null,
): Promise<PolicyRow | null> {
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM action_authority_policies
       WHERE tenant_id = $1 AND action_kind IS NOT DISTINCT FROM $2`,
    [ctx.tenantId, actionKind],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/**
 * Resolve the matrix for one action kind: the kind's row first, then the
 * tenant-wide default row, then the built-in default (deterministic,
 * total — every kind resolves). Returns the deciding row (null =
 * built-in) and where it came from.
 */
async function resolvePolicyRow(
  ctx: TenantContext,
  actionKind: string,
): Promise<{ source: PolicyResolutionSource; row: PolicyRow | null }> {
  const kindRow = await lookupPolicy(ctx, actionKind);
  if (kindRow !== null) return { source: 'kind', row: kindRow };
  const defaultRow = await lookupPolicy(ctx, null);
  if (defaultRow !== null) return { source: 'tenant-default', row: defaultRow };
  return { source: 'built-in', row: null };
}

export async function setAuthorityPolicy(
  ctx: TenantContext,
  input: SetAuthorityPolicyInput,
): Promise<AuthorityPolicy> {
  assertActionsTenantContext(ctx);
  // The matrix is the tenant's security control surface: only holders of
  // the administer claim may tighten or relax it (authorization before
  // input parsing — unauthorized callers learn nothing about shapes).
  if (!canAdminister(ctx.authority)) {
    throw new ActionsError(
      'forbidden',
      `this operation requires the '${ACTIONS_AUTHORITY_ADMINISTER}' authority claim`,
    );
  }
  const valid: ValidatedPolicyInput = validateSetAuthorityPolicyInput(input);
  const timestamp = now();

  return getDb().transaction(async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM action_authority_policies
         WHERE tenant_id = $1 AND action_kind IS NOT DISTINCT FROM $2`,
      [ctx.tenantId, valid.actionKind],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId !== undefined) {
      const updated = await tx.query<PolicyRow>(
        `UPDATE action_authority_policies
           SET approval_levels = $3::jsonb, forbidden_levels = $4::jsonb, note = $5, updated_at = $6
         WHERE tenant_id = $1 AND id = $2
         RETURNING *`,
        [
          ctx.tenantId,
          existingId,
          JSON.stringify(valid.approvalLevels),
          JSON.stringify(valid.forbiddenLevels),
          valid.note,
          timestamp,
        ],
      );
      return mapPolicy(updated.rows[0]!);
    }
    let inserted: DbResult<PolicyRow>;
    try {
      inserted = await tx.query<PolicyRow>(
        `INSERT INTO action_authority_policies (
           tenant_id, action_kind, approval_levels, forbidden_levels, note, created_at, updated_at
         ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $6)
         RETURNING *`,
        [
          ctx.tenantId,
          valid.actionKind,
          JSON.stringify(valid.approvalLevels),
          JSON.stringify(valid.forbiddenLevels),
          valid.note,
          timestamp,
        ],
      );
    } catch (error) {
      if (isDuplicateKeyOn(error, 'action_authority_policies')) {
        throw new ActionsError(
          'policy_conflict',
          'an authority policy for this action kind was created concurrently; retry the set operation',
        );
      }
      throw error;
    }
    return mapPolicy(inserted.rows[0]!);
  });
}

export async function getAuthorityPolicy(
  ctx: TenantContext,
  query: PolicySubjectQuery,
): Promise<AuthorityPolicy> {
  assertActionsTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  const row = await lookupPolicy(ctx, valid.actionKind);
  if (row === null) {
    throw new ActionsError(
      'policy_not_found',
      `no authority policy for action kind '${valid.actionKind ?? 'default'}' exists in this tenant`,
    );
  }
  return mapPolicy(row);
}

export async function resolveAuthorityPolicy(
  ctx: TenantContext,
  query: PolicySubjectQuery,
): Promise<ResolvedAuthorityPolicy> {
  assertActionsTenantContext(ctx);
  const valid = validatePolicySubjectQuery(query);
  // Resolution needs a concrete kind to resolve FOR; the default row is
  // the fallback inside the resolution, never its subject.
  if (valid.actionKind === null) {
    throw new ActionsError(
      'invalid_query',
      'query.actionKind is required for resolution — resolution falls back to the tenant default, it cannot address the default row itself',
    );
  }
  const actionKind = valid.actionKind;
  const { source, row } = await resolvePolicyRow(ctx, actionKind);
  // The EFFECTIVE level rules: the built-in floor when no tenant row
  // decided, so a resolved policy is always directly evaluable.
  const effective = row === null ? builtInDefaultMatrix() : null;
  return {
    actionKind,
    source,
    policy: row === null ? null : mapPolicy(row),
    approvalLevels: effective !== null ? [...effective.approvalLevels] : [...row!.approval_levels],
    forbiddenLevels: effective !== null ? [...effective.forbiddenLevels] : [...row!.forbidden_levels],
  };
}

export async function listAuthorityPolicies(
  ctx: TenantContext,
  query: ListAuthorityPoliciesQuery,
): Promise<AuthorityPolicy[]> {
  assertActionsTenantContext(ctx);
  const valid = validateListPoliciesQuery(query);
  const rows = await getDb().query<PolicyRow>(
    `SELECT * FROM action_authority_policies
       WHERE tenant_id = $1
       ORDER BY action_kind ASC NULLS FIRST, id ASC
       LIMIT $2`,
    [ctx.tenantId, valid.limit],
  );
  return rows.rows.map(mapPolicy);
}

/**
 * Evaluate one (action kind, authority level) against the tenant's
 * matrix WITHOUT recording anything — the read-only twin of the gate.
 * Downstream policy checks (W013 cognition, W021 agent gateway, ...)
 * that only need the answer use this; consequential paths use
 * `authorizeAction` so the decision is recorded and auditable.
 */
export async function evaluateActionAuthority(
  ctx: TenantContext,
  query: EvaluateAuthorityQuery,
): Promise<AuthorityEvaluation> {
  assertActionsTenantContext(ctx);
  const valid = validateEvaluateAuthorityQuery(query);
  const { source, row } = await resolvePolicyRow(ctx, valid.actionKind);
  const policy = row === null ? null : mapPolicy(row);
  const outcome = evaluateAuthorityMatrix(
    row === null
      ? null
      : { approvalLevels: row.approval_levels, forbiddenLevels: row.forbidden_levels },
    valid.authorityLevel,
  );
  return {
    actionKind: valid.actionKind,
    authorityLevel: valid.authorityLevel,
    outcome,
    resolvedVia: source,
    policy,
  };
}

// ---------------------------------------------------------------------------
// The approval gates (action requests)
// ---------------------------------------------------------------------------

/** Tenant-scoped request lookup by id; null when absent (or foreign). */
async function findRequestRow(
  db: Queryable,
  ctx: TenantContext,
  requestId: string,
): Promise<RequestRow | null> {
  const rows = await db.query<RequestRow>(
    `SELECT * FROM action_requests WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, requestId],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

/** Tenant-scoped request lookup by idempotency key; null when absent. */
async function findRequestRowByIdempotencyKey(
  db: Queryable,
  ctx: TenantContext,
  idempotencyKey: string,
): Promise<RequestRow | null> {
  const rows = await db.query<RequestRow>(
    `SELECT * FROM action_requests WHERE tenant_id = $1 AND idempotency_key = $2`,
    [ctx.tenantId, idempotencyKey],
  );
  const row = rows.rows[0];
  return row === undefined ? null : row;
}

export async function authorizeAction(
  ctx: TenantContext,
  input: AuthorizeActionInput,
): Promise<ActionRequest> {
  assertActionsTenantContext(ctx);
  const valid: ValidatedAuthorizeInput = validateAuthorizeActionInput(input);

  // Idempotent fast path: a recorded key replays the original request —
  // first write wins (the events module's replay semantics), so retried
  // authorizations from asynchronous cognition (lock 36) never duplicate
  // gate history.
  if (valid.idempotencyKey !== null) {
    const existing = await findRequestRowByIdempotencyKey(getDb(), ctx, valid.idempotencyKey);
    if (existing !== null) return mapRequest(existing);
  }

  // The deterministic evaluation: pure function of the tenant's policy
  // state and (kind, level). Nothing else participates.
  const { source, row } = await resolvePolicyRow(ctx, valid.actionKind);
  const policy = row === null ? null : mapPolicy(row);
  const outcome = evaluateAuthorityMatrix(
    row === null
      ? null
      : { approvalLevels: row.approval_levels, forbiddenLevels: row.forbidden_levels },
    valid.authorityLevel,
  );
  const status = statusForOutcome(outcome);
  const policyDecision = policyDecisionForOutcome(outcome);

  const requestedAt = now();
  return getDb().transaction(async (tx) => {
    // Re-check inside the transaction: a key committed between the fast
    // path and now also replays without writing a second request.
    if (valid.idempotencyKey !== null) {
      const raced = await findRequestRowByIdempotencyKey(tx, ctx, valid.idempotencyKey);
      if (raced !== null) return mapRequest(raced);
    }

    // The evaluation snapshot: the policy exactly as it decided. Later
    // policy edits never rewrite what gated a recorded request.
    const policySnapshot = policy === null ? null : JSON.stringify(policy);
    const decidedAt = status === 'pending' ? null : requestedAt;

    const inserted = await tx.query<RequestRow>(
      `INSERT INTO action_requests (
         tenant_id, action_kind, authority_level, payload, justification,
         requested_by, requested_at, idempotency_key,
         outcome, resolved_via, policy_snapshot, status, decided_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        ctx.tenantId,
        valid.actionKind,
        valid.authorityLevel,
        JSON.stringify(valid.payload),
        valid.justification,
        ctx.principalId,
        requestedAt,
        valid.idempotencyKey,
        outcome,
        source,
        policySnapshot,
        status,
        decidedAt,
        requestedAt,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) {
      // ON CONFLICT swallowed the insert: a concurrent authorization of
      // the same key won the race. Replay its request.
      if (valid.idempotencyKey !== null) {
        const winner = await findRequestRowByIdempotencyKey(tx, ctx, valid.idempotencyKey);
        if (winner !== null) return mapRequest(winner);
      }
      throw new Error(
        'action request insert returned no row without an idempotency conflict (internal invariant violation)',
      );
    }

    // Outcomes the matrix decided on its own record their policy decision
    // immediately; a gated request (approval_required) records NONE — it
    // waits for a human one.
    if (policyDecision !== null) {
      const sourceDescription =
        source === 'kind'
          ? `the '${valid.actionKind}' policy`
          : source === 'tenant-default'
            ? 'the tenant-default policy'
            : 'the built-in default matrix';
      const note =
        policyDecision === 'approve'
          ? `authority matrix allows ${valid.authorityLevel} of '${valid.actionKind}' (${sourceDescription})`
          : `authority matrix forbids ${valid.authorityLevel} of '${valid.actionKind}' (${sourceDescription})`;
      await tx.query(
        `INSERT INTO action_approval_decisions (
           tenant_id, request_id, decision, decided_by, principal_id, note, decided_at
         ) VALUES ($1, $2, $3, 'policy', NULL, $4, $5)`,
        [ctx.tenantId, row.id, policyDecision, note, requestedAt],
      );
    }
    return mapRequest(row);
  });
}

export async function getActionRequest(
  ctx: TenantContext,
  query: GetActionRequestQuery,
): Promise<ActionRequest> {
  assertActionsTenantContext(ctx);
  const valid = validateGetActionRequestQuery(query);
  const row = await findRequestRow(getDb(), ctx, valid.requestId);
  if (row === null) {
    throw new ActionsError(
      'action_request_not_found',
      `no action request '${valid.requestId}' exists in this tenant`,
    );
  }
  return mapRequest(row);
}

export async function listActionRequests(
  ctx: TenantContext,
  query: ListActionRequestsQuery,
): Promise<ActionRequest[]> {
  assertActionsTenantContext(ctx);
  const valid = validateListActionRequestsQuery(query);

  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  const add = (fragment: string, value: unknown): void => {
    params.push(value);
    conditions.push(fragment.replace('$#', `$${params.length}`));
  };

  if (valid.actionKind !== null) add('action_kind = $#', valid.actionKind);
  if (valid.authorityLevel !== null) add('authority_level = $#', valid.authorityLevel);
  if (valid.status !== null) add('status = $#', valid.status);
  if (valid.requestedBy !== null) add('requested_by = $#', valid.requestedBy);

  params.push(valid.limit);
  const limitPlaceholder = `$${params.length}`;
  const rows = await getDb().query<RequestRow>(
    `SELECT * FROM action_requests WHERE ${conditions.join(' AND ')}
       ORDER BY requested_at DESC, id DESC
       LIMIT ${limitPlaceholder}`,
    params,
  );
  return rows.rows.map(mapRequest);
}

// ---------------------------------------------------------------------------
// Human approval decisions
// ---------------------------------------------------------------------------

export async function decideApproval(
  ctx: TenantContext,
  input: DecideApprovalInput,
): Promise<ActionRequest> {
  assertActionsTenantContext(ctx);
  const valid: ValidatedDecideInput = validateDecideApprovalInput(input);

  const row = await findRequestRow(getDb(), ctx, valid.requestId);
  if (row === null) {
    throw new ActionsError(
      'action_request_not_found',
      `no action request '${valid.requestId}' exists in this tenant`,
    );
  }

  // Authorization before state: an unauthorized caller learns the request
  // exists (tenant members may read the approvals surface) but can never
  // move it.
  if (!canApprove(ctx.authority, row.action_kind)) {
    throw new ActionsError(
      'forbidden',
      `deciding '${row.action_kind}' requests requires the 'actions:approve' or '${kindScopedApproveClaim(row.action_kind)}' authority claim`,
    );
  }
  if (ctx.principalId === row.requested_by) {
    throw new ActionsError(
      'forbidden',
      'the requesting principal may not approve or reject its own action request (separation of duties)',
    );
  }
  if (row.status !== 'pending') {
    throw new ActionsError(
      'not_pending',
      `action request '${valid.requestId}' is already ${row.status} — only a pending request can be decided`,
    );
  }

  const decidedAt = now();
  return getDb().transaction(async (tx) => {
    // First decision wins: the guarded UPDATE loses the race against a
    // concurrent decider, re-reads, and reports the terminal state.
    const updated = await tx.query<RequestRow>(
      `UPDATE action_requests
         SET status = $3, decided_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
       RETURNING *`,
      [ctx.tenantId, valid.requestId, valid.decision === 'approve' ? 'approved' : 'rejected', decidedAt],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) {
      const current = await findRequestRow(tx, ctx, valid.requestId);
      throw new ActionsError(
        'not_pending',
        `action request '${valid.requestId}' is already ${current?.status ?? 'decided'} — only a pending request can be decided`,
      );
    }

    await tx.query(
      `INSERT INTO action_approval_decisions (
         tenant_id, request_id, decision, decided_by, principal_id, note, decided_at
       ) VALUES ($1, $2, $3, 'principal', $4, $5, $6)`,
      [ctx.tenantId, valid.requestId, valid.decision, ctx.principalId, valid.note, decidedAt],
    );
    return mapRequest(updatedRow);
  });
}

export async function listApprovalDecisions(
  ctx: TenantContext,
  query: ListApprovalDecisionsQuery,
): Promise<ApprovalDecision[]> {
  assertActionsTenantContext(ctx);
  const valid = validateListApprovalDecisionsQuery(query);

  // The request must exist in this tenant — its decision trail is
  // tenant-scoped with it (cross-tenant: uniform not_found, no leak).
  const request = await findRequestRow(getDb(), ctx, valid.requestId);
  if (request === null) {
    throw new ActionsError(
      'action_request_not_found',
      `no action request '${valid.requestId}' exists in this tenant`,
    );
  }

  const rows = await getDb().query<DecisionRow>(
    `SELECT * FROM action_approval_decisions
       WHERE tenant_id = $1 AND request_id = $2
       ORDER BY decided_at ASC, id ASC`,
    [ctx.tenantId, valid.requestId],
  );
  return rows.rows.map(mapDecision);
}
