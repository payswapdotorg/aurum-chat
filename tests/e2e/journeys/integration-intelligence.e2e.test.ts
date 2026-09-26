// W096 — the Integration Intelligence End-to-End Fixture proof (the journey
// suite of work item W096).
//
// "Prove discover→recommend→approve→connect→verify→map→observe→request
//  action scope→execute→reconcile→outcome. Acceptance: machine-readable
//  fixture, browser evidence for admin UX, provider-failure case,
//  denied-scope case and tenant-isolation case."
//
// WHAT THIS SUITE IS. The proof of record lives in the MACHINE-READABLE,
// versioned fixtures under tests/e2e/fixtures/integration-intelligence/
// (validated against fixture.schema.json, schemaVersion 1); this suite
// executes them against the REAL module services — W081
// integration-intelligence, W082 connection-broker, W083 capability-grants
// and W084 deep-actions, riding their real W009 actions gate, W036 sources
// discovery transport, W004 observations evidence, W008/W007/W017 grounding
// contracts — with deterministic in-memory doubles ONLY where a live
// provider/network would be involved (the repo fixture pattern; see the
// executor's header). Every expectation keys on DURABLE RECORDS — table
// rows and append-only event ledgers in the embedded PostgreSQL — never on
// return values alone, so the Tech Lead re-verifies against the same
// fixtures.
//
//   * THE HAPPY PATH runs on the deterministic demo company tenant (the
//     W068 demo world, booted through the real migrations + seedDemoHarness)
//     so the admin-facing surfaces the chain rides render its durable
//     records: /approvals (the W009 authority gate — the pending request,
//     its outcome-oriented justification and the decision control the human
//     actually uses, for all three chain action kinds) and /connections
//     (the registered discovery source). The machine-readable DOM
//     assertions on the server-rendered HTML — the same evidence-of-record
//     discipline as the W070 journeys — are declared IN the fixture at the
//     exact chain moments they must hold, and one W009 decision (the
//     deep-action proposal) is driven through the REAL tower API handler
//     with the manager persona's session cookie.
//   * THE PROVIDER-FAILURE CASE — the provider errors mid-chain at
//     execution: the task parks 'failed' with honest evidence, the durable
//     records match the provider's actual state (no silent partial state),
//     and the healing path resumes exactly the open operation.
//   * THE DENIED-SCOPE CASE — the action-scope request is rejected by the
//     authority gate: no grant is minted, the denial is recorded with its
//     human-readable reason and exact requested scope, nothing executes.
//   * THE TENANT-ISOLATION CASE — the full chain for TWO tenants side by
//     side (the W044 sweep doctrine): exact per-tenant row counts at every
//     table the chain touches, uniform not-found cross-tenant reads, the
//     other tenant's discovery source refused as unauthorized before any
//     transport interaction, and an omnipotent-claims principal still blind
//     across the boundary. The isolation case LIVES HERE, in the journey —
//     it is not a tests/tenant-isolation sweep (the coverage manifest maps
//     MODULES to sweeps; the chain is already covered by the four modules'
//     own sweeps, and a non-module manifest key would trip the W044
//     coverage tripwire).
//
// Registration: this file matches the journey suite's vitest pattern
// (**/*.test.ts under tests/e2e/journeys/) exactly like
// journeys.e2e.test.ts / capability-discovery.e2e.test.ts — no new
// user-visible surface is introduced, so discoverability.e2e.test.ts's
// instruments list is deliberately untouched.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// The harness first (its next/headers / next/navigation mocks register on
// module evaluation — see its header note).
import {
  apiRequest,
  companyTenantId,
  demoWorld,
  renderOk,
  shutdownWorld,
  signInPersona,
  type DemoSeedReport,
  type PersonaSession,
} from './harness';
import { handleTowerApprovalDecision } from '../../../src/app/(tower)/lib/api';
import {
  formatRunReport,
  loadFixture,
  runIntegrationFixture,
  type FixtureHooks,
  type FixtureRunReport,
} from '../fixtures/integration-intelligence/executor';
import {
  listDeepActionEvents,
  listDeepActions,
} from '../../../src/modules/deep-actions/contract';
import { getDb } from '../../../src/infra/db';
import { newId } from '../../../src/infra/ids';
import type { TenantContext } from '../../../src/infra/tenant';

const FIXTURES = [
  'happy-path.fixture.json',
  'provider-failure.fixture.json',
  'denied-scope.fixture.json',
  'tenant-isolation.fixture.json',
] as const;

