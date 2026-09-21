// Integration tests of the demo roles' capability visibility (W068
// acceptance: "role-specific capability visibility") against the embedded
// PostgreSQL (PGlite, `:memory:`).
//
// The matrix (roles.ts) is verified against REALITY, not against itself:
// every persona signs in through the real auth flow with the assembled
// demo password, the session's derived role and authority claims are
// checked against the interim mapping (claimsForRole), and the
// claim-gated operations are exercised through the owning contracts —
// the employee is refused, the manager approves, the developer publishes,
// and the platform reviewer's session honestly lacks the platform claim
// that only the harness context carries at this base.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { seedDemoHarness } from '../seed';
import { demoPersonaPassword, demoPersonaSpec } from '../manifest';
import { DEMO_CAPABILITIES, capabilityVisibilityForRole } from '../roles';
import type { DemoSeedReport } from '../types';
import {
  authenticateSession,
  claimsForRole,
  MANAGEMENT_CLAIMS,
  signIn,
} from '@/modules/auth/contract';
import { ActionsError, decideApproval } from '@/modules/actions/contract';
import { MarketplaceError, createPackage, listReviewQueue } from '@/modules/marketplace/contract';
import { ApiError, createApiKey } from '@/modules/api/contract';
import { listGoals } from '@/modules/goals/contract';
import { getActionRequest } from '@/modules/actions/contract';
import { LlmError, registerAiProviderAccount } from '@/modules/llm/contract';

let report: DemoSeedReport;

interface PersonaSession {
  token: string;
  principalId: string;
  tenantId: string;
  role: string;
  authority: string[];
}

async function signInPersona(role: DemoSeedReport['personas'][number]['role']): Promise<PersonaSession> {
  const spec = demoPersonaSpec(role);
  const issued = await signIn({ email: spec.email, password: demoPersonaPassword() });
  expect(issued.session.company).not.toBeNull();
  return {
    token: issued.token,
    principalId: issued.session.principalId,
    tenantId: issued.session.company!.tenantId,
    role: issued.session.company!.role,
    authority: issued.session.company!.authority,
  };
}

function ctx(session: PersonaSession, authority: string[] = session.authority): TenantContext {
  return { tenantId: session.tenantId, principalId: session.principalId, authority };
}

