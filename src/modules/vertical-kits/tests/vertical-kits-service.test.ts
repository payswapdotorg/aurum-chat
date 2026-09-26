// Integration tests for the vertical-kits module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W092
// acceptance end-to-end, for BOTH shipped starter kits:
//
// "each pack is installable, permission-scoped, versioned, auditable and
//  removable; core modules remain industry-independent."
//
//   * THE ACCEPTANCE PATH (both kits) — register → verify → install →
//     THE GRANT REVIEW (the W009 gate: kind 'vertical-kit-deployment' ×
//     EXECUTE; the human approve mints exactly the declared capabilities
//     as kit grants) → activate → USE through fixture doubles (the
//     capability gate, the edge read path and the edge write path) →
//     remove → CLEAN STATE (every grant revoked, invocations denied,
//     audit retained) → the kit is reinstallable;
//
//   * DENIAL STOPS THE KIT — a rejected review mints no grant and the
//     suspended/removed states deny every invocation with the
//     deterministic, task-grounded reason;
//
//   * THE POLICY MATRIX OUTCOMES — a tenant policy that auto-allows the
//     kind mints the grants at install; a policy that forbids it refuses
//     the install (the gate's own verdict, recorded not swallowed);
//
//   * SEPARATION OF DUTIES — the requesting principal never decides its
//     own install review (enforced by the actions module, propagated);
//
//   * VERSIONED AND SIGNED — strictly increasing versions, immutable
//     manifests, and the signed-manifest digest: a row edited outside
//     the service fails re-verification's integrity check loudly;
//
//   * INSTALL REQUIRES VERIFICATION — an unverified version never
//     installs; a malformed manifest never registers;
//
//   * DEFERRED-ON-W088 — with no edge wired, inspect/execute fail
//     explicitly (edge_unavailable); with the fixture double wired, the
//     read/write paths execute and record their receipts; a provider
//     object cannot cross the kit runtime (invalid_edge_result);
//
//   * HONEST STATUS — components report 'defined' (never claimed as
//     deployed software), integrations report 'deferred-on-w088' until
//     an edge is wired;
//
//   * TENANT ISOLATION — two tenants, zero leakage;
//
//   * STORAGE DISCIPLINE — the events, invocations and verifications
//     ledgers are append-only (UPDATE/DELETE/TRUNCATE refused at the
//     storage level).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as actionsContract from '@/modules/actions/contract';
import { VerticalKitsError } from '../errors';
import * as verticalKits from '../contract';
import {
  ACCOUNTING_LEDGER_ERP_KIT,
  LEGAL_CASE_MANAGEMENT_KIT,
} from '../kits';
import type { VerticalKitEdge } from '../contract';

// ---------------------------------------------------------------------------
// Contexts and helpers
// ---------------------------------------------------------------------------

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: VerticalKitsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected VerticalKitsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof VerticalKitsError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** Register + verify a kit in a tenant: the installable posture. */
async function registerVerifiedKit(
  ctx: TenantContext,
  manifest: typeof LEGAL_CASE_MANAGEMENT_KIT,
): Promise<verticalKits.VerticalKitVersion> {
  const registered = await verticalKits.registerKitVersion(ctx, { manifest });
  const run = await verticalKits.runKitVerification(ctx, {
    kitVersionId: registered.version.id,
  });
  expect(run.outcome).toBe('verified');
  return registered.version;
}

/**
 * The fixture double of the system-of-record edge — an in-test
 * implementation of the module's OWN VerticalKitEdge port (the seam that
 * awaits the W088 Edge Connector). No live network: a scripted map.
 */
class ScriptedEdge implements VerticalKitEdge {
  readonly edgeId = 'fixture-edge-1';
  readonly executeCalls: verticalKits.VerticalKitEdgeExecuteRequest[] = [];
  private readonly states = new Map<string, Record<string, unknown>>();

  async inspect(
    request: verticalKits.VerticalKitEdgeInspectRequest,
  ): Promise<verticalKits.VerticalKitEdgeState> {
    const state = this.states.get(`${request.integrationKey}:${request.target}`);
    return { found: state !== undefined, state: state ?? null };
  }

  async execute(
    request: verticalKits.VerticalKitEdgeExecuteRequest,
  ): Promise<verticalKits.VerticalKitEdgeReceipt> {
    this.executeCalls.push(request);
    this.states.set(`${request.integrationKey}:${request.target}`, request.payload);
    return {
      status: 'accepted',
      receiptId: `fixture-receipt-${this.executeCalls.length}`,
      detail: null,
    };
  }
}

/** The full governed walk for one kit, shared by both verticals. */
interface Walked {
  installation: verticalKits.KitInstallationDetail;
  edge: ScriptedEdge;
}

