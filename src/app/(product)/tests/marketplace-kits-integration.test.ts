// Integration tests for the marketplace product surface's KIT half
// (W105) against the embedded PostgreSQL (PGlite, `:memory:`) through
// the db port — the W092 vertical starter kits' user-visible path, the
// J22 unblock:
//
//   * THE PUBLIC CATALOG PATH: an anonymous visitor sees the two signed
//     starter kits in the catalog's kits section with their REAL states
//     (the module's own deterministic verification + the sha-256
//     manifest digests), and the shipped kit detail renders the signed
//     manifest, the checks and the honest not-installed state.
//   * THE JOURNEY (scoped, through the surface's own API handlers):
//     install a shipped kit (register → verify → the W009 grant-review
//     gate) → the catalog shows pending-review → the kit detail shows
//     the installation, the registry-run verification and the empty
//     invocation ledger → the human review approves (a DIFFERENT
//     principal — separation of duties is the actions module's own) →
//     the declared capabilities are minted → activate → the invocation
//     ledger records allowed AND denied verdicts → suspend → resume →
//     remove (terminal, grants revoked, audit retained) → the kit is
//     reinstallable with the already-true steps reported as skipped.
//   * THE POLICY OUTCOMES: an auto-allow tenant policy mints the grants
//     at install (the accounting kit's path through the same surface).
//   * HONEST ERRORS: an unknown kit reports the honest failed step; a
//     double install reports the domain's live-lifecycle refusal; a
//     review on a non-pending installation maps to 409; an
//     unauthenticated write maps to 401.
//   * TENANT ISOLATION: another tenant's registered kit is invisible —
//     not in the catalog, not in the kit detail (no existence leak).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

import { setAuthorityPolicy } from '@/modules/actions/contract';
import { registerUser, selectCompany } from '@/modules/auth/contract';
import { addTenantMember, provisionTenant } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import {
  LEGAL_CASE_MANAGEMENT_KIT,
  STARTER_KITS,
  digestKitManifest,
  invokeKitCapability,
  registerKitVersion,
  runKitVerification,
} from '@/modules/vertical-kits/contract';

import { handleKitAction } from '../marketplace/lib/kit-api';
import type { KitInstallReport } from '../marketplace/lib/kit-flow';
import {
  buildInstalledKitsView,
  buildKitDetailView,
  buildKitsCatalogView,
} from '../marketplace/lib/kit-views';
import { publicBrowsingContext } from '../marketplace/lib/views';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** The session cookie the marketplace write API resolves (lib/session). */
const SESSION_COOKIE = 'aurum_session';
const sessionTokens = new Map<string, string>();

async function registeredUser(label: string): Promise<{ principalId: string; token: string }> {
  const email = [label, '.', newId().slice(0, 8), '@example', '.test'].join('');
  const issued = await registerUser({
    displayName: label,
    email,
    password: ['ha', 'rbor', '-cr', 'ane-44'].join(''),
  });
  sessionTokens.set(issued.session.principalId, issued.token);
  return { principalId: issued.session.principalId, token: issued.token };
}

