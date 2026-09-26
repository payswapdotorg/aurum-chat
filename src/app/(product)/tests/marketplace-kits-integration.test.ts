// Integration tests for the vertical-kits marketplace surface (W105)
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db
// port — Journey J22's user-visible path, end to end through REAL
// module contracts and the surface's own API handlers:
//
//   * THE CATALOG SURFACING — the two signed starter kits are listed in
//     the governed marketplace catalog's kits section (anonymous
//     browsing included), enriched with the caller's registry/
//     verification/installation state when scoped; a second tenant sees
//     none of the first tenant's registry or installations (no leak).
//   * THE DETAIL DESTINATION — /marketplace/kit/<kitKey>'s view: the
//     signed manifest digest, the shipped checks, the recorded
//     verification runs, the required capabilities, and the honest
//     not-found for an unknown key.
//   * THE LIFECYCLE LIFELINE — kits NEVER ride the extension flow:
//     register (the shipped manifest only) → verify (append-only run) →
//     install (the vertical-kits lifecycle; the W009 gate holds the
//     grant review) → decide-review (separation of duties enforced —
//     another authorized principal) → activate → suspend → resume →
//     remove (grants revoked, audit retained) → reinstallable. Every
//     step through the surface's own handlers, every state visible in
//     the installed view.
//   * HONEST REFUSALS — install before verification (kit_not_verified),
//     a second install while live (kit_already_installed), an unknown
//     kit key (kit_not_shipped), an unauthenticated write (401), a
//     claim-less member (403).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

import { provisionTenant } from '@/modules/organizations/contract';
import { addTenantMember } from '@/modules/organizations/contract';
import { ORGANIZATIONS_AUTHORITY_PROVISION } from '@/modules/organizations/contract';
import { MANAGEMENT_CLAIMS, registerUser, selectCompany } from '@/modules/auth/contract';
import { invokeKitCapability, isManifestDigest } from '@/modules/vertical-kits/contract';

import { handleKitAction } from '../marketplace/lib/api';
import { buildKitCatalogSection } from '../marketplace/lib/kits';
import { buildKitDetailView } from '../marketplace/lib/kits';
import { buildKitInstalledSection } from '../marketplace/lib/kits';
import { publicBrowsingContext } from '../marketplace/lib/views';

