// Integration tests of the demo harness seeding (W068) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// Acceptance coverage:
//   * "deterministic data for every major journey" — every declared
//     anchor of every catalog journey exists after one run, and the
//     seeded records are real domain state (verified through the owning
//     contracts: goals, discovery, capabilities, processes, cognition,
//     marketplace, contributions, rewards, connections, BYOA, api);
//   * idempotency — a second run creates nothing, skips everything and
//     returns the SAME directory (stable tenant/persona/record ids);
//   * "no production backdoor" — the module-side gate refuses server
//     databases, production runtimes and accidental runs;
//   * tenant isolation — the anchor registry is tenant-scoped.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import { DemoError } from '../errors';
import { demoJourneys } from '../journeys';
import { seedDemoHarness, readDemoJourneyAnchors } from '../seed';
import type { DemoJourneyId, DemoSeedReport } from '../types';
import { listGoals } from '@/modules/goals/contract';
import { listUnknowns } from '@/modules/epistemics/contract';
import { listContradictions } from '@/modules/epistemics/contract';
import { listMissions } from '@/modules/missions/contract';
import { listDiscoveryRuns } from '@/modules/attention/contract';
import { analyzeGaps } from '@/modules/capabilities/contract';
import { listProcessFindings, listProcesses } from '@/modules/processes/contract';
import { getExecution } from '@/modules/cognition/contract';
import { listExecutionLinks, listMessages } from '@/modules/conversations/contract';
import {
  getPackage,
  listCatalogPackages,
  listReviewQueue,
} from '@/modules/marketplace/contract';
import { listAiProviderAccounts } from '@/modules/llm/contract';
import { listApiKeys, listWebhookSubscriptions } from '@/modules/api/contract';
import { listChannelConnections } from '@/modules/channels/contract';
import { listSources } from '@/modules/sources/contract';
import { listDestinations } from '@/modules/destinations/contract';
import { getContribution } from '@/modules/contributions/contract';
import { listRewards } from '@/modules/rewards/contract';
import { getActionRequest } from '@/modules/actions/contract';

let report: DemoSeedReport;
let secondRun: DemoSeedReport;

function companyCtx(): TenantContext {
  const company = report.tenants.find((tenant) => tenant.key === 'company')!;
  const manager = report.personas.find((persona) => persona.role === 'manager')!;
  return { tenantId: company.id, principalId: manager.principalId, authority: [] };
}

function anchor(journeyId: DemoJourneyId, key: string): string {
  const journey = report.journeys.find((entry) => entry.id === journeyId);
  expect(journey).toBeDefined();
  const found = journey!.anchors.find((anchorEntry) => anchorEntry.anchorKey === key);
  expect(found).toBeDefined();
  return found!.recordId;
}