beforeAll(async () => {
  await runMigrations(getDb());
  report = await seedDemoHarness();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// Sign-in: each persona lands in its company with the real derived claims
// ---------------------------------------------------------------------------

describe('persona sign-in (the real auth flow)', () => {
  it('the manager is the company owner with the management claim set', async () => {
    const manager = await signInPersona('manager');
    const company = report.tenants.find((tenant) => tenant.key === 'company')!;
    expect(manager.tenantId).toBe(company.id);
    expect(manager.role).toBe('owner');
    expect(manager.authority).toEqual(claimsForRole('owner'));
    expect(manager.authority).toContain('actions:approve');
  });

  it('the employee is a plain member with no management claims', async () => {
    const employee = await signInPersona('employee');
    const company = report.tenants.find((tenant) => tenant.key === 'company')!;
    expect(employee.tenantId).toBe(company.id);
    expect(employee.role).toBe('member');
    expect(employee.authority).toEqual([]);
  });

  it('the developer is an admin with the develop/publish and API claims', async () => {
    const developer = await signInPersona('developer');
    expect(developer.role).toBe('admin');
    expect(developer.authority).toEqual(claimsForRole('admin'));
    expect(developer.authority).toContain('marketplace:submit');
    expect(developer.authority).toContain('extensions:administer');
    expect(developer.authority).toContain('api:administer');
  });

  it('the platform reviewer sits in the platform review tenant — without the platform claim', async () => {
    const reviewer = await signInPersona('platform-reviewer');
    const platform = report.tenants.find((tenant) => tenant.key === 'platform')!;
    expect(reviewer.tenantId).toBe(platform.id);
    expect(reviewer.role).toBe('admin');
    // The interim model (W058): platform claims never ride a tenant
    // session — the harness context carries them while seeding only.
    expect(reviewer.authority).not.toContain('marketplace:administer');
    expect(reviewer.authority).toEqual([...MANAGEMENT_CLAIMS]);
  });

  it('session authentication re-derives the same scope (renewal-safe)', async () => {
    const manager = await signInPersona('manager');
    const again = await authenticateSession({ token: manager.token });
    expect(again.company?.role).toBe('owner');
    expect(again.company?.authority).toEqual(claimsForRole('owner'));
  });
});

// ---------------------------------------------------------------------------
// The capability matrix vs the sessions' real authority
// ---------------------------------------------------------------------------

describe('capability visibility matches the sessions (the matrix vs reality)', () => {
  it('every tenant-role capability the manager/developer see is really in their session claims', async () => {
    const manager = await signInPersona('manager');
    const developer = await signInPersona('developer');
    for (const capability of DEMO_CAPABILITIES) {
      if (capability.claimSource !== 'tenant-role') continue;
      for (const claim of capability.requiredClaims) {
        expect(manager.authority).toContain(claim);
        expect(developer.authority).toContain(claim);
      }
    }
  });

  it('the employee sees no capability their session could not exercise', async () => {
    const employee = await signInPersona('employee');
    for (const capability of capabilityVisibilityForRole('employee')) {
      expect(capability.claimSource).toBe('open');
    }
    expect(employee.authority).toEqual([]);
  });

  it('harness-only capabilities are invisible to every session role', async () => {
    const manager = await signInPersona('manager');
    const reviewer = await signInPersona('platform-reviewer');
    for (const capability of DEMO_CAPABILITIES.filter((entry) => entry.claimSource === 'harness-only')) {
      for (const claim of capability.requiredClaims) {
        expect(manager.authority).not.toContain(claim);
        expect(reviewer.authority).not.toContain(claim);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The claim-gated operations (the enforcement, not the description)
// ---------------------------------------------------------------------------

describe('claim-gated operations per role', () => {
  it('the employee cannot decide the pending approval (no actions:approve)', async () => {
    const employee = await signInPersona('employee');
    const pending = report.pendingApprovals.find((approval) => approval.actionKind === 'employee-messaging')!;
    await expect(
      decideApproval(ctx(employee), { requestId: pending.requestId, decision: 'approve' }),
    ).rejects.toBeInstanceOf(ActionsError);
  });

  it('the employee cannot submit a marketplace package (no marketplace:submit)', async () => {
    const employee = await signInPersona('employee');
    const developerPackageId = report.journeys
      .find((journey) => journey.id === 'marketplace')!
      .anchors.find((entry) => entry.anchorKey === 'developer-package')!.recordId;
    await expect(
      createPackage(ctx(employee), { kind: 'extension', manifestId: developerPackageId }),
    ).rejects.toBeInstanceOf(MarketplaceError);
  });

  it('the employee cannot create an API key (no api:administer)', async () => {
    const employee = await signInPersona('employee');
    await expect(
      createApiKey(ctx(employee), { label: 'should-not-exist', scopes: ['goals:read'] }),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('the manager session configures AI provider accounts (W066: llm:administer rides the session); the employee cannot', async () => {
    const manager = await signInPersona('manager');
    expect(manager.authority).toContain('llm:administer');
    const registered = await registerAiProviderAccount(ctx(manager), {
      provider: 'mistral',
      label: 'Meridian Mistral (session demo)',
      credentialRef: 'secret-store://demo/mistral-meridian-session',
      scopes: ['analysis'],
      capabilities: ['text-generation'],
      maxDataClassification: 'internal',
      priority: 2,
    });
    expect(registered.created).toBe(true);

    const employee = await signInPersona('employee');
    await expect(
      registerAiProviderAccount(ctx(employee), {
        provider: 'groq',
        label: 'should-not-exist',
        credentialRef: 'secret-store://demo/groq-session-refused',
        scopes: ['analysis'],
        capabilities: ['text-generation'],
        maxDataClassification: 'internal',
        priority: 3,
      }),
    ).rejects.toBeInstanceOf(LlmError);
  });

  it('the manager decides the pending approval — and the request shows the decision', async () => {
    const manager = await signInPersona('manager');
    const pending = report.pendingApprovals.find((approval) => approval.actionKind === 'employee-messaging')!;
    const decided = await decideApproval(ctx(manager), {
      requestId: pending.requestId,
      decision: 'approve',
      note: 'ask June — she has the courier paperwork',
    });
    expect(decided.status).toBe('approved');
    const reread = await getActionRequest(ctx(manager), { requestId: pending.requestId });
    expect(reread.status).toBe('approved');
    expect(reread.decidedAt).not.toBeNull();
  });

  it('the platform reviewer session cannot review packages; the harness claim can (interim model, honestly)', async () => {
    const reviewer = await signInPersona('platform-reviewer');
    const developerPackageId = report.journeys
      .find((journey) => journey.id === 'marketplace')!
      .anchors.find((entry) => entry.anchorKey === 'developer-package')!.recordId;
    // The session context lacks 'marketplace:administer' — refused.
    await expect(
      listReviewQueue(ctx(reviewer), { limit: 10 }),
    ).rejects.toBeInstanceOf(MarketplaceError);
    // The harness context (the claim W058 keeps out of sessions) sees it.
    const queue = await listReviewQueue(
      { tenantId: reviewer.tenantId, principalId: reviewer.principalId, authority: ['marketplace:administer'] },
      { limit: 10 },
    );
    expect(queue.some((entry) => entry.id === developerPackageId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation of the demo data (ADR-0001)
// ---------------------------------------------------------------------------

describe('demo data stays tenant-scoped', () => {
  it('a foreign tenant sees none of the demo company data', async () => {
    const foreign: TenantContext = { tenantId: newId(), principalId: newId(), authority: [] };
    const goals = await listGoals(foreign, { status: 'active', limit: 100 });
    expect(goals).toEqual([]);
  });

  it('a foreign tenant cannot read a demo approval request (no existence leak)', async () => {
    const pending = report.pendingApprovals.find((approval) => approval.actionKind === 'agent-recruitment')!;
    const foreign: TenantContext = { tenantId: newId(), principalId: newId(), authority: [] };
    await expect(getActionRequest(foreign, { requestId: pending.requestId })).rejects.toBeInstanceOf(
      ActionsError,
    );
  });
});