const CANONICAL_CHAIN = [
  'discover',
  'recommend',
  'approve',
  'connect',
  'verify',
  'map',
  'observe',
  'request-scope',
  'execute',
  'reconcile',
  'outcome',
] as const;

let report: DemoSeedReport;
let manager: PersonaSession;
let demoTenant: string;

beforeAll(async () => {
  report = await demoWorld();
  manager = await signInPersona('manager');
  demoTenant = companyTenantId(report);
});

afterAll(async () => {
  await shutdownWorld();
});

/** A plain member context of the demo company tenant (spot-check reads). */
function memberOfDemoTenant(): TenantContext {
  return { tenantId: demoTenant, principalId: newId(), authority: [] };
}

/** The suite's injected hooks: REAL SSR rendering + the REAL tower API. */
function journeyHooks(): FixtureHooks {
  return {
    renderPage: async (path: string, persona: string): Promise<string> => {
      if (persona !== 'manager') {
        throw new Error(`the W096 fixtures render admin surfaces as the manager persona, not '${persona}'`);
      }
      const rendered = await renderOk(path, manager);
      return rendered.html;
    },
    decideViaTower: async (
      requestId: string,
      decision: 'approve' | 'reject',
      note: string | null,
    ): Promise<{ status: number; body: unknown }> => {
      // The exact POST the tower's DecisionForm issues, with the manager
      // persona's session cookie — the admin-UX decision path of record.
      return handleTowerApprovalDecision(
        apiRequest(`/api/tower/approvals/${requestId}/decide`, manager, {
          method: 'POST',
          body: { decision, note },
        }),
        requestId,
        { decision, note },
      );
    },
  };
}

/** Require a fixture run to be fully green (the report is the evidence). */
function requireGreen(run: FixtureRunReport): void {
  expect(run.schemaValidated).toBe(true);
  expect(run.allPass, formatRunReport(run)).toBe(true);
}

async function tableCount(table: string, tenantId: string, where?: string): Promise<number> {
  const rows = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table} WHERE tenant_id = $1${where === undefined ? '' : ` AND ${where}`}`,
    [tenantId],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

/** The whole-database row count of one chain table (all tenants). */
async function totalCount(table: string): Promise<number> {
  const rows = await getDb().query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${table}`,
  );
  return Number(rows.rows[0]?.count ?? 0);
}

/** Every table the W096 chain touches (the isolation sweep's scope). */
const CHAIN_TABLES = [
  'integration_discovery_grants',
  'integration_systems',
  'integration_recommendations',
  'integration_recommendation_batches',
  'integration_verification_runs',
  'broker_connections',
  'broker_connection_events',
  'capability_access',
  'capability_grant_requests',
  'capability_grants',
  'capability_grant_events',
  'capability_invocations',
  'deep_action_tasks',
  'deep_action_operations',
  'deep_action_surface',
  'deep_action_events',
  'deep_action_idempotency',
  'action_requests',
  'action_approval_decisions',
  'sources',
  'observations',
] as const;

// ---------------------------------------------------------------------------
// The machine-readable fixture (schema-validated, versioned)
// ---------------------------------------------------------------------------

describe('W096 — the machine-readable fixture', () => {
  it('every fixture variant validates against the versioned fixture.schema.json and names the canonical chain', () => {
    for (const file of FIXTURES) {
      const fixture = loadFixture(file);
      expect(fixture.schemaVersion, file).toBe(1);
      expect(fixture.chain, file).toEqual([...CANONICAL_CHAIN]);
    }
    const happy = loadFixture('happy-path.fixture.json');
    expect(happy.variant).toEqual({
      providerFailure: false,
      deniedScope: false,
      tenantIsolation: false,
    });
    const failure = loadFixture('provider-failure.fixture.json');
    expect(failure.variant.providerFailure).toBe(true);
    expect(failure.deepAction.transientFailureTargets).toEqual(['tick-2001']);
    const denial = loadFixture('denied-scope.fixture.json');
    expect(denial.variant.deniedScope).toBe(true);
    const isolation = loadFixture('tenant-isolation.fixture.json');
    expect(isolation.variant.tenantIsolation).toBe(true);
    expect(isolation.tenants.map((tenant) => tenant.key)).toEqual(['alpha', 'beta']);
    expect(isolation.finalSteps?.[0]?.phase).toBe('isolation-probe');
  });
});