beforeAll(async () => {
  await runMigrations(getDb());
  report = await seedDemoHarness();
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The report and the anchor completeness
// ---------------------------------------------------------------------------

describe('the seeded demo world', () => {
  it('seeds three tenants and four personas', () => {
    expect(report.tenants.map((tenant) => tenant.key).sort()).toEqual(['company', 'platform', 'vendor']);
    expect(report.personas.map((persona) => persona.role).sort()).toEqual([
      'developer',
      'employee',
      'manager',
      'platform-reviewer',
    ]);
  });

  it('records every declared anchor of every catalog journey (deterministic data for every major journey)', () => {
    const seeded = new Set(
      report.journeys.flatMap((journey) => journey.anchors.map((entry) => `${journey.id}/${entry.anchorKey}`)),
    );
    for (const journey of demoJourneys()) {
      for (const key of journey.anchorKeys) {
        expect(seeded.has(`${journey.id}/${key}`)).toBe(true);
      }
    }
    expect(report.created).toBeGreaterThan(0);
  });

  it('leaves pending approvals for the manager to decide in the browser', () => {
    const kinds = report.pendingApprovals.map((approval) => approval.actionKind).sort();
    expect(kinds).toContain('employee-messaging');
    expect(kinds).toContain('agent-recruitment');
    expect(kinds).toContain('contribution-reward');
  });
});

// ---------------------------------------------------------------------------
// Idempotency — the deterministic re-run
// ---------------------------------------------------------------------------

describe('re-running the harness', () => {
  beforeAll(async () => {
    secondRun = await seedDemoHarness();
  });

  it('creates nothing and skips everything', () => {
    expect(secondRun.created).toBe(0);
    expect(secondRun.skipped).toBe(report.created);
  });

  it('returns the same tenants, personas and anchor record ids', () => {
    expect(secondRun.tenants).toEqual(report.tenants);
    expect(secondRun.personas).toEqual(report.personas);
    const first = new Map(anchorTuples(report));
    for (const [key, recordId] of anchorTuples(secondRun)) {
      expect(first.get(key)).toBe(recordId);
    }
    expect(first.size).toBe(anchorTuples(secondRun).length);
  });

  it('does not duplicate the pending approvals', () => {
    const pendingKinds = secondRun.pendingApprovals.map((approval) => approval.actionKind);
    expect(pendingKinds.filter((kind) => kind === 'employee-messaging')).toHaveLength(1);
    expect(pendingKinds.filter((kind) => kind === 'agent-recruitment')).toHaveLength(1);
    expect(pendingKinds.filter((kind) => kind === 'contribution-reward')).toHaveLength(1);
  });
});

function anchorTuples(run: DemoSeedReport): [string, string][] {
  return run.journeys.flatMap((journey) =>
    journey.anchors.map((entry) => [`${journey.id}/${entry.anchorKey}`, entry.recordId] as [string, string]),
  );
}

// ---------------------------------------------------------------------------
// Journey data — the records are real domain state (contracts only)
// ---------------------------------------------------------------------------

describe('journey data through the owning contracts', () => {
  it('C: two active goals, the promoted unknown, the launched mission and the discovery run', async () => {
    const ctx = companyCtx();
    const goals = await listGoals(ctx, { status: 'active', limit: 100 });
    expect(goals.map((goal) => goal.content.title)).toContain('Keep wholesale delivery freshness above 92%');
    expect(goals.map((goal) => goal.content.title)).toContain('Cut order-to-ship time to 48 hours');

    const unknowns = await listUnknowns(ctx, { status: 'open', limit: 100 });
    expect(unknowns.some((unknown) => unknown.question.includes('wholesale-freshness-score'))).toBe(true);

    const missions = await listMissions(ctx, { status: 'active', limit: 100 });
    expect(missions.length).toBeGreaterThanOrEqual(1);

    const runs = await listDiscoveryRuns(ctx, { limit: 10 });
    expect(runs.length).toBe(1);
    expect(runs[0]!.counts.promoted).toBe(1);
  });

  it('D: the cold-chain gap, the fulfillment process findings and the retained contradiction', async () => {
    const ctx = companyCtx();
    const gaps = await analyzeGaps(ctx, {});
    const coldChain = gaps.find((gap) => gap.capability.name === 'cold-chain-logistics');
    expect(coldChain).toBeDefined();
    expect(coldChain!.status).not.toBe('covered');

    const processes = await listProcesses(ctx, { limit: 100 });
    expect(processes.map((process) => process.name)).toContain('Wholesale order fulfillment');
    const processId = processes.find((process) => process.name === 'Wholesale order fulfillment')!.id;
    const findings = await listProcessFindings(ctx, { processId });
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((finding) => finding.kind === 'bottleneck')).toBe(true);

    const contradictions = await listContradictions(ctx, { status: 'open', limit: 100 });
    expect(contradictions).toHaveLength(1);
  });

  it('E: the cognition cycle suspended at the approval gate, linked to the conversation', async () => {
    const ctx = companyCtx();
    const executionId = anchor('consequential-approval', 'cognition-execution');
    const trace = await getExecution(ctx, { executionId });
    expect(trace.state).toBe('awaiting_approval');
    expect(trace.pending.requestId).toBe(anchorMetadata('consequential-approval', 'cognition-execution', 'pendingRequestId'));
    expect(trace.steps.some((step) => step.stage === 'risk-opportunity-capability-analysis')).toBe(true);

    const conversationId = anchor('employee-chat', 'conversation-freshness');
    const links = await listExecutionLinks(ctx, { conversationId });
    expect(links.some((link) => link.executionId === executionId && link.role === 'triggered')).toBe(true);

    const decidedId = anchor('consequential-approval', 'approval-history');
    const decided = await getActionRequest(ctx, { requestId: decidedId });
    expect(decided.status).toBe('approved');
  });

  it('B: the conversation transcript — four person-attributed and Aurum turns', async () => {
    const ctx = companyCtx();
    const conversationId = anchor('employee-chat', 'conversation-freshness');
    const messages = await listMessages(ctx, { conversationId });
    expect(messages).toHaveLength(4);
    expect(messages[0]!.direction).toBe('inbound');
    expect(messages[0]!.actor.kind).toBe('person');
    expect(messages[1]!.actor.kind).toBe('system');
  });

  it('F: the validated contribution and the gated reward', async () => {
    const ctx = companyCtx();
    const contributionId = anchor('employee-contribution', 'contribution');
    const contribution = await getContribution(ctx, contributionId);
    expect(contribution.status).toBe('validated');

    const rewards = await listRewards(ctx, { limit: 100 });
    expect(rewards).toHaveLength(1);
    expect(rewards[0]!.status).toBe('proposed');
    expect(rewards[0]!.actionRequestId).toBe(anchorMetadata('employee-contribution', 'reward', 'actionRequestId'));
  });

  it('G: two channels, two sources, one destination', async () => {
    const ctx = companyCtx();
    expect((await listChannelConnections(ctx, { limit: 100 })).length).toBe(2);
    expect((await listSources(ctx, { limit: 100 })).length).toBe(2);
    expect((await listDestinations(ctx, { limit: 100 })).length).toBe(1);
  });

  it('H: two BYOA accounts on two different providers', async () => {
    const accounts = await listAiProviderAccounts(companyCtx(), {});
    expect(accounts).toHaveLength(2);
    const providers = accounts.map((account) => account.provider).sort();
    expect(providers).toEqual(['anthropic', 'openai']);
  });

  it('J: the governed chain — INSTALLABLE vendor package in the catalog, installed; the developer package PENDING_REVIEW', async () => {
    const ctx = companyCtx();
    const vendorPackageId = anchor('marketplace', 'vendor-package');
    const vendorPackage = await getPackage(ctx, { packageId: vendorPackageId });
    expect(vendorPackage.state).toBe('INSTALLABLE');

    const catalog = await listCatalogPackages(ctx, { limit: 100 });
    expect(catalog.some((entry) => entry.packageKey === 'roast-batch-tracker')).toBe(true);

    const developerPackageId = anchor('marketplace', 'developer-package');
    const developerPackage = await getPackage(ctx, { packageId: developerPackageId });
    expect(developerPackage.state).toBe('PENDING_REVIEW');
    expect(developerPackage.vendorTenant).toBe(report.tenants.find((tenant) => tenant.key === 'company')!.id);

    // The platform queue (the harness-scoped administer claim) sees it.
    const platform = report.tenants.find((tenant) => tenant.key === 'platform')!;
    const reviewer = report.personas.find((persona) => persona.role === 'platform-reviewer')!;
    const queue = await listReviewQueue(
      { tenantId: platform.id, principalId: reviewer.principalId, authority: ['marketplace:administer'] },
      { limit: 100 },
    );
    expect(queue.some((entry) => entry.id === developerPackageId)).toBe(true);
  });

  it('L: the API key and the webhook subscription', async () => {
    const manager = report.personas.find((persona) => persona.role === 'manager')!;
    const admin = { ...companyCtx(), principalId: manager.principalId, authority: ['api:administer'] };
    const keys = await listApiKeys(admin);
    expect(keys.length).toBe(1);
    expect(keys[0]!.label).toBe('meridian-ops-integration');
    const webhooks = await listWebhookSubscriptions(admin);
    expect(webhooks.length).toBe(1);
    expect(webhooks[0]!.eventTypes).toEqual(['goal.*']);
  });
});

function anchorMetadata(journeyId: string, key: string, field: string): unknown {
  const journey = report.journeys.find((entry) => entry.id === journeyId)!;
  const found = journey.anchors.find((entry) => entry.anchorKey === key)!;
  return found.metadata[field];
}

// ---------------------------------------------------------------------------
// The anchor registry (tenant-scoped directory)
// ---------------------------------------------------------------------------

describe('the anchor registry', () => {
  it('reads back through the tenant-scoped directory', async () => {
    const anchors = await readDemoJourneyAnchors(companyCtx());
    expect(anchors.length).toBe(report.created + report.skipped);
    const keys = anchors.map((entry) => `${entry.journeyId}/${entry.anchorKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a foreign tenant sees no demo anchors (ADR-0001)', async () => {
    const foreign: TenantContext = { tenantId: newId(), principalId: newId(), authority: [] };
    expect(await readDemoJourneyAnchors(foreign)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The gate inside the seeding entry point
// ---------------------------------------------------------------------------

describe('the module-side gate', () => {
  it('refuses a server database (DATABASE_URL)', async () => {
    process.env.DATABASE_URL = 'postgresql://demo.example/prod';
    try {
      await expect(seedDemoHarness()).rejects.toMatchObject({
        code: 'production_backend',
      } satisfies Partial<DemoError>);
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it('refuses a production runtime', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      await expect(seedDemoHarness()).rejects.toMatchObject({
        code: 'production_runtime',
      } satisfies Partial<DemoError>);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses an accidental embedded run (no memory mode, no opt-in)', async () => {
    const memory = process.env.AURUM_DB_MEMORY;
    const optIn = process.env.AURUM_DEMO_SEED;
    delete process.env.AURUM_DB_MEMORY;
    delete process.env.AURUM_DEMO_SEED;
    try {
      await expect(seedDemoHarness()).rejects.toMatchObject({
        code: 'opt_in_required',
      } satisfies Partial<DemoError>);
    } finally {
      process.env.AURUM_DB_MEMORY = memory;
      if (optIn !== undefined) process.env.AURUM_DEMO_SEED = optIn;
    }
  });
});