const db = getDb();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function kitRequest(principalId: string, path: string, body: unknown = null): Request {
  const token = sessionTokens.get(principalId);
  if (token === undefined) {
    throw new Error(`no registered session for principal ${principalId}`);
  }
  return new Request(`https://aurum.test${path}`, {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

function ownerCtxOf(tenantId: string, principalId: string): TenantContext {
  // What a signed-in owner/admin session actually resolves (W058 + the
  // W105 claim completion): the full interim management claim set,
  // including 'vertical-kits:administer' and 'actions:approve'.
  return { tenantId, principalId, authority: [...MANAGEMENT_CLAIMS] };
}

let tenantA: string;
let ownerA: { principalId: string; token: string };
let adminA: { principalId: string; token: string };
let memberA: { principalId: string; token: string };
let tenantB: string;
let ownerB: { principalId: string; token: string };

const LEGAL = 'legal-case-management';
const ACCOUNTING = 'accounting-ledger-erp';

beforeAll(async () => {
  await runMigrations(db);

  const provisioner = {
    principalId: newId(),
    authority: [ORGANIZATIONS_AUTHORITY_PROVISION],
  };

  ownerA = await registeredUser('w105-owner-a');
  adminA = await registeredUser('w105-admin-a');
  memberA = await registeredUser('w105-member-a');
  ownerB = await registeredUser('w105-owner-b');

  const tenantA_ = await provisionTenant(provisioner, {
    name: 'Dewey & Howe LLP',
    ownerPrincipalId: ownerA.principalId,
  });
  tenantA = tenantA_.id;
  await selectCompany({ token: ownerA.token, tenantId: tenantA });

  // A second authorized principal in the SAME tenant (the separation-of-
  // duties counterpart for the grant review) and a claim-less member.
  await addTenantMember(
    { tenantId: tenantA, principalId: ownerA.principalId, authority: [] },
    { principalId: adminA.principalId, role: 'admin' },
  );
  await selectCompany({ token: adminA.token, tenantId: tenantA });
  await addTenantMember(
    { tenantId: tenantA, principalId: ownerA.principalId, authority: [] },
    { principalId: memberA.principalId, role: 'member' },
  );
  await selectCompany({ token: memberA.token, tenantId: tenantA });

  const tenantB_ = await provisionTenant(provisioner, {
    name: 'Ledger & Sons Accounting',
    ownerPrincipalId: ownerB.principalId,
  });
  tenantB = tenantB_.id;
  await selectCompany({ token: ownerB.token, tenantId: tenantB });
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The catalog surfacing
// ---------------------------------------------------------------------------

describe('the catalog kits section', () => {
  it('lists the two signed starter kits for an anonymous visitor', async () => {
    const section = await buildKitCatalogSection(publicBrowsingContext());
    expect(section.ok).toBe(true);
    expect(section.tenantScoped).toBe(false);
    expect(section.items.map((kit) => kit.kitKey).sort()).toEqual(
      [ACCOUNTING, LEGAL].sort(),
    );
    for (const item of section.items) {
      expect(item.state.kind).toBe('shipped');
      expect(item.stateLabel).toBe('Signed starter kit');
    }
  });

  it('a scoped tenant with no registry yet still sees the shipped content', async () => {
    const section = await buildKitCatalogSection({
      tenantId: tenantB,
      principalId: ownerB.principalId,
      authority: [],
    });
    expect(section.ok).toBe(true);
    expect(section.tenantScoped).toBe(true);
    expect(section.items).toHaveLength(2);
    for (const item of section.items) {
      expect(item.tenant).not.toBe(null);
      expect(item.tenant!.registered).toBe(null);
      expect(item.tenant!.installation).toBe(null);
      expect(item.state.kind).toBe('shipped');
    }
  });
});

// ---------------------------------------------------------------------------
// The full lifecycle lifeline (through the surface's own handlers)
// ---------------------------------------------------------------------------

describe('the kit lifecycle through the marketplace surface', () => {
  let legalVersionId: string;

  it('refuses an unauthenticated write (401)', async () => {
    const result = await handleKitAction(
      new Request('https://aurum.test/x', { method: 'POST' }),
      LEGAL,
      'register',
      {},
    );
    expect(result.status).toBe(401);
  });

  it('refuses a claim-less member (403)', async () => {
    const result = await handleKitAction(
      kitRequest(memberA.principalId, `/api/product/marketplace/kit/${LEGAL}/register`),
      LEGAL,
      'register',
      {},
    );
    expect(result.status).toBe(403);
  });

  it('refuses an unknown kit key honestly (404 kit_not_shipped)', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, '/api/product/marketplace/kit/not-a-kit/register'),
      'not-a-kit',
      'register',
      {},
    );
    expect(result.status).toBe(404);
    if ('body' in result) expect(result.body.error).toBe('kit_not_shipped');
  });

  it('registers the SHIPPED starter version in the tenant registry', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/register`),
      LEGAL,
      'register',
      {},
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    expect(result.body['ok']).toBe(true);
    const version = result.body['version'] as {
      id: string;
      kitKey: string;
      version: string;
      manifestDigest: string;
    };
    expect(version.kitKey).toBe(LEGAL);
    expect(version.version).toBe('1.0.0');
    expect(isManifestDigest(version.manifestDigest)).toBe(true);
    legalVersionId = version.id;

    // The catalog enrichment now shows the registered (unverified) state.
    const section = await buildKitCatalogSection(ownerCtxOf(tenantA, ownerA.principalId));
    const legal = section.items.find((kit) => kit.kitKey === LEGAL)!;
    expect(legal.state.kind).toBe('verification');
    expect(legal.tenant!.registered!.id).toBe(legalVersionId);
    expect(legal.tenant!.registered!.verificationState).toBe('unverified');
  });

  it('refuses to register the same version twice (version_not_monotonic)', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/register`),
      LEGAL,
      'register',
      {},
    );
    expect(result.status).toBe(409);
  });

  it('refuses to install an unverified version (kit_not_verified)', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/install`),
      LEGAL,
      'install',
      { justification: 'premature install attempt' },
    );
    expect(result.status).toBe(409);
    if ('body' in result) expect(result.body.error).toBe('kit_not_verified');
  });

  it('records an append-only verification run (the shipped checks, over the stored bytes)', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/verify`),
      LEGAL,
      'verify',
      { kitVersionId: legalVersionId },
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const run = result.body['run'] as { outcome: string; checks: { check: string; passed: boolean }[] };
    expect(run.outcome).toBe('verified');
    expect(run.checks.every((check) => check.passed)).toBe(true);

    // The catalog enrichment now shows the verified posture.
    const section = await buildKitCatalogSection(ownerCtxOf(tenantA, ownerA.principalId));
    const legal = section.items.find((kit) => kit.kitKey === LEGAL)!;
    expect(legal.state.kind).toBe('verification');
    expect(legal.tenant!.registered!.verificationState).toBe('verified');
  });

  it('installs through the vertical-kits lifecycle and lands pending-review (the human gate)', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/install`),
      LEGAL,
      'install',
      { justification: 'legal operations starter for the firm' },
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const installation = result.body['installation'] as {
      installation: { id: string; status: string; kitKey: string; actionRequestId: string };
      grants: unknown[];
    };
    expect(installation.installation.status).toBe('pending-review');
    expect(installation.installation.kitKey).toBe(LEGAL);
    expect(installation.grants).toHaveLength(0); // nothing minted while pending

    // The catalog and the installed view both reflect the pending state.
    const section = await buildKitCatalogSection(ownerCtxOf(tenantA, ownerA.principalId));
    const legal = section.items.find((kit) => kit.kitKey === LEGAL)!;
    expect(legal.state.kind).toBe('installation');
    if (legal.state.kind === 'installation') {
      expect(legal.state.status).toBe('pending-review');
    }

    const installed = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    expect(installed.ok).toBe(true);
    expect(installed.items).toHaveLength(1);
    expect(installed.items[0]!.status).toBe('pending-review');
    expect(installed.items[0]!.live).toBe(true);
  });

  it('refuses a second install while a lifecycle is live (kit_already_installed)', async () => {
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/install`),
      LEGAL,
      'install',
      {},
    );
    expect(result.status).toBe(409);
    if ('body' in result) expect(result.body.error).toBe('kit_already_installed');
  });

  it('enforces separation of duties on the grant review (the requester never decides)', async () => {
    const installedBefore = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    const installationId = installedBefore.items[0]!.id;
    const result = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/decide-review`),
      LEGAL,
      'decide-review',
      { installationId, decision: 'approve' },
    );
    // The actions contract refuses the self-decision as 'forbidden' with
    // the separation-of-duties message — mapped to 403 by the API layer.
    expect(result.status).toBe(403);
    if ('body' in result) {
      expect(String(result.body.message)).toContain('separation of duties');
    }
  });

  it('another authorized principal decides the review — approval mints exactly the declared capabilities', async () => {
    const installedBefore = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    const installationId = installedBefore.items[0]!.id;
    const result = await handleKitAction(
      kitRequest(adminA.principalId, `/api/product/marketplace/kit/${LEGAL}/decide-review`),
      LEGAL,
      'decide-review',
      { installationId, decision: 'approve', note: 'the firm accepted the legal starter scope' },
    );
    expect(result.status).toBe(200);
    if (result.status !== 200) return;
    const installation = result.body['installation'] as {
      installation: { status: string };
      grants: { capabilityKey: string; status: string }[];
    };
    expect(installation.installation.status).toBe('granted');
    expect(installation.grants.length).toBeGreaterThan(0);
    expect(installation.grants.every((grant) => grant.status === 'active')).toBe(true);

    const detail = await buildKitDetailView(ownerCtxOf(tenantA, ownerA.principalId), LEGAL);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.view.installation!.status).toBe('granted');
      expect(detail.view.installation!.grants.active).toBe(installation.grants.length);
      expect(detail.view.actions.canActivate).toBe(true);
    }
  });

  it('activates, serves a capability invocation, and the ledger counts it', async () => {
    const installedBefore = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    const installationId = installedBefore.items[0]!.id;

    const activated = await handleKitAction(
      kitRequest(adminA.principalId, `/api/product/marketplace/kit/${LEGAL}/activate`),
      LEGAL,
      'activate',
      { installationId },
    );
    expect(activated.status).toBe(200);
    if (activated.status !== 200) return;
    const installation = activated.body['installation'] as { installation: { status: string } };
    expect(installation.installation.status).toBe('active');

    // A real capability invocation through the contract — the ledger row.
    const invocation = await invokeKitCapability(
      { tenantId: tenantA, principalId: adminA.principalId, authority: [] },
      {
        installationId,
        capabilityKey: 'read.case-matters',
        taskContext: { description: 'review the open matters for the weekly partner meeting' },
      },
    );
    expect(invocation.outcome).toBe('allowed');
    expect(invocation.basis).toBe('kit-grant');

    const installed = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    expect(installed.items[0]!.status).toBe('active');
    expect(installed.items[0]!.invocations!.allowed).toBe(1);
    expect(installed.items[0]!.grants!.active).toBeGreaterThan(0);

    const detail = await buildKitDetailView(ownerCtxOf(tenantA, ownerA.principalId), LEGAL);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.view.installation!.invocations.allowed).toBe(1);
      expect(detail.view.installation!.recentInvocations).toHaveLength(1);
      expect(detail.view.installation!.recentInvocations[0]!.outcome).toBe('allowed');
    }
  });

  it('suspends and resumes through the surface', async () => {
    const installedBefore = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    const installationId = installedBefore.items[0]!.id;

    const suspended = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/suspend`),
      LEGAL,
      'suspend',
      { installationId, reason: 'period-end freeze' },
    );
    expect(suspended.status).toBe(200);
    if (suspended.status !== 200) return;
    expect(
      (suspended.body['installation'] as { installation: { status: string } }).installation.status,
    ).toBe('suspended');

    const resumed = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/resume`),
      LEGAL,
      'resume',
      { installationId },
    );
    expect(resumed.status).toBe(200);
    if (resumed.status !== 200) return;
    expect(
      (resumed.body['installation'] as { installation: { status: string } }).installation.status,
    ).toBe('active');
  });

  it('removes terminally — grants revoked, audit retained, reinstallable', async () => {
    const installedBefore = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    const installationId = installedBefore.items[0]!.id;
    const grantsBefore = installedBefore.items[0]!.grants!.active;

    const removed = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/remove`),
      LEGAL,
      'remove',
      { installationId, reason: 'switching to the accounting vertical first' },
    );
    expect(removed.status).toBe(200);
    if (removed.status !== 200) return;
    const installation = removed.body['installation'] as {
      installation: { status: string };
      grants: { status: string }[];
    };
    expect(installation.installation.status).toBe('removed');
    expect(installation.grants.every((grant) => grant.status === 'revoked')).toBe(true);
    expect(grantsBefore).toBeGreaterThan(0);

    // The installed view keeps the terminal history (live first, then history).
    const installed = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    expect(installed.items).toHaveLength(1);
    expect(installed.items[0]!.status).toBe('removed');
    expect(installed.items[0]!.live).toBe(false);
    expect(installed.items[0]!.grants!.active).toBe(0);
    expect(installed.items[0]!.grants!.revoked).toBe(grantsBefore);

    // The kit is reinstallable — a fresh lifecycle.
    const reinstalled = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${LEGAL}/install`),
      LEGAL,
      'install',
      { justification: 'fresh lifecycle after the removal' },
    );
    expect(reinstalled.status).toBe(200);
    const installedAfter = await buildKitInstalledSection(ownerCtxOf(tenantA, ownerA.principalId));
    expect(installedAfter.items).toHaveLength(2);
    expect(installedAfter.items[0]!.live).toBe(true);
    expect(installedAfter.items[0]!.status).toBe('pending-review');
    expect(installedAfter.items[1]!.live).toBe(false);

    // Clean up: remove the fresh lifecycle so later isolation checks start clean.
    const cleanup = await handleKitAction(
      kitRequest(adminA.principalId, `/api/product/marketplace/kit/${LEGAL}/remove`),
      LEGAL,
      'remove',
      { installationId: installedAfter.items[0]!.id, reason: 'test cleanup' },
    );
    expect(cleanup.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The detail destination (the honest reads)
// ---------------------------------------------------------------------------

describe('the kit detail view', () => {
  it('renders the signed manifest, the recorded runs and the registry for a scoped caller', async () => {
    const result = await buildKitDetailView(ownerCtxOf(tenantA, ownerA.principalId), LEGAL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.kitKey).toBe(LEGAL);
    expect(isManifestDigest(view.manifestDigest)).toBe(true);
    expect(view.shippedChecksOutcome).toBe('verified');
    expect(view.registry!.ok).toBe(true);
    expect(view.registry!.versions.map((version) => version.version)).toContain('1.0.0');
    expect(view.registry!.latestRun!.outcome).toBe('verified');
    // Terminal history only — the live lifecycle was removed in the walk.
    expect(view.installation).toBe(null);
    expect(view.actions.canInstall).toBe(true); // verified version, no live install
  });

  it('is the honest not-found for an unknown kit key', async () => {
    const result = await buildKitDetailView(ownerCtxOf(tenantA, ownerA.principalId), 'no-such-kit');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('not_found');
  });

  it('an anonymous visitor sees the shipped content with no tenant sections', async () => {
    const result = await buildKitDetailView(publicBrowsingContext(), ACCOUNTING);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.registry).toBe(null);
    expect(result.view.installation).toBe(null);
    expect(result.view.actions.scoped).toBe(false);
    expect(result.view.shippedChecksOutcome).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (the no-leak discipline at every kit boundary)
// ---------------------------------------------------------------------------

describe('kit tenant isolation', () => {
  it('a second tenant sees none of the first tenant\u2019s registry or installations', async () => {
    const section = await buildKitCatalogSection(ownerCtxOf(tenantB, ownerB.principalId));
    const legal = section.items.find((kit) => kit.kitKey === LEGAL)!;
    expect(legal.tenant!.registered).toBe(null);
    expect(legal.tenant!.installation).toBe(null);
    expect(legal.state.kind).toBe('shipped');

    const installed = await buildKitInstalledSection(ownerCtxOf(tenantB, ownerB.principalId));
    expect(installed.ok).toBe(true);
    expect(installed.items).toHaveLength(0);

    const detail = await buildKitDetailView(ownerCtxOf(tenantB, ownerB.principalId), LEGAL);
    expect(detail.ok).toBe(true);
    if (detail.ok) {
      expect(detail.view.registry!.versions).toHaveLength(0);
      expect(detail.view.installation).toBe(null);
    }
  });

  it('a second tenant cannot govern the first tenant\u2019s installation (404, no existence leak)', async () => {
    // Tenant B installs its own kit to get an installation id, then tries
    // to act on a fabricated id: the contract treats cross-tenant access
    // as indistinguishable from missing.
    const registered = await handleKitAction(
      kitRequest(ownerB.principalId, `/api/product/marketplace/kit/${ACCOUNTING}/register`),
      ACCOUNTING,
      'register',
      {},
    );
    expect(registered.status).toBe(200);
    if (registered.status !== 200) return;
    const version = registered.body['version'] as { id: string };
    await handleKitAction(
      kitRequest(ownerB.principalId, `/api/product/marketplace/kit/${ACCOUNTING}/verify`),
      ACCOUNTING,
      'verify',
      { kitVersionId: version.id },
    );
    const installed = await handleKitAction(
      kitRequest(ownerB.principalId, `/api/product/marketplace/kit/${ACCOUNTING}/install`),
      ACCOUNTING,
      'install',
      {},
    );
    expect(installed.status).toBe(200);
    if (installed.status !== 200) return;
    const installation = installed.body['installation'] as { installation: { id: string; status: string } };
    expect(installation.installation.status).toBe('pending-review');

    // Tenant A tries to decide tenant B's pending review by id → 404.
    const foreign = await handleKitAction(
      kitRequest(ownerA.principalId, `/api/product/marketplace/kit/${ACCOUNTING}/decide-review`),
      ACCOUNTING,
      'decide-review',
      { installationId: installation.installation.id, decision: 'approve' },
    );
    expect(foreign.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// The detail destination (the honest reads)
// ---------------------------------------------------------------------------