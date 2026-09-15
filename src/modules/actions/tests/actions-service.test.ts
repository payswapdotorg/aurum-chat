// Integration tests for the actions module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W009
// acceptance:
//
//  * THE AUTHORITY MATRIX: tenant-scoped policy rows per action kind
//    (plus the tenant-wide default row and the built-in floor),
//    claim-gated writes ('actions:administer'), upsert semantics, and
//    deterministic resolution order kind → tenant-default → built-in;
//  * UNIFORMITY (§20): the matrix governs every canonical action kind
//    — employee messaging, source access, data export, agent
//    recruitment, agent termination, extension deployment, external
//    communication — through the same machinery, and a kind row
//    overrides the default for exactly that kind;
//  * DETERMINISTIC APPROVAL GATES: the pure evaluation drives identical
//    outcomes for identical policy state (repeated evaluations, and the
//    recorded gate agrees with the read-only evaluator); outcomes map
//    onto request states (allowed → approved with a POLICY decision,
//    forbidden → rejected with a POLICY rejection, approval_required →
//    pending with NO decision until a human one lands); evaluation
//    snapshots are frozen at gate time and survive later policy edits;
//  * THE APPROVAL LIFECYCLE: claim-gated human decisions
//    ('actions:approve' / kind-scoped), separation of duties (the
//    requester never decides its own request), first-decision-wins,
//    not-pending terminal states, and the append-only decision trail;
//  * IDEMPOTENCY: a recorded key replays the original request (first
//    write wins), keys are tenant-scoped, keyless requests never
//    deduplicate;
//  * TENANT ISOLATION (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks);
//  * STORAGE-LEVEL GUARANTEES: requests are immutable history except
//    their decision state (guard trigger), decisions are append-only,
//    and the policy table's shape/vocabulary/ambiguity rules hold even
//    for writes bypassing the service.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as actionsContract from '../contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

const {
  authorizeAction,
  canApprove,
  CANONICAL_ACTION_KINDS,
  decideApproval,
  evaluateActionAuthority,
  getActionRequest,
  getAuthorityPolicy,
  kindScopedApproveClaim,
  listActionRequests,
  listApprovalDecisions,
  listAuthorityPolicies,
  resolveAuthorityPolicy,
  setAuthorityPolicy,
} = actionsContract;

// Dedicated tenants keep each concern's data (and policies!) isolated
// from the others, so every assertion below sees only what it created.
const tenantPolicies = newId();
const tenantUniform = newId();
const tenantDeterminism = newId();
const tenantGate = newId();
const tenantDeny = newId();
const tenantApprovals = newId();
const tenantIdem = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantStorage = newId();
const tenantFilters = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

function admin(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:administer'] };
}

function approver(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['actions:approve'] };
}

function kindApprover(tenantId: string, actionKind: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [kindScopedApproveClaim(actionKind)] };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Contract surface
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no un-decide, no request mutation, no policy removal', async () => {
    // There is deliberately no updateActionRequest, no deleteActionRequest,
    // no revokeDecision, no removeAuthorityPolicy: requests are history,
    // decisions are append-only, and policy lifecycle beyond upsert is
    // not W009 scope.
    expect(Object.keys(actionsContract).sort()).toEqual([
      'ACTIONS_AUTHORITY_ADMINISTER',
      'ACTIONS_AUTHORITY_APPROVE',
      'ACTION_REQUEST_STATUSES',
      'AUTHORITY_LEVELS',
      'AUTHORITY_OUTCOMES',
      'ActionsError',
      'CANONICAL_ACTION_KINDS',
      'DEFAULT_LIST_LIMIT',
      'MAX_IDEMPOTENCY_KEY_LENGTH',
      'MAX_LIST_LIMIT',
      'MAX_PAYLOAD_BYTES',
      'authorizeAction',
      'builtInDefaultMatrix',
      'canAdminister',
      'canApprove',
      'decideApproval',
      'evaluateActionAuthority',
      'evaluateAuthorityMatrix',
      'getActionRequest',
      'getAuthorityPolicy',
      'isActionRequestStatus',
      'isAuthorityLevel',
      'isAuthorityOutcome',
      'isCanonicalActionKind',
      'kindScopedApproveClaim',
      'listActionRequests',
      'listApprovalDecisions',
      'listAuthorityPolicies',
      'policyDecisionForOutcome',
      'resolveAuthorityPolicy',
      'setAuthorityPolicy',
      'statusForOutcome',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The authority matrix (tenant policy)
// ---------------------------------------------------------------------------

describe('the authority matrix (tenant policy rows)', () => {
  it('requires the administer claim to write policy — plain members are forbidden', async () => {
    await expect(
      setAuthorityPolicy(member(tenantPolicies), { approvalLevels: ['EXECUTE'] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // even a global approver cannot rewrite the matrix
    await expect(
      setAuthorityPolicy(approver(tenantPolicies), { approvalLevels: [] }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('creates the default row (null kind) and kind rows; upsert keeps one row per key', async () => {
    const created = await setAuthorityPolicy(admin(tenantPolicies), {
      approvalLevels: ['EXECUTE'],
      forbiddenLevels: [],
      note: 'floor preserved',
    });
    expect(created.tenantId).toBe(tenantPolicies);
    expect(created.actionKind).toBeNull();
    expect(created.approvalLevels).toEqual(['EXECUTE']);
    expect(created.forbiddenLevels).toEqual([]);
    expect(created.note).toBe('floor preserved');

    const updated = await setAuthorityPolicy(admin(tenantPolicies), {
      approvalLevels: ['ASK', 'EXECUTE'],
      note: 'tightened',
    });
    expect(updated.id).toBe(created.id);
    expect(updated.approvalLevels).toEqual(['ASK', 'EXECUTE']);
    expect(updated.note).toBe('tightened');
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

    const kindRow = await setAuthorityPolicy(admin(tenantPolicies), {
      actionKind: 'source-access',
      approvalLevels: ['OBSERVE'],
      forbiddenLevels: ['EXECUTE'],
    });
    expect(kindRow.actionKind).toBe('source-access');
    expect(kindRow.approvalLevels).toEqual(['OBSERVE']);
    expect(kindRow.forbiddenLevels).toEqual(['EXECUTE']);

    const all = await listAuthorityPolicies(member(tenantPolicies), {});
    expect(all).toHaveLength(2);
    // default row first (NULLS FIRST), then alphabetical kinds
    expect(all.map((row) => row.actionKind)).toEqual([null, 'source-access']);
  });

  it('exact lookups miss as policy_not_found; resolution falls back in order', async () => {
    // exact: the default row and the kind row exist in tenantPolicies
    const exactDefault = await getAuthorityPolicy(member(tenantPolicies), { actionKind: null });
    expect(exactDefault.actionKind).toBeNull();
    const exactKind = await getAuthorityPolicy(member(tenantPolicies), { actionKind: 'source-access' });
    expect(exactKind.actionKind).toBe('source-access');
    await expect(
      getAuthorityPolicy(member(tenantPolicies), { actionKind: 'agent-recruitment' }),
    ).rejects.toMatchObject({ code: 'policy_not_found' });

    // resolution: kind row wins over the tenant default
    const viaKind = await resolveAuthorityPolicy(member(tenantPolicies), { actionKind: 'source-access' });
    expect(viaKind.source).toBe('kind');
    expect(viaKind.approvalLevels).toEqual(['OBSERVE']);
    expect(viaKind.forbiddenLevels).toEqual(['EXECUTE']);
    expect(viaKind.policy?.id).toBe(exactKind.id);

    // ...the default row governs kinds without their own row
    const viaDefault = await resolveAuthorityPolicy(member(tenantPolicies), { actionKind: 'agent-recruitment' });
    expect(viaDefault.source).toBe('tenant-default');
    expect(viaDefault.approvalLevels).toEqual(['ASK', 'EXECUTE']);
    expect(viaDefault.policy?.actionKind).toBeNull();

    // ...and a fresh tenant resolves to the built-in floor
    const freshTenant = newId();
    const viaBuiltIn = await resolveAuthorityPolicy(member(freshTenant), { actionKind: 'data-export' });
    expect(viaBuiltIn.source).toBe('built-in');
    expect(viaBuiltIn.policy).toBeNull();
    expect(viaBuiltIn.approvalLevels).toEqual(['EXECUTE']);
    expect(viaBuiltIn.forbiddenLevels).toEqual([]);

    // resolution always needs a concrete kind — the default row is the
    // fallback inside the resolution, never its subject
    await expect(
      resolveAuthorityPolicy(member(tenantPolicies), { actionKind: null }),
    ).rejects.toMatchObject({ code: 'invalid_query' });
  });

  it('bounds and orders the policy list', async () => {
    const list = await listAuthorityPolicies(member(tenantPolicies), { limit: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]!.actionKind).toBeNull();
    await expect(listAuthorityPolicies(member(tenantPolicies), { limit: 0 })).rejects.toMatchObject({
      code: 'invalid_query',
    });
  });
});

// ---------------------------------------------------------------------------
// Uniformity (§20) — one matrix for every consequential action kind
// ---------------------------------------------------------------------------

describe('uniformity (§20: the matrix applies uniformly to all action kinds)', () => {
  it('governs every canonical kind through the same resolution and evaluation', async () => {
    await setAuthorityPolicy(admin(tenantUniform), {
      approvalLevels: ['EXECUTE'],
      forbiddenLevels: ['ASK'],
    });

    for (const kind of CANONICAL_ACTION_KINDS) {
      const ask = await evaluateActionAuthority(member(tenantUniform), { actionKind: kind, authorityLevel: 'ASK' });
      expect(ask.outcome, `${kind} ASK`).toBe('forbidden');
      expect(ask.resolvedVia, `${kind} ASK`).toBe('tenant-default');

      const execute = await evaluateActionAuthority(member(tenantUniform), {
        actionKind: kind,
        authorityLevel: 'EXECUTE',
      });
      expect(execute.outcome, `${kind} EXECUTE`).toBe('approval_required');

      const observe = await evaluateActionAuthority(member(tenantUniform), {
        actionKind: kind,
        authorityLevel: 'OBSERVE',
      });
      expect(observe.outcome, `${kind} OBSERVE`).toBe('allowed');
    }

    // the open kind namespace resolves through the same machinery
    const custom = await evaluateActionAuthority(member(tenantUniform), {
      actionKind: 'invoice-processing',
      authorityLevel: 'ASK',
    });
    expect(custom.outcome).toBe('forbidden');
    expect(custom.resolvedVia).toBe('tenant-default');
  });

  it('lets a kind row override the default for exactly that kind', async () => {
    await setAuthorityPolicy(admin(tenantUniform), {
      actionKind: 'employee-messaging',
      approvalLevels: [],
      forbiddenLevels: [],
    });

    const messaging = await evaluateActionAuthority(member(tenantUniform), {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
    });
    expect(messaging.outcome).toBe('allowed');
    expect(messaging.resolvedVia).toBe('kind');

    for (const kind of CANONICAL_ACTION_KINDS.filter((k) => k !== 'employee-messaging')) {
      const stillForbidden = await evaluateActionAuthority(member(tenantUniform), {
        actionKind: kind,
        authorityLevel: 'ASK',
      });
      expect(stillForbidden.outcome, `${kind} ASK`).toBe('forbidden');
      expect(stillForbidden.resolvedVia, `${kind} ASK`).toBe('tenant-default');
    }
  });
});

// ---------------------------------------------------------------------------
// Deterministic approval gates
// ---------------------------------------------------------------------------

describe('deterministic approval gates', () => {
  it('yields identical outcomes for identical policy state, and the recorded gate agrees', async () => {
    await setAuthorityPolicy(admin(tenantDeterminism), {
      actionKind: 'agent-recruitment',
      approvalLevels: ['PROPOSE', 'EXECUTE'],
      forbiddenLevels: [],
    });

    for (let i = 0; i < 5; i += 1) {
      const evaluation = await evaluateActionAuthority(member(tenantDeterminism), {
        actionKind: 'agent-recruitment',
        authorityLevel: 'EXECUTE',
      });
      expect(evaluation.outcome).toBe('approval_required');
      expect(evaluation.resolvedVia).toBe('kind');
      expect(evaluation.policy?.actionKind).toBe('agent-recruitment');
    }

    const request = await authorizeAction(member(tenantDeterminism), {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'invoice-reconciliation' },
    });
    expect(request.evaluation.outcome).toBe('approval_required');
    expect(request.evaluation.resolvedVia).toBe('kind');
    expect(request.status).toBe('pending');
  });

  it('changes outcomes only when the policy state changes', async () => {
    const before = await evaluateActionAuthority(member(tenantDeterminism), {
      actionKind: 'agent-recruitment',
      authorityLevel: 'PROPOSE',
    });
    expect(before.outcome).toBe('approval_required');

    await setAuthorityPolicy(admin(tenantDeterminism), {
      actionKind: 'agent-recruitment',
      approvalLevels: [],
      forbiddenLevels: ['PROPOSE'],
    });

    const after = await evaluateActionAuthority(member(tenantDeterminism), {
      actionKind: 'agent-recruitment',
      authorityLevel: 'PROPOSE',
    });
    expect(after.outcome).toBe('forbidden');
  });

  it('freezes the evaluation snapshot at gate time — later policy edits never rewrite it', async () => {
    await setAuthorityPolicy(admin(tenantDeterminism), {
      actionKind: 'extension-deployment',
      approvalLevels: ['EXECUTE'],
    });
    const request = await authorizeAction(member(tenantDeterminism), {
      actionKind: 'extension-deployment',
      authorityLevel: 'EXECUTE',
      payload: { extension: 'bulk-exporter', version: '1.4.0' },
    });
    expect(request.evaluation.policy?.approvalLevels).toEqual(['EXECUTE']);

    await setAuthorityPolicy(admin(tenantDeterminism), {
      actionKind: 'extension-deployment',
      approvalLevels: [],
      forbiddenLevels: ['EXECUTE'],
    });

    const reread = await getActionRequest(member(tenantDeterminism), { requestId: request.id });
    expect(reread.evaluation.outcome).toBe('approval_required');
    expect(reread.evaluation.policy?.approvalLevels).toEqual(['EXECUTE']);
    expect(reread.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// The gate outcomes (authorizeAction)
// ---------------------------------------------------------------------------

describe('authorizeAction (routing through the matrix)', () => {
  it('auto-allows OBSERVE under the built-in floor and records the policy approval', async () => {
    const ctx = member(tenantGate);
    const before = new Date();
    const request = await authorizeAction(ctx, {
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
      payload: { system: 'erp', scope: 'invoices' },
      justification: 'monthly reconciliation',
    });
    const after = new Date();

    expect(request.tenantId).toBe(tenantGate);
    expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.actionKind).toBe('source-access');
    expect(request.authorityLevel).toBe('OBSERVE');
    expect(request.payload).toEqual({ system: 'erp', scope: 'invoices' });
    expect(request.justification).toBe('monthly reconciliation');
    expect(request.requestedBy).toBe(ctx.principalId);
    expect(request.idempotencyKey).toBeNull();
    expect(Date.parse(request.requestedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(request.requestedAt)).toBeLessThanOrEqual(after.getTime());

    expect(request.evaluation.outcome).toBe('allowed');
    expect(request.evaluation.resolvedVia).toBe('built-in');
    expect(request.evaluation.policy).toBeNull();
    expect(request.status).toBe('approved');
    expect(request.decidedAt).toBe(request.requestedAt);

    const decisions = await listApprovalDecisions(ctx, { requestId: request.id });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'approve',
      decidedBy: 'policy',
      principalId: null,
    });
    expect(decisions[0]!.note).toContain('allows OBSERVE');
    expect(decisions[0]!.note).toContain('built-in default matrix');
  });

  it('gates EXECUTE under the built-in floor: pending, no decision, no decidedAt', async () => {
    const ctx = member(tenantGate);
    const request = await authorizeAction(ctx, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'collections-agent', budget: 250_00 },
    });

    expect(request.evaluation.outcome).toBe('approval_required');
    expect(request.status).toBe('pending');
    expect(request.decidedAt).toBeNull();
    const decisions = await listApprovalDecisions(ctx, { requestId: request.id });
    expect(decisions).toHaveLength(0);
  });

  it('rejects what the tenant default forbids and records the policy rejection', async () => {
    await setAuthorityPolicy(admin(tenantDeny), {
      approvalLevels: [],
      forbiddenLevels: ['EXECUTE', 'ASK'],
    });
    const ctx = member(tenantDeny);
    const request = await authorizeAction(ctx, {
      actionKind: 'external-communication',
      authorityLevel: 'EXECUTE',
      payload: { channel: 'press', statement: '...' },
    });

    expect(request.evaluation.outcome).toBe('forbidden');
    expect(request.evaluation.resolvedVia).toBe('tenant-default');
    expect(request.status).toBe('rejected');
    expect(request.decidedAt).toBe(request.requestedAt);

    const decisions = await listApprovalDecisions(ctx, { requestId: request.id });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: 'reject', decidedBy: 'policy', principalId: null });
    expect(decisions[0]!.note).toContain('forbids EXECUTE');
    expect(decisions[0]!.note).toContain('tenant-default policy');
  });

  it('rejects smuggled lifecycle fields and malformed inputs', async () => {
    const ctx = member(tenantGate);
    const base = {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK' as const,
      payload: { question: 'status?' },
    };
    for (const smuggled of ['id', 'tenantId', 'status', 'requestedBy', 'requestedAt', 'decidedAt', 'evaluation']) {
      await expect(
        authorizeAction(ctx, { ...base, [smuggled]: newId() } as never),
      ).rejects.toMatchObject({ code: 'invalid_action_input' });
    }
    await expect(
      authorizeAction(ctx, { ...base, authorityLevel: 'GUESS' as never }),
    ).rejects.toMatchObject({ code: 'invalid_action_input' });
    await expect(authorizeAction(ctx, { ...base, payload: null })).rejects.toMatchObject({
      code: 'invalid_action_input',
    });
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('idempotency keys (async cognition retries)', () => {
  it('replays the original request on retry — first write wins, no duplicate', async () => {
    const ctx = member(tenantIdem);
    const input = {
      actionKind: 'data-export',
      authorityLevel: 'EXECUTE' as const,
      payload: { dataset: 'receivables', format: 'csv' },
      idempotencyKey: 'cognition:mission-42:export',
    };

    const first = await authorizeAction(ctx, input);
    expect(first.status).toBe('pending');

    const replay = await authorizeAction(ctx, input);
    expect(replay).toEqual(first);

    // divergent retry: first write wins, history is not rewritten
    const divergent = await authorizeAction(ctx, {
      ...input,
      payload: { dataset: 'tampered', format: 'csv' },
    });
    expect(divergent.id).toBe(first.id);
    expect(divergent.payload).toEqual(first.payload);

    const listed = await listActionRequests(ctx, { actionKind: 'data-export' });
    expect(listed).toHaveLength(1);

    // keyless requests never dedupe (SQL UNIQUE treats NULLs as distinct)
    const k1 = await authorizeAction(ctx, { ...input, idempotencyKey: null });
    const k2 = await authorizeAction(ctx, { ...input, idempotencyKey: null });
    expect(k1.id).not.toBe(k2.id);
  });

  it('scopes idempotency keys per tenant', async () => {
    const ctxA = member(tenantIdem);
    const ctxB = member(tenantIsoB);
    const domestic = await authorizeAction(ctxA, {
      actionKind: 'data-export',
      authorityLevel: 'OBSERVE',
      payload: { dataset: 'payables' },
      idempotencyKey: 'shared-key',
    });
    const foreign = await authorizeAction(ctxB, {
      actionKind: 'data-export',
      authorityLevel: 'OBSERVE',
      payload: { dataset: 'payables' },
      idempotencyKey: 'shared-key',
    });
    expect(foreign.id).not.toBe(domestic.id);
    expect(foreign.tenantId).toBe(tenantIsoB);
    expect(domestic.tenantId).toBe(tenantIdem);
  });
});

// ---------------------------------------------------------------------------
// Human approval decisions
// ---------------------------------------------------------------------------

describe('decideApproval (the human gate)', () => {
  it('approves a pending request for a claim holder and records the principal decision', async () => {
    const requester = member(tenantApprovals);
    const gate = await authorizeAction(requester, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'collections-agent' },
      justification: 'W022 proposal',
    });
    expect(gate.status).toBe('pending');

    const approverCtx = approver(tenantApprovals);
    const before = new Date();
    const approved = await decideApproval(approverCtx, {
      requestId: gate.id,
      decision: 'approve',
      note: 'within budget',
    });
    const after = new Date();

    expect(approved.status).toBe('approved');
    expect(approved.decidedAt).not.toBeNull();
    expect(Date.parse(approved.decidedAt!)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(approved.decidedAt!)).toBeLessThanOrEqual(after.getTime());
    // the substantive request is untouched by the decision
    expect(approved.payload).toEqual(gate.payload);
    expect(approved.requestedBy).toBe(requester.principalId);

    const decisions = await listApprovalDecisions(member(tenantApprovals), { requestId: gate.id });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: 'approve',
      decidedBy: 'principal',
      principalId: approverCtx.principalId,
      note: 'within budget',
    });
  });

  it('rejects a pending request symmetrically', async () => {
    const requester = member(tenantApprovals);
    const gate = await authorizeAction(requester, {
      actionKind: 'extension-deployment',
      authorityLevel: 'EXECUTE',
      payload: { extension: 'bulk-exporter' },
    });
    const rejected = await decideApproval(approver(tenantApprovals), {
      requestId: gate.id,
      decision: 'reject',
      note: 'security review failed',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.decidedAt).not.toBeNull();

    const decisions = await listApprovalDecisions(member(tenantApprovals), { requestId: gate.id });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decision: 'reject', decidedBy: 'principal' });
  });

  it('enforces separation of duties: the requester never decides its own request', async () => {
    const requester = member(tenantApprovals);
    const gate = await authorizeAction(requester, {
      actionKind: 'agent-termination',
      authorityLevel: 'EXECUTE',
      payload: { agent: 'legacy-collections-bot' },
    });
    // the requester even holds the global approve claim — still forbidden
    const selfApprover = memberAs(tenantApprovals, requester.principalId, ['actions:approve']);
    await expect(
      decideApproval(selfApprover, { requestId: gate.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // the request is untouched: still pending, still decisionless
    const reread = await getActionRequest(member(tenantApprovals), { requestId: gate.id });
    expect(reread.status).toBe('pending');
    expect(await listApprovalDecisions(member(tenantApprovals), { requestId: gate.id })).toHaveLength(0);
  });

  it('requires the approve claim — kind-scoped claims cover exactly their kind', async () => {
    const requester = member(tenantApprovals);
    const gate = await authorizeAction(requester, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'triage-agent' },
    });

    // plain member: forbidden
    await expect(
      decideApproval(member(tenantApprovals), { requestId: gate.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // administer-only: forbidden (administering the matrix is not deciding)
    await expect(
      decideApproval(admin(tenantApprovals), { requestId: gate.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    // kind-scoped to another kind: forbidden
    await expect(
      decideApproval(kindApprover(tenantApprovals, 'data-export'), { requestId: gate.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    // kind-scoped to the right kind: allowed
    const approved = await decideApproval(kindApprover(tenantApprovals, 'agent-recruitment'), {
      requestId: gate.id,
      decision: 'approve',
    });
    expect(approved.status).toBe('approved');
  });

  it('makes decisions terminal: not_pending for auto-decided and already-decided requests', async () => {
    const ctx = member(tenantApprovals);

    // policy-auto-approved requests are terminal the moment they land
    const auto = await authorizeAction(ctx, {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { question: 'who owns supplier risk?' },
    });
    expect(auto.status).toBe('approved');
    await expect(
      decideApproval(approver(tenantApprovals), { requestId: auto.id, decision: 'reject' }),
    ).rejects.toMatchObject({ code: 'not_pending' });

    // policy-rejected requests likewise
    await setAuthorityPolicy(admin(tenantApprovals), {
      approvalLevels: ['EXECUTE'],
      forbiddenLevels: ['ASK'],
    });
    const denied = await authorizeAction(ctx, {
      actionKind: 'external-communication',
      authorityLevel: 'ASK',
      payload: { note: 'press inquiry' },
    });
    expect(denied.status).toBe('rejected');
    await expect(
      decideApproval(approver(tenantApprovals), { requestId: denied.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'not_pending' });

    // and the first human decision on a gated request wins
    const gate = await authorizeAction(ctx, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'yet-another-agent' },
    });
    await decideApproval(approver(tenantApprovals), { requestId: gate.id, decision: 'approve' });
    await expect(
      decideApproval(approver(tenantApprovals), { requestId: gate.id, decision: 'reject' }),
    ).rejects.toMatchObject({ code: 'not_pending' });
    const decisions = await listApprovalDecisions(ctx, { requestId: gate.id });
    expect(decisions).toHaveLength(1);
  });

  it('validates decision inputs', async () => {
    const ctx = member(tenantApprovals);
    await expect(
      decideApproval(ctx, { requestId: newId(), decision: 'maybe' as never }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
    await expect(
      decideApproval(ctx, { requestId: 'not-a-uuid', decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'invalid_decision' });
  });
});

// ---------------------------------------------------------------------------
// Request listing (the Approvals surface feed)
// ---------------------------------------------------------------------------

describe('listActionRequests (the approvals surface)', () => {
  it('filters by kind, level, status and requester; newest first', async () => {
    const requester = newId();
    const ctx = memberAs(tenantFilters, requester);
    await setAuthorityPolicy(admin(tenantFilters), { approvalLevels: ['ASK', 'EXECUTE'] });

    const ask = await authorizeAction(ctx, {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
      payload: { q: 1 },
    });
    const execute = await authorizeAction(ctx, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { q: 2 },
    });
    const observe = await authorizeAction(ctx, {
      actionKind: 'employee-messaging',
      authorityLevel: 'OBSERVE',
      payload: { q: 3 },
    });
    expect(ask.status).toBe('pending');
    expect(execute.status).toBe('pending');
    expect(observe.status).toBe('approved');

    const byKind = await listActionRequests(member(tenantFilters), { actionKind: 'employee-messaging' });
    expect(byKind.map((r) => r.id).sort()).toEqual([ask.id, observe.id].sort());

    const byStatus = await listActionRequests(member(tenantFilters), { status: 'pending' });
    expect(byStatus.map((r) => r.id).sort()).toEqual([ask.id, execute.id].sort());

    const byLevel = await listActionRequests(member(tenantFilters), { authorityLevel: 'EXECUTE' });
    expect(byLevel.map((r) => r.id)).toEqual([execute.id]);

    const byRequester = await listActionRequests(member(tenantFilters), { requestedBy: requester });
    expect(byRequester).toHaveLength(3);

    // newest first: the feed is ordered by requested_at descending
    const all = await listActionRequests(member(tenantFilters), {});
    expect(all.map((r) => r.id).sort()).toEqual([ask.id, execute.id, observe.id].sort());
    for (let i = 1; i < all.length; i += 1) {
      expect(Date.parse(all[i - 1]!.requestedAt)).toBeGreaterThanOrEqual(Date.parse(all[i]!.requestedAt));
    }

    const limited = await listActionRequests(member(tenantFilters), { limit: 1 });
    expect(limited).toHaveLength(1);

    // another tenant's member sees none of this
    const foreign = await listActionRequests(member(tenantIsoA), {});
    expect(foreign.find((r) => r.tenantId === tenantFilters)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('makes foreign requests indistinguishable from missing ones', async () => {
    const ctxA = member(tenantIsoA);
    const request = await authorizeAction(ctxA, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'iso-agent' },
    });

    await expect(getActionRequest(member(tenantIsoB), { requestId: request.id })).rejects.toMatchObject({
      code: 'action_request_not_found',
    });
    await expect(
      decideApproval(approver(tenantIsoB), { requestId: request.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'action_request_not_found' });
    await expect(
      listApprovalDecisions(member(tenantIsoB), { requestId: request.id }),
    ).rejects.toMatchObject({ code: 'action_request_not_found' });
  });

  it('never lets one tenant policy leak into another tenant\'s evaluation', async () => {
    await setAuthorityPolicy(admin(tenantIsoA), { forbiddenLevels: ['ASK', 'EXECUTE'] });

    const inA = await evaluateActionAuthority(member(tenantIsoA), {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
    });
    expect(inA.outcome).toBe('forbidden');
    expect(inA.resolvedVia).toBe('tenant-default');

    const inB = await evaluateActionAuthority(member(tenantIsoB), {
      actionKind: 'employee-messaging',
      authorityLevel: 'ASK',
    });
    expect(inB.outcome).toBe('allowed');
    expect(inB.resolvedVia).toBe('built-in');

    await expect(
      getAuthorityPolicy(member(tenantIsoB), { actionKind: null }),
    ).rejects.toMatchObject({ code: 'policy_not_found' });
    const policiesB = await listAuthorityPolicies(member(tenantIsoB), {});
    expect(policiesB).toHaveLength(0);
  });

  it('malformed contexts fail as invalid_context before any SQL runs', async () => {
    await expect(
      authorizeAction({ tenantId: '', principalId: newId(), authority: [] }, {
        actionKind: 'employee-messaging',
        authorityLevel: 'ASK',
        payload: {},
      }),
    ).rejects.toMatchObject({ code: 'invalid_context' });
    await expect(
      listActionRequests({ tenantId: newId(), principalId: '', authority: [] }, {}),
    ).rejects.toMatchObject({ code: 'invalid_context' });
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees
// ---------------------------------------------------------------------------

describe('storage-level guarantees (defense in depth)', () => {
  it('rejects UPDATE of substantive request fields; only the decision state may move', async () => {
    const ctx = member(tenantStorage);
    const request = await authorizeAction(ctx, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'guard-test' },
    });

    await expect(
      getDb().query(`UPDATE action_requests SET payload = '"tampered"'::jsonb WHERE id = $1`, [request.id]),
    ).rejects.toThrow(/immutable history/i);
    await expect(
      getDb().query(`UPDATE action_requests SET requested_by = 'someone-else' WHERE id = $1`, [request.id]),
    ).rejects.toThrow(/immutable history/i);
    await expect(
      getDb().query(`UPDATE action_requests SET outcome = 'allowed' WHERE id = $1`, [request.id]),
    ).rejects.toThrow(/immutable history/i);
    await expect(
      getDb().query(`UPDATE action_requests SET action_kind = 'employee-messaging' WHERE id = $1`, [request.id]),
    ).rejects.toThrow(/immutable history/i);

    // the service's own transition shape (status + decided_at + updated_at) is allowed...
    await getDb().query(
      `UPDATE action_requests SET status = 'approved', decided_at = now(), updated_at = now() WHERE id = $1`,
      [request.id],
    );
    // ...but the decision state stays self-consistent (CHECK constraint):
    // a non-pending status without a decided_at is rejected at the storage layer
    await expect(
      getDb().query(
        `UPDATE action_requests SET status = 'rejected', decided_at = NULL, updated_at = now() WHERE id = $1`,
        [request.id],
      ),
    ).rejects.toThrow(/decision_state_shape/i);

    const after = await getActionRequest(ctx, { requestId: request.id });
    expect(after.status).toBe('approved');
    expect(after.payload).toEqual({ role: 'guard-test' });
  });

  it('rejects DELETE and TRUNCATE on requests and decisions', async () => {
    const ctx = member(tenantStorage);
    const request = await authorizeAction(ctx, {
      actionKind: 'source-access',
      authorityLevel: 'OBSERVE',
      payload: { system: 'erp' },
    });

    await expect(getDb().query(`DELETE FROM action_requests WHERE id = $1`, [request.id])).rejects.toThrow(
      /immutable history/i,
    );
    await expect(getDb().query(`TRUNCATE action_requests`)).rejects.toThrow(
      /immutable history|cannot truncate/i,
    );
    await expect(getDb().query(`TRUNCATE action_approval_decisions`)).rejects.toThrow(
      /append-only|cannot truncate/i,
    );
  });

  it('keeps approval decisions append-only', async () => {
    const ctx = member(tenantStorage);
    const request = await authorizeAction(ctx, {
      actionKind: 'external-communication',
      authorityLevel: 'EXECUTE',
      payload: { channel: 'partner' },
    });
    const gate = await authorizeAction(ctx, {
      actionKind: 'agent-recruitment',
      authorityLevel: 'EXECUTE',
      payload: { role: 'x' },
    });
    await decideApproval(approver(tenantStorage), { requestId: gate.id, decision: 'approve' });

    const decisions = await listApprovalDecisions(ctx, { requestId: gate.id });
    const decisionId = decisions[0]!.id;

    await expect(
      getDb().query(`UPDATE action_approval_decisions SET decision = 'reject' WHERE id = $1`, [decisionId]),
    ).rejects.toThrow(/append-only/i);
    await expect(
      getDb().query(`DELETE FROM action_approval_decisions WHERE id = $1`, [decisionId]),
    ).rejects.toThrow(/append-only/i);

    // decisions cannot reference another tenant's request (composite FK),
    // and the decider shape holds even for service-bypassing writes.
    await expect(
      getDb().query(
        `INSERT INTO action_approval_decisions (tenant_id, request_id, decision, decided_by, principal_id, decided_at)
         VALUES ($1, $2, 'approve', 'policy', 'someone', now())`,
        [tenantStorage, request.id],
      ),
    ).rejects.toThrow(/decider_shape/i);
    await expect(
      getDb().query(
        `INSERT INTO action_approval_decisions (tenant_id, request_id, decision, decided_by, decided_at)
         VALUES ($1, $2, 'approve', 'principal', now())`,
        [tenantStorage, request.id],
      ),
    ).rejects.toThrow(/decider_shape/i);
  });

  it('keeps policy rows well-formed even for service-bypassing writes', async () => {
    const tenant = tenantStorage;
    await expect(
      getDb().query(
        `INSERT INTO action_authority_policies (tenant_id, action_kind, approval_levels, forbidden_levels, created_at, updated_at)
         VALUES ($1, 'x-kind', '["ASK"]'::jsonb, '["ASK"]'::jsonb, now(), now())`,
        [tenant],
      ),
    ).rejects.toThrow(/cannot be both approval-gated and forbidden/i);
    await expect(
      getDb().query(
        `INSERT INTO action_authority_policies (tenant_id, action_kind, approval_levels, forbidden_levels, created_at, updated_at)
         VALUES ($1, 'x-kind', '["WISH"]'::jsonb, '[]'::jsonb, now(), now())`,
        [tenant],
      ),
    ).rejects.toThrow(/unknown authority level/i);
    // ...while a well-formed bypassing insert is accepted (policies are
    // management controls, not append-only history)
    await getDb().query(
      `INSERT INTO action_authority_policies (tenant_id, action_kind, approval_levels, forbidden_levels, created_at, updated_at)
       VALUES ($1, 'bypass-kind', '["ASK"]'::jsonb, '[]'::jsonb, now(), now())`,
      [tenant],
    );
    const policies = await listAuthorityPolicies(member(tenant), {});
    expect(policies.find((p) => p.actionKind === 'bypass-kind')).toMatchObject({
      approvalLevels: ['ASK'],
      forbiddenLevels: [],
    });
  });
});

// ---------------------------------------------------------------------------
// canApprove parity (pure claim rules vs the service gate)
// ---------------------------------------------------------------------------

describe('claim rules (pure helpers used by the service gate)', () => {
  it('mirrors the service enforcement exactly', () => {
    const claims = [kindScopedApproveClaim('agent-recruitment')];
    expect(canApprove(claims, 'agent-recruitment')).toBe(true);
    expect(canApprove(claims, 'agent-termination')).toBe(false);
    expect(canApprove(['actions:approve'], 'agent-termination')).toBe(true);
    expect(canApprove([], 'agent-termination')).toBe(false);
  });
});
