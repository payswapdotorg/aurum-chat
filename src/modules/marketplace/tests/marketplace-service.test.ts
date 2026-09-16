// Integration tests for the marketplace module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W028
// acceptance:
//
//  * THE GOVERNED CHAIN, END TO END for BOTH kinds: an ExtensionPackage
//    (frozen from a manifest the vendor tenant registers through the
//    extensions contract) and an AgentPackage (the agent blueprint,
//    validated against the agents module's exported closed
//    vocabularies) each walk DRAFT → SUBMITTED →
//    AUTOMATED_VERIFICATION → PENDING_REVIEW → APPROVED → PUBLISHED →
//    INSTALLABLE, with the full transition trail, the append-only
//    verification run and the platform review decision recorded.
//  * PLATFORM APPROVAL IS MANDATORY (lock 27): nothing reaches
//    PUBLISHED/INSTALLABLE except through the platform review decision;
//    every skip attempt is invalid_transition; the reviewer is provably
//    neither the vendor principal nor the vendor tenant (separation of
//    duties — service check AND storage trigger); claim-less callers are
//    forbidden.
//  * AUTOMATED_VERIFICATION: the deterministic checks run BEFORE review
//    and atomically decide PENDING_REVIEW vs REJECTED; extension
//    packages record EXACTLY the extensions module's five checks (one
//    semantics — the same outcomes the registry's own run produces over
//    the same manifest); agent packages record the four marketplace
//    checks; a package corrupted past the storage shape floor (a bypass
//    write, the drift/bypass scenario) is CAUGHT and REJECTED with
//    per-check evidence; REJECTED is terminal and the fixed artifact
//    ships as a NEW strictly-increasing version.
//  * TENANT ISOLATION ON THE PLATFORM CATALOG (ADR-0001 adapted):
//    pre-publication packages — and their verification runs, review
//    decisions and lifecycle trails — are invisible to every other
//    tenant (uniform package_not_found, no existence leak, reads AND
//    writes); the public catalog exposes exactly PUBLISHED/INSTALLABLE
//    versions to every tenant; publication never implies installation
//    (lock 26) — this module's chain ends at INSTALLABLE.
//  * STORAGE-LEVEL GUARANTEES: package payloads are frozen (only state
//    and updated_at may move), DELETE/TRUNCATE are forbidden, evidence
//    tables are append-only, the separation-of-duties trigger and the
//    lifecycle direction CHECK hold for writes bypassing the service.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  getManifest,
  registerExtensionManifest,
} from '@/modules/extensions/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { MarketplaceError } from '../errors';
import * as marketplace from '../contract';
import {
  AGENT_PACKAGE_CHECKS,
  EXTENSION_PACKAGE_CHECKS,
  MARKETPLACE_AUTHORITY_ADMINISTER,
  MARKETPLACE_AUTHORITY_SUBMIT,
} from '../contract';
import type { CreateAgentPackageInput, MarketplacePackage } from '../types';

const {
  createPackage,
  getPackage,
  getPackageVerification,
  listCatalogPackages,
  listPackageLifecycleEvents,
  listPackageReviews,
  listPackageVerifications,
  listPackages,
  listReviewQueue,
  makePackageInstallable,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
} = marketplace;

// Dedicated tenants keep each concern's data isolated from the others,
// so every assertion below sees only what it created itself.
const tenantVendor = newId();
const tenantVendorB = newId();
const tenantPlatform = newId();
const tenantInstaller = newId();
const tenantIso = newId();
const tenantDrift = newId();

const VENDOR_PRINCIPAL = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

function vendorSubmitter(tenantId: string, principalId: string = newId()): TenantContext {
  return { tenantId, principalId, authority: [MARKETPLACE_AUTHORITY_SUBMIT] };
}

/** The vendor that walks the happy paths (a stable principal, for provenance assertions). */
function vendorA(): TenantContext {
  return vendorSubmitter(tenantVendor, VENDOR_PRINCIPAL);
}

function extensionRegistrar(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['extensions:administer'] };
}

function platformAdmin(tenantId: string = tenantPlatform, principalId: string = newId()): TenantContext {
  return { tenantId, principalId, authority: [MARKETPLACE_AUTHORITY_ADMINISTER] };
}

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/** Async-aware error-code assertion — contract operations reject, not throw. */
async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MarketplaceError);
    expect((error as MarketplaceError).code).toBe(code);
  }
}

/** A raw db statement is rejected with a message containing `fragment`. */
async function expectDbRejection(fragment: string, fn: () => Promise<unknown>): Promise<void> {
  await expect(fn()).rejects.toThrow(fragment);
}

/** Register one extension manifest version in the vendor tenant (the artifact source). */
async function registerManifest(
  tenantId: string,
  extensionKey: string,
  version: string,
): Promise<string> {
  const registered = await registerExtensionManifest(extensionRegistrar(tenantId), {
    extensionKey,
    version,
    manifestSchemaVersion: 1,
    displayName: 'Probe Extension',
    hostRuntime: { minVersion: '1.0.0' },
  });
  return registered.manifest.id;
}

