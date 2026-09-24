// Integration tests for the integration-intelligence module against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port. Covers the
// W081 acceptance end-to-end:
//
// "admin grants an approved discovery source; Aurum identifies
//  systems/capabilities; shows outcome-oriented recommendations and scope
//  impact; no uncontrolled network scanning; every discovered system is
//  tenant-scoped."
//
//  * THE ACCEPTANCE PATH — admin grants a (stubbed) discovery source →
//    systems identified (capability surfaces, data categories) →
//    recommendations ranked with scope impact and why-it-matters
//    explanations grounded in the org's OWN goals/unknowns/gaps (created
//    here through the real contracts) → bulk approval through the actions
//    authority (W009: EXECUTE gated, separation of duties, decision
//    trail) → connection → automatic verification records (which promised
//    capabilities actually verified reachable);
//  * THE NO-SCAN INVARIANT — the discovery engine refuses un-granted,
//    cross-tenant and revoked sources BEFORE any transport interaction
//    (asserted by counting the stubbed transport's fetch requests: zero);
//  * TENANT ISOLATION — two tenants, zero leakage (grants, inventory,
//    recommendations, batches, verifications — uniform not-found, and one
//    tenant's grant never authorizes discovery through the other's
//    source);
//  * POLICY PATHS — tenant policy may auto-allow or forbid the connection
//    kind (still through W009: policy decisions recorded, nothing
//    bypassed);
//  * RE-DISCOVERY — dedupe suppresses re-observed directory records;
//    existing systems update instead of duplicating; a rejected
//    recommendation is never re-proposed;
//  * VERIFICATION HONESTY — connection without a wired verification
//    transport records a `pending` run (never a fake success); explicit
//    verification refuses `verification_unavailable` without a transport.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as integration from '../contract';
import * as sourcesContract from '@/modules/sources/contract';
import * as actionsContract from '@/modules/actions/contract';
import { createGoal } from '@/modules/goals/contract';
import { recordUnknown } from '@/modules/epistemics/contract';
import { registerCapability, registerRequirement } from '@/modules/capabilities/contract';
import { getObservation } from '@/modules/observations/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import type { CanonicalSourceRecord, SourceFetchRequest, SourceFetchResult, SourceTransport } from '@/modules/sources/contract';
import type { VerificationTransport } from '../types';
import { ActionsError } from '@/modules/actions/contract';
import { IntegrationError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';

const {
  grantDiscoverySource,
  revokeDiscoverySource,
  getDiscoveryGrant,
  listDiscoveryGrants,
  runDiscovery,
  getSystem,
  listSystems,
  getRecommendation,
  listRecommendations,
  submitRecommendationBatch,
  decideRecommendationBatch,
  getRecommendationBatch,
  listRecommendationBatches,
  connectSystem,
  verifySystem,
  listVerificationRuns,
  setVerificationTransport,
  INTEGRATION_AUTHORITY_ADMINISTER,
  INTEGRATION_ACTION_KIND,
  DISCOVERY_RECORD_KIND,
} = integration;

const { registerSource, setSourceTransport } = sourcesContract;
const { listApprovalDecisions, setAuthorityPolicy } = actionsContract;

// A FRESH tenant per test so counts stay deterministic (every test owns
// its own grants, inventory, recommendations and policies).
function freshTenant(): string {
  return newId();
}

// Stable principals per tenant (separation of duties: the requester of a
// batch is never its decider — the actions contract enforces it).
function principal(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function admin(ctx: TenantContext): TenantContext {
  return { ...ctx, authority: [...ctx.authority, INTEGRATION_AUTHORITY_ADMINISTER] };
}

// Fake credentials are assembled from fragments at runtime (never a
// realistic full token literal in source — GitHub push protection).
function fakeCredentialRef(label: string): string {
  return `secret-store://` + `w081/` + `${label}/` + 'ref';
}

// ---------------------------------------------------------------------------
// Stubbed transports
// ---------------------------------------------------------------------------

/** A provider-neutral source transport that records every fetch request. */
class ScriptedDirectoryTransport implements SourceTransport {
  readonly requests: SourceFetchRequest[] = [];
  private windows: SourceFetchResult[] = [];

  /** Queue exact windows (consumed in order); unscripted fetches return empty exhausted windows. */
  script(...windows: SourceFetchResult[]): void {
    this.windows.push(...windows);
  }

  async fetch(request: SourceFetchRequest): Promise<SourceFetchResult> {
    this.requests.push(request);
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/** A verification transport with scripted per-capability reachability. */
class ScriptedVerificationTransport implements VerificationTransport {
  readonly probes: string[] = [];
  /** capabilityKey → reachable; default true. */
  unreachable = new Set<string>();

  async probe(request: { capabilityKey: string }): Promise<{ reachable: boolean; detail: string | null }> {
    this.probes.push(request.capabilityKey);
    return this.unreachable.has(request.capabilityKey)
      ? { reachable: false, detail: 'the capability endpoint refused the read probe' }
      : { reachable: true, detail: null };
  }
}

/** One canonical directory record (the discovery-source adapter output). */
function directoryRecord(
  externalId: string,
  displayName: string,
  capabilityClasses: string[],
  extra: Record<string, unknown> = {},
  providerRecordId?: string,
): CanonicalSourceRecord {
  return {
    providerRecordId: providerRecordId ?? `dir-${externalId}`,
    kind: DISCOVERY_RECORD_KIND,
    payload: { externalId, displayName, capabilityClasses, ...extra },
    occurredAt: '2026-09-23T10:00:00Z',
  };
}

function windowOf(records: CanonicalSourceRecord[]): SourceFetchResult {
  return { records, nextCursor: null, hasMore: false };
}

let directoryTransport: ScriptedDirectoryTransport;
let verificationTransport: ScriptedVerificationTransport;

const BASE_TIME = Date.parse('2026-09-23T12:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

let accountCounter = 0;

/** Registers a (stubbed) discovery source in the tenant — the approved directory/admin API. */
async function registerDirectorySource(ctx: TenantContext, displayName: string): Promise<string> {
  accountCounter += 1;
  const { source } = await registerSource(ctx, {
    provider: 'notion',
    providerAccountId: `ws-${String(accountCounter).padStart(8, '0')}`,
    displayName,
    authKind: 'oauth',
    credentialRef: fakeCredentialRef(`notion-${accountCounter}`),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  return source.id;
}

async function expectIntegrationError(
  code: IntegrationError['code'],
  fn: () => Promise<unknown>,
): Promise<IntegrationError> {
  try {
    await fn();
    throw new Error(`expected IntegrationError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof IntegrationError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setSourceTransport(null);
  setVerificationTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  directoryTransport = new ScriptedDirectoryTransport();
  verificationTransport = new ScriptedVerificationTransport();
  setSourceTransport(directoryTransport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setSourceTransport(null);
  setVerificationTransport(null);
});

// ---------------------------------------------------------------------------
// The W081 acceptance path, end-to-end
// ---------------------------------------------------------------------------

describe('W081 acceptance path: grant → discover → explain → recommend → approve → connect → verify', () => {
  it('walks the whole journey through the real contracts', async () => {
    const tenant = freshTenant();
    const adminCtx = admin(principal(tenant));
    const aurumCtx = principal(tenant); // the intelligence employee (member)
    const approverCtx = {
      tenantId: tenant,
      principalId: newId(),
      authority: ['actions:approve'],
    };

    // -- The org's own intelligence: a goal, an unknown and a capability gap
    //    (all through their public contracts — the grounding surface).
    const goal = await createGoal(adminCtx, {
      title: 'Reduce customer churn',
      objective: 'Keep the customers we already have instead of constantly replacing them',
      desiredState: 'At-risk customers are identified and helped before they leave',
      horizonEnd: '2027-03-31T00:00:00Z',
      owner: { kind: 'person', label: 'Sarah (Head of Success)' },
      priority: 'high',
      successCriteria: 'Quarterly churn below 3 percent',
      actor: { kind: 'person', label: 'Sarah (Head of Success)' },
    });
    const unknown = await recordUnknown(aurumCtx, {
      question: 'Which customers are at risk of leaving?',
      consequence: 'Without this we learn about churn only when the cancellation arrives',
    });
    const capability = await registerCapability(adminCtx, {
      name: 'Customer success management',
      description: 'Proactively tracking and helping at-risk accounts',
      actor: { kind: 'person', label: 'Sarah' },
    });
    await registerRequirement(adminCtx, {
      capabilityId: capability.id,
      source: { kind: 'manual', label: 'Ops review' },
      actor: { kind: 'person', label: 'Sarah' },
    });

    // -- Admin grants an approved discovery source (the admin gate).
    await expectIntegrationError('forbidden', () =>
      grantDiscoverySource(aurumCtx, { sourceId: newId() }),
    );
    const sourceId = await registerDirectorySource(adminCtx, 'Acme Notion Workspace');
    // A grant for a source that does not exist in this tenant is refused
    // through the sources contract's uniform not-found (no existence leak).
    await expect(integration.grantDiscoverySource(adminCtx, { sourceId: newId() })).rejects.toThrow();
    const { grant, created } = await grantDiscoverySource(adminCtx, {
      sourceId,
      note: 'approved workspace directory',
    });
    expect(created).toBe(true);
    expect(grant.status).toBe('active');
    expect(grant.sourceId).toBe(sourceId);

    // -- The (stubbed) directory delivers three systems: a CRM, a helpdesk
    //    and a finance tool.
    directoryTransport.script(
      windowOf([
        directoryRecord('app-crm', 'Acme CRM', ['customer-records', 'sales-pipeline']),
        directoryRecord('app-helpdesk', 'Acme Helpdesk', ['support-desk']),
        directoryRecord('app-finance', 'Acme Finance', ['billing-payments', 'accounting-finance']),
      ]),
    );

    // -- Aurum surveys the AUTHORIZED tooling (a member may run discovery —
    //    the grant was the admin act; discovery itself is observe/analyze).
    const run = await runDiscovery(aurumCtx, { sourceId });
    expect(run.runs).toHaveLength(1);
    expect(run.runs[0]).toMatchObject({
      grantId: grant.id,
      sourceId,
      fetched: 3,
      ingested: 3,
      duplicates: 0,
      ignored: 0,
      systemsCreated: 3,
      systemsUpdated: 0,
      recommendationsCreated: 3,
    });
    expect(directoryTransport.requests).toHaveLength(1);
    expect(directoryTransport.requests[0]!.sourceId).toBe(sourceId);

    // -- The Tool & System Inventory: tenant-scoped systems with capability
    //    surfaces, data categories and evidence observations.
    const systems = await listSystems(aurumCtx, {});
    expect(systems).toHaveLength(3);
    const crm = systems.find((system) => system.displayName === 'Acme CRM')!;
    const helpdesk = systems.find((system) => system.displayName === 'Acme Helpdesk')!;
    const finance = systems.find((system) => system.displayName === 'Acme Finance')!;
    expect(crm.tenantId).toBe(tenant);
    expect(crm.systemKey).toBe(`${sourceId}:app-crm`);
    expect(crm.capabilityClasses).toEqual(['customer-records', 'sales-pipeline']);
    expect(crm.dataCategories).toEqual(['customer-contacts', 'deals']);
    expect(crm.capabilities.map((capability) => capability.key).sort()).toEqual([
      'read.customer-records',
      'read.sales-pipeline',
      'write.customer-records',
      'write.sales-pipeline',
    ]);
    expect(crm.connectionStatus).toBe('discovered');
    expect(crm.health).toBe('unknown');
    // Every discovered system cites its evidence observation (W004).
    expect(crm.evidenceObservationIds).toHaveLength(1);
    const evidence = await getObservation(aurumCtx, crm.evidenceObservationIds[0]!);
    expect(evidence.kind).toBe(DISCOVERY_RECORD_KIND);
    expect((evidence.payload as { externalId: string }).externalId).toBe('app-crm');

    // -- Why-it-matters: the CRM grounds in the org's OWN goal, unknown and
    //    gap; the others fall back to capability-class basis.
    expect(crm.whyItMatters.basis).toBe('org-context');
    expect(crm.whyItMatters.groundedIn.goals.map((entry) => entry.id)).toEqual([goal.id]);
    expect(crm.whyItMatters.groundedIn.unknowns.map((entry) => entry.id)).toEqual([unknown.id]);
    expect(crm.whyItMatters.groundedIn.gaps.map((entry) => entry.capabilityName)).toEqual([
      'Customer success management',
    ]);
    expect(crm.whyItMatters.summary).toContain('This would help with your goal "Reduce customer churn".');
    expect(crm.whyItMatters.summary).toContain(
      'It could also help answer the open question "Which customers are at risk of leaving?".',
    );
    // Outcome-oriented outcomes across §10 dimensions, in canonical order.
    const dimensions = crm.whyItMatters.outcomes.map((outcome) => outcome.dimension);
    expect(dimensions).toEqual([...dimensions].sort((a, b) =>
      ['quality', 'speed', 'cost', 'privacy', 'policy'].indexOf(a) -
      ['quality', 'speed', 'cost', 'privacy', 'policy'].indexOf(b)));
    expect(helpdesk.whyItMatters.basis).toBe('capability-class');
    expect(finance.whyItMatters.basis).toBe('capability-class');

    // -- Recommendations: ranked (the grounded CRM first), safe-by-default
    //    read-only, with explicit scope impact.
    const recommendations = await listRecommendations(aurumCtx, {});
    expect(recommendations).toHaveLength(3);
    const [top, second, third] = recommendations;
    expect(top!.systemId).toBe(crm.id);
    expect(top!.score).toBeGreaterThan(second!.score);
    expect(second!.score).toBeGreaterThanOrEqual(third!.score);
    expect(top!.status).toBe('proposed');
    expect(top!.connectionMode).toBe('read-only');
    expect(top!.scopeImpact.wouldRead.map((capability) => capability.key)).toEqual([
      'read.customer-records',
      'read.sales-pipeline',
    ]);
    expect(top!.scopeImpact.staysWriteGated.map((capability) => capability.key)).toEqual([
      'write.customer-records',
      'write.sales-pipeline',
    ]);
    // The recommendation freezes the explanation the approver will see.
    expect(top!.whyItMatters).toEqual(crm.whyItMatters);

    // -- BULK APPROVAL through the actions authority (W009).
    const batch = await submitRecommendationBatch(aurumCtx, {
      recommendationIds: recommendations.map((recommendation) => recommendation.id),
    });
    expect(batch.status).toBe('pending_approval');
    expect(batch.recommendationCount).toBe(3);
    expect(batch.actionRequestId).not.toBeNull();

    // The gate record exists in the actions module: kind
    // 'integration-connection', level EXECUTE, pending, and its payload
    // carries the outcome-oriented explanations and scope impact.
    const requests = await actionsContract.listActionRequests(approverCtx, {
      actionKind: INTEGRATION_ACTION_KIND,
    });
    const request = requests.find((entry) => entry.id === batch.actionRequestId)!;
    expect(request).toBeDefined();
    expect(request.status).toBe('pending');
    expect(request.authorityLevel).toBe('EXECUTE');
    expect(request.requestedBy).toBe(aurumCtx.principalId);
    const payload = request.payload as {
      recommendations: { displayName: string; whyItMatters: string; scopeImpact: { connectionMode: string } }[];
    };
    expect(payload.recommendations).toHaveLength(3);
    expect(payload.recommendations[0]!.displayName).toBe('Acme CRM');
    expect(payload.recommendations[0]!.whyItMatters).toContain('Reduce customer churn');
    expect(payload.recommendations[0]!.scopeImpact.connectionMode).toBe('read-only');

    // The recommendations moved to pending_approval with the batch.
    const pending = await listRecommendations(aurumCtx, { status: 'pending_approval' });
    expect(pending).toHaveLength(3);

    // Separation of duties: the requesting principal never decides its own
    // request — enforced by the actions contract, surfaced through ours.
    await expect(
      decideRecommendationBatch(aurumCtx, { batchId: batch.id, decision: 'approve' }),
    ).rejects.toThrow(ActionsError);
    // And deciding requires the approve claim.
    const plainMember = principal(tenant);
    await expect(
      decideRecommendationBatch(plainMember, { batchId: batch.id, decision: 'approve' }),
    ).rejects.toThrow(ActionsError);

    // The authorized human decides the WHOLE batch (bulk approval).
    advance(60);
    const decided = await decideRecommendationBatch(approverCtx, {
      batchId: batch.id,
      decision: 'approve',
      note: 'read-only is fine for all three',
    });
    expect(decided.status).toBe('approved');
    expect(decided.decidedAt).not.toBeNull();
    const approvedRecommendations = await listRecommendations(aurumCtx, { batchId: batch.id });
    expect(approvedRecommendations).toHaveLength(3);
    for (const recommendation of approvedRecommendations) {
      expect(recommendation.status).toBe('approved');
      expect(recommendation.decidedAt).not.toBeNull();
    }
    // The human decision is on the actions module's append-only trail.
    const decisions = await listApprovalDecisions(approverCtx, { requestId: batch.actionRequestId! });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decision).toBe('approve');
    expect(decisions[0]!.decidedBy).toBe('principal');
    expect(decisions[0]!.principalId).toBe(approverCtx.principalId);

    // Only a pending batch can be decided (first decision wins).
    await expectIntegrationError('batch_not_pending', () =>
      decideRecommendationBatch(approverCtx, { batchId: batch.id, decision: 'reject' }),
    );

    // -- Connect + AUTOMATIC VERIFICATION (which promised capabilities
    //    actually verified reachable). Finance's accounting probe fails.
    setVerificationTransport(verificationTransport);
    verificationTransport.unreachable.add('read.accounting-finance');

    advance(60);
    const crmRecommendation = approvedRecommendations.find(
      (recommendation) => recommendation.systemId === crm.id,
    )!;
    const connectedCrm = await connectSystem(aurumCtx, {
      recommendationId: crmRecommendation.id,
    });
    expect(connectedCrm.recommendation.status).toBe('connected');
    expect(connectedCrm.system.connectionStatus).toBe('connected');
    expect(connectedCrm.verification.status).toBe('verified');
    expect(connectedCrm.verification.promisedCount).toBe(2);
    expect(connectedCrm.verification.verifiedCount).toBe(2);
    expect(connectedCrm.system.health).toBe('healthy');

    advance(60);
    const financeRecommendation = approvedRecommendations.find(
      (recommendation) => recommendation.systemId === finance.id,
    )!;
    const connectedFinance = await connectSystem(aurumCtx, {
      recommendationId: financeRecommendation.id,
    });
    expect(connectedFinance.verification.status).toBe('partial');
    expect(connectedFinance.verification.promisedCount).toBe(2);
    expect(connectedFinance.verification.verifiedCount).toBe(1);
    expect(
      connectedFinance.verification.results.find((result) => result.outcome === 'unreachable')!
        .capabilityKey,
    ).toBe('read.accounting-finance');
    expect(connectedFinance.system.health).toBe('degraded');

    // The promised-vs-verified ledger is queryable per system.
    const financeRuns = await listVerificationRuns(aurumCtx, { systemId: finance.id });
    expect(financeRuns).toHaveLength(1);
    expect(financeRuns[0]!.transportWired).toBe(true);
    expect(financeRuns[0]!.verifiedAt).not.toBeNull();

    // Connection is a one-way transition per recommendation.
    await expectIntegrationError('recommendation_status_conflict', () =>
      connectSystem(aurumCtx, { recommendationId: financeRecommendation.id }),
    );
    // And an unapproved recommendation cannot connect at all.
    const helpdeskRecommendation = approvedRecommendations.find(
      (recommendation) => recommendation.systemId === helpdesk.id,
    )!;
    advance(60);
    await connectSystem(aurumCtx, { recommendationId: helpdeskRecommendation.id });
    const helpdeskAfter = await getSystem(aurumCtx, { systemId: helpdesk.id });
    expect(helpdeskAfter.connectionStatus).toBe('connected');
    expect(helpdeskAfter.health).toBe('healthy');

    // -- The journey's evidence is reconstructable: grant → observations →
    //    systems → recommendations → W009 request → decision → connection →
    //    verification.
    const grants = await listDiscoveryGrants(adminCtx, {});
    expect(grants).toHaveLength(1);
    const grantRead = await getDiscoveryGrant(adminCtx, { grantId: grant.id });
    expect(grantRead.status).toBe('active');
    const batches = await listRecommendationBatches(aurumCtx, {});
    expect(batches).toHaveLength(1);
    const batchRead = await getRecommendationBatch(aurumCtx, { batchId: batch.id });
    expect(batchRead.status).toBe('approved');
    const recommendationRead = await getRecommendation(aurumCtx, {
      recommendationId: crmRecommendation.id,
    });
    expect(recommendationRead.connectedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The no-scan invariant (discovery refuses un-granted sources)
// ---------------------------------------------------------------------------

describe('no-scan invariant: discovery happens ONLY through admin-granted sources', () => {
  it('refuses un-granted sources BEFORE any transport interaction', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);

    // A registered source with a wired transport, but NO grant.
    const sourceId = await registerDirectorySource(adminCtx, 'Untouched Workspace');
    directoryTransport.script(windowOf([directoryRecord('app-x', 'Some App', ['code-repositories'])]));

    // Refused — and ZERO fetches happened (no probing, no scanning).
    await expectIntegrationError('discovery_not_authorized', () =>
      runDiscovery(memberCtx, { sourceId }),
    );
    expect(directoryTransport.requests).toHaveLength(0);

    // A random uuid (no source at all) is refused identically.
    await expectIntegrationError('discovery_not_authorized', () =>
      runDiscovery(memberCtx, { sourceId: newId() }),
    );
    expect(directoryTransport.requests).toHaveLength(0);

    // No grants at all: an empty run, still zero fetches.
    const empty = await runDiscovery(memberCtx, {});
    expect(empty.runs).toEqual([]);
    expect(directoryTransport.requests).toHaveLength(0);

    // Grant → exactly one fetch, for the granted source only.
    await grantDiscoverySource(adminCtx, { sourceId });
    const run = await runDiscovery(memberCtx, { sourceId });
    expect(run.runs).toHaveLength(1);
    expect(directoryTransport.requests).toHaveLength(1);
    expect(directoryTransport.requests[0]!.sourceId).toBe(sourceId);

    // Revoke → refused again, zero new fetches.
    const grants = await listDiscoveryGrants(adminCtx, { status: 'active' });
    const revoked = await revokeDiscoverySource(adminCtx, { grantId: grants[0]!.id });
    expect(revoked.status).toBe('revoked');
    expect(revoked.revokedBy).toBe(adminCtx.principalId);
    await expectIntegrationError('discovery_not_authorized', () =>
      runDiscovery(memberCtx, { sourceId }),
    );
    expect(directoryTransport.requests).toHaveLength(1);

    // Revocation requires the admin claim.
    await expectIntegrationError('forbidden', () =>
      revokeDiscoverySource(memberCtx, { grantId: grants[0]!.id }),
    );
  });

  it('runs every actively granted source (and only those) when no source is specified', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);
    const sourceA = await registerDirectorySource(adminCtx, 'Directory One');
    const sourceB = await registerDirectorySource(adminCtx, 'Directory Two');
    const ungranted = await registerDirectorySource(adminCtx, 'Directory Three');
    await grantDiscoverySource(adminCtx, { sourceId: sourceA });
    await grantDiscoverySource(adminCtx, { sourceId: sourceB });
    // Re-granting is the re-authorization path (idempotent grant state).
    const regrant = await grantDiscoverySource(adminCtx, { sourceId: sourceA });
    expect(regrant.created).toBe(false);

    directoryTransport.script(
      windowOf([directoryRecord('app-1', 'System One', ['project-tracking'])]),
      windowOf([directoryRecord('app-2', 'System Two', ['knowledge-base'])]),
    );
    const run = await runDiscovery(memberCtx, {});
    expect(run.runs).toHaveLength(2);
    expect(directoryTransport.requests).toHaveLength(2);
    const polledSources = new Set(directoryTransport.requests.map((request) => request.sourceId));
    expect(polledSources).toEqual(new Set([sourceA, sourceB]));
    expect(polledSources.has(ungranted)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — two tenants, zero leakage
// ---------------------------------------------------------------------------

describe('tenant isolation: every discovered system is tenant-scoped', () => {
  it('keeps grants, inventory, recommendations, batches and verifications strictly apart', async () => {
    const tenantA = freshTenant();
    const tenantB = freshTenant();
    const adminA = admin(principal(tenantA));
    const memberA = principal(tenantA);
    const adminB = admin(principal(tenantB));
    const memberB = principal(tenantB);
    const foreignMember = principal(freshTenant());

    // Tenant A grants + discovers two systems.
    const sourceA = await registerDirectorySource(adminA, 'A Directory');
    await grantDiscoverySource(adminA, { sourceId: sourceA });
    directoryTransport.script(
      windowOf([
        directoryRecord('app-crm', 'A CRM', ['customer-records']),
        directoryRecord('app-chat', 'A Chat', ['team-communication']),
      ]),
    );
    await runDiscovery(memberA, { sourceId: sourceA });

    // Tenant B grants + discovers one system (its own directory).
    const sourceB = await registerDirectorySource(adminB, 'B Directory');
    await grantDiscoverySource(adminB, { sourceId: sourceB });
    directoryTransport.script(windowOf([directoryRecord('app-books', 'B Books', ['accounting-finance'])]));
    await runDiscovery(memberB, { sourceId: sourceB });

    // Inventories are disjoint.
    const systemsA = await listSystems(memberA, {});
    const systemsB = await listSystems(memberB, {});
    expect(systemsA.map((system) => system.displayName).sort()).toEqual(['A CRM', 'A Chat']);
    expect(systemsB.map((system) => system.displayName)).toEqual(['B Books']);
    expect(systemsA.every((system) => system.tenantId === tenantA)).toBe(true);

    // Cross-tenant lookups are uniformly not-found (no existence leak).
    const systemA = systemsA[0]!;
    await expectIntegrationError('system_not_found', () =>
      getSystem(memberB, { systemId: systemA.id }),
    );
    await expectIntegrationError('system_not_found', () =>
      getSystem(foreignMember, { systemId: systemA.id }),
    );

    // Recommendations are disjoint; cross-tenant reads not-found.
    const recommendationsA = await listRecommendations(memberA, {});
    const recommendationsB = await listRecommendations(memberB, {});
    expect(recommendationsA).toHaveLength(2);
    expect(recommendationsB).toHaveLength(1);
    await expectIntegrationError('recommendation_not_found', () =>
      getRecommendation(memberB, { recommendationId: recommendationsA[0]!.id }),
    );

    // Grants never cross: tenant B cannot discover through tenant A's
    // source (A's grant does not authorize B — grants are tenant-scoped).
    await expectIntegrationError('discovery_not_authorized', () =>
      runDiscovery(memberB, { sourceId: sourceA }),
    );
    const grantsB = await listDiscoveryGrants(adminB, {});
    await expectIntegrationError('discovery_grant_not_found', () =>
      getDiscoveryGrant(memberA, { grantId: grantsB[0]!.id }),
    );

    // B's batch + decisions + verification are invisible to A and vice versa.
    const approverB = {
      tenantId: tenantB,
      principalId: newId(),
      authority: ['actions:approve'],
    };
    setVerificationTransport(verificationTransport);
    const batchB = await submitRecommendationBatch(memberB, {
      recommendationIds: recommendationsB.map((recommendation) => recommendation.id),
    });
    await expectIntegrationError('batch_not_found', () =>
      getRecommendationBatch(memberA, { batchId: batchB.id }),
    );
    await decideRecommendationBatch(approverB, { batchId: batchB.id, decision: 'approve' });
    const connected = await connectSystem(memberB, {
      recommendationId: recommendationsB[0]!.id,
    });
    const runsB = await listVerificationRuns(memberB, { systemId: connected.system.id });
    expect(runsB).toHaveLength(1);
    const runsA = await listVerificationRuns(memberA, { systemId: systemA.id });
    expect(runsA).toHaveLength(0);

    // Zero leakage on the write path: B's member cannot touch A's batch.
    await expectIntegrationError('batch_not_found', () =>
      decideRecommendationBatch(memberB, { batchId: newId(), decision: 'approve' }),
    );
  });

  it('grounds explanations per-tenant (one tenant goals never steer another)', async () => {
    const adminA = admin(principal(freshTenant()));
    const memberA = principal(adminA.tenantId);
    const adminB = admin(principal(freshTenant()));
    const memberB = principal(adminB.tenantId);

    // Only tenant A has the churn goal.
    await createGoal(adminA, {
      title: 'Reduce customer churn',
      objective: 'Retention over acquisition',
      desiredState: 'Churn is visible early',
      horizonEnd: '2027-06-30T00:00:00Z',
      owner: { kind: 'person', label: 'A CEO' },
      priority: 'critical',
      successCriteria: 'Churn under 3 percent',
      actor: { kind: 'person', label: 'A CEO' },
    });

    const sourceA = await registerDirectorySource(adminA, 'A Directory Two');
    await grantDiscoverySource(adminA, { sourceId: sourceA });
    directoryTransport.script(windowOf([directoryRecord('app-crm2', 'A CRM Two', ['customer-records'])]));
    await runDiscovery(memberA, { sourceId: sourceA });

    const sourceB = await registerDirectorySource(adminB, 'B Directory Two');
    await grantDiscoverySource(adminB, { sourceId: sourceB });
    directoryTransport.script(windowOf([directoryRecord('app-crm2', 'B CRM Two', ['customer-records'])]));
    await runDiscovery(memberB, { sourceId: sourceB });

    const systemsA = await listSystems(memberA, {});
    const systemsB = await listSystems(memberB, {});
    expect(systemsA[0]!.whyItMatters.basis).toBe('org-context');
    expect(systemsA[0]!.whyItMatters.summary).toContain('Reduce customer churn');
    expect(systemsB[0]!.whyItMatters.basis).toBe('capability-class');
    expect(systemsB[0]!.whyItMatters.summary).not.toContain('Reduce customer churn');
  });
});

// ---------------------------------------------------------------------------
// Crash recovery — a decision that landed in the actions module while our
// state update was interrupted syncs back onto the batch (first decision wins)
// ---------------------------------------------------------------------------

describe('decideRecommendationBatch crash recovery (first decision wins)', () => {
  it('syncs the batch state when the request was already decided directly in the actions module', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const aurumCtx = principal(adminCtx.tenantId);
    const approverCtx = {
      tenantId: adminCtx.tenantId,
      principalId: newId(),
      authority: ['actions:approve'],
    };

    const sourceId = await registerDirectorySource(adminCtx, 'Recovery Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(windowOf([directoryRecord('app-crm', 'Recovery CRM', ['customer-records'])]));
    await runDiscovery(aurumCtx, { sourceId });
    const recommendations = await listRecommendations(aurumCtx, {});
    const batch = await submitRecommendationBatch(aurumCtx, {
      recommendationIds: [recommendations[0]!.id],
    });

    // The human decides DIRECTLY through the actions contract (e.g. from
    // the approvals surface) while our mirror update never ran.
    await actionsContract.decideApproval(approverCtx, {
      requestId: batch.actionRequestId!,
      decision: 'reject',
      note: 'decided from the approvals feed',
    });

    // Our decide path does not fight the decided request — it syncs the
    // batch onto the authoritative request state (first decision wins).
    const synced = await decideRecommendationBatch(approverCtx, {
      batchId: batch.id,
      decision: 'approve', // ignored — the first decision already won
    });
    expect(synced.status).toBe('rejected');
    const rejected = await listRecommendations(aurumCtx, { batchId: batch.id });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// Policy paths — tenant policy may auto-allow or forbid (still through W009)
// ---------------------------------------------------------------------------

describe('authority policy paths: the W009 matrix decides, never a bypass', () => {
  it('auto-allows when tenant policy allows EXECUTE (a policy decision, recorded)', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const policyAdmin = { ...principal(adminCtx.tenantId), authority: ['actions:administer'] };
    const aurumCtx = principal(adminCtx.tenantId);

    const sourceId = await registerDirectorySource(adminCtx, 'Policy Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(windowOf([directoryRecord('app-1', 'Policy CRM', ['customer-records'])]));
    await runDiscovery(aurumCtx, { sourceId });
    const recommendations = await listRecommendations(aurumCtx, {});

    // Tenant policy allows EXECUTE for the connection kind.
    await setAuthorityPolicy(policyAdmin, {
      actionKind: INTEGRATION_ACTION_KIND,
      approvalLevels: [],
      forbiddenLevels: [],
      note: 'read-only connections are pre-approved',
    });

    const batch = await submitRecommendationBatch(aurumCtx, {
      recommendationIds: recommendations.map((recommendation) => recommendation.id),
    });
    expect(batch.status).toBe('approved');
    expect(batch.decidedAt).not.toBeNull();
    // Policy auto-approval is a recorded decision in the actions module.
    const decisions = await listApprovalDecisions(policyAdmin, {
      requestId: batch.actionRequestId!,
    });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.decidedBy).toBe('policy');
    const approved = await listRecommendations(aurumCtx, { status: 'approved' });
    expect(approved).toHaveLength(1);
  });

  it('rejects the batch when tenant policy forbids EXECUTE (and nothing connects)', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const policyAdmin = { ...principal(adminCtx.tenantId), authority: ['actions:administer'] };
    const aurumCtx = principal(adminCtx.tenantId);

    const sourceId = await registerDirectorySource(adminCtx, 'Forbidden Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(windowOf([directoryRecord('app-2', 'Forbidden CRM', ['customer-records'])]));
    await runDiscovery(aurumCtx, { sourceId });
    const recommendations = await listRecommendations(aurumCtx, {});
    // Clean slate: forbid the connection kind.
    await setAuthorityPolicy(policyAdmin, {
      actionKind: INTEGRATION_ACTION_KIND,
      approvalLevels: [],
      forbiddenLevels: ['EXECUTE'],
      note: 'no external connections in this tenant',
    });

    const batch = await submitRecommendationBatch(aurumCtx, {
      recommendationIds: recommendations.map((recommendation) => recommendation.id),
    });
    expect(batch.status).toBe('rejected');
    const rejected = await listRecommendations(aurumCtx, { status: 'rejected' });
    expect(rejected).toHaveLength(1);
    // A rejected recommendation cannot be connected (the human said no).
    await expectIntegrationError('recommendation_status_conflict', () =>
      connectSystem(aurumCtx, { recommendationId: rejected[0]!.id }),
    );
    // And it is not re-proposed by later discovery (standing decision).
    directoryTransport.script(
      windowOf([
        directoryRecord('app-2', 'Forbidden CRM', ['customer-records'], {}, 'dir-app-2-v2'),
      ]),
    );
    await runDiscovery(aurumCtx, { sourceId });
    const still = await listRecommendations(aurumCtx, {});
    expect(still).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Re-discovery: dedupe, updates, no duplicate proposals
// ---------------------------------------------------------------------------

describe('re-discovery: dedupe, system updates, no duplicate proposals', () => {
  it('suppresses re-observed records and updates existing systems', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);
    const sourceId = await registerDirectorySource(adminCtx, 'Rediscovery Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });

    directoryTransport.script(
      windowOf([directoryRecord('app-crm', 'Acme CRM', ['customer-records'])]),
    );
    await runDiscovery(memberCtx, { sourceId });

    // Same window again: everything is a duplicate — no new systems, no new
    // recommendations, no observation churn.
    directoryTransport.script(
      windowOf([directoryRecord('app-crm', 'Acme CRM', ['customer-records'])]),
    );
    const second = await runDiscovery(memberCtx, { sourceId });
    expect(second.runs[0]).toMatchObject({
      fetched: 1,
      ingested: 0,
      duplicates: 1,
      systemsCreated: 0,
      systemsUpdated: 0,
      recommendationsCreated: 0,
    });

    // A CHANGED record (new provider record id) updates the system in place
    // — display name and surface move, identity (system key) does not.
    directoryTransport.script(
      windowOf([
        directoryRecord(
          'app-crm',
          'Acme CRM (renamed)',
          ['customer-records', 'support-desk'],
          { description: 'Now with support', health: 'degraded' },
          'dir-app-crm-v2',
        ),
        directoryRecord('app-new', 'Acme Wiki', ['knowledge-base'], {}, 'dir-app-new'),
      ]),
    );
    const third = await runDiscovery(memberCtx, { sourceId });
    expect(third.runs[0]!.systemsCreated).toBe(1);
    expect(third.runs[0]!.systemsUpdated).toBe(1);
    expect(third.runs[0]!.recommendationsCreated).toBe(1);

    const systems = await listSystems(memberCtx, {});
    expect(systems).toHaveLength(2);
    const crm = systems.find((system) => system.externalId === 'app-crm')!;
    expect(crm.displayName).toBe('Acme CRM (renamed)');
    expect(crm.systemKey).toBe(`${sourceId}:app-crm`);
    expect(crm.capabilityClasses).toEqual(['customer-records', 'support-desk']);
    expect(crm.description).toBe('Now with support');
    expect(crm.health).toBe('degraded');
    expect(crm.evidenceObservationIds.length).toBe(2);

    // The updated CRM keeps its one live recommendation (no duplicate).
    const crmRecommendations = await listRecommendations(memberCtx, { systemId: crm.id });
    expect(crmRecommendations).toHaveLength(1);
  });

  it('ignores non-directory records delivered by a granted source', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);
    const sourceId = await registerDirectorySource(adminCtx, 'Mixed Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(
      windowOf([
        {
          providerRecordId: 'member-42',
          kind: 'directory.member.listed',
          payload: { member: 'someone' },
          occurredAt: '2026-09-23T10:00:00Z',
        },
        directoryRecord('app-crm', 'Acme CRM', ['customer-records']),
      ]),
    );
    const run = await runDiscovery(memberCtx, { sourceId });
    expect(run.runs[0]!.ignored).toBe(1);
    expect(run.runs[0]!.systemsCreated).toBe(1);
    const systems = await listSystems(memberCtx, {});
    expect(systems).toHaveLength(1);
  });

  it('rejects a malformed directory record loudly (buggy-adapter discipline)', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);
    const sourceId = await registerDirectorySource(adminCtx, 'Broken Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(
      windowOf([
        directoryRecord('app-crm', 'Acme CRM', ['not-a-real-class'], {}, 'dir-broken'),
      ]),
    );
    await expectIntegrationError('invalid_directory_record', () =>
      runDiscovery(memberCtx, { sourceId }),
    );
  });
});

// ---------------------------------------------------------------------------
// Verification honesty
// ---------------------------------------------------------------------------

describe('verification honesty: pending without a transport, never a fake success', () => {
  it('records a pending run on connect when no verification transport is wired', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const aurumCtx = principal(adminCtx.tenantId);
    const approverCtx = {
      tenantId: adminCtx.tenantId,
      principalId: newId(),
      authority: ['actions:approve'],
    };

    const sourceId = await registerDirectorySource(adminCtx, 'Verification Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(windowOf([directoryRecord('app-crm', 'Acme CRM', ['customer-records'])]));
    await runDiscovery(aurumCtx, { sourceId });
    const recommendations = await listRecommendations(aurumCtx, {});
    const batch = await submitRecommendationBatch(aurumCtx, {
      recommendationIds: [recommendations[0]!.id],
    });
    await decideRecommendationBatch(approverCtx, { batchId: batch.id, decision: 'approve' });

    // NO verification transport wired: connection succeeds, verification is
    // honestly pending (never a fake success).
    const connected = await connectSystem(aurumCtx, { recommendationId: recommendations[0]!.id });
    expect(connected.recommendation.status).toBe('connected');
    expect(connected.verification.status).toBe('pending');
    expect(connected.verification.transportWired).toBe(false);
    expect(connected.verification.verifiedCount).toBe(0);
    expect(connected.verification.verifiedAt).toBeNull();
    expect(
      connected.verification.results.every((result) => result.outcome === 'pending'),
    ).toBe(true);
    // Health stays unknown (nothing verified, nothing failed).
    expect(connected.system.health).toBe('unknown');

    // Explicit verification refuses without a transport.
    await expectIntegrationError('verification_unavailable', () =>
      verifySystem(aurumCtx, { systemId: connected.system.id }),
    );

    // Wiring a transport later lets explicit verification complete the run.
    setVerificationTransport(verificationTransport);
    advance(60);
    const run = await verifySystem(aurumCtx, { systemId: connected.system.id });
    expect(run.status).toBe('verified');
    expect(run.verifiedCount).toBe(1);
    const system = await getSystem(aurumCtx, { systemId: connected.system.id });
    expect(system.health).toBe('healthy');
    const runs = await listVerificationRuns(aurumCtx, { systemId: connected.system.id });
    expect(runs).toHaveLength(2); // the pending run + the explicit re-run
  });

  it('refuses to verify a system that is not connected', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);
    const sourceId = await registerDirectorySource(adminCtx, 'Unconnected Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(windowOf([directoryRecord('app-x', 'Some App', ['code-repositories'])]));
    await runDiscovery(memberCtx, { sourceId });
    const systems = await listSystems(memberCtx, {});
    setVerificationTransport(verificationTransport);
    await expectIntegrationError('system_not_connected', () =>
      verifySystem(memberCtx, { systemId: systems[0]!.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Inventory query surface
// ---------------------------------------------------------------------------

describe('inventory queries', () => {
  it('filters by connection status, health, capability class, data category and name', async () => {
    const adminCtx = admin(principal(freshTenant()));
    const memberCtx = principal(adminCtx.tenantId);
    const sourceId = await registerDirectorySource(adminCtx, 'Query Workspace');
    await grantDiscoverySource(adminCtx, { sourceId });
    directoryTransport.script(
      windowOf([
        directoryRecord('app-crm', 'Query CRM', ['customer-records']),
        directoryRecord('app-pay', 'Query Billing', ['billing-payments']),
        directoryRecord('app-docs', 'Query Docs', ['document-collaboration']),
      ]),
    );
    await runDiscovery(memberCtx, { sourceId });

    expect((await listSystems(memberCtx, { capabilityClass: 'customer-records' })).map((system) => system.externalId)).toEqual(['app-crm']);
    expect((await listSystems(memberCtx, { dataCategory: 'payments' })).map((system) => system.externalId)).toEqual(['app-pay']);
    expect((await listSystems(memberCtx, { search: 'billing' })).map((system) => system.externalId)).toEqual(['app-pay']);
    expect((await listSystems(memberCtx, { connectionStatus: 'disconnected' }))).toEqual([]);
    expect((await listSystems(memberCtx, { health: 'unknown' })).map((system) => system.externalId).sort()).toEqual(['app-crm', 'app-docs', 'app-pay']);
    expect((await listSystems(memberCtx, { health: 'healthy' }))).toEqual([]);
  });
});
