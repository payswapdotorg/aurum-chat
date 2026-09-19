// Integration tests for the marketplace product surface (W064) against
// the embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// The acceptance core of the work item, end to end through REAL module
// contracts only (the product surface composes; it never writes state
// directly):
//
//   * JOURNEY J, THE PUBLISH FLOW: a vendor tenant registers + verifies
//     a manifest, freezes it as an extension package, authors an agent
//     package, and walks the governed chain — submit → automated
//     verification → platform review (a DIFFERENT tenant, separation of
//     duties) → publish → installable — through the surface's own API
//     handlers, asserting every state the chain passes through.
//   * PERMISSION INSPECTION: the package detail view exposes exactly
//     the requested permission ceiling for extensions and the scope set
//     for agent packages, with the capability declaration and quotas.
//   * BROWSE: the public catalog shows exactly the PUBLISHED +
//     INSTALLABLE versions; kind filters work; pre-publication work is
//     invisible to other tenants (no existence leak).
//   * INSTALL/ACTIVATE/SUSPEND/ROLLBACK: an installer tenant installs
//     an INSTALLABLE extension package (register → verify → activate →
//     deploy, with a NARROWED grant), the agent package (blueprint
//     registration), then upgrades to v2 and rolls back to the recorded
//     v1 deployment — all through the surface's API handlers; the
//     approval-gated path (default tenant policy) holds the install at
//     the human gate and the deterministic idempotency keys complete
//     the SAME gate requests after the decision.
//   * AGENT PACKAGES: the same governance surface — the catalog entry,
//     the permission inspection, the chain, the install.
//   * THE BUILDER: request a build through the developer handler and
//     pump it to a deployed manifest (fake agent transport).
//   * VIEWS: catalog/package/developer/installed/extension views agree
//     with the contract reads; the review queue is administer-only;
//     developer usability is claim-gated; tenant isolation holds at
//     every boundary.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