async function walkFullLifecycle(
  tenantId: string,
  kit: typeof LEGAL_CASE_MANAGEMENT_KIT,
): Promise<Walked> {
  const admin = memberOf(tenantId, ['vertical-kits:administer']);
  const approver = memberOf(tenantId, ['actions:approve']);

  await registerVerifiedKit(admin, kit);
  const installed = await verticalKits.installKit(admin, {
    kitKey: kit.kitKey,
    version: kit.version,
    justification: `W092 acceptance walk for ${kit.kitKey}`,
  });
  expect(installed.installation.status).toBe('pending-review');
  const decided = await verticalKits.decideKitReview(approver, {
    installationId: installed.installation.id,
    decision: 'approve',
    note: 'W092 acceptance: approved for the walk',
  });
  expect(decided.installation.status).toBe('granted');
  const activated = await verticalKits.activateKit(admin, {
    installationId: decided.installation.id,
  });
  expect(activated.installation.status).toBe('active');

  const edge = new ScriptedEdge();
  verticalKits.setVerticalKitEdge(edge);
  return { installation: activated, edge };
}

let migrationsRan = false;

beforeAll(async () => {
  if (!migrationsRan) {
    await runMigrations(getDb());
    migrationsRan = true;
  }
});

afterAll(async () => {
  verticalKits.setVerticalKitEdge(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The acceptance walk — both kits
// ---------------------------------------------------------------------------

describe('W092 acceptance — the legal / case-management kit', () => {
  const tenant = newId();

  it('install → grant review → activate → use (fixture double) → remove → clean state', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const approver = memberOf(tenant, ['actions:approve']);
    const member = memberOf(tenant);

    // -- install: the W009 gate routes the grant review (pending).
    await registerVerifiedKit(admin, LEGAL_CASE_MANAGEMENT_KIT);
    const installed = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.0.0',
      justification: 'Legal operations onboarding',
    });
    expect(installed.installation.status).toBe('pending-review');
    // The gate record exists and the approver-facing payload carries the
    // EXACT capability scope being asked for.
    const request = await actionsContract.getActionRequest(member, {
      requestId: installed.installation.actionRequestId,
    });
    expect(request.actionKind).toBe('vertical-kit-deployment');
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.status).toBe('pending');
    const payload = request.payload as { requiredCapabilities: { key: string }[] };
    expect([...payload.requiredCapabilities.map((c) => c.key)].sort()).toEqual(
      [...LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.map((c) => c.key)].sort(),
    );

    // Before the review: no grant, no usable authority — the kit cannot
    // even be activated yet, and no capability is allowed.
    expect(installed.grants).toEqual([]);
    await expectCode('installation_not_active', () =>
      verticalKits.inspectKitIntegration(member, {
        installationId: installed.installation.id,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        taskContext: { description: 'Inspect the matter' },
      }),
    );

    // -- the grant review: a DIFFERENT principal approves; exactly the
    // declared capabilities are minted.
    const decided = await verticalKits.decideKitReview(approver, {
      installationId: installed.installation.id,
      decision: 'approve',
      note: 'Legal reviewed the capability scope',
    });
    expect(decided.installation.status).toBe('granted');
    expect(decided.grants.map((g) => g.capabilityKey)).toEqual(
      [...LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.map((c) => c.key)].sort(),
    );
    for (const grant of decided.grants) {
      expect(grant.status).toBe('active');
      expect(grant.grantedBy).toBe(approver.principalId);
    }

    // -- activate.
    const activated = await verticalKits.activateKit(admin, {
      installationId: decided.installation.id,
    });
    expect(activated.installation.status).toBe('active');

    // -- use: the capability gate allows exactly the granted scope.
    const allowedRead = await verticalKits.invokeKitCapability(member, {
      installationId: activated.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Summarize matter status for the weekly review' },
    });
    expect(allowedRead.outcome).toBe('allowed');
    expect(allowedRead.basis).toBe('kit-grant');
    // An undeclared capability is denied with the EXACT scope language.
    const deniedUnknown = await verticalKits.invokeKitCapability(member, {
      installationId: activated.installation.id,
      capabilityKey: 'write.billing-records', // hmm — declared read-only below
      taskContext: { description: 'Post a time entry' },
    });
    // write.billing-records is not declared at all (only read.billing-records is).
    expect(deniedUnknown.outcome).toBe('denied');
    expect(deniedUnknown.basis).toBe('grant-missing');
    expect(deniedUnknown.denialReason).toContain("capability 'write.billing-records'");

    // -- use: the edge paths. DEFERRED-ON-W088 first: nothing wired.
    await expectCode('edge_unavailable', () =>
      verticalKits.inspectKitIntegration(member, {
        installationId: activated.installation.id,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        taskContext: { description: 'Inspect the matter' },
      }),
    );
    await expectCode('edge_unavailable', () =>
      verticalKits.executeKitIntegration(member, {
        installationId: activated.installation.id,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        payload: { status: 'pending-close' },
        taskContext: { description: 'Move the matter to pending-close' },
      }),
    );

    // Then the fixture double wires the port and the paths execute.
    const edge = new ScriptedEdge();
    verticalKits.setVerticalKitEdge(edge);
    const inspected = await verticalKits.inspectKitIntegration(member, {
      installationId: activated.installation.id,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      taskContext: { description: 'Inspect the matter' },
    });
    expect(inspected.invocation.outcome).toBe('allowed');
    expect(inspected.invocation.capabilityKey).toBe('read.case-matters');
    expect(inspected.state).toEqual({ found: false, state: null });

    const executed = await verticalKits.executeKitIntegration(member, {
      installationId: activated.installation.id,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      payload: { status: 'pending-close' },
      taskContext: { description: 'Move the matter to pending-close', requestedFor: 'the closing checklist' },
    });
    expect(executed.invocation.outcome).toBe('allowed');
    expect(executed.invocation.capabilityKey).toBe('write.case-matters');
    expect(executed.receipt).not.toBeNull();
    expect(executed.receipt!.receiptStatus).toBe('accepted');
    expect(executed.receipt!.receiptId).toBe('fixture-receipt-1');
    expect(executed.receipt!.edgeId).toBe('fixture-edge-1');
    expect(edge.executeCalls).toHaveLength(1);
    expect(edge.executeCalls[0]!.target).toBe('matter-001');
    expect(edge.executeCalls[0]!.payload).toEqual({ status: 'pending-close' });

    // The read path now sees the written state.
    const after = await verticalKits.inspectKitIntegration(member, {
      installationId: activated.installation.id,
      integrationKey: 'case-management-sor',
      target: 'matter-001',
      taskContext: { description: 'Confirm the write' },
    });
    expect(after.state).toEqual({ found: true, state: { status: 'pending-close' } });

    // -- the honest status report: defined components, ready integrations.
    const status = await verticalKits.getKitStatus(member, {
      installationId: activated.installation.id,
    });
    expect(status.status).toBe('active');
    expect(status.grants).toEqual({ active: 5, revoked: 0 });
    expect(status.extensions.every((c) => c.state === 'defined')).toBe(true);
    expect(status.agents.every((c) => c.state === 'defined')).toBe(true);
    expect(status.integrations.map((i) => i.readiness)).toEqual(['ready', 'ready']);
    expect(status.edgeWired).toBe('fixture-edge-1');
    expect(status.invocations.allowed).toBeGreaterThanOrEqual(3);

    // -- suspend: the gate denies with the state named verbatim.
    const suspended = await verticalKits.suspendKit(admin, {
      installationId: activated.installation.id,
      reason: 'case load review',
    });
    expect(suspended.installation.status).toBe('suspended');
    const suspendedInvocation = await verticalKits.invokeKitCapability(member, {
      installationId: activated.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Read while suspended' },
    });
    expect(suspendedInvocation.outcome).toBe('denied');
    expect(suspendedInvocation.basis).toBe('installation-inactive');
    expect(suspendedInvocation.denialReason).toContain("'suspended'");
    // A suspended kit's edge paths refuse too.
    await expectCode('installation_not_active', () =>
      verticalKits.executeKitIntegration(member, {
        installationId: activated.installation.id,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        payload: { status: 'closed' },
        taskContext: { description: 'Write while suspended' },
      }),
    );

    // -- resume.
    const resumed = await verticalKits.resumeKit(admin, {
      installationId: activated.installation.id,
    });
    expect(resumed.installation.status).toBe('active');
    const resumedInvocation = await verticalKits.invokeKitCapability(member, {
      installationId: activated.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Read after resume' },
    });
    expect(resumedInvocation.outcome).toBe('allowed');

    // -- remove: every grant revoked, no orphaned authority, audit retained.
    const removed = await verticalKits.removeKit(admin, {
      installationId: activated.installation.id,
      reason: 'the firm retired the starter kit',
    });
    expect(removed.installation.status).toBe('removed');
    expect(removed.installation.removalReason).toBe('the firm retired the starter kit');
    for (const grant of removed.grants) {
      expect(grant.status).toBe('revoked');
      expect(grant.revokedBy).toBe(admin.principalId);
      expect(grant.revocationReason).toBe('the firm retired the starter kit');
    }
    // The invocation gate denies everything now.
    const postRemoval = await verticalKits.invokeKitCapability(member, {
      installationId: activated.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Read after removal' },
    });
    expect(postRemoval.outcome).toBe('denied');
    expect(postRemoval.basis).toBe('installation-inactive');
    // The edge paths refuse.
    await expectCode('installation_not_active', () =>
      verticalKits.executeKitIntegration(member, {
        installationId: activated.installation.id,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        payload: { status: 'closed' },
        taskContext: { description: 'Write after removal' },
      }),
    );
    // The AUDIT IS RETAINED: the whole history is still readable.
    const events = await verticalKits.listKitEvents(member, {
      installationId: activated.installation.id,
    });
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain('installed');
    expect(eventNames).toContain('review-approved');
    expect(eventNames.filter((n) => n === 'grant-minted')).toHaveLength(5);
    expect(eventNames).toContain('activated');
    expect(eventNames).toContain('suspended');
    expect(eventNames).toContain('resumed');
    expect(eventNames.filter((n) => n === 'grant-revoked')).toHaveLength(5);
    expect(eventNames).toContain('removed');
    // The invocation ledger and the executed edge actions are retained too.
    const invocations = await verticalKits.listKitInvocations(member, {
      installationId: activated.installation.id,
    });
    expect(invocations.length).toBeGreaterThanOrEqual(5);
    const edgeActions = await verticalKits.listKitEdgeActions(member, {
      installationId: activated.installation.id,
    });
    expect(edgeActions).toHaveLength(1);
    // The honest status reports the removed state and revoked grants.
    const statusAfter = await verticalKits.getKitStatus(member, {
      installationId: activated.installation.id,
    });
    expect(statusAfter.status).toBe('removed');
    expect(statusAfter.grants).toEqual({ active: 0, revoked: 5 });

    // -- the kit is reinstallable: a fresh lifecycle on the same key.
    const reinstalled = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.0.0',
      justification: 'Second lifecycle after retirement',
    });
    expect(reinstalled.installation.status).toBe('pending-review');
    expect(reinstalled.installation.id).not.toBe(activated.installation.id);
    // Clean up this fixture's live lifecycle (the walk below expects a
    // free tenant state only where it re-walks; here we just leave it).
  });

  it('a REJECTED review mints nothing — denial stops the kit', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const approver = memberOf(tenant, ['actions:approve']);
    const member = memberOf(tenant);

    // Remove the pending lifecycle from the prior test, then install a
    // fresh one to reject.
    const live = await verticalKits.listKitInstallations(admin, { status: 'pending-review' });
    for (const installation of live) {
      await verticalKits.removeKit(admin, { installationId: installation.id });
    }
    const installed = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.0.0',
    });
    const rejected = await verticalKits.decideKitReview(approver, {
      installationId: installed.installation.id,
      decision: 'reject',
      note: 'the capability scope is too broad for now',
    });
    expect(rejected.installation.status).toBe('rejected');
    expect(rejected.grants).toEqual([]);
    // No authority exists to invoke.
    const invocation = await verticalKits.invokeKitCapability(member, {
      installationId: rejected.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Try to read after rejection' },
    });
    expect(invocation.outcome).toBe('denied');
    expect(invocation.basis).toBe('installation-inactive');
    // A rejected review is terminal: no activation, no re-decide.
    await expectCode('installation_not_lifecycle_state', () =>
      verticalKits.activateKit(admin, { installationId: rejected.installation.id }),
    );
    await expectCode('installation_not_pending_review', () =>
      verticalKits.decideKitReview(approver, {
        installationId: rejected.installation.id,
        decision: 'approve',
      }),
    );
    // The audit recorded the refusal.
    const events = await verticalKits.listKitEvents(member, {
      installationId: rejected.installation.id,
    });
    expect(events.map((e) => e.event)).toContain('review-rejected');
  });

  it('the requester never decides their own install review (separation of duties)', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer', 'actions:approve']);
    const live = await verticalKits.listKitInstallations(admin, { status: 'rejected' });
    for (const installation of live) {
      await verticalKits.removeKit(admin, { installationId: installation.id });
    }
    const installed = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.0.0',
    });
    // Same principal holds actions:approve — the actions module still
    // refuses (the requester never decides its own request).
    let refusal: unknown;
    try {
      await verticalKits.decideKitReview(admin, {
        installationId: installed.installation.id,
        decision: 'approve',
      });
      refusal = null;
    } catch (error) {
      refusal = error;
    }
    expect(refusal).not.toBeNull();
    expect((refusal as { name?: string }).name).toBe('ActionsError');
    // The installation is still pending its review.
    const still = await verticalKits.getKitInstallation(admin, {
      installationId: installed.installation.id,
    });
    expect(still.installation.status).toBe('pending-review');
    // A plain member cannot decide either (no approve claim).
    const member = memberOf(tenant);
    let memberRefusal: unknown;
    try {
      await verticalKits.decideKitReview(member, {
        installationId: installed.installation.id,
        decision: 'approve',
      });
      memberRefusal = null;
    } catch (error) {
      memberRefusal = error;
    }
    expect(memberRefusal).not.toBeNull();
    // Cleanup.
    await verticalKits.removeKit(admin, { installationId: installed.installation.id });
  });
});