// ---------------------------------------------------------------------------
// The happy path — the full chain + browser evidence for the admin UX
// ---------------------------------------------------------------------------

describe('W096 — the happy path: discover→…→outcome on the demo company tenant, with admin-UX browser evidence', () => {
  let run: FixtureRunReport;
  let happyTenant: string;

  it('executes the whole chain against the real module services and every durable expectation holds', async () => {
    run = await runIntegrationFixture('happy-path.fixture.json', journeyHooks(), {
      demoTenantId: demoTenant,
    });
    happyTenant = run.tenants.find((tenant) => tenant.key === 'company')?.tenantId ?? '';
    expect(happyTenant).toBe(demoTenant);
    requireGreen(run);
  }, 120_000);

  it('the chain advanced through every canonical phase in order', () => {
    const phases = run.steps.map((step) => step.phase);
    expect(phases).toEqual([...CANONICAL_CHAIN]);
  });

  it('the durable outcome is directly re-verifiable from the demo tenant (independent of the executor)', async () => {
    const member = memberOfDemoTenant();
    const tasks = await listDeepActions(member, {});
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.status).toBe('reconciled');
    expect(task.mismatchCount).toBe(0);
    const events = await listDeepActionEvents(member, { taskId: task.id });
    expect(events.map((event) => event.event).reverse()).toEqual([
      'created',
      'surface-discovered',
      'targets-inspected',
      'proposed',
      'authorized',
      'operation-executed',
      'operation-executed',
      'executed',
      'verified',
      'reconciled',
    ]);
    // The three W009 gate decisions of the chain, durable on the actions trail.
    expect(await tableCount('action_requests', demoTenant, `action_kind = 'integration-connection' AND status = 'approved'`)).toBe(1);
    expect(await tableCount('action_requests', demoTenant, `action_kind = 'capability-grant' AND status = 'approved'`)).toBe(2);
    expect(await tableCount('action_requests', demoTenant, `action_kind = 'deep-action' AND status = 'approved'`)).toBe(1);
    expect(await tableCount('capability_grants', demoTenant, `status = 'active'`)).toBe(2);
    expect(await tableCount('capability_invocations', demoTenant, `outcome = 'allowed'`)).toBe(6);
    expect(await tableCount('capability_invocations', demoTenant, `outcome = 'denied'`)).toBe(0);
    expect(await tableCount('observations', demoTenant, `kind = 'deep-action.pre-state'`)).toBe(2);
    expect(await tableCount('observations', demoTenant, `kind = 'deep-action.post-state'`)).toBe(2);
    expect(await tableCount('broker_connections', demoTenant, `status = 'connected'`)).toBe(2);
    expect(await tableCount('integration_systems', demoTenant, `connection_status = 'connected'`)).toBe(2);
  });

  it('the browser evidence for the admin UX was captured at the exact chain moments (machine-readable DOM assertions)', () => {
    const browser = run.steps.flatMap((step) => step.browser);
    // Mid-chain: the pending integration-connection batch on /approvals.
    expect(
      browser.some(
        (entry) => entry.surface === '/approvals' && entry.assertion.includes('Integration Connection'),
      ),
    ).toBe(true);
    // Mid-chain: the pending capability-grant ask on /approvals.
    expect(
      browser.some((entry) => entry.surface === '/approvals' && entry.assertion.includes('Capability Grant')),
    ).toBe(true);
    // Mid-chain: the pending deep-action proposal on /approvals.
    expect(
      browser.some((entry) => entry.surface === '/approvals' && entry.assertion.includes('Deep Action')),
    ).toBe(true);
    // Final: the decided chain surfaced on /approvals + the discovery source on /connections.
    expect(browser.filter((entry) => entry.surface === '/approvals' && entry.pass).length).toBeGreaterThanOrEqual(10);
    expect(
      browser.some(
        (entry) => entry.surface === '/connections' && entry.assertion.includes('ws-w096-dir-01'),
      ),
    ).toBe(true);
    // And the tower decision really went through the real tower API.
    const towerDecision = run.steps
      .flatMap((step) => step.invokes)
      .find((invoke) => invoke.op === 'decide-deep-action-gate');
    expect(towerDecision?.detail).toContain('tower API');
  });
});

// ---------------------------------------------------------------------------
// The provider-failure case
// ---------------------------------------------------------------------------