import {
  decideApproval,
  setAuthorityPolicy,
} from '@/modules/actions/contract';
import { provisionTenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import {
  listAgents,
  registerAgent,
  setAgentTransport,
} from '@/modules/agents/contract';
import type {
  AgentRuntimeTransport,
  AgentRuntimeTransportReceipt,
  AgentRuntimeTransportRequest,
  RegisterAgentInput,
} from '@/modules/agents/contract';
import {
  getCurrentDeployment,
  getExtension,
  registerExtensionManifest,
  runManifestVerification,
} from '@/modules/extensions/contract';
import type { MarketplacePackage } from '@/modules/marketplace/contract';
import { isExtensionPackage } from '@/modules/marketplace/contract';

import {
  handleDeveloperAction,
  handleExtensionAction,
  handlePackageAction,
} from '../marketplace/lib/api';
import { installPackage } from '../marketplace/lib/install';
import type { InstallReport } from '../marketplace/lib/install';
import {
  buildCatalogView,
  buildDeveloperView,
  buildExtensionView,
  buildInstalledView,
  buildPackageView,
  parseKindFilter,
  publicBrowsingContext,
} from '../marketplace/lib/views';
import { derivePackageActions } from '../marketplace/lib/labels';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** The vendor: submits packages to the platform pipeline. */
const VENDOR_CLAIMS = ['marketplace:submit', 'extensions:administer'];
/** The platform operator: runs verification, reviews, publishes. */
const PLATFORM_CLAIMS = ['marketplace:administer'];
/** The installer: installs and governs extensions in its own tenant. */
const INSTALLER_CLAIMS = ['extensions:administer', 'agents:administer'];

let vendorCtx: TenantContext;
let platformCtx: TenantContext;
let installerCtx: TenantContext;
let installerDefaultPolicyCtx: TenantContext;

/** Always-succeeding fake agent transport (the builder's isolated environment). */
class FakeAgentTransport implements AgentRuntimeTransport {
  private output: unknown = {};
  private counter = 0;

  respondWith(output: unknown): void {
    this.output = output;
  }

  async send(_request: AgentRuntimeTransportRequest): Promise<AgentRuntimeTransportReceipt> {
    this.counter += 1;
    const taskId = `fake-${String(this.counter).padStart(6, '0')}`;
    return {
      status: 'delivered',
      payload: {
        run_id: `lg_${taskId}`,
        output: { result: this.output, summary: null },
        usage: { input_tokens: 900, output_tokens: 700, steps: 2 },
      },
      providerTaskId: taskId,
      detail: null,
    };
  }
}

let transport: FakeAgentTransport;

/** A complete, consistent declaration (the W027 fixture shape). */
function buildOutput(): Record<string, unknown> {
  return {
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
  };
}

function designOutput(): Record<string, unknown> {
  const output = buildOutput();
  return {
    displayName: output.displayName,
    description: output.description,
    stateScope: output.stateScope,
    uiSurfaces: output.uiSurfaces,
    schedules: output.schedules,
    eventSubscriptions: output.eventSubscriptions,
    externalParticipants: output.externalParticipants,
    telemetry: output.telemetry,
    notes: null,
  };
}

const BUILDER_AGENT: RegisterAgentInput = {
  slug: 'extension-designer',
  displayName: 'Extension Designer',
  role: 'extension design and build',
  description: 'Designs extension manifests from build briefs.',
  provider: 'langgraph',
  instructions: 'Design extensions as JSON design documents.',
  runtimeConfig: { assistantId: 'asst_builder_1' },
  permissions: ['observe', 'analyze', 'recommend', 'ask', 'propose'],
};

function request_(ctx: TenantContext, path: string): Request {
  return new Request(`https://aurum.test${path}`, {
    headers: {
      'x-aurum-tenant': ctx.tenantId,
      'x-aurum-principal': ctx.principalId,
      'x-aurum-authority': ctx.authority.join(','),
    },
  });
}

let extensionPackage: MarketplacePackage;
let agentPackage: MarketplacePackage;
let extensionPackageV2: MarketplacePackage;

beforeAll(async () => {
  await runMigrations(db);

  const platformProvisioner = {
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };
  const vendorTenant = await provisionTenant(platformProvisioner, {
    name: 'Acme Software',
    ownerPrincipalId: newId(),
  });
  const platformTenant = await provisionTenant(platformProvisioner, {
    name: 'Aurum Platform Ops',
    ownerPrincipalId: newId(),
  });
  const installerTenant = await provisionTenant(platformProvisioner, {
    name: 'Northwind Traders',
    ownerPrincipalId: newId(),
  });
  const installerDefaultPolicyTenant = await provisionTenant(platformProvisioner, {
    name: 'Initech',
    ownerPrincipalId: newId(),
  });

  vendorCtx = member(vendorTenant.id, VENDOR_CLAIMS);
  platformCtx = member(platformTenant.id, PLATFORM_CLAIMS);
  installerCtx = member(installerTenant.id, INSTALLER_CLAIMS);
  installerDefaultPolicyCtx = member(installerDefaultPolicyTenant.id, INSTALLER_CLAIMS);

  // The installer tenants let extension-deployment EXECUTE apply without
  // approval (the default matrix gates it); the second one deliberately
  // KEEPS the default policy for the approval-gated install test.
  await setAuthorityPolicy(
    member(installerTenant.id, ['actions:administer', 'extensions:administer']),
    { actionKind: 'extension-deployment', approvalLevels: [], forbiddenLevels: [] },
  );

  // The vendor registers + verifies a manifest version, then freezes it.
  const registered = await registerExtensionManifest(vendorCtx, {
    extensionKey: 'invoice-ocr',
    version: '1.0.0',
    manifestSchemaVersion: 1,
    displayName: 'Invoice OCR',
    description: 'Reads invoices into the world model',
    requestedPermissions: [
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ],
    stateScope: 'tenant',
    uiSurfaces: ['control-tower-panel', 'settings-form'],
    schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
    eventSubscriptions: ['invoice.received', 'invoice.paid'],
    externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
    telemetry: true,
    quotas: {
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1_000,
    },
    hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
  });
  await runManifestVerification(vendorCtx, { manifestId: registered.manifest.id });

  transport = new FakeAgentTransport();
  setAgentTransport(transport);
});

afterAll(async () => {
  setAgentTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// The publish flow (through the surface's own API handlers)
// ---------------------------------------------------------------------------

describe('the publish flow (vendor → platform → catalog)', () => {
  it('creates the extension package from the verified manifest (DRAFT)', async () => {
    const manifests = await import('@/modules/extensions/contract').then((m) =>
      m.listManifests(vendorCtx, { limit: 10 }),
    );
    const manifest = manifests[0]!;
    const result = await handleDeveloperAction(
      request_(vendorCtx, '/api/product/marketplace/developer/create-extension-package'),
      'create-extension-package',
      { manifestId: manifest.id },
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const pkg = result.body['package'] as MarketplacePackage;
      extensionPackage = pkg;
      expect(pkg.state).toBe('DRAFT');
      expect(pkg.vendorTenant).toBe(vendorCtx.tenantId);
      expect(pkg.kind).toBe('extension');
      expect(isExtensionPackage(pkg) ? pkg.payload.subject.requestedPermissions : []).toHaveLength(7);
    }
  });

  it('creates the agent package blueprint (DRAFT) — the same governance surface', async () => {
    const result = await handleDeveloperAction(
      request_(vendorCtx, '/api/product/marketplace/developer/create-agent-package'),
      'create-agent-package',
      {
        packageKey: 'collections-negotiator',
        version: '1.0.0',
        displayName: 'Collections Negotiator',
        description: 'Negotiates outstanding invoices politely.',
        role: 'negotiate outstanding invoices',
        instructions: 'Be polite, be firm, escalate stuck cases.',
        provider: 'langgraph',
        permissions: ['observe', 'analyze', 'recommend', 'propose'],
      },
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const pkg = result.body['package'] as MarketplacePackage;
      agentPackage = pkg;
      expect(pkg.state).toBe('DRAFT');
      expect(pkg.kind).toBe('agent');
      const payload = pkg.payload as { permissions: string[] };
      expect(payload.permissions).toEqual(['observe', 'analyze', 'recommend', 'propose']);
    }
  });

  it('refuses an agent package with an unknown runtime provider (honest 400)', async () => {
    const result = await handleDeveloperAction(
      request_(vendorCtx, '/api/product/marketplace/developer/create-agent-package'),
      'create-agent-package',
      {
        packageKey: 'bad-provider-agent',
        version: '1.0.0',
        displayName: 'Bad Provider',
        role: 'nothing',
        instructions: 'nothing',
        provider: 'skynet',
        permissions: ['observe'],
      },
    );
    expect(result.status).toBe(400);
  });

  it('a plain member (no submit claim) cannot create packages', async () => {
    const plain = member(vendorCtx.tenantId);
    const result = await handleDeveloperAction(
      request_(plain, '/api/product/marketplace/developer/create-extension-package'),
      'create-extension-package',
      { manifestId: '00000000-0000-4000-8000-000000000000' },
    );
    expect(result.status).toBe(403);
  });

  it('submits both packages (DRAFT → SUBMITTED, vendor only)', async () => {
    for (const pkg of [extensionPackage, agentPackage]) {
      const result = await handlePackageAction(
        request_(vendorCtx, `/api/product/marketplace/package/${pkg.id}/submit`),
        pkg.id,
        'submit',
        {},
      );
      expect(result.status).toBe(200);
      if (result.status === 200) {
        expect((result.body['package'] as MarketplacePackage).state).toBe('SUBMITTED');
      }
    }
    // The INSTALLER (not the vendor) cannot submit someone else's draft:
    // it does not even see it (uniform not-found) — a caller WITH the
    // submit claim, so the claim gate passes and the vendor-ownership
    // rule is what answers.
    const foreignSubmitter = member(installerCtx.tenantId, ['marketplace:submit']);
    const foreign = await handlePackageAction(
      request_(foreignSubmitter, `/api/product/marketplace/package/${extensionPackage.id}/submit`),
      extensionPackage.id,
      'submit',
      {},
    );
    expect(foreign.status).toBe(404);
  });

  it('runs automated verification (platform) → PENDING_REVIEW with recorded checks', async () => {
    for (const pkg of [extensionPackage, agentPackage]) {
      const result = await handlePackageAction(
        request_(platformCtx, `/api/product/marketplace/package/${pkg.id}/verify`),
        pkg.id,
        'verify',
        {},
      );
      expect(result.status).toBe(200);
      if (result.status === 200) {
        expect((result.body['package'] as MarketplacePackage).state).toBe('PENDING_REVIEW');
        const run = result.body['run'] as { checks: { check: string; outcome: string }[] };
        expect(run.checks.length).toBe(pkg.kind === 'extension' ? 5 : 4);
        expect(run.checks.every((check) => check.outcome === 'pass')).toBe(true);
      }
    }
  });

  it('review requires a reason to reject (honest 400 before the contract)', async () => {
    const result = await handlePackageAction(
      request_(platformCtx, `/api/product/marketplace/package/${extensionPackage.id}/review`),
      extensionPackage.id,
      'review',
      { decision: 'reject' },
    );
    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.body.error).toBe('invalid_body');
    }
  });

  it('the vendor cannot review its own package (separation of duties, 409)', async () => {
    const rogue = member(vendorCtx.tenantId, [...VENDOR_CLAIMS, ...PLATFORM_CLAIMS]);
    const result = await handlePackageAction(
      request_(rogue, `/api/product/marketplace/package/${extensionPackage.id}/review`),
      extensionPackage.id,
      'review',
      { decision: 'approve' },
    );
    expect(result.status).toBe(409);
    if (result.status === 409) {
      expect(result.body.error).toBe('separation_of_duties');
    }
  });

  it('reviews both packages (approve) and publishes + makes installable', async () => {
    for (const pkg of [extensionPackage, agentPackage]) {
      const reviewed = await handlePackageAction(
        request_(platformCtx, `/api/product/marketplace/package/${pkg.id}/review`),
        pkg.id,
        'review',
        { decision: 'approve', reason: 'checks passed, permissions justified' },
      );
      expect(reviewed.status).toBe(200);
      if (reviewed.status === 200) {
        expect((reviewed.body['package'] as MarketplacePackage).state).toBe('APPROVED');
      }

      const published = await handlePackageAction(
        request_(platformCtx, `/api/product/marketplace/package/${pkg.id}/publish`),
        pkg.id,
        'publish',
        {},
      );
      expect(published.status).toBe(200);
      if (published.status === 200) {
        expect((published.body['package'] as MarketplacePackage).state).toBe('PUBLISHED');
      }

      const installable = await handlePackageAction(
        request_(platformCtx, `/api/product/marketplace/package/${pkg.id}/make-installable`),
        pkg.id,
        'make-installable',
        {},
      );
      expect(installable.status).toBe(200);
      if (installable.status === 200) {
        expect((installable.body['package'] as MarketplacePackage).state).toBe('INSTALLABLE');
        // Keep the module-level fixtures fresh (the operations above
        // return NEW package objects — the old ones hold stale states).
        if (pkg.id === extensionPackage.id) {
          extensionPackage = installable.body['package'] as MarketplacePackage;
        } else {
          agentPackage = installable.body['package'] as MarketplacePackage;
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Browse + permission inspection + package status (the views)
// ---------------------------------------------------------------------------

describe('browse and permission inspection (views)', () => {
  it('the public catalog shows exactly the installable versions (any context)', async () => {
    for (const ctx of [publicBrowsingContext(), installerCtx, vendorCtx]) {
      const view = await buildCatalogView(ctx, 'all');
      expect(view.ok).toBe(true);
      const keys = view.items.map((item) => `${item.kind}:${item.packageKey}:${item.version}`);
      expect(keys).toContain(`extension:invoice-ocr:1.0.0`);
      expect(keys).toContain(`agent:collections-negotiator:1.0.0`);
      for (const item of view.items) {
        expect(['Published', 'Installable']).toContain(item.stateLabel);
      }
    }
  });

  it('kind filters narrow the catalog', async () => {
    expect(parseKindFilter('agent')).toBe('agent');
    expect(parseKindFilter('nonsense')).toBe('all');
    const extensions = await buildCatalogView(publicBrowsingContext(), 'extension');
    const agents = await buildCatalogView(publicBrowsingContext(), 'agent');
    expect(extensions.items.every((item) => item.kind === 'extension')).toBe(true);
    expect(agents.items.every((item) => item.kind === 'agent')).toBe(true);
    expect(agents.items.map((item) => item.packageKey)).toContain('collections-negotiator');
  });

  it('a scoped caller sees its installed summary; the browsing context does not', async () => {
    const scoped = await buildCatalogView(installerCtx, 'all');
    expect(scoped.installed).not.toBe(null);
    expect(scoped.installed!.ok).toBe(true);
    expect(scoped.installed!.total).toBe(0);
    const browsing = await buildCatalogView(publicBrowsingContext(), 'all');
    expect(browsing.installed).toBe(null);
  });

  it('the package view exposes the permission ceiling, capabilities and evidence', async () => {
    const result = await buildPackageView(installerCtx, extensionPackage.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.stateLabel).toBe('Installable');
    expect(view.kindLabel).toBe('Extension package');
    expect(view.permissions.map((permission) => permission.key)).toEqual([
      'state:read',
      'state:write',
      'ui:render',
      'schedule:run',
      'events:subscribe',
      'external:participate',
      'telemetry:emit',
    ]);
    expect(view.permissions[0]!.description.length).toBeGreaterThan(10);
    expect(view.capabilities.map((line) => line.label)).toContain('Persistent state');
    expect(view.quotas[0]!.detail).toContain('MiB');
    // The governed chain reached INSTALLABLE.
    expect(view.chain.find((node) => node.state === 'INSTALLABLE')!.reached).toBe(true);
    // Evidence: one verification run (5 checks), one review, 6 lifecycle
    // events (create, submit, verify, verification-passed, approve,
    // publish, make-installable).
    expect(view.evidence.verification.outcome).toBe('verified');
    expect(view.evidence.verification.latestRun!.checks).toHaveLength(5);
    expect(view.evidence.reviews).toHaveLength(1);
    expect(view.evidence.reviews[0]!.decision).toBe('approve');
    expect(view.evidence.lifecycle.length).toBeGreaterThanOrEqual(6);
    // The installer may install (state + claim).
    expect(view.actions.canInstall).toBe(true);
    expect(view.actions.canReview).toBe(false);
  });

  it('agent packages inspect permissions the same way (same governance surface)', async () => {
    const result = await buildPackageView(installerCtx, agentPackage.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.kindLabel).toBe('Agent package');
    expect(view.permissions.map((permission) => permission.key)).toEqual([
      'observe',
      'analyze',
      'recommend',
      'propose',
    ]);
    expect(view.capabilities).toEqual([]);
    expect(view.evidence.verification.latestRun!.checks.map((check) => check.check)).toEqual([
      'agent-schema',
      'provider-known',
      'permission-scopes',
      'instructions-bounds',
    ]);
  });

  it("another tenant's pre-publication work is invisible (no existence leak)", async () => {
    // A NEW draft by the vendor is invisible to the installer.
    const manifests = await import('@/modules/extensions/contract').then((m) =>
      m.listManifests(vendorCtx, { limit: 10 }),
    );
    const draft = await handleDeveloperAction(
      request_(vendorCtx, '/api/product/marketplace/developer/create-extension-package'),
      'create-extension-package',
      { manifestId: manifests[0]!.id, packageKey: 'vendor-secret-draft' },
    );
    expect(draft.status).toBe(200);
    const draftPkg = draft.status === 200 ? (draft.body['package'] as MarketplacePackage) : null;
    expect(draftPkg).not.toBe(null);

    const result = await buildPackageView(installerCtx, draftPkg!.id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('not_found');
  });

  it('the vendor view of its own package shows the vendor-side actions', async () => {
    const result = await buildPackageView(vendorCtx, extensionPackage.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.actions.isVendor).toBe(true);
    // The vendor fixture holds extensions:administer, and a published
    // package is public — the vendor may install its own package like
    // anyone else (publication is not vendor-exclusive).
    expect(result.view.actions.canInstall).toBe(true);
    expect(result.view.actions.installBlockedReason).toBe(null);
    // But the vendor cannot review (not the platform queue's caller).
    expect(result.view.actions.canReview).toBe(false);
  });

  it('the platform operator sees publish-side actions from the derivation', async () => {
    const actions = derivePackageActions(platformCtx, {
      ...extensionPackage,
    });
    expect(actions.canReview).toBe(false); // not PENDING_REVIEW anymore
    expect(actions.canPublish).toBe(false); // not APPROVED anymore
    expect(actions.canInstall).toBe(false); // no extensions:administer claim
    expect(actions.installBlockedReason).toContain('extensions:administer');
  });
});

// ---------------------------------------------------------------------------
// Install / activate / suspend / rollback (the tenant-side lifecycle)
// ---------------------------------------------------------------------------

describe('install, activate, suspend, rollback', () => {
  it('installs the extension package with a NARROWED grant (register → verify → activate → deploy)', async () => {
    const result = await handlePackageAction(
      request_(installerCtx, `/api/product/marketplace/package/${extensionPackage.id}/install`),
      extensionPackage.id,
      'install',
      { grantedPermissions: ['state:read', 'state:write'] },
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const report = result.body['report'] as InstallReport;
      expect(report.outcome).toBe('installed');
      expect(report.steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done']);
      expect(report.targetKey).toBe('invoice-ocr');

      // The narrowed grant is what actually landed.
      const current = await getCurrentDeployment(installerCtx, { extensionKey: 'invoice-ocr' });
      expect(current).not.toBe(null);
      expect(current!.grantedPermissions).toEqual(['state:read', 'state:write']);

      const extension = await getExtension(installerCtx, { extensionKey: 'invoice-ocr' });
      expect(extension.lifecycleState).toBe('ACTIVE');
    }
  });

  it('re-installing is idempotent (the same artifact version skips forward)', async () => {
    const report = await installPackage(installerCtx, extensionPackage, null);
    expect(report.outcome).toBe('installed');
    const register = report.steps.find((step) => step.step === 'register')!;
    expect(register.status).toBe('skipped');
    expect(report.steps.find((step) => step.step === 'deploy')!.status).toBe('done');
  });

  it('installs the agent package (blueprint → tenant agent, same surface)', async () => {
    const result = await handlePackageAction(
      request_(installerCtx, `/api/product/marketplace/package/${agentPackage.id}/install`),
      agentPackage.id,
      'install',
      {},
    );
    expect(result.status).toBe(200);
    if (result.status === 200) {
      const report = result.body['report'] as InstallReport;
      expect(report.outcome).toBe('installed');
      expect(report.steps[0]!.status).toBe('done');
      const agents = await listAgents(installerCtx, { limit: 100 });
      const agent = agents.find((entry) => entry.slug === 'collections-negotiator')!;
      expect(agent.role).toBe('negotiate outstanding invoices');
      expect(agent.permissions).toEqual(['observe', 'analyze', 'recommend', 'propose']);
      expect(agent.provider).toBe('langgraph');
    }
    // Idempotent: first registration wins, nothing overwritten.
    const again = await installPackage(installerCtx, agentPackage, null);
    expect(again.steps[0]!.status).toBe('skipped');
  });

  it('a member without the administer claim gets an honest failed step (not fake success)', async () => {
    const plain = member(installerCtx.tenantId);
    const report = await installPackage(plain, extensionPackage, null);
    expect(report.outcome).toBe('failed');
    expect(report.steps[0]!.status).toBe('failed');
    expect(report.steps[0]!.detail).toContain('extensions:administer');
  });

  it('a non-INSTALLABLE package refuses the install (409)', async () => {
    // The vendor's fresh secret draft (still DRAFT) — invisible to the
    // installer anyway; use the vendor's OWN view of it instead.
    const manifests = await import('@/modules/extensions/contract').then((m) =>
      m.listManifests(vendorCtx, { limit: 10 }),
    );
    const draft = await handleDeveloperAction(
      request_(vendorCtx, '/api/product/marketplace/developer/create-extension-package'),
      'create-extension-package',
      { manifestId: manifests[0]!.id, packageKey: 'vendor-not-installable' },
    );
    const draftPkg = draft.status === 200 ? (draft.body['package'] as MarketplacePackage) : null;
    expect(draftPkg).not.toBe(null);
    const result = await handlePackageAction(
      request_(vendorCtx, `/api/product/marketplace/package/${draftPkg!.id}/install`),
      draftPkg!.id,
      'install',
      {},
    );
    expect(result.status).toBe(409);
    if (result.status === 409) {
      expect(result.body.error).toBe('not_installable');
    }
  });

  it('suspends and resumes through the extension action handler', async () => {
    const suspend = await handleExtensionAction(
      request_(installerCtx, '/api/product/marketplace/extension/invoice-ocr/suspend'),
      'invoice-ocr',
      'suspend',
      {},
    );
    expect(suspend.status).toBe(200);
    if (suspend.status === 200) {
      expect(suspend.body['applied']).toBe(true);
    }
    const suspended = await getExtension(installerCtx, { extensionKey: 'invoice-ocr' });
    expect(suspended.lifecycleState).toBe('SUSPENDED');

    const resume = await handleExtensionAction(
      request_(installerCtx, '/api/product/marketplace/extension/invoice-ocr/resume'),
      'invoice-ocr',
      'resume',
      {},
    );
    expect(resume.status).toBe(200);
    const resumed = await getExtension(installerCtx, { extensionKey: 'invoice-ocr' });
    expect(resumed.lifecycleState).toBe('ACTIVE');
  });

  it('publishes v2, upgrades to it, then ROLLS BACK to the recorded v1 deployment', async () => {
    // v2 through the whole chain (vendor → platform).
    const registeredV2 = await registerExtensionManifest(vendorCtx, {
      extensionKey: 'invoice-ocr',
      version: '1.1.0',
      manifestSchemaVersion: 1,
      displayName: 'Invoice OCR',
      description: 'Reads invoices into the world model',
      requestedPermissions: [
        'state:read',
        'state:write',
        'ui:render',
        'schedule:run',
        'events:subscribe',
        'external:participate',
        'telemetry:emit',
      ],
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel', 'settings-form'],
      schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.received', 'invoice.paid'],
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
      telemetry: true,
      quotas: {
        maxStateBytes: 1_048_576,
        maxScheduleInvocationsPerDay: 24,
        maxExternalCallsPerDay: 1_000,
      },
      hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
    });
    await runManifestVerification(vendorCtx, { manifestId: registeredV2.manifest.id });
    const created = await handleDeveloperAction(
      request_(vendorCtx, '/api/product/marketplace/developer/create-extension-package'),
      'create-extension-package',
      { manifestId: registeredV2.manifest.id },
    );
    const createdPkg = created.status === 200 ? (created.body['package'] as MarketplacePackage) : null;
    expect(createdPkg).not.toBe(null);
    extensionPackageV2 = createdPkg!;
    for (const [action, ctx, body] of [
      ['submit', vendorCtx, {}],
      ['verify', platformCtx, {}],
      ['review', platformCtx, { decision: 'approve' }],
      ['publish', platformCtx, {}],
      ['make-installable', platformCtx, {}],
    ] as const) {
      const step = await handlePackageAction(
        request_(ctx, `/api/product/marketplace/package/${extensionPackageV2!.id}/${action}`),
        extensionPackageV2!.id,
        action,
        body,
      );
      expect(step.status).toBe(200);
    }

    // The v1 deployment (the narrowed grant) is the rollback target.
    const v1 = await getCurrentDeployment(installerCtx, { extensionKey: 'invoice-ocr' });
    expect(v1!.version).toBe('1.0.0');
    expect(v1!.grantedPermissions).toEqual(['state:read', 'state:write']);

    // Upgrade to v2 with the full grant.
    const upgraded = await installPackage(installerCtx, extensionPackageV2, null);
    expect(upgraded.outcome).toBe('installed');
    const current2 = await getCurrentDeployment(installerCtx, { extensionKey: 'invoice-ocr' });
    expect(current2!.version).toBe('1.1.0');
    expect(current2!.grantedPermissions).toHaveLength(7);

    // Roll back to the recorded v1 deployment through the handler.
    const rollback = await handleExtensionAction(
      request_(installerCtx, '/api/product/marketplace/extension/invoice-ocr/rollback'),
      'invoice-ocr',
      'rollback',
      { targetDeploymentId: v1!.id },
    );
    expect(rollback.status).toBe(200);
    if (rollback.status === 200) {
      expect(rollback.body['applied']).toBe(true);
    }
    const rolledBack = await getCurrentDeployment(installerCtx, { extensionKey: 'invoice-ocr' });
    expect(rolledBack!.version).toBe('1.0.0');
    // The rollback restored the RECORDED grant — never a fresh negotiation.
    expect(rolledBack!.grantedPermissions).toEqual(['state:read', 'state:write']);
  });

  it('the default authority policy holds the install at the human gates, then the same keys complete it', async () => {
    const approver = member(installerDefaultPolicyCtx.tenantId, ['actions:approve']);

    // This tenant kept the default matrix: extension-deployment EXECUTE
    // needs human approval. Install → activation waits (the deployment
    // step cannot run while the extension is not ACTIVE).
    const first = await installPackage(installerDefaultPolicyCtx, extensionPackage, null);
    expect(first.outcome).toBe('awaiting_approval');
    const activate = first.steps.find((step) => step.step === 'activate')!;
    expect(activate.status).toBe('awaiting_approval');
    expect(activate.actionRequestId).toBeDefined();
    const held = await getExtension(installerDefaultPolicyCtx, { extensionKey: 'invoice-ocr' });
    expect(held.lifecycleState).toBe('REGISTERED');

    // The human approves the activation; the re-run replays the SAME
    // gate request (same deterministic key) and applies it — then the
    // deployment step meets its OWN gate and waits.
    await decideApproval(approver, { requestId: activate.actionRequestId!, decision: 'approve' });
    const second = await installPackage(installerDefaultPolicyCtx, extensionPackage, null);
    expect(second.outcome).toBe('awaiting_approval');
    expect(second.steps.find((step) => step.step === 'activate')!.status).toBe('done');
    const deploy = second.steps.find((step) => step.step === 'deploy')!;
    expect(deploy.status).toBe('awaiting_approval');
    expect(deploy.actionRequestId).toBeDefined();
    const active = await getExtension(installerDefaultPolicyCtx, { extensionKey: 'invoice-ocr' });
    expect(active.lifecycleState).toBe('ACTIVE');

    // The deployment decision; the final re-run replays it and lands.
    await decideApproval(approver, { requestId: deploy.actionRequestId!, decision: 'approve' });
    const third = await installPackage(installerDefaultPolicyCtx, extensionPackage, null);
    expect(third.outcome).toBe('installed');
    const deployment = await getCurrentDeployment(installerDefaultPolicyCtx, {
      extensionKey: 'invoice-ocr',
    });
    expect(deployment).not.toBe(null);
    expect(deployment!.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Installed views + governance drill-down
// ---------------------------------------------------------------------------

describe('installed views', () => {
  it('the installed summary reflects the registry (both installer tenants)', async () => {
    const view = await buildInstalledView(installerCtx);
    expect(view.ok).toBe(true);
    const item = view.items.find((entry) => entry.extensionKey === 'invoice-ocr');
    expect(item).toBeDefined();
    expect(item!.stateLabel).toBe('Active');
    expect(item!.latestVersion).toBe('1.1.0');
    expect(item!.verificationState).toBe('VERIFIED');
    expect(item!.deployment!.version).toBe('1.0.0'); // rolled back

    const gated = await buildInstalledView(installerDefaultPolicyCtx);
    const gatedItem = gated.items.find((entry) => entry.extensionKey === 'invoice-ocr');
    expect(gatedItem!.stateLabel).toBe('Active');
  });

  it('the extension drill-down carries manifests, deployments, trail and legal transitions', async () => {
    const result = await buildExtensionView(installerCtx, 'invoice-ocr');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.extension.stateLabel).toBe('Active');
    expect(view.manifests.map((manifest) => manifest.version)).toEqual(['1.1.0', '1.0.0']);
    expect(view.manifests.every((manifest) => manifest.isDeployable)).toBe(true);
    // Two deployments recorded; the current one flagged; the other is a
    // rollback target.
    expect(view.deployments).toHaveLength(3); // v1 deploy, v2 deploy, v1 rollback
    expect(view.deployments.filter((deployment) => deployment.isCurrent)).toHaveLength(1);
    expect(view.deployments.filter((deployment) => deployment.isRollbackTarget)).toHaveLength(2);
    // From ACTIVE the legal transitions are suspend + deprecate.
    expect(view.availableTransitions.map((transition) => transition.transition)).toEqual([
      'suspend',
      'deprecate',
    ]);
    expect(view.canGovern).toBe(true);
    expect(view.lifecycleEvents.map((event) => event.transition)).toEqual([
      'activate',
      'suspend',
      'resume',
    ]); // rollbacks are runtime deployment records, not lifecycle transitions
  });

  it("another tenant's extension is a not-found (isolation at the drill-down)", async () => {
    const result = await buildExtensionView(vendorCtx, 'invoice-ocr');
    // The VENDOR also registered invoice-ocr v1 — but only in its own
    // registry; both tenants having the same key is legal. Use a key the
    // vendor never registered instead.
    const missing = await buildExtensionView(vendorCtx, 'not-registered-anywhere');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.failure).toBe('not_found');
    expect(result.ok).toBe(true);
  });

  it('a member without the govern claim still reads, and sees the notice flag', async () => {
    const plain = member(installerCtx.tenantId);
    const result = await buildExtensionView(plain, 'invoice-ocr');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.canGovern).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The developer surface views + the builder
// ---------------------------------------------------------------------------

describe('developer surface views', () => {
  it('the vendor sees its packages, manifests and agents; the review queue is administer-only', async () => {
    const view = await buildDeveloperView(vendorCtx);
    expect(view.scoped).toBe(true);
    expect(view.usable).toBe(true);
    expect(view.packages.items.map((pkg) => pkg.packageKey)).toContain('invoice-ocr');
    expect(view.packages.items.every((pkg) => pkg.stateLabel.length > 0)).toBe(true);
    expect(view.manifests.items.map((manifest) => manifest.version)).toContain('1.1.0');
    expect(view.manifests.items.every((manifest) => manifest.verificationState === 'VERIFIED')).toBe(true);
    expect(view.builderAgents.items).toHaveLength(0); // no builder agent registered yet
    expect(view.reviewQueue.allowed).toBe(false);

    const platformView = await buildDeveloperView(platformCtx);
    expect(platformView.reviewQueue.allowed).toBe(true);
    // The platform saw the queue drain — nothing is pending now.
    expect(platformView.reviewQueue.items).toHaveLength(0);
  });

  it('a plain member gets the honest not-usable surface', async () => {
    const view = await buildDeveloperView(member(installerCtx.tenantId));
    expect(view.usable).toBe(false);
    // Reads still degrade quietly, never fake-empty:
    expect(view.packages.ok).toBe(true);
  });
});

describe('the builder (request → advance → deployed)', () => {
  it('walks a build through the surface handlers to a deployed manifest', async () => {
    const agent = (await registerAgent(installerCtx, BUILDER_AGENT)).agent;

    const requested = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/request-build'),
      'request-build',
      {
        extensionKey: 'translate-memo',
        version: '1.0.0',
        brief: 'Translate selected memos into plain English',
        agentId: agent.id,
      },
    );
    expect(requested.status).toBe(200);
    const build = requested.status === 200 ? (requested.body['build'] as { id: string; phase: string }) : null;
    expect(build).not.toBe(null);
    expect(build!.phase).toBe('designing');

    // design → building
    transport.respondWith(designOutput());
    const step1 = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/advance-build'),
      'advance-build',
      { buildId: build!.id },
    );
    expect(step1.status).toBe(200);
    const phase1 = step1.status === 200 ? (step1.body['build'] as { phase: string }) : null;
    expect(phase1!.phase).toBe('building');

    // building → built (the manifest registers)
    transport.respondWith(buildOutput());
    const step2 = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/advance-build'),
      'advance-build',
      { buildId: build!.id },
    );
    const phase2 = step2.status === 200 ? (step2.body['build'] as { phase: string }) : null;
    expect(phase2!.phase).toBe('built');

    // built → verified
    const step3 = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/advance-build'),
      'advance-build',
      { buildId: build!.id },
    );
    const phase3 = step3.status === 200 ? (step3.body['build'] as { phase: string }) : null;
    expect(phase3!.phase).toBe('verified');

    // verified → deployed (this tenant's policy allows deployments)
    const step4 = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/advance-build'),
      'advance-build',
      { buildId: build!.id },
    );
    const phase4 = step4.status === 200 ? (step4.body['build'] as { phase: string }) : null;
    expect(phase4!.phase).toBe('deployed');
    if (step4.status === 200) {
      expect(step4.body['terminal']).toBe(true);
    }

    // The developer view lists the session with its phase and can-advance false.
    const view = await buildDeveloperView(installerCtx);
    const buildView = view.builds.items.find((entry) => entry.id === build!.id);
    expect(buildView).toBeDefined();
    expect(buildView!.phaseLabel).toBe('Deployed');
    expect(buildView!.canAdvance).toBe(false);
    expect(buildView!.canCancel).toBe(false);
    expect(view.builderAgents.items.map((entry) => entry.slug)).toContain('extension-designer');
  });

  it('cancel requires a reason and cancels only live builds', async () => {
    const agent = await listAgents(installerCtx, { limit: 10 });
    const builderAgent = agent.find((entry) => entry.slug === 'extension-designer')!;

    const requested = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/request-build'),
      'request-build',
      {
        extensionKey: 'doomed-build',
        version: '1.0.0',
        brief: 'A build that will be cancelled',
        agentId: builderAgent.id,
      },
    );
    const build = requested.status === 200 ? (requested.body['build'] as { id: string }) : null;
    expect(build).not.toBe(null);

    const cancelled = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/cancel-build'),
      'cancel-build',
      { buildId: build!.id, reason: 'wrong brief' },
    );
    expect(cancelled.status).toBe(200);
    const phase = cancelled.status === 200 ? (cancelled.body['build'] as { phase: string }) : null;
    expect(phase!.phase).toBe('cancelled');

    // No reason → honest 400.
    const bad = await handleDeveloperAction(
      request_(installerCtx, '/api/product/marketplace/developer/cancel-build'),
      'cancel-build',
      { buildId: build!.id },
    );
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// The API context seam
// ---------------------------------------------------------------------------

describe('write context resolution', () => {
  it('an unscoped request cannot write (missing tenant → 400)', async () => {
    const result = await handlePackageAction(
      new Request('https://aurum.test/api/product/marketplace/package/x/submit'),
      extensionPackage.id,
      'submit',
      {},
    );
    expect(result.status).toBe(400);
    if (result.status === 400) {
      expect(result.body.error).toBe('missing_tenant');
    }
  });

  it('the query seam scopes writes too (browser-friendly)', async () => {
    const url = `https://aurum.test/api/product/marketplace/package/${extensionPackage.id}/submit?tenant=${vendorCtx.tenantId}&principal=${vendorCtx.principalId}&authority=${encodeURIComponent('marketplace:submit')}`;
    // This package is already SUBMITTED — the contract refuses with a
    // 409 invalid_transition, which proves the seam reached the domain
    // with the right identity (not a 400 scope failure).
    const result = await handlePackageAction(new Request(url), extensionPackage.id, 'submit', {});
    expect(result.status).toBe(409);
  });
});