describe('W092 acceptance — the accounting / ledger-ERP kit', () => {
  const tenant = newId();

  it('install → grant review → activate → use (fixture double) → remove → clean state', async () => {
    const walked = await walkFullLifecycle(tenant, ACCOUNTING_LEDGER_ERP_KIT);
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const member = memberOf(tenant);
    const installationId = walked.installation.installation.id;

    // The grants cover exactly the declared accounting scope (the read
    // model orders them by capability key).
    expect(walked.installation.grants.map((g) => g.capabilityKey)).toEqual([
      'read.journal-entries',
      'read.ledger-accounts',
      'read.payables-ledger',
      'read.receivables-ledger',
      'write.journal-entries',
    ]);

    // -- use: post a journal entry through the ledger ERP integration.
    const executed = await verticalKits.executeKitIntegration(member, {
      installationId,
      integrationKey: 'ledger-erp-sor',
      target: 'journal-2026-09-001',
      payload: {
        entryDate: '2026-09-26',
        periodName: '2026-09',
        memo: 'W092 acceptance walk',
        status: 'posted',
        lines: [
          { accountCode: '1100', debit: 1000, credit: 0 },
          { accountCode: '4000', debit: 0, credit: 1000 },
        ],
      },
      taskContext: { description: 'Post the opening acceptance journal entry' },
    });
    expect(executed.invocation.capabilityKey).toBe('write.journal-entries');
    expect(executed.receipt!.receiptStatus).toBe('accepted');
    expect(walked.edge.executeCalls).toHaveLength(1);

    // The read-only integration: reads work, writes are refused by the
    // DECLARATION (least privilege), before any gate call is needed.
    const aging = await verticalKits.inspectKitIntegration(member, {
      installationId,
      integrationKey: 'ar-aging-sor',
      target: 'inv-1001',
      taskContext: { description: 'Review the aging bucket for invoice 1001' },
    });
    expect(aging.invocation.capabilityKey).toBe('read.receivables-ledger');
    expect(aging.invocation.outcome).toBe('allowed');
    await expectCode('integration_read_only', () =>
      verticalKits.executeKitIntegration(member, {
        installationId,
        integrationKey: 'ar-aging-sor',
        target: 'inv-1001',
        payload: { remaining: 0 },
        taskContext: { description: 'Try to write through a read-only integration' },
      }),
    );

    // -- remove and verify clean state.
    const removed = await verticalKits.removeKit(admin, {
      installationId,
      reason: 'the finance team retired the starter kit',
    });
    expect(removed.installation.status).toBe('removed');
    expect(removed.grants.every((g) => g.status === 'revoked')).toBe(true);
    const postRemoval = await verticalKits.invokeKitCapability(member, {
      installationId,
      capabilityKey: 'read.ledger-accounts',
      taskContext: { description: 'Read the chart of accounts after removal' },
    });
    expect(postRemoval.outcome).toBe('denied');
    expect(postRemoval.basis).toBe('installation-inactive');
    // The audit and the executed action are retained.
    const events = await verticalKits.listKitEvents(member, { installationId });
    expect(events.filter((e) => e.event === 'grant-revoked')).toHaveLength(5);
    expect(events.map((e) => e.event)).toContain('removed');
    expect(await verticalKits.listKitEdgeActions(member, { installationId })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The policy matrix outcomes (per-tenant fresh state)
// ---------------------------------------------------------------------------

describe('the tenant policy decides the gate outcome at install', () => {
  const tenant = newId();

  it('a policy that AUTO-ALLOWS the kind mints the grants at install; one that FORBIDS refuses', async () => {
    const admin = memberOf(tenant, [
      'vertical-kits:administer',
      'actions:administer',
      'actions:approve',
    ]);
    const member = memberOf(tenant);

    await registerVerifiedKit(admin, LEGAL_CASE_MANAGEMENT_KIT);

    // Auto-allow: the request lands approved (a POLICY decision) and the
    // installation is granted immediately.
    await actionsContract.setAuthorityPolicy(admin, {
      actionKind: 'vertical-kit-deployment',
      approvalLevels: [],
      forbiddenLevels: [],
      note: 'auto-allow kits for this test tenant',
    });
    const autoAllowed = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.0.0',
      justification: 'auto-allowed install',
    });
    expect(autoAllowed.installation.status).toBe('granted');
    expect(autoAllowed.installation.reviewedAt).not.toBeNull();
    expect(autoAllowed.grants.map((g) => g.capabilityKey)).toEqual(
      [...LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.map((c) => c.key)].sort(),
    );
    const activated = await verticalKits.activateKit(admin, {
      installationId: autoAllowed.installation.id,
    });
    expect(activated.installation.status).toBe('active');
    const allowed = await verticalKits.invokeKitCapability(member, {
      installationId: autoAllowed.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Read under an auto-allowed policy' },
    });
    expect(allowed.outcome).toBe('allowed');
    await verticalKits.removeKit(admin, { installationId: autoAllowed.installation.id });

    // Forbid: the gate itself refuses the install — the verdict is
    // recorded on the installation, not swallowed.
    await actionsContract.setAuthorityPolicy(admin, {
      actionKind: 'vertical-kit-deployment',
      approvalLevels: [],
      forbiddenLevels: ['EXECUTE'],
      note: 'forbid kits for this test tenant',
    });
    const forbidden = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.0.0',
      justification: 'forbidden install',
    });
    expect(forbidden.installation.status).toBe('rejected');
    expect(forbidden.installation.reviewedAt).not.toBeNull();
    expect(forbidden.grants).toEqual([]);
    const refused = await verticalKits.invokeKitCapability(member, {
      installationId: forbidden.installation.id,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Read under a forbidden policy' },
    });
    expect(refused.outcome).toBe('denied');
    expect(refused.basis).toBe('installation-inactive');
    // Cleanup: drop the rejected installation (the tenant itself is
    // throwaway — a fresh tenant per describe block).
    await verticalKits.removeKit(admin, { installationId: forbidden.installation.id });
  });
});

// ---------------------------------------------------------------------------
// Versioning and the signed manifest
// ---------------------------------------------------------------------------

describe('versioned and signed: the registry discipline', () => {
  const tenant = newId();

  it('versions strictly increase per kit key; a changed manifest is a NEW version', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const first = await registerVerifiedKit(admin, LEGAL_CASE_MANAGEMENT_KIT);

    // Same version again → refused (also covers a changed manifest at
    // the same version: it can never overwrite the frozen row).
    await expectCode('version_not_monotonic', () =>
      verticalKits.registerKitVersion(admin, {
        manifest: { ...LEGAL_CASE_MANAGEMENT_KIT, displayName: 'Changed' },
      }),
    );
    // An older version → refused.
    await expectCode('version_not_monotonic', () =>
      verticalKits.registerKitVersion(admin, {
        manifest: { ...LEGAL_CASE_MANAGEMENT_KIT, version: '0.9.0' },
      }),
    );
    // A NEWER version registers (numeric order: 1.2.10 > 1.2.9).
    const newer = await verticalKits.registerKitVersion(admin, {
      manifest: {
        ...LEGAL_CASE_MANAGEMENT_KIT,
        version: '1.2.10',
        requiredCapabilities: [
          ...LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities,
          {
            key: 'read.trust-accounting',
            label: 'Read trust accounting records',
            dataCategories: ['trust-records'],
            mode: 'read',
          },
        ],
      },
    });
    expect(newer.version.version).toBe('1.2.10');
    expect(newer.version.manifest.requiredCapabilities).toHaveLength(6);
    expect(newer.version.manifestDigest).not.toBe(first.manifestDigest);

    // The version history is readable and ordered newest-first; the
    // derived verification state follows the latest run per version.
    const versions = await verticalKits.listKitVersions(admin, {
      kitKey: 'legal-case-management',
    });
    expect(versions.map((v) => v.version)).toEqual(['1.2.10', '1.0.0']);
    expect(versions[1]!.verificationState).toBe('verified');
    expect(versions[0]!.verificationState).toBe('unverified');

    // The newest version is installable on its own merits.
    const verified = await verticalKits.runKitVerification(admin, {
      kitVersionId: newer.version.id,
    });
    expect(verified.outcome).toBe('verified');
    const installed = await verticalKits.installKit(admin, {
      kitKey: 'legal-case-management',
      version: '1.2.10',
    });
    expect(installed.installation.kitVersion).toBe('1.2.10');
    expect(installed.requiredCapabilities).toHaveLength(6);
    await verticalKits.removeKit(admin, { installationId: installed.installation.id });
  });

  it('a row edited outside the service fails re-verification (the signed manifest)', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const registered = await registerVerifiedKit(admin, ACCOUNTING_LEDGER_ERP_KIT);

    // Tamper with the STORED MANIFEST directly (bypassing the service —
    // the versions table is workflow state, not an append-only ledger):
    // the recorded digest no longer matches the stored content.
    const db = getDb();
    await db.query(
      `UPDATE vertical_kit_versions
         SET manifest = manifest || '{"displayName": "Tampered Ledger Kit"}'::jsonb
         WHERE tenant_id = $1 AND id = $2`,
      [tenant, registered.id],
    );

    const run = await verticalKits.runKitVerification(admin, {
      kitVersionId: registered.id,
    });
    expect(run.outcome).toBe('failed');
    const integrity = run.checks.find((c) => c.check === 'manifest-integrity')!;
    expect(integrity.passed).toBe(false);
    expect(integrity.detail).toContain('modified outside the service');

    // The derived state follows: unverified installs are refused (the
    // tampered version cannot be installed while FAILED).
    await expectCode('kit_not_verified', () =>
      verticalKits.installKit(admin, {
        kitKey: 'accounting-ledger-erp',
        version: '1.0.0',
      }),
    );
    // Restore the row (test hygiene) and verify it is healthy again.
    await db.query(
      `UPDATE vertical_kit_versions
         SET manifest = $3
         WHERE tenant_id = $1 AND id = $2`,
      [tenant, registered.id, JSON.stringify(ACCOUNTING_LEDGER_ERP_KIT)],
    );
    const restored = await verticalKits.runKitVerification(admin, {
      kitVersionId: registered.id,
    });
    expect(restored.outcome).toBe('verified');
  });

  it('a malformed manifest never registers (verification folded into registration)', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    await expectCode('kit_verification_failed', () =>
      verticalKits.registerKitVersion(admin, {
        manifest: {
          ...LEGAL_CASE_MANAGEMENT_KIT,
          kitKey: 'malformed-kit',
          requiredCapabilities: [
            { key: 'fly.matter', label: 'not a read/write key', dataCategories: [], mode: 'read' },
          ],
        },
      }),
    );
    const versions = await verticalKits.listKitVersions(admin, { kitKey: 'malformed-kit' });
    expect(versions).toEqual([]);
  });

  it('an unverified version never installs; administration is claim-gated', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const member = memberOf(tenant);
    await verticalKits.registerKitVersion(admin, {
      manifest: { ...LEGAL_CASE_MANAGEMENT_KIT, version: '2.0.0' },
    });
    await expectCode('kit_not_verified', () =>
      verticalKits.installKit(admin, { kitKey: 'legal-case-management', version: '2.0.0' }),
    );
    // A plain member holds no administration claim.
    await expectCode('forbidden', () =>
      verticalKits.registerKitVersion(member, { manifest: LEGAL_CASE_MANAGEMENT_KIT }),
    );
    await expectCode('forbidden', () =>
      verticalKits.installKit(member, { kitKey: 'legal-case-management', version: '2.0.0' }),
    );
  });
});