describe('W096 — the provider-failure case: the provider errors mid-chain', () => {
  let run: FixtureRunReport;
  let failureTenant: string;

  it('degrades honestly, evidences the failure durably and leaves no silent partial state', async () => {
    run = await runIntegrationFixture('provider-failure.fixture.json', journeyHooks());
    failureTenant = run.tenants[0]?.tenantId ?? '';
    requireGreen(run);
  }, 120_000);

  it('the failure and the recovery are directly re-verifiable from the tenant', async () => {
    const member = { tenantId: failureTenant, principalId: newId(), authority: [] };
    const tasks = await listDeepActions(member, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('reconciled');
    const events = await listDeepActionEvents(member, { taskId: tasks[0]!.id });
    const chain = events.map((event) => event.event).reverse();
    expect(chain).toContain('execution-failed');
    expect(chain[chain.length - 1]).toBe('reconciled');
    expect(await tableCount('deep_action_events', failureTenant, `event = 'execution-failed'`)).toBe(1);
    expect(await tableCount('deep_action_idempotency', failureTenant)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The denied-scope case
// ---------------------------------------------------------------------------

describe('W096 — the denied-scope case: the authority gate rejects the action-scope request', () => {
  let run: FixtureRunReport;
  let denialTenant: string;

  it('records the denial with its reason and nothing executes', async () => {
    run = await runIntegrationFixture('denied-scope.fixture.json', journeyHooks());
    denialTenant = run.tenants[0]?.tenantId ?? '';
    requireGreen(run);
  }, 120_000);

  it('the stopped write is directly re-verifiable from the tenant', async () => {
    const member = { tenantId: denialTenant, principalId: newId(), authority: [] };
    const tasks = await listDeepActions(member, {});
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.status).toBe('rejected');
    expect(tasks[0]!.rejectionReason).toContain('The write is stopped');
    expect(await tableCount('capability_grants', denialTenant)).toBe(0);
    expect(await tableCount('capability_invocations', denialTenant, `outcome = 'denied' AND basis = 'grant-missing'`)).toBe(2);
    expect(await tableCount('deep_action_idempotency', denialTenant)).toBe(1);
    expect(await tableCount('observations', denialTenant, `kind = 'deep-action.post-state'`)).toBe(0);
    expect(await tableCount('action_requests', denialTenant, `action_kind = 'capability-grant' AND status = 'rejected'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The tenant-isolation case
// ---------------------------------------------------------------------------

describe('W096 — the tenant-isolation case: the full chain for two tenants, zero leakage', () => {
  let run: FixtureRunReport;
  let alpha: string;
  let beta: string;
  /** Whole-database row counts per chain table, BEFORE the isolation run. */
  let beforeTotals: Map<string, number>;

  it('runs the whole chain for both tenants and every isolation probe holds', async () => {
    beforeTotals = new Map(
      await Promise.all(
        CHAIN_TABLES.map(async (table) => [table, await totalCount(table)] as const),
      ),
    );
    run = await runIntegrationFixture('tenant-isolation.fixture.json', journeyHooks());
    alpha = run.tenants.find((tenant) => tenant.key === 'alpha')?.tenantId ?? '';
    beta = run.tenants.find((tenant) => tenant.key === 'beta')?.tenantId ?? '';
    expect(alpha).not.toBe(beta);
    requireGreen(run);
  }, 180_000);

  it('both tenants hold exactly their own reconciled outcome, and no chain table row leaked', async () => {
    for (const tenantId of [alpha, beta]) {
      const member = { tenantId, principalId: newId(), authority: [] };
      const tasks = await listDeepActions(member, {});
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.status).toBe('reconciled');
      expect(await tableCount('integration_systems', tenantId)).toBe(1);
      expect(await tableCount('broker_connections', tenantId)).toBe(1);
      expect(await tableCount('capability_grants', tenantId)).toBe(1);
      expect(await tableCount('deep_action_tasks', tenantId)).toBe(1);
      expect(await tableCount('action_requests', tenantId)).toBe(3);
    }
    // Every row the isolation run created landed in EXACTLY one of the two
    // chain tenants: the whole-database delta per table equals the two
    // tenants' combined rows — no third tenant, no cross-tenant landing,
    // no duplication.
    for (const table of CHAIN_TABLES) {
      const before = beforeTotals.get(table) ?? 0;
      const after = await totalCount(table);
      const inTenants =
        (await tableCount(table, alpha)) + (await tableCount(table, beta));
      expect(after - before, `${table} gained rows outside the two chain tenants`).toBe(inTenants);
      expect(inTenants, `${table} row count across the two tenants`).toBeGreaterThan(0);
    }
  });
});
