// W068 — the demo harness's INTEGRATION tests (embedded PostgreSQL via the
// db port, PGlite `:memory:` — the module's acceptance surface).
//
// Covered:
//   * the guard at the seed boundary (server database / missing opt-in
//     refuse before anything is created);
//   * the full deterministic seed: accounts, companies, memberships and
//     every major journey's anchors (A–L), all through the module
//     contracts the product surfaces read;
//   * the no-backdoor property: the demo accounts authenticate through
//     the NORMAL auth path with exactly the claims their verified roles
//     derive — nothing else;
//   * role-specific capability visibility being REAL: the employee
//     session cannot decide approvals; the platform review claim does
//     not ride any session (the pipeline context is the only way);
//   * tenant isolation: a foreign tenant sees nothing of the demo data;
//   * idempotent re-seeding: the second run reuses every anchor (the
//     same manifest ids, no duplicates).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
process.env.AURUM_DEMO_SEED = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import {
  authenticateSession,
  claimsForRole,
  signIn,
  AuthError,
} from '@/modules/auth/contract';
import { getGoal, listGoals } from '@/modules/goals/contract';
import { getMission } from '@/modules/missions/contract';
import { listActionRequests } from '@/modules/actions/contract';
import { decideApproval } from '@/modules/actions/contract';
import { ActionsError } from '@/modules/actions/contract';
import { getNotification, listNotifications } from '@/modules/notifications/contract';
import { listMessages } from '@/modules/conversations/contract';
import { listObservations } from '@/modules/observations/contract';
import { listProcessFindings } from '@/modules/processes/contract';
import { listContributions } from '@/modules/contributions/contract';
import { listRewards } from '@/modules/rewards/contract';
import { getPackage, listReviewQueue, MarketplaceError } from '@/modules/marketplace/contract';
import { getExtension } from '@/modules/extensions/contract';
import { listAiProviderAccounts } from '@/modules/llm/contract';
import { listAgents } from '@/modules/agents/contract';
import { listApiKeys, listWebhookSubscriptions } from '@/modules/api/contract';
import { listInvites } from '@/modules/auth/contract';
import { listWorkspaces } from '@/modules/organizations/contract';
import {
  DemoError,
  demoSharedPassword,
  seedDemoHarness,
  type DemoManifest,
  type DemoSeedReport,
} from '../contract';

// ---------------------------------------------------------------------------
// The seeded state (one seed run, asserted by the focused its below)
// ---------------------------------------------------------------------------

let first: DemoSeedReport;

const managerCtxOf = (manifest: DemoManifest): TenantContext => ({
  tenantId: manifest.companies.company.tenantId,
  principalId: manifest.accounts.manager.principalId,
  // exactly the claims the manager's verified owner session derives
  authority: [...claimsForRole('owner')],
});
const employeeCtxOf = (manifest: DemoManifest): TenantContext => ({
  tenantId: manifest.companies.company.tenantId,
  principalId: manifest.accounts.employee.principalId,
  authority: [...claimsForRole('member')],
});