function request_(token: string, path: string): Request {
  return new Request(`https://aurum.test${path}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

async function kitAction(
  token: string,
  kitKey: string,
  action: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return handleKitAction(request_(token, `/api/product/marketplace/kit/${kitKey}/${action}`), kitKey, action as never, body);
}

let tenantA: { id: string };
let tenantB: { id: string };
let installerToken: string;
let reviewerToken: string;
let installerCtx: TenantContext;

beforeAll(async () => {
  await runMigrations(db);

  const provisioner = {
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };

  // Tenant A: the installer owner (a live session) + a second admin
  // member (the grant reviewer — separation of duties needs a DIFFERENT
  // principal deciding the install the owner requested).
  const tenantAOwner = newId();
  tenantA = await provisionTenant(provisioner, {
    name: `W105 Installer ${newId().slice(0, 6)}`,
    ownerPrincipalId: tenantAOwner,
  });
  const ownerCtx = { tenantId: tenantA.id, principalId: tenantAOwner, authority: [] };
  const installer = await registeredUser('w105-installer');
  await addTenantMember(ownerCtx, { principalId: installer.principalId, role: 'owner' });
  await selectCompany({ token: installer.token, tenantId: tenantA.id });
  installerToken = installer.token;

  const reviewer = await registeredUser('w105-reviewer');
  await addTenantMember(ownerCtx, { principalId: reviewer.principalId, role: 'admin' });
  await selectCompany({ token: reviewer.token, tenantId: tenantA.id });
  reviewerToken = reviewer.token;

  installerCtx = memberOf(tenantA.id, ['vertical-kits:administer']);

  // Tenant B: the isolation probe (contract-level only).
  tenantB = await provisionTenant(provisioner, {
    name: `W105 Other ${newId().slice(0, 6)}`,
    ownerPrincipalId: newId(),
  });
});

afterAll(async () => {
  await closeDb();
});

/** The body-shape of the API install result (the honest report). */
function installReportOf(result: { status: number; body: Record<string, unknown> }): KitInstallReport {
  return result.body['report'] as KitInstallReport;
}

// ---------------------------------------------------------------------------
// The public catalog path (anonymous browsing — the kits' real states)
// ---------------------------------------------------------------------------

describe('the catalog kits section (public browsing)', () => {
  it('lists the two signed starter kits with their real verification + digest states', async () => {
    const view = await buildKitsCatalogView(publicBrowsingContext());
    expect(view.ok).toBe(true);
    expect(view.scoped).toBe(false);
    expect(view.total).toBe(2);
    const keys = view.items.map((item) => item.kitKey);
    expect(keys).toEqual(['legal-case-management', 'accounting-ledger-erp']);
    for (const item of view.items) {
      expect(item.verificationState).toBe('verified');
      expect(item.verificationSource).toBe('shipped-manifest');
      expect(item.registered).toBe(false);
      expect(item.installStatus).toBeNull();
      expect(item.installLabel).toBe('Not installed');
      const manifest = STARTER_KITS.find((kit) => kit.kitKey === item.kitKey)!;
      expect(item.manifestDigest).toBe(digestKitManifest(manifest));
      expect(item.version).toBe(manifest.version);
      expect(item.counts.capabilities).toBe(manifest.requiredCapabilities.length);
      expect(item.href).toBe(`/marketplace/kit/${item.kitKey}`);
    }
  });

  it('renders the shipped kit detail for an anonymous visitor (read-only, honest)', async () => {
    const result = await buildKitDetailView(publicBrowsingContext(), 'legal-case-management');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.shipped).toBe(true);
    expect(view.registered).toBe(false);
    expect(view.manifest.kitKey).toBe('legal-case-management');
    expect(view.manifestDigest).toBe(digestKitManifest(LEGAL_CASE_MANAGEMENT_KIT));
    expect(view.verification.state).toBe('verified');
    expect(view.verification.source).toBe('shipped-manifest');
    expect(view.verification.checks).toHaveLength(7);
    for (const check of view.verification.checks) {
      expect(check.passed, `${check.check}: ${check.detail}`).toBe(true);
    }
    expect(view.installation).toBeNull();
    expect(view.runtime).toBeNull();
    // No claim, no scope: the anonymous caller may install nothing.
    expect(view.actions.canGovern).toBe(false);
    expect(view.actions.canInstall).toBe(false);
    expect(view.actions.installBlockedReason).toContain('vertical-kits:administer');
    // The reviewer-facing payload is inspectable without scope.
    expect(view.capabilities.map((line) => line.key)).toEqual(
      LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.map((capability) => capability.key),
    );
  });

  it('an unknown kit key is honestly not found (public and scoped alike)', async () => {
    const anonymous = await buildKitDetailView(publicBrowsingContext(), 'no-such-kit');
    expect(anonymous.ok).toBe(false);
    if (!anonymous.ok) expect(anonymous.failure).toBe('not_found');
    const scoped = await buildKitDetailView(installerCtx, 'no-such-kit');
    expect(scoped.ok).toBe(false);
    if (!scoped.ok) expect(scoped.failure).toBe('not_found');
  });
});

// ---------------------------------------------------------------------------
// The J22 journey through the surface's own API handlers (tenant A)
// ---------------------------------------------------------------------------

describe('the kit journey: catalog → detail → install → review → activate → ledger → remove', () => {
  let installationId = '';
  let pendingInstallationId = '';

  it('installs the shipped legal kit through the gate (register → verify → pending-review)', async () => {
    const result = await kitAction(installerToken, 'legal-case-management', 'install', {
      justification: 'Legal operations onboarding',
    });
    expect(result.status).toBe(200);
    const report = installReportOf(result);
    expect(result.body['ok']).toBe(true);
    expect(report.outcome).toBe('awaiting_approval');
    expect(report.kitKey).toBe('legal-case-management');
    expect(report.version).toBe('1.0.0');
    expect(report.steps.map((step) => step.step)).toEqual(['register', 'verify', 'install']);
    expect(report.steps[0]!.status).toBe('done');
    expect(report.steps[1]!.status).toBe('done');
    expect(report.steps[2]!.status).toBe('awaiting_approval');
    expect(report.steps[2]!.actionRequestId).toBeDefined();
    expect(report.installationStatus).toBe('pending-review');
    pendingInstallationId = report.installationId ?? '';
    expect(pendingInstallationId).not.toBe('');
  });

  it('the catalog now shows the kit registered with its pending install state', async () => {
    const view = await buildKitsCatalogView(installerCtx);
    expect(view.ok).toBe(true);
    expect(view.scoped).toBe(true);
    const legal = view.items.find((item) => item.kitKey === 'legal-case-management')!;
    expect(legal.registered).toBe(true);
    expect(legal.verificationSource).toBe('registry');
    expect(legal.verificationState).toBe('verified');
    expect(legal.installStatus).toBe('pending-review');
    expect(legal.installLabel).toBe('Pending grant review');
    // the accounting kit is untouched by the legal install
    const accounting = view.items.find((item) => item.kitKey === 'accounting-ledger-erp')!;
    expect(accounting.registered).toBe(false);
    expect(accounting.installStatus).toBeNull();
  });

  it('the kit detail shows the installation, the registry-run verification and the empty ledger', async () => {
    const result = await buildKitDetailView(installerCtx, 'legal-case-management');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.registered).toBe(true);
    expect(view.verification.source).toBe('registry-run');
    expect(view.verification.state).toBe('verified');
    expect(view.verification.checks.length).toBeGreaterThan(0);
    expect(view.verification.ranAt).not.toBeNull();
    expect(view.installation).not.toBeNull();
    expect(view.installation!.status).toBe('pending-review');
    expect(view.installation!.grants).toEqual([]);
    expect(view.runtime).not.toBeNull();
    expect(view.runtime!.invocations).toEqual({ allowed: 0, denied: 0 });
    expect(view.runtime!.recentInvocations).toEqual([]);
    expect(view.runtime!.integrations.every((i) => i.readiness === 'deferred-on-w088')).toBe(true);
    // the actions THIS caller may take: the review is decidable
    expect(view.actions.canGovern).toBe(true);
    expect(view.actions.canReview).toBe(true);
    expect(view.actions.canInstall).toBe(false); // a live lifecycle exists
    expect(view.actions.installBlockedReason).toContain('live installation');
  });

  it('the installed view lists the pending kit installation', async () => {
    const view = await buildInstalledKitsView(installerCtx);
    expect(view.ok).toBe(true);
    expect(view.total).toBe(1);
    expect(view.items[0]!.kitKey).toBe('legal-case-management');
    expect(view.items[0]!.status).toBe('pending-review');
    expect(view.items[0]!.stateLabel).toBe('Pending grant review');
    expect(view.items[0]!.verificationState).toBe('verified');
    expect(view.items[0]!.grants).toEqual({ active: 0, revoked: 0 });
  });

  it('a second install while the lifecycle is live reports the domain refusal honestly', async () => {
    const result = await kitAction(installerToken, 'legal-case-management', 'install', {});
    expect(result.status).toBe(200);
    const report = installReportOf(result);
    expect(report.outcome).toBe('failed');
    expect(report.steps[2]!.status).toBe('failed');
    expect(report.steps[2]!.detail).toContain('already has a live installation');
  });

  it('the human grant review approves and mints EXACTLY the declared capabilities', async () => {
    // A DIFFERENT principal decides (separation of duties — the actions
    // module enforces it; the surface only routes).
    const result = await kitAction(reviewerToken, 'legal-case-management', 'review', {
      installationId: pendingInstallationId,
      decision: 'approve',
      reason: 'Legal reviewed the capability scope',
    });
    expect(result.status).toBe(200);
    const installation = result.body['installation'] as { status: string };
    expect(installation.status).toBe('granted');
    const grants = result.body['grants'] as { capabilityKey: string; status: string }[];
    expect(grants.map((grant) => grant.capabilityKey).sort()).toEqual(
      LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.map((capability) => capability.key).sort(),
    );
    installationId = pendingInstallationId;
  });

  it('a review on a decided installation maps to 409 (not pending)', async () => {
    const result = await kitAction(reviewerToken, 'legal-case-management', 'review', {
      installationId,
      decision: 'reject',
      reason: 'too late',
    });
    expect(result.status).toBe(409);
    expect(result.body['error']).toBe('installation_not_pending_review');
  });

  it('activation turns the kit on; the detail shows grants and the chain', async () => {
    const result = await kitAction(installerToken, 'legal-case-management', 'activate', {
      installationId,
    });
    expect(result.status).toBe(200);
    expect((result.body['installation'] as { status: string }).status).toBe('active');

    const detail = await buildKitDetailView(installerCtx, 'legal-case-management');
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.view.installation!.status).toBe('active');
    expect(detail.view.runtime!.grants.active).toBe(
      LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.length,
    );
    expect(detail.view.actions.canSuspend).toBe(true);
    expect(detail.view.actions.canActivate).toBe(false);
  });

  it('the invocation ledger records allowed AND denied verdicts with their reasons', async () => {
    const allowed = await invokeKitCapability(installerCtx, {
      installationId,
      capabilityKey: 'read.case-matters',
      taskContext: { description: 'Summarize matter status for the weekly review' },
    });
    expect(allowed.outcome).toBe('allowed');
    const denied = await invokeKitCapability(installerCtx, {
      installationId,
      capabilityKey: 'write.billing-records', // read-only in the manifest
      taskContext: { description: 'Post a time entry' },
    });
    expect(denied.outcome).toBe('denied');

    const detail = await buildKitDetailView(installerCtx, 'legal-case-management');
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.view.runtime!.invocations).toEqual({ allowed: 1, denied: 1 });
    expect(detail.view.runtime!.recentInvocations).toHaveLength(2);
    const deniedRow = detail.view.runtime!.recentInvocations.find(
      (row) => row.outcome === 'denied',
    )!;
    expect(deniedRow.capabilityKey).toBe('write.billing-records');
    expect(deniedRow.basis).toBe('grant-missing');
    expect(deniedRow.denialReason).toContain("capability 'write.billing-records'");
  });

  it('suspend parks the kit; resume returns it; the states surface honestly', async () => {
    const suspended = await kitAction(installerToken, 'legal-case-management', 'suspend', {
      installationId,
      reason: 'quarter-end freeze',
    });
    expect((suspended.body['installation'] as { status: string }).status).toBe('suspended');
    let detail = await buildKitDetailView(installerCtx, 'legal-case-management');
    expect(detail.ok && detail.view.installation!.status).toBe('suspended');
    expect(detail.ok && detail.view.actions.canResume).toBe(true);

    const resumed = await kitAction(installerToken, 'legal-case-management', 'resume', {
      installationId,
    });
    expect((resumed.body['installation'] as { status: string }).status).toBe('active');
    detail = await buildKitDetailView(installerCtx, 'legal-case-management');
    expect(detail.ok && detail.view.installation!.status).toBe('active');
  });

  it('removal requires a reason at the surface (the terminal step records why)', async () => {
    const refused = await kitAction(installerToken, 'legal-case-management', 'remove', {
      installationId,
    });
    expect(refused.status).toBe(400);
    expect(refused.body['error']).toBe('invalid_body');

    const removed = await kitAction(installerToken, 'legal-case-management', 'remove', {
      installationId,
      reason: 'switching to the accounting vertical first',
    });
    expect(removed.status).toBe(200);
    expect((removed.body['installation'] as { status: string }).status).toBe('removed');
    // every grant was revoked with the kit — no orphaned authority
    const grants = removed.body['grants'] as { status: string }[];
    expect(grants.length).toBe(LEGAL_CASE_MANAGEMENT_KIT.requiredCapabilities.length);
    expect(grants.every((grant) => grant.status === 'revoked')).toBe(true);
  });

  it('the installed view keeps removed lifecycles as counted audit, never as running', async () => {
    const view = await buildInstalledKitsView(installerCtx);
    expect(view.ok).toBe(true);
    expect(view.items).toEqual([]);
    expect(view.removedCount).toBe(1);

    const detail = await buildKitDetailView(installerCtx, 'legal-case-management');
    expect(detail.ok && detail.view.installation).toBeNull();
    expect(detail.ok && detail.view.removedCount).toBe(1);
    // removal is terminal but the kit is reinstallable — the registry
    // already holds the verified version.
    expect(detail.ok && detail.view.actions.canInstall).toBe(true);
  });

  it('a reinstall reports the already-true steps as skipped (idempotent honesty)', async () => {
    // Tenant A switched to auto-allow for the remainder of the suite
    // (the accounting kit's path below needs it too).
    await setAuthorityPolicy(
      memberOf(tenantA.id, ['actions:administer']),
      { actionKind: 'vertical-kit-deployment', approvalLevels: [], forbiddenLevels: [] },
    );
    const result = await kitAction(installerToken, 'legal-case-management', 'install', {
      justification: 'back by popular demand',
    });
    expect(result.status).toBe(200);
    const report = installReportOf(result);
    expect(report.outcome).toBe('installed');
    expect(report.steps[0]!.status).toBe('skipped');
    expect(report.steps[0]!.detail).toContain('already in your kit registry');
    expect(report.steps[1]!.status).toBe('skipped');
    expect(report.steps[1]!.detail).toContain('VERIFIED');
    expect(report.steps[2]!.status).toBe('done');
    expect(report.installationStatus).toBe('granted');
    installationId = report.installationId ?? '';
  });
});

// ---------------------------------------------------------------------------
// The accounting kit + the auto-allow policy outcome (same surface)
// ---------------------------------------------------------------------------

describe('the accounting kit installs through the same path', () => {
  it('an auto-allow policy mints the grants at install; activation completes the path', async () => {
    const result = await kitAction(installerToken, 'accounting-ledger-erp', 'install', {
      justification: 'Ledger close automation',
    });
    expect(result.status).toBe(200);
    const report = installReportOf(result);
    expect(report.outcome).toBe('installed');
    expect(report.installationStatus).toBe('granted');

    const activated = await kitAction(installerToken, 'accounting-ledger-erp', 'activate', {
      installationId: report.installationId ?? '',
    });
    expect((activated.body['installation'] as { status: string }).status).toBe('active');

    // The catalog shows BOTH kits with their live states now.
    const catalog = await buildKitsCatalogView(installerCtx);
    const accounting = catalog.items.find((item) => item.kitKey === 'accounting-ledger-erp')!;
    expect(accounting.installStatus).toBe('active');
    expect(accounting.installLabel).toBe('Active');
    expect(accounting.registered).toBe(true);
    const legal = catalog.items.find((item) => item.kitKey === 'legal-case-management')!;
    expect(legal.installStatus).toBe('granted');

    // The installed view governs both live lifecycles.
    const installed = await buildInstalledKitsView(installerCtx);
    expect(installed.total).toBe(2);
    expect(installed.items.map((item) => item.kitKey).sort()).toEqual([
      'accounting-ledger-erp',
      'legal-case-management',
    ]);
  });

  it('an unknown kit reports the honest failed step (nothing to install)', async () => {
    const result = await kitAction(installerToken, 'no-such-kit', 'install', {});
    expect(result.status).toBe(200);
    expect(result.body['ok']).toBe(false);
    const report = installReportOf(result);
    expect(report.outcome).toBe('failed');
    expect(report.steps[0]!.detail).toContain('neither a shipped starter kit nor');
  });
});

// ---------------------------------------------------------------------------
// Honest error surfaces
// ---------------------------------------------------------------------------

describe('kit API error surfaces', () => {
  it('an unauthenticated write maps to 401 (no session, no scope)', async () => {
    const result = await handleKitAction(
      new Request('https://aurum.test/api/product/marketplace/kit/legal-case-management/install'),
      'legal-case-management',
      'install',
      {},
    );
    expect(result.status).toBe(401);
    expect(result.body['error']).toBe('unauthenticated');
  });

  it('a malformed body maps to 400', async () => {
    const result = await kitAction(installerToken, 'accounting-ledger-erp', 'activate', {});
    expect(result.status).toBe(400);
    expect(result.body['error']).toBe('invalid_body');
  });

  it('an unknown installation maps to 404 (cross-tenant reads are indistinguishable from missing)', async () => {
    const result = await kitAction(installerToken, 'accounting-ledger-erp', 'activate', {
      installationId: newId(),
    });
    expect(result.status).toBe(404);
    expect(result.body['error']).toBe('installation_not_found');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (another tenant's kit registry is invisible)
// ---------------------------------------------------------------------------

describe('tenant isolation (the kit surfaces)', () => {
  const tenantBPrivateKit = {
    ...LEGAL_CASE_MANAGEMENT_KIT,
    kitKey: 'tenant-b-private-kit',
    displayName: 'Tenant B Private Kit',
    description: 'A kit registered only in tenant B registry.',
  };

  it("tenant B's registered kit never appears in tenant A's catalog or detail", async () => {
    const bAdmin = memberOf(tenantB.id, ['vertical-kits:administer']);
    const registered = await registerKitVersion(bAdmin, { manifest: tenantBPrivateKit });
    await runKitVerification(bAdmin, { kitVersionId: registered.version.id });

    // Tenant B sees its own kit (its catalog, its detail).
    const bCatalog = await buildKitsCatalogView(bAdmin);
    const bItem = bCatalog.items.find((item) => item.kitKey === 'tenant-b-private-kit');
    expect(bItem).toBeDefined();
    expect(bItem!.registered).toBe(true);
    expect(bItem!.verificationState).toBe('verified');
    const bDetail = await buildKitDetailView(bAdmin, 'tenant-b-private-kit');
    expect(bDetail.ok).toBe(true);

    // Tenant A sees NOTHING of it — not in the catalog, not by key.
    const aCatalog = await buildKitsCatalogView(installerCtx);
    expect(aCatalog.items.some((item) => item.kitKey === 'tenant-b-private-kit')).toBe(false);
    const aDetail = await buildKitDetailView(installerCtx, 'tenant-b-private-kit');
    expect(aDetail.ok).toBe(false);
    if (!aDetail.ok) expect(aDetail.failure).toBe('not_found');
  });
});