// ---------------------------------------------------------------------------
// The edge seam (DEFERRED-ON-W088)
// ---------------------------------------------------------------------------

describe('the DEFERRED-ON-W088 edge seam', () => {
  const tenant = newId();

  it('provider objects never cross the kit runtime', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const member = memberOf(tenant);
    const walked = await walkFullLifecycle(tenant, LEGAL_CASE_MANAGEMENT_KIT);
    const installationId = walked.installation.installation.id;

    // A wired edge that returns a PROVIDER object is rejected loudly.
    class ProviderReceipt {
      status = 'accepted';
      receiptId = 'provider-1';
    }
    verticalKits.setVerticalKitEdge({
      edgeId: 'provider-leaky-edge',
      inspect: async () => ({ found: true, state: new ProviderReceipt() }),
      execute: async () => new ProviderReceipt() as unknown as verticalKits.VerticalKitEdgeReceipt,
    });
    await expectCode('invalid_edge_result', () =>
      verticalKits.inspectKitIntegration(member, {
        installationId,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        taskContext: { description: 'Inspect through a leaky edge' },
      }),
    );
    await expectCode('invalid_edge_result', () =>
      verticalKits.executeKitIntegration(member, {
        installationId,
        integrationKey: 'case-management-sor',
        target: 'matter-001',
        payload: { status: 'closed' },
        taskContext: { description: 'Write through a leaky edge' },
      }),
    );
    // Nothing was recorded from the refused results.
    expect(await verticalKits.listKitEdgeActions(member, { installationId })).toHaveLength(0);

    // An unknown integration is a caller mistake, not a gate matter.
    await expectCode('integration_not_found', () =>
      verticalKits.inspectKitIntegration(member, {
        installationId,
        integrationKey: 'no-such-sor',
        target: 'x',
        taskContext: { description: 'Unknown integration' },
      }),
    );

    await verticalKits.removeKit(admin, { installationId });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (the deep two-tenant proof lives in the W044 sweep;
// this is the module suite's own quick check)
// ---------------------------------------------------------------------------

describe('tenant isolation (module suite)', () => {
  const tenantA = newId();
  const tenantB = newId();

  it("one tenant's kits, installations and ledgers are invisible to the other", async () => {
    const adminA = memberOf(tenantA, ['vertical-kits:administer']);
    const adminB = memberOf(tenantB, ['vertical-kits:administer']);
    const walked = await walkFullLifecycle(tenantA, LEGAL_CASE_MANAGEMENT_KIT);
    const installationId = walked.installation.installation.id;

    // Tenant B registered nothing: its registry is empty.
    expect(await verticalKits.listKitVersions(adminB, {})).toEqual([]);
    expect(await verticalKits.listKitInstallations(adminB, {})).toEqual([]);

    // B's cross-tenant reads are uniformly not-found — no existence leak.
    await expectCode('installation_not_found', () =>
      verticalKits.getKitInstallation(adminB, { installationId }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.decideKitReview(adminB, { installationId, decision: 'approve' }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.activateKit(adminB, { installationId }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.removeKit(adminB, { installationId }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.invokeKitCapability(adminB, {
        installationId,
        capabilityKey: 'read.case-matters',
        taskContext: { description: 'Cross-tenant invocation' },
      }),
    );
    await expectCode('installation_not_found', () =>
      verticalKits.listKitEvents(adminB, { installationId }),
    );

    // B can register the SAME kit key independently (its own registry).
    const bVersion = await registerVerifiedKit(adminB, LEGAL_CASE_MANAGEMENT_KIT);
    expect(bVersion.id).not.toBe(walked.installation.installation.kitVersionId);
    await verticalKits.removeKit(adminA, { installationId });
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only ledgers)
// ---------------------------------------------------------------------------

describe('storage discipline — the ledgers are append-only', () => {
  const tenant = newId();

  it('UPDATE, DELETE and TRUNCATE are refused on the audit ledgers', async () => {
    const admin = memberOf(tenant, ['vertical-kits:administer']);
    const member = memberOf(tenant);
    const walked = await walkFullLifecycle(tenant, ACCOUNTING_LEDGER_ERP_KIT);
    const installationId = walked.installation.installation.id;

    // Produce one invocation and one edge action so every ledger has a
    // row to protect.
    const invocation = await verticalKits.invokeKitCapability(member, {
      installationId,
      capabilityKey: 'read.ledger-accounts',
      taskContext: { description: 'Read the chart of accounts for the audit' },
    });
    expect(invocation.outcome).toBe('allowed');
    const executed = await verticalKits.executeKitIntegration(member, {
      installationId,
      integrationKey: 'ledger-erp-sor',
      target: 'journal-audit-001',
      payload: { memo: 'audit probe' },
      taskContext: { description: 'Post the audit probe entry' },
    });
    expect(executed.receipt!.receiptStatus).toBe('accepted');

    const db = getDb();

    const event = (
      await db.query<{ id: string }>(
        `SELECT id FROM vertical_kit_events WHERE tenant_id = $1 LIMIT 1`,
        [tenant],
      )
    ).rows[0]!;
    await expect(
      db.query(`UPDATE vertical_kit_events SET detail = 'rewritten' WHERE id = $1`, [event.id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM vertical_kit_events WHERE id = $1`, [event.id])).rejects.toThrow(
      /append-only/,
    );

    const invocationRow = (
      await db.query<{ id: string }>(
        `SELECT id FROM vertical_kit_invocations WHERE tenant_id = $1 LIMIT 1`,
        [tenant],
      )
    ).rows[0]!;
    await expect(
      db.query(`UPDATE vertical_kit_invocations SET outcome = 'allowed' WHERE id = $1`, [invocationRow.id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM vertical_kit_invocations WHERE id = $1`, [invocationRow.id]),
    ).rejects.toThrow(/append-only/);

    const version = (
      await db.query<{ id: string }>(
        `SELECT id FROM vertical_kit_versions WHERE tenant_id = $1 LIMIT 1`,
        [tenant],
      )
    ).rows[0]!;
    const verificationId = (
      await db.query<{ id: string }>(
        `SELECT id FROM vertical_kit_verifications WHERE tenant_id = $1 AND kit_version_id = $2 LIMIT 1`,
        [tenant, version.id],
      )
    ).rows[0]!.id;
    await expect(
      db.query(`UPDATE vertical_kit_verifications SET outcome = 'verified' WHERE id = $1`, [
        verificationId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`DELETE FROM vertical_kit_verifications WHERE id = $1`, [verificationId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      db.query(`TRUNCATE vertical_kit_events`),
    ).rejects.toThrow(/append-only/);

    await verticalKits.removeKit(admin, { installationId });
  });
});