beforeAll(async () => {
  await runMigrations(getDb());
  first = await seedDemoHarness();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The guard at the seed boundary
// ---------------------------------------------------------------------------

describe('the guard (no production backdoor)', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const originalOptIn = process.env.AURUM_DEMO_SEED;

  async function withEnv(
    env: { databaseUrl?: string; optIn?: string },
    fn: () => Promise<void>,
  ): Promise<unknown> {
    if (env.databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = env.databaseUrl;
    if (env.optIn === undefined) delete process.env.AURUM_DEMO_SEED;
    else process.env.AURUM_DEMO_SEED = env.optIn;
    try {
      return await fn();
    } finally {
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
      if (originalOptIn === undefined) delete process.env.AURUM_DEMO_SEED;
      else process.env.AURUM_DEMO_SEED = originalOptIn;
    }
  }

  it('refuses to seed a server database (DATABASE_URL set)', async () => {
    await withEnv({ databaseUrl: 'postgres://user:pass@db.example.com:5432/prod', optIn: '1' }, async () => {
      await expect(seedDemoHarness()).rejects.toMatchObject({
        code: 'production_backdoor',
      } satisfies Partial<DemoError>);
    });
  });

  it('refuses to seed without the explicit opt-in', async () => {
    await withEnv({ optIn: undefined }, async () => {
      await expect(seedDemoHarness()).rejects.toMatchObject({
        code: 'production_backdoor',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The accounts and the companies
// ---------------------------------------------------------------------------

describe('the seeded tenants and roles', () => {
  it('created the dataset on the first run', () => {
    expect(first.status).toBe('created');
    expect(first.createdAnchors.length).toBeGreaterThan(0);
  });

  it('bound the four roles to three deterministic demo companies', () => {
    const { accounts, companies } = first.manifest;
    expect(accounts.manager.email).toBe('manager@meridian-demo.example');
    expect(accounts.employee.email).toBe('employee@meridian-demo.example');
    expect(accounts.developer.email).toBe('developer@cobalt-demo.example');
    expect(accounts['platform-reviewer'].email).toBe('reviewer@platform-demo.example');
    expect(accounts.manager.tenantName).toBe('Meridian Freight (Demo)');
    expect(accounts.employee.tenantId).toBe(accounts.manager.tenantId);
    expect(accounts.developer.tenantName).toBe('Cobalt Labs (Demo)');
    expect(accounts['platform-reviewer'].tenantName).toBe('Aurum Platform (Demo)');
    expect(companies.company.tenantId).toBe(accounts.manager.tenantId);
    expect(companies.vendor.tenantId).toBe(accounts.developer.tenantId);
    expect(companies.platform.tenantId).toBe(accounts['platform-reviewer'].tenantId);
  });

  it('gave the accounts their verified tenant roles', async () => {
    const { accounts } = first.manifest;
    for (const [role, expected] of [
      ['manager', 'owner'],
      ['employee', 'member'],
      ['developer', 'owner'],
      ['platform-reviewer', 'admin'],
    ] as const) {
      const signedIn = await signIn({ email: accounts[role].email, password: demoSharedPassword() });
      expect(signedIn.session.company?.role).toBe(expected);
      expect(signedIn.session.company?.tenantId).toBe(accounts[role].tenantId);
    }
  });

  it('authenticates through the NORMAL session path with exactly the derived claims', async () => {
    const { accounts } = first.manifest;

    // Manager: the management claim set rides the session.
    const manager = await signIn({ email: accounts.manager.email, password: demoSharedPassword() });
    const managerSession = await authenticateSession({ token: manager.token });
    expect(managerSession.company?.authority).toContain('actions:approve');
    expect(managerSession.company?.authority).toContain('extensions:administer');
    expect(managerSession.company?.authority).toContain('api:administer');

    // Employee: a plain member carries NO claims — nothing else.
    const employee = await signIn({ email: accounts.employee.email, password: demoSharedPassword() });
    const employeeSession = await authenticateSession({ token: employee.token });
    expect(employeeSession.company?.authority).toEqual([]);
    expect(employeeSession.company?.role).toBe('member');

    // A wrong password is just invalid_credentials (no special-casing).
    await expect(
      signIn({ email: accounts.employee.email, password: 'not-the-demo-password' }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('created the second workspace and the pending invite (Journey A)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const workspaces = await listWorkspaces(ctx);
    expect(workspaces.map((workspace) => workspace.name)).toContain('Returns Taskforce');
    const invites = await listInvites(ctx, {});
    expect(invites.some((invite) => invite.email === 'new-hire@meridian-demo.example')).toBe(true);
    expect(manifest.invite?.email).toBe('new-hire@meridian-demo.example');
  });
});

// ---------------------------------------------------------------------------
// The journey anchors
// ---------------------------------------------------------------------------

describe('the deterministic journey data', () => {
  it('seeded the intelligence chain (goals → claim → belief → unknown → mission — Journeys C/D)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);

    expect(manifest.goals).toHaveLength(3);
    const goals = await listGoals(ctx, { limit: 100 });
    expect(goals.some((goal) => goal.content.title === 'Keep the returns cycle under three days')).toBe(true);

    expect(manifest.unknown?.question).toContain('customs-broker document set');
    expect(manifest.unknown?.status).toBe('open');
    expect(manifest.belief?.proposition).toContain('bottleneck');
    expect(manifest.belief?.status).toBe('active');
    expect(manifest.claim?.proposition).toContain('RET-2001');

    const mission = await getMission(ctx, manifest.mission!.id);
    expect(mission.content.title).toBe('Close the customs-documentation gap in the returns cycle');
    expect(mission.content.status).toBe('active');
    expect(mission.content.affectedGoals[0]?.goalId).toBe(manifest.goals[0]?.id);
  });

  it('seeded the evidence observations and the reconstructed process (Journey D)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const observations = await listObservations(ctx, { kind: 'returns.stage', limit: 100 });
    expect(observations.length).toBeGreaterThanOrEqual(6);
    const findings = await listProcessFindings(ctx, { processId: manifest.process!.id, limit: 100 });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(manifest.process?.name).toBe('Returns processing');
  });

  it('seeded the conversation with person-attributed channel turns (Journey B)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    expect(manifest.conversation).not.toBeNull();
    const messages = await listMessages(ctx, { conversationId: manifest.conversation!.id, limit: 100 });
    expect(messages.length).toBeGreaterThanOrEqual(5);
    const inbound = messages.filter((message) => message.direction === 'inbound');
    expect(inbound.length).toBe(3);
    // Every inbound turn attributes to the linked person, never to a
    // pseudo-employee (lock 15).
    for (const turn of inbound) {
      expect(turn.actor.kind).toBe('person');
    }
  });

  it('seeded the pending human gate and its notification (Journey E)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const pending = await listActionRequests(ctx, { status: 'pending', limit: 100 });
    const kinds = pending.map((request) => request.actionKind);
    expect(kinds).toContain('employee-messaging');
    expect(kinds).toContain('agent-recruitment');
    expect(pending.some((request) => request.id === manifest.pendingApprovals[0]?.id)).toBe(true);

    const notifications = await listNotifications(ctx, { limit: 100 });
    const seeded = notifications.find((notification) => notification.subject.includes('customs question'));
    expect(seeded).toBeDefined();
    expect(seeded!.status).toBe('delivered');
    const read = await getNotification(ctx, { notificationId: seeded!.id });
    expect(read.recipient.providerAccountId).toBe('+15550102640');
  });

  it('seeded the employee contribution, its measured impact and the GRANTED reward (Journey F)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const contributions = await listContributions(ctx, { missionId: manifest.mission!.id, limit: 10 });
    expect(contributions).toHaveLength(1);
    expect(contributions[0]!.status).toBe('measured');
    expect(contributions[0]!.summary).toContain('packing list');

    const rewards = await listRewards(ctx, { missionId: manifest.mission!.id, limit: 10 });
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.status).toBe('granted');
    // Non-compensation semantics only (lock: no salary/performance).
    expect(['recognition', 'gift', 'voucher', 'experience', 'donation']).toContain(rewards[0]!.tier.kind);
    expect(manifest.reward?.status).toBe('granted');
  });

  it('seeded the connections (channel + source + destination — Journey G)', async () => {
    const manifest = first.manifest;
    expect(manifest.channelConnections[0]?.provider).toBe('whatsapp');
    expect(manifest.sources.some((source) => source.provider === 'stripe')).toBe(true);
    expect(manifest.destinations.some((destination) => destination.provider === 'webhook')).toBe(true);
  });

  it('seeded the BYOA account and one completed execution (Journey H)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const accounts = await listAiProviderAccounts(ctx, { provider: 'openai', limit: 10 });
    expect(accounts.some((account) => account.label === 'Demo OpenAI account')).toBe(true);
    expect(manifest.llmExecution?.status).toBe('completed');
  });

  it('seeded the agent, its succeeded execution, the capability gap and the recruitment proposal (Journey I)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const agents = await listAgents(ctx, { limit: 100 });
    expect(agents.some((agent) => agent.slug === 'returns-triage')).toBe(true);
    expect(manifest.agentExecution?.status).toBe('succeeded');
    expect(manifest.capability?.name).toBe('Customs documentation handling');
    expect(manifest.recruitmentProposal?.status).toBeDefined();
  });

  it('seeded the marketplace pipeline: installable + pending-review + installed (Journey J)', async () => {
    const manifest = first.manifest;
    const { marketplace } = manifest;

    // v1 through the full governed chain.
    expect(marketplace.installableExtension?.state).toBe('INSTALLABLE');
    expect(marketplace.installableExtension?.packageKey).toBe('returns-doc-classifier');
    // v2 parked in the platform review queue.
    expect(marketplace.pendingReview?.state).toBe('PENDING_REVIEW');
    // The agent package is installable too.
    expect(marketplace.installableAgent?.state).toBe('INSTALLABLE');
    expect(marketplace.installableAgent?.packageKey).toBe('returns-negotiator');

    // The vendor sees its packages on its own tenant.
    const vendorCtx: TenantContext = {
      tenantId: manifest.companies.vendor.tenantId,
      principalId: manifest.accounts.developer.principalId,
      authority: [],
    };
    const v1 = await getPackage(vendorCtx, { packageId: marketplace.installableExtension!.id });
    expect(v1.state).toBe('INSTALLABLE');
    const v2 = await getPackage(vendorCtx, { packageId: marketplace.pendingReview!.id });
    expect(v2.state).toBe('PENDING_REVIEW');

    // The demo company installed both packages.
    const companyCtx = managerCtxOf(manifest);
    const extension = await getExtension(companyCtx, { extensionKey: marketplace.installedExtensionKey! });
    expect(extension.lifecycleState).toBe('ACTIVE');
    const agents = await listAgents(companyCtx, { limit: 100 });
    expect(agents.some((agent) => agent.slug === marketplace.installedAgentSlug)).toBe(true);
  });

  it('seeded the audit trail of the consequential decision (Journey K)', () => {
    expect(first.manifest.auditRecords.length).toBeGreaterThanOrEqual(1);
    for (const record of first.manifest.auditRecords) {
      expect(record.chainStage).toBe('approval');
    }
  });

  it('seeded the developer integration (API key + webhook — Journey L)', async () => {
    const manifest = first.manifest;
    const ctx = managerCtxOf(manifest);
    const keys = await listApiKeys(ctx);
    expect(keys.some((key) => key.label === 'Demo warehouse integration')).toBe(true);
    const webhooks = await listWebhookSubscriptions(ctx);
    expect(webhooks.some((webhook) => webhook.label === 'Demo warehouse events')).toBe(true);
    expect(manifest.apiKey?.label).toBe('Demo warehouse integration');
    expect(manifest.webhook?.url).toBe('https://demo.meridian.example/hooks/aurum-events');
  });
});

// ---------------------------------------------------------------------------
// Role-specific capability visibility (the real authority behavior)
// ---------------------------------------------------------------------------

describe('role-specific capability visibility is real (not just the model)', () => {
  it('an employee session cannot decide the pending approval', async () => {
    const manifest = first.manifest;
    const pending = manifest.pendingApprovals.find(
      (request) => request.actionKind === 'employee-messaging',
    )!;
    await expect(
      decideApproval(employeeCtxOf(manifest), {
        requestId: pending.id,
        decision: 'approve',
        note: 'the employee must not be able to decide this',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' } satisfies Partial<ActionsError>);
    // ...and the request is still pending afterwards.
    const requests = await listActionRequests(managerCtxOf(manifest), { limit: 200 });
    expect(requests.find((request) => request.id === pending.id)?.status).toBe('pending');
  });

  it('the platform review claim does not ride any session (only the pipeline reaches it)', async () => {
    const manifest = first.manifest;
    const pendingId = manifest.marketplace.pendingReview!.id;

    // The reviewer's own SESSION context (admin of the platform company,
    // claims derived exactly as sessions derive them — no platform claim)
    // is refused by the marketplace contract.
    const reviewerSessionCtx: TenantContext = {
      tenantId: manifest.companies.platform.tenantId,
      principalId: manifest.accounts['platform-reviewer'].principalId,
      authority: [], // a member/admin session never carries marketplace:administer
    };
    await expect(
      reviewPackageWith(reviewerSessionCtx, pendingId),
    ).rejects.toMatchObject({ code: 'forbidden' } satisfies Partial<MarketplaceError>);

    // The explicit platform pipeline context (the documented harness seam)
    // DOES see the deterministic pending-review item in its queue.
    const pipelineCtx: TenantContext = {
      tenantId: manifest.companies.platform.tenantId,
      principalId: manifest.accounts['platform-reviewer'].principalId,
      authority: ['marketplace:administer'],
    };
    const queue = await listReviewQueue(pipelineCtx, { limit: 50 });
    expect(queue.some((pkg) => pkg.id === pendingId)).toBe(true);
  });
});

async function reviewPackageWith(ctx: TenantContext, packageId: string): Promise<unknown> {
  // reviewPackage is imported lazily to keep the file's import list tight.
  const { reviewPackage } = await import('@/modules/marketplace/contract');
  return reviewPackage(ctx, { packageId, decision: 'approve', reason: 'should be refused' });
}

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation of the demo dataset', () => {
  const foreignCtx: TenantContext = { tenantId: newId(), principalId: newId(), authority: [] };

  it('shows a foreign tenant nothing (no existence leak)', async () => {
    const manifest = first.manifest;
    expect(await listGoals(foreignCtx, { limit: 100 })).toEqual([]);
    await expect(getGoal(foreignCtx, manifest.goals[0]!.id)).rejects.toMatchObject({
      code: 'goal_not_found',
    });
    expect(await listActionRequests(foreignCtx, { limit: 100 })).toEqual([]);
    expect(await listNotifications(foreignCtx, { limit: 100 })).toEqual([]);
    expect(await listContributions(foreignCtx, { missionId: manifest.mission!.id, limit: 10 })).toEqual([]);
    expect(await listRewards(foreignCtx, { missionId: manifest.mission!.id, limit: 10 })).toEqual([]);
    expect(await listMessages(foreignCtx, { conversationId: manifest.conversation!.id, limit: 10 })).toEqual([]);
    await expect(
      getPackage(foreignCtx, { packageId: manifest.marketplace.pendingReview!.id }),
    ).rejects.toMatchObject({ code: 'package_not_found' });
  });
});

// ---------------------------------------------------------------------------
// Determinism / idempotency
// ---------------------------------------------------------------------------

describe('the idempotent re-seed', () => {
  let second: DemoSeedReport;

  beforeAll(async () => {
    second = await seedDemoHarness();
  });

  it('reports the dataset as already present', () => {
    expect(second.status).toBe('present');
    expect(second.createdAnchors).toEqual([]);
    expect(second.reusedAnchors.length).toBeGreaterThan(0);
  });

  it('returns the SAME manifest ids (deterministic anchors, not duplicates)', () => {
    const a = first.manifest;
    const b = second.manifest;
    expect(b.goals.map((goal) => goal.id)).toEqual(a.goals.map((goal) => goal.id));
    expect(b.mission?.id).toBe(a.mission?.id);
    expect(b.conversation?.id).toBe(a.conversation?.id);
    expect(b.contribution?.id).toBe(a.contribution?.id);
    expect(b.reward?.id).toBe(a.reward?.id);
    expect(b.marketplace.installableExtension?.id).toBe(a.marketplace.installableExtension?.id);
    expect(b.marketplace.pendingReview?.id).toBe(a.marketplace.pendingReview?.id);
    expect(b.apiKey?.id).toBe(a.apiKey?.id);
    expect(b.webhook?.id).toBe(a.webhook?.id);
    expect(b.accounts.manager.principalId).toBe(a.accounts.manager.principalId);
    expect(b.companies.company.tenantId).toBe(a.companies.company.tenantId);
  });

  it('duplicated nothing (counts unchanged)', async () => {
    const manifest = second.manifest;
    const ctx = managerCtxOf(manifest);
    const goals = await listGoals(ctx, { limit: 100 });
    expect(goals.filter((goal) => goal.content.title.startsWith('Keep the returns cycle'))).toHaveLength(1);
    const contributions = await listContributions(ctx, { missionId: manifest.mission!.id, limit: 10 });
    expect(contributions).toHaveLength(1);
    const rewards = await listRewards(ctx, { missionId: manifest.mission!.id, limit: 10 });
    expect(rewards).toHaveLength(1);
    const messages = await listMessages(ctx, { conversationId: manifest.conversation!.id, limit: 100 });
    expect(messages.length).toBe(first.manifest.conversation?.messageCount);
    const observations = await listObservations(ctx, { kind: 'returns.stage', limit: 100 });
    expect(observations).toHaveLength(6);
    const keys = await listApiKeys(ctx);
    expect(keys.filter((key) => key.label === 'Demo warehouse integration')).toHaveLength(1);
    const pending = await listActionRequests(ctx, { status: 'pending', limit: 100 });
    expect(pending.filter((request) => request.actionKind === 'employee-messaging')).toHaveLength(1);
  });
});