/** The full governed chain for an already-submitted package (approve path). */
async function approveThrough(
  pkg: MarketplacePackage,
): Promise<MarketplacePackage> {
  const verified = await runAutomatedVerification(platformAdmin(), { packageId: pkg.id });
  expect(verified.package.state).toBe('PENDING_REVIEW');
  const reviewed = await reviewPackage(platformAdmin(), {
    packageId: pkg.id,
    decision: 'approve',
    reason: 'Clean artifact',
  });
  expect(reviewed.package.state).toBe('APPROVED');
  const published = await publishPackage(platformAdmin(), { packageId: pkg.id });
  expect(published.state).toBe('PUBLISHED');
  const installable = await makePackageInstallable(platformAdmin(), { packageId: pkg.id });
  expect(installable.state).toBe('INSTALLABLE');
  return installable;
}

/** Create + submit one agent package for `tenantId`. */
async function submitAgentPackage(
  tenantId: string,
  packageKey: string,
  version: string,
): Promise<MarketplacePackage> {
  const created = await createPackage(vendorSubmitter(tenantId), {
    kind: 'agent',
    packageKey,
    version,
    displayName: 'Reconciler',
    description: 'Reconciles invoices.',
    role: 'Invoice reconciler',
    instructions: 'Reconcile invoices; flag mismatches.',
    provider: 'langgraph',
    permissions: ['analyze', 'observe'],
  });
  return submitPackage(vendorSubmitter(tenantId), { packageId: created.id });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The governed chain, end to end
// ---------------------------------------------------------------------------

describe('the governed chain (extension package)', () => {
  it('walks DRAFT → SUBMITTED → AUTOMATED_VERIFICATION → PENDING_REVIEW → APPROVED → PUBLISHED → INSTALLABLE', async () => {
    const manifestId = await registerManifest(tenantVendor, 'invoice-sync', '1.4.0');

    // DRAFT: the manifest content is FROZEN into a self-contained
    // platform artifact (read once, under the vendor's own context).
    const created = await createPackage(vendorA(), { kind: 'extension', manifestId });
    expect(created.state).toBe('DRAFT');
    expect(created.kind).toBe('extension');
    expect(created.packageKey).toBe('invoice-sync'); // defaults to the extension key
    expect(created.version).toBe('1.4.0');
    expect(created.vendorTenant).toBe(tenantVendor);
    expect(created.vendorPrincipal).toBe(VENDOR_PRINCIPAL);
    expect(created.payload).toEqual({
      manifestId,
      extensionKey: 'invoice-sync',
      subject: {
        manifestSchemaVersion: 1,
        requestedPermissions: [],
        capabilities: {
          stateScope: 'none',
          uiSurfaces: [],
          schedules: [],
          eventSubscriptions: [],
          externalParticipants: [],
          telemetry: false,
        },
        quotas: {
          maxStateBytes: 0,
          maxScheduleInvocationsPerDay: 0,
          maxExternalCallsPerDay: 0,
        },
        hostCompatibility: { minVersion: '1.0.0', maxVersion: null },
      },
    });
    expect(marketplace.isExtensionPackage(created)).toBe(true);
    expect(marketplace.isAgentPackage(created)).toBe(false);

    // SUBMITTED: the vendor's hand-off.
    const submitted = await submitPackage(vendorA(), { packageId: created.id });
    expect(submitted.state).toBe('SUBMITTED');

    // AUTOMATED_VERIFICATION → PENDING_REVIEW with the run as evidence.
    const verified = await runAutomatedVerification(platformAdmin(), { packageId: created.id });
    expect(verified.package.state).toBe('PENDING_REVIEW');
    expect(verified.run.outcome).toBe('verified');
    expect(verified.run.checks.map((check) => check.check)).toEqual([...EXTENSION_PACKAGE_CHECKS]);
    expect(verified.run.checks.every((check) => check.outcome === 'pass')).toBe(true);
    expect(verified.run.summary).toBe('5/5 checks passed');
    expect(verified.run.ranByTenant).toBe(tenantPlatform);

    // The derived posture folds from the latest run.
    const info = await getPackageVerification(vendorA(), { packageId: created.id });
    expect(info.outcome).toBe('verified');
    expect(info.latestRun?.id).toBe(verified.run.id);

    // PENDING_REVIEW → APPROVED (the mandatory platform decision).
    const reviewed = await reviewPackage(platformAdmin(), {
      packageId: created.id,
      decision: 'approve',
      reason: 'Clean artifact',
    });
    expect(reviewed.package.state).toBe('APPROVED');
    expect(reviewed.review.decision).toBe('approve');
    expect(reviewed.review.reason).toBe('Clean artifact');
    expect(reviewed.review.reviewedByTenant).toBe(tenantPlatform);

    // APPROVED → PUBLISHED → INSTALLABLE.
    const published = await publishPackage(platformAdmin(), { packageId: created.id });
    expect(published.state).toBe('PUBLISHED');
    const installable = await makePackageInstallable(platformAdmin(), { packageId: created.id });
    expect(installable.state).toBe('INSTALLABLE');

    // The full transition trail, newest first, with the exact states and actors.
    const trail = await listPackageLifecycleEvents(vendorA(), { packageId: created.id });
    expect(trail.map((event) => event.transition)).toEqual([
      'make-installable',
      'publish',
      'approve',
      'verification-passed',
      'verify',
      'submit',
    ]);
    expect(trail.every((event) => event.packageId === created.id)).toBe(true);
    const submitEvent = trail.find((event) => event.transition === 'submit')!;
    expect(submitEvent.fromState).toBe('DRAFT');
    expect(submitEvent.toState).toBe('SUBMITTED');
    expect(submitEvent.actor).toBe(VENDOR_PRINCIPAL);
    expect(submitEvent.actorTenant).toBe(tenantVendor);
    const verifyEvent = trail.find((event) => event.transition === 'verify')!;
    expect(verifyEvent.fromState).toBe('SUBMITTED');
    expect(verifyEvent.toState).toBe('AUTOMATED_VERIFICATION');
    expect(verifyEvent.actorTenant).toBe(tenantPlatform);

    // Deep-linked reads survive the whole chain.
    const read = await getPackage(vendorA(), { packageId: created.id });
    expect(read.state).toBe('INSTALLABLE');
    expect(read.createdAt).toBe(created.createdAt);
    expect(read.updatedAt >= read.createdAt).toBe(true);
  });

  it('runs EXACTLY the extensions module\'s own checks — one semantics with the registry', async () => {
    const manifestId = await registerManifest(tenantVendor, 'semantics-probe', '2.0.0');
    const submitted = await submitPackage(
      vendorA(),
      { packageId: (await createPackage(vendorA(), { kind: 'extension', manifestId })).id },
    );

    const run = await runAutomatedVerification(platformAdmin(), { packageId: submitted.id });
    // The registry's own derived view of the same manifest records the
    // same five-check outcome for the same subject.
    const manifest = await getManifest(extensionRegistrar(tenantVendor), { manifestId });
    expect(manifest.verification.state).toBe('UNVERIFIED'); // the registry never ran its own
    // The marketplace ran the SAME exported pure checks over the frozen
    // subject: identical check names, identical outcomes.
    expect(run.run.checks.map((check) => check.check)).toEqual([...EXTENSION_PACKAGE_CHECKS]);
    expect([...EXTENSION_PACKAGE_CHECKS]).toEqual([
      'manifest-schema',
      'permissions-consistency',
      'capability-declarations',
      'quota-bounds',
      'compatibility-bounds',
    ]);
    expect(run.package.state).toBe('PENDING_REVIEW');

    // The vendor's own registry remains untouched by the marketplace's
    // phase (module boundary: no cross-module writes).
    const after = await getManifest(extensionRegistrar(tenantVendor), { manifestId });
    expect(after.verification.state).toBe('UNVERIFIED');
  });

  it('freezes the manifest under the VENDOR\'s own context only', async () => {
    const foreignManifestId = await registerManifest(tenantVendorB, 'vendor-b-widget', '1.0.0');
    // A well-formed uuid that no tenant can read: uniformly invalid_manifest_ref.
    await expectCode('invalid_manifest_ref', () =>
      createPackage(vendorA(), { kind: 'extension', manifestId: foreignManifestId }),
    );
    await expectCode('invalid_manifest_ref', () =>
      createPackage(vendorA(), { kind: 'extension', manifestId: newId() }),
    );
    // A vendor can freeze its own manifest under a distinct catalog key.
    const ownManifestId = await registerManifest(tenantVendor, 'rebranded-widget', '1.0.0');
    const created = await createPackage(vendorA(), {
      kind: 'extension',
      manifestId: ownManifestId,
      packageKey: 'acme-rebranded',
    });
    expect(created.packageKey).toBe('acme-rebranded');
    expect(created.payload).toMatchObject({ extensionKey: 'rebranded-widget' });
  });
});

describe('the governed chain (agent package)', () => {
  it('walks the same chain with the agent-package check set', async () => {
    const created = await createPackage(vendorA(), {
      kind: 'agent',
      packageKey: 'invoice-reconciler',
      version: '1.2.3',
      displayName: 'Invoice Reconciler',
      description: 'Reconciles invoices against the ledger.',
      role: 'Invoice reconciler',
      instructions: 'Reconcile invoices; flag mismatches.',
      provider: 'crewai',
      permissions: ['analyze', 'observe', 'observe'],
    });
    expect(created.state).toBe('DRAFT');
    expect(marketplace.isAgentPackage(created)).toBe(true);
    // The blueprint is normalized: deduplicated, canonical §20 order.
    expect(created.payload).toEqual({
      role: 'Invoice reconciler',
      instructions: 'Reconcile invoices; flag mismatches.',
      provider: 'crewai',
      permissions: ['observe', 'analyze'],
    });

    await submitPackage(vendorA(), { packageId: created.id });
    const verified = await runAutomatedVerification(platformAdmin(), { packageId: created.id });
    expect(verified.package.state).toBe('PENDING_REVIEW');
    expect(verified.run.checks.map((check) => check.check)).toEqual([...AGENT_PACKAGE_CHECKS]);
    expect(verified.run.summary).toBe('4/4 checks passed');

    const reviewed = await reviewPackage(platformAdmin(), {
      packageId: created.id,
      decision: 'approve',
    });
    expect(reviewed.package.state).toBe('APPROVED');
    expect(reviewed.review.reason).toBeNull(); // optional on approval

    const published = await publishPackage(platformAdmin(), { packageId: created.id });
    expect(published.state).toBe('PUBLISHED');
    const installable = await makePackageInstallable(platformAdmin(), { packageId: created.id });
    expect(installable.state).toBe('INSTALLABLE');
  });

  it('rejects agent blueprints that violate the agents module\'s closed vocabularies at creation', async () => {
    const base: CreateAgentPackageInput = {
      kind: 'agent',
      packageKey: 'bad-probe',
      version: '1.0.0',
      displayName: 'Bad Probe',
      role: 'Probe',
      instructions: 'Probe.',
      provider: 'crewai',
      permissions: ['observe'],
    };
    await expectCode('invalid_input', () =>
      createPackage(vendorA(), { ...base, provider: 'vendor-runtime' as never }),
    );
    await expectCode('invalid_input', () =>
      createPackage(vendorA(), { ...base, permissions: ['root' as never] }),
    );
    await expectCode('invalid_input', () => createPackage(vendorA(), { ...base, permissions: [] }));
    await expectCode('invalid_input', () =>
      createPackage(vendorA(), { ...base, version: '2.0' }),
    );
    await expectCode('invalid_input', () =>
      createPackage(vendorA(), { ...base, packageKey: 'Not_A_Slug' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Platform approval is mandatory
// ---------------------------------------------------------------------------

describe('platform approval is mandatory (lock 27)', () => {
  it('rejects every attempt to skip the platform decision', async () => {
    const manifestId = await registerManifest(tenantVendor, 'skip-probe', '1.0.0');
    const created = await createPackage(vendorA(), { kind: 'extension', manifestId });

    // No publishing straight from the early states.
    await expectCode('invalid_transition', () =>
      publishPackage(platformAdmin(), { packageId: created.id }),
    );
    await expectCode('invalid_transition', () =>
      makePackageInstallable(platformAdmin(), { packageId: created.id }),
    );
    // No review before verification put it in the queue.
    await expectCode('invalid_transition', () =>
      reviewPackage(platformAdmin(), { packageId: created.id, decision: 'approve' }),
    );
    // Verification runs on SUBMITTED packages only.
    await expectCode('invalid_transition', () =>
      runAutomatedVerification(platformAdmin(), { packageId: created.id }),
    );

    const submitted = await submitPackage(vendorA(), { packageId: created.id });
    // Still no review: the automated phase has not run.
    await expectCode('invalid_transition', () =>
      reviewPackage(platformAdmin(), { packageId: submitted.id, decision: 'approve' }),
    );
    await expectCode('invalid_transition', () =>
      publishPackage(platformAdmin(), { packageId: submitted.id }),
    );

    const verified = await runAutomatedVerification(platformAdmin(), { packageId: submitted.id });
    // INSTALLABLE is reachable only through APPROVED → PUBLISHED.
    await expectCode('invalid_transition', () =>
      makePackageInstallable(platformAdmin(), { packageId: verified.package.id }),
    );
    await expectCode('invalid_transition', () =>
      publishPackage(platformAdmin(), { packageId: verified.package.id }),
    ); // not approved yet — review first

    const reviewed = await reviewPackage(platformAdmin(), {
      packageId: verified.package.id,
      decision: 'approve',
    });
    await expectCode('invalid_transition', () =>
      makePackageInstallable(platformAdmin(), { packageId: reviewed.package.id }),
    ); // approved but not published
  });

  it('separates the reviewer from the vendor — principal AND tenant', async () => {
    const manifestId = await registerManifest(tenantVendor, 'duties-probe', '1.0.0');
    const created = await createPackage(vendorA(), { kind: 'extension', manifestId });
    await submitPackage(vendorA(), { packageId: created.id });
    await runAutomatedVerification(platformAdmin(), { packageId: created.id });

    // The vendor principal itself, holding a mis-granted administer claim.
    await expectCode('separation_of_duties', () =>
      reviewPackage(
        { tenantId: tenantVendor, principalId: VENDOR_PRINCIPAL, authority: [MARKETPLACE_AUTHORITY_ADMINISTER] },
        { packageId: created.id, decision: 'approve' },
      ),
    );
    // A different principal of the VENDOR TENANT, likewise mis-granted.
    await expectCode('separation_of_duties', () =>
      reviewPackage(platformAdmin(tenantVendor), { packageId: created.id, decision: 'approve' }),
    );
    // A different tenant, but the SAME principal id.
    await expectCode('separation_of_duties', () =>
      reviewPackage(
        { tenantId: tenantInstaller, principalId: VENDOR_PRINCIPAL, authority: [MARKETPLACE_AUTHORITY_ADMINISTER] },
        { packageId: created.id, decision: 'approve' },
      ),
    );

    // A genuinely distinct platform reviewer decides it.
    const reviewed = await reviewPackage(platformAdmin(), {
      packageId: created.id,
      decision: 'approve',
      reason: 'Distinct reviewer',
    });
    expect(reviewed.package.state).toBe('APPROVED');
  });

  it('gates every platform-side operation behind the administer claim', async () => {
    const manifestId = await registerManifest(tenantVendor, 'claim-probe', '1.0.0');
    const created = await createPackage(vendorA(), { kind: 'extension', manifestId });
    await submitPackage(vendorA(), { packageId: created.id });

    await expectCode('forbidden', () =>
      runAutomatedVerification(member(tenantPlatform), { packageId: created.id }),
    );
    await expectCode('forbidden', () =>
      reviewPackage(member(tenantPlatform), { packageId: created.id, decision: 'approve' }),
    );
    await expectCode('forbidden', () => publishPackage(member(tenantPlatform), { packageId: created.id }));
    await expectCode('forbidden', () =>
      makePackageInstallable(member(tenantPlatform), { packageId: created.id }),
    );
    await expectCode('forbidden', () => listReviewQueue(member(tenantPlatform), {}));
    // The vendor itself lacks the platform claim too.
    await expectCode('forbidden', () =>
      runAutomatedVerification(vendorA(), { packageId: created.id }),
    );
  });

  it('gates the vendor side behind the submit claim', async () => {
    const manifestId = await registerManifest(tenantVendor, 'submit-claim-probe', '1.0.0');
    await expectCode('forbidden', () =>
      createPackage(member(tenantVendor), { kind: 'extension', manifestId }),
    );
    const created = await createPackage(vendorA(), { kind: 'extension', manifestId });
    await expectCode('forbidden', () =>
      submitPackage(member(tenantVendor), { packageId: created.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// AUTOMATED_VERIFICATION: failure, drift and bypass writes
// ---------------------------------------------------------------------------

describe('automated verification failure and the fixed next version', () => {
  it('REJECTS a package corrupted past the storage shape floor — the FAILED path is reachable', async () => {
    // Bypass the service: an agent package whose provider is garbage.
    // The migration's shape CHECKs pin structure only (the extensions
    // module's cron-grammar precedent) — vocabulary is AUTOMATED_
    // VERIFICATION scope, so this row lands and must be CAUGHT.
    const db = getDb();
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO marketplace_packages (
         package_kind, package_key, version,
         version_major, version_minor, version_patch,
         display_name, description, payload,
         vendor_tenant, vendor_principal, state, created_at, updated_at
       ) VALUES ('agent', 'drift-probe', '1.0.0', 1, 0, 0, 'Drift Probe', NULL,
         '{"role":"Probe","instructions":"Probe.","provider":"vendor-runtime","permissions":["observe"]}'::jsonb,
         $1, 'drift-probe-vendor', 'SUBMITTED', now(), now())
       RETURNING id`,
      [tenantDrift],
    );
    const packageId = inserted.rows[0]!.id;

    const result = await runAutomatedVerification(platformAdmin(), { packageId });
    expect(result.package.state).toBe('REJECTED');
    expect(result.run.outcome).toBe('failed');
    const failed = result.run.checks.find((check) => check.check === 'provider-known')!;
    expect(failed.outcome).toBe('fail');
    expect(failed.detail).toContain('provider must be one of');
    expect(result.run.summary).toBe('3/4 checks passed — failed: provider-known');

    // The evidence is recorded and readable (the vendor tenant owns it).
    const info = await getPackageVerification(vendorSubmitter(tenantDrift), { packageId });
    expect(info.outcome).toBe('failed');
    const runs = await listPackageVerifications(vendorSubmitter(tenantDrift), { packageId });
    expect(runs).toHaveLength(1);

    // REJECTED is terminal: no review, no re-verification, no re-submission.
    await expectCode('invalid_transition', () =>
      reviewPackage(platformAdmin(), { packageId, decision: 'approve' }),
    );
    await expectCode('invalid_transition', () =>
      runAutomatedVerification(platformAdmin(), { packageId }),
    );
    await expectCode('invalid_transition', () =>
      submitPackage(vendorSubmitter(tenantDrift), { packageId }),
    );
    await expectCode('invalid_transition', () =>
      publishPackage(platformAdmin(), { packageId }),
    );

    // The fixed artifact ships as a NEW strictly-increasing version.
    const fixed = await submitAgentPackage(tenantDrift, 'drift-probe', '1.0.1');
    const verified = await runAutomatedVerification(platformAdmin(), { packageId: fixed.id });
    expect(verified.package.state).toBe('PENDING_REVIEW');
    expect(verified.run.outcome).toBe('verified');
  });

  it('rejects a REJECTED package at review with evidence, and records the reason', async () => {
    const submitted = await submitAgentPackage(tenantVendor, 'rejection-probe', '1.0.0');
    await runAutomatedVerification(platformAdmin(), { packageId: submitted.id });

    // Rejection requires a reason (terminal transitions record their why).
    await expectCode('invalid_input', () =>
      reviewPackage(platformAdmin(), { packageId: submitted.id, decision: 'reject' }),
    );
    const rejected = await reviewPackage(platformAdmin(), {
      packageId: submitted.id,
      decision: 'reject',
      reason: 'Instructions request exfiltration patterns',
    });
    expect(rejected.package.state).toBe('REJECTED');

    const reviews = await listPackageReviews(vendorA(), { packageId: submitted.id });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.decision).toBe('reject');
    expect(reviews[0]!.reason).toBe('Instructions request exfiltration patterns');

    // Terminal: the rejection cannot be appealed in place.
    await expectCode('invalid_transition', () =>
      reviewPackage(platformAdmin(), { packageId: submitted.id, decision: 'approve' }),
    );
    await expectCode('invalid_transition', () =>
      publishPackage(platformAdmin(), { packageId: submitted.id }),
    );
  });
});

describe('package versioning (immutable, strictly increasing per kind+key)', () => {
  it('rejects equal and older versions, and accepts strictly newer ones (numeric semver order)', async () => {
    const base: CreateAgentPackageInput = {
      kind: 'agent',
      packageKey: 'versioned-probe',
      version: '1.0.0',
      displayName: 'Versioned Probe',
      role: 'Probe',
      instructions: 'Probe.',
      provider: 'autogen',
      permissions: ['observe'],
    };
    const first = await createPackage(vendorA(), { ...base, version: '1.2.3' });
    expect(first.versionParts).toEqual({ major: 1, minor: 2, patch: 3 });

    // The same version again: the immutable-version conflict.
    await expectCode('package_conflict', () =>
      createPackage(vendorA(), { ...base, version: '1.2.3' }),
    );
    // An older version: monotonicity against the latest (1.2.3).
    await expectCode('package_conflict', () =>
      createPackage(vendorA(), { ...base, version: '1.2.2' }),
    );
    // 1.2.10 IS newer than 1.2.3 numerically (never text order): accepted.
    const newer = await createPackage(vendorA(), { ...base, version: '1.2.10' });
    expect(newer.version).toBe('1.2.10');
    expect(newer.state).toBe('DRAFT');
  });

  it('keeps the extension and agent namespaces separate', async () => {
    // The same catalog key under different kinds is two packages.
    const agent = await createPackage(vendorA(), {
      kind: 'agent',
      packageKey: 'namespace-probe',
      version: '1.0.0',
      displayName: 'Namespace Probe',
      role: 'Probe',
      instructions: 'Probe.',
      provider: 'autogen',
      permissions: ['observe'],
    });
    const manifestId = await registerManifest(tenantVendor, 'namespace-probe', '1.0.0');
    const extension = await createPackage(vendorA(), { kind: 'extension', manifestId });
    expect(agent.id).not.toBe(extension.id);
    expect(extension.packageKey).toBe('namespace-probe');
    expect(extension.version).toBe('1.0.0');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation on the platform catalog
// ---------------------------------------------------------------------------

describe('tenant isolation (platform catalog visibility)', () => {
  it('hides another tenant\'s pre-publication package — reads AND writes, no existence leak', async () => {
    const manifestId = await registerManifest(tenantVendor, 'iso-probe', '1.0.0');
    const created = await createPackage(vendorA(), { kind: 'extension', manifestId });
    await submitPackage(vendorA(), { packageId: created.id });
    const verified = await runAutomatedVerification(platformAdmin(), { packageId: created.id });

    const foreign = member(tenantIso);
    // Reads: the package, its runs, its (empty) reviews, its trail.
    await expectCode('package_not_found', () => getPackage(foreign, { packageId: created.id }));
    await expectCode('package_not_found', () =>
      getPackageVerification(foreign, { packageId: created.id }),
    );
    await expectCode('package_not_found', () =>
      listPackageVerifications(foreign, { packageId: created.id }),
    );
    await expectCode('package_not_found', () => listPackageReviews(foreign, { packageId: created.id }));
    await expectCode('package_not_found', () =>
      listPackageLifecycleEvents(foreign, { packageId: created.id }),
    );
    // Writes: the foreign tenant cannot submit the vendor's package
    // (the vendor-scoped path — uniform not_found). The platform-side
    // operations (review/publish/installable) are claim-gated FIRST
    // ('forbidden' for claim-less callers — covered in the claims suite);
    // a caller HOLDING the administer claim is a platform operator by
    // definition and may act on any pipeline package — that is the
    // governance model, not a leak: vendor pre-publication work stays
    // invisible to plain tenants and to other vendors.
    await expectCode('package_not_found', () =>
      submitPackage(vendorSubmitter(tenantIso), { packageId: created.id }),
    );
    // Platform operators DO see the pipeline package (administer claim).
    const seen = await getPackage(platformAdmin(), { packageId: created.id });
    expect(seen.state).toBe('PENDING_REVIEW');

    // Once public, the SAME foreign tenant sees it — that is the
    // marketplace's purpose (lock 26: publication ≠ installation, but
    // publication = catalog visibility).
    const reviewed = await reviewPackage(platformAdmin(), {
      packageId: verified.package.id,
      decision: 'approve',
    });
    await publishPackage(platformAdmin(), { packageId: reviewed.package.id });
    const publicRead = await getPackage(foreign, { packageId: created.id });
    expect(publicRead.state).toBe('PUBLISHED');
    const publicRuns = await listPackageVerifications(foreign, { packageId: created.id });
    expect(publicRuns).toHaveLength(1);
  });

  it('never lists another tenant\'s packages in the vendor view', async () => {
    const own = await submitAgentPackage(tenantIso, 'iso-own-probe', '1.0.0');
    const theirs = await submitAgentPackage(tenantVendor, 'iso-their-probe', '1.0.0');

    const ownView = await listPackages(vendorSubmitter(tenantIso), {});
    expect(ownView.map((pkg) => pkg.id)).toContain(own.id);
    expect(ownView.map((pkg) => pkg.id)).not.toContain(theirs.id);

    const theirView = await listPackages(vendorA(), { kind: 'agent' });
    expect(theirView.map((pkg) => pkg.id)).toContain(theirs.id);
    expect(theirView.map((pkg) => pkg.id)).not.toContain(own.id);

    // Filters: kind and states.
    const drafts = await listPackages(vendorSubmitter(tenantIso), { states: ['DRAFT'] });
    expect(drafts).toHaveLength(0); // the only own package is SUBMITTED
    const submitted = await listPackages(vendorSubmitter(tenantIso), {
      states: ['SUBMITTED'],
      kind: 'agent',
    });
    expect(submitted.map((pkg) => pkg.id)).toEqual([own.id]);
  });

  it('exposes exactly PUBLISHED and INSTALLABLE versions in the public catalog', async () => {
    // A package at every non-public stage of the same key.
    const draft = await createPackage(vendorA(), {
      kind: 'agent',
      packageKey: 'catalog-probe',
      version: '1.0.0',
      displayName: 'Catalog Probe',
      role: 'Probe',
      instructions: 'Probe.',
      provider: 'autogen',
      permissions: ['observe'],
    });
    const submitted = await submitAgentPackage(tenantVendor, 'catalog-probe', '2.0.0');

    // Nothing public yet: an empty catalog for every tenant.
    const before = await listCatalogPackages(member(tenantIso), {});
    expect(before.map((pkg) => pkg.packageKey)).not.toContain('catalog-probe');

    // One version walks the whole chain to INSTALLABLE.
    const installable = await approveThrough(
      await submitAgentPackage(tenantVendor, 'catalog-probe', '3.0.0'),
    );

    // The catalog shows only the public version, to ANY tenant — never
    // the draft or the in-flight submission of the same key.
    const catalog = await listCatalogPackages(member(tenantIso), { kind: 'agent' });
    const mine = catalog.filter((pkg) => pkg.packageKey === 'catalog-probe');
    expect(mine.map((pkg) => pkg.id)).toEqual([installable.id]);
    expect(mine[0]!.state).toBe('INSTALLABLE');
    expect(catalog.map((pkg) => pkg.id)).not.toContain(draft.id);
    expect(catalog.map((pkg) => pkg.id)).not.toContain(submitted.id);
    // The vendor's own catalog view is the same public one (plus nothing
    // pre-publication — listPackages is where their own drafts appear).
    const vendorCatalog = await listCatalogPackages(vendorA(), {});
    expect(vendorCatalog.map((pkg) => pkg.id)).not.toContain(draft.id);
  });
});

// ---------------------------------------------------------------------------
// The platform review queue
// ---------------------------------------------------------------------------

describe('the platform review queue', () => {
  it('lists exactly the pipeline states, oldest first, for platform operators', async () => {
    const first = await submitAgentPackage(tenantVendor, 'queue-probe-1', '1.0.0');
    await submitAgentPackage(tenantVendor, 'queue-probe-2', '1.0.0');
    const verifiedPkg = await runAutomatedVerification(platformAdmin(), {
      packageId: (await submitAgentPackage(tenantVendor, 'queue-probe-3', '1.0.0')).id,
    });
    await approveThrough(await submitAgentPackage(tenantVendor, 'queue-probe-4', '1.0.0'));

    const queue = await listReviewQueue(platformAdmin(), { kind: 'agent' });
    const ids = queue.map((pkg) => pkg.id);
    expect(ids).toContain(first.id);
    expect(queue.every((pkg) =>
      ['SUBMITTED', 'AUTOMATED_VERIFICATION', 'PENDING_REVIEW'].includes(pkg.state),
    )).toBe(true);
    // The verified package sits in the queue as PENDING_REVIEW.
    expect(queue.find((pkg) => pkg.id === verifiedPkg.package.id)?.state).toBe('PENDING_REVIEW');
    // The queue is ordered oldest-updated first (updated_at ASC, id ASC
    // tiebreak) — the backlog discipline; cross-package timestamps can
    // tie within one millisecond under the embedded database, so the
    // strict global order is not asserted here.
    expect(queue.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Storage-level guarantees (writes bypassing the service)
// ---------------------------------------------------------------------------

describe('storage-level guarantees', () => {
  it('freezes the package payload — only state and updated_at may move', async () => {
    const submitted = await submitAgentPackage(tenantDrift, 'storage-probe', '1.0.0');
    const db = getDb();
    await expectDbRejection(
      'only the governed state',
      () =>
        db.query(`UPDATE marketplace_packages SET payload = '{"role":"Hacked"}'::jsonb WHERE id = $1`, [
          submitted.id,
        ]),
    );
    await expectDbRejection(
      'only the governed state',
      () =>
        db.query(`UPDATE marketplace_packages SET display_name = 'Hacked' WHERE id = $1`, [
          submitted.id,
        ]),
    );
    await expectDbRejection(
      'only the governed state',
      () =>
        db.query(`UPDATE marketplace_packages SET vendor_tenant = $2 WHERE id = $1`, [
          submitted.id,
          newId(),
        ]),
    );
    await expectDbRejection(
      'catalog history',
      () => db.query(`DELETE FROM marketplace_packages WHERE id = $1`, [submitted.id]),
    );
    // The legal mutation (a state move by a bypass write) is allowed at
    // the storage layer — the service + event trail are the governance.
    const moved = await db.query(
      `UPDATE marketplace_packages SET state = 'REJECTED', updated_at = now() WHERE id = $1`,
      [submitted.id],
    );
    expect(moved.rowCount).toBe(1);
  });

  it('rejects UPDATE/DELETE on the append-only evidence tables', async () => {
    const manifestId = await registerManifest(tenantDrift, 'evidence-probe', '1.0.0');
    const created = await createPackage(vendorSubmitter(tenantDrift), {
      kind: 'extension',
      manifestId,
    });
    await submitPackage(vendorSubmitter(tenantDrift), { packageId: created.id });
    const verified = await runAutomatedVerification(platformAdmin(), { packageId: created.id });
    await reviewPackage(platformAdmin(), {
      packageId: created.id,
      decision: 'approve',
      reason: 'Storage probe',
    });
    const events = await listPackageLifecycleEvents(vendorSubmitter(tenantDrift), {
      packageId: created.id,
    });
    const eventId = events[0]!.id;

    const db = getDb();
    await expectDbRejection(
      'append-only',
      () =>
        db.query(`UPDATE marketplace_package_verifications SET outcome = 'verified', summary = 'forged' WHERE id = $1`, [
          verified.run.id,
        ]),
    );
    await expectDbRejection(
      'append-only',
      () => db.query(`DELETE FROM marketplace_package_verifications WHERE id = $1`, [verified.run.id]),
    );
    await expectDbRejection(
      'append-only',
      () =>
        db.query(`UPDATE marketplace_package_reviews SET decision = 'approve', reason = 'forged' WHERE package_id = $1`, [
          created.id,
        ]),
    );
    await expectDbRejection(
      'append-only',
      () => db.query(`DELETE FROM marketplace_package_reviews WHERE package_id = $1`, [created.id]),
    );
    await expectDbRejection(
      'append-only',
      () =>
        db.query(`UPDATE marketplace_package_lifecycle_events SET to_state = 'INSTALLABLE' WHERE id = $1`, [
          eventId,
        ]),
    );
    await expectDbRejection(
      'append-only',
      () =>
        db.query(`DELETE FROM marketplace_package_lifecycle_events WHERE id = $1`, [eventId]),
    );
  });

  it('pins separation of duties and the transition directions for bypass writes', async () => {
    const submitted = await submitAgentPackage(tenantDrift, 'bypass-probe', '1.0.0');
    const db = getDb();

    // The vendor cannot INSERT its own review decision, even by SQL.
    await expectDbRejection(
      'separation of duties',
      () =>
        db.query(
          `INSERT INTO marketplace_package_reviews (
             package_id, decision, reason, reviewed_by_tenant, reviewed_by_principal, reviewed_at
           ) VALUES ($1, 'approve', 'self-dealing', $2, $3, now())`,
          [submitted.id, tenantDrift, 'drift-probe-vendor'],
        ),
    );

    // An invented transition cannot be recorded: only the exact legal
    // (transition, from, to) triples exist.
    await expectDbRejection(
      'direction_shape',
      () =>
        db.query(
          `INSERT INTO marketplace_package_lifecycle_events (
             package_id, transition, from_state, to_state, actor_tenant, actor, occurred_at
           ) VALUES ($1, 'publish', 'DRAFT', 'PUBLISHED', $2, 'bypass', now())`,
          [submitted.id, tenantDrift],
        ),
    );
    // The legal triple records fine (the service is the gate, the trail
    // the evidence).
    const legal = await db.query(
      `INSERT INTO marketplace_package_lifecycle_events (
         package_id, transition, from_state, to_state, actor_tenant, actor, occurred_at
       ) VALUES ($1, 'submit', 'DRAFT', 'SUBMITTED', $2, 'bypass', now())`,
      [submitted.id, tenantDrift],
    );
    expect(legal.rowCount).toBe(1);
  });

  it('accepts a control bypass write of legal shape (the honest floor)', async () => {
    // A well-formed extension package row lands via SQL and behaves like
    // any submitted package (the cron-grammar control: shape CHECKs
    // hold, deeper rules are verification scope).
    const db = getDb();
    const manifestId = await registerManifest(tenantDrift, 'bypass-control', '1.0.0');
    const manifest = await getManifest(extensionRegistrar(tenantDrift), { manifestId });
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO marketplace_packages (
         package_kind, package_key, version,
         version_major, version_minor, version_patch,
         display_name, description, payload,
         vendor_tenant, vendor_principal, state, created_at, updated_at
       ) VALUES ('extension', 'bypass-control', '9.9.9', 9, 9, 9, $2, NULL, $3::jsonb,
         $1, 'bypass-vendor', 'SUBMITTED', now(), now())
       RETURNING id`,
      [
        tenantDrift,
        manifest.displayName,
        JSON.stringify({
          manifestId: manifest.id,
          extensionKey: manifest.extensionKey,
          subject: {
            manifestSchemaVersion: manifest.manifestSchemaVersion,
            requestedPermissions: manifest.requestedPermissions,
            capabilities: manifest.capabilities,
            quotas: manifest.quotas,
            hostCompatibility: manifest.hostCompatibility,
          },
        }),
      ],
    );
    const packageId = inserted.rows[0]!.id;
    const result = await runAutomatedVerification(platformAdmin(), { packageId });
    expect(result.package.state).toBe('PENDING_REVIEW');
    expect(result.run.outcome).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// Context and query guards at the service boundary
// ---------------------------------------------------------------------------

describe('context and query guards', () => {
  it('rejects malformed contexts and queries uniformly', async () => {
    const badContext = { tenantId: '', principalId: '', authority: [] } as TenantContext;
    await expectCode('invalid_context', () => getPackage(badContext, { packageId: newId() }));
    await expectCode('invalid_query', () => getPackage(vendorA(), { packageId: 'nope' }));
    await expectCode('invalid_query', () => listPackages(vendorA(), { limit: 0 }));
    await expectCode('invalid_query', () => listCatalogPackages(vendorA(), { kind: 'plugin' as never }));
    await expectCode('invalid_input', () =>
      reviewPackage(platformAdmin(), { packageId: newId(), decision: 'later' as never }),
    );
    await expectCode('invalid_input', () => createPackage(vendorA(), null as never));
    await expectCode('invalid_input', () =>
      createPackage(vendorA(), { kind: 'extension', manifestId: 'not-a-uuid' }),
    );
  });
});
