// Unit tests for the vertical-kits marketplace surface's PURE logic
// (W105 — J22's user-visible path): the kit lifecycle label/tone
// vocabularies, the shipped-starter-kit read model (digests + counts),
// the catalog-state derivation, the action-availability matrix, the API
// body parsers, the vertical-kits error mapping and the discoverability
// wiring. No database — the integration suite covers the contract
// compositions end-to-end.

import { describe, expect, it } from 'vitest';
import {
  KIT_INSTALLATION_STATES,
  STARTER_KITS,
  digestKitManifest,
  isManifestDigest,
} from '@/modules/vertical-kits/contract';
import type { KitInstallationStatus } from '@/modules/vertical-kits/contract';
import { claimsForRole, MANAGEMENT_CLAIMS } from '@/modules/auth/contract';
import {
  buildKitCatalogSection,
  buildKitDetailView,
  deriveKitActions,
  findShippedKit,
  isLiveKitInstallation,
  kitCatalogStateLabel,
  kitCatalogStateTone,
  kitInstallationStateExplanation,
  kitInstallationStateLabel,
  kitInstallationStateTone,
  kitVerificationLabel,
  shippedStarterKits,
  shippedVersionRegistered,
} from '../marketplace/lib/kits';
import type { KitActionFacts } from '../marketplace/lib/kits';
import { PUBLIC_CATALOG_TENANT } from '../marketplace/lib/views';
import {
  isKitAction,
  parseKitInstallBody,
  parseKitLifecycleBody,
  parseKitReviewBody,
  parseKitVerifyBody,
  verticalKitsApiError,
} from '../marketplace/lib/api';
import { MARKETPLACE_DESTINATIONS, buildShellCommands } from '../lib/command-registry';
import { capabilityEntries } from '../lib/capability-hub';

// ---------------------------------------------------------------------------
// The kit lifecycle vocabulary (totals: every state has honest copy)
// ---------------------------------------------------------------------------

describe('kit installation state vocabulary', () => {
  it('labels, tones and explains every kit lifecycle state', () => {
    for (const state of KIT_INSTALLATION_STATES as readonly KitInstallationStatus[]) {
      expect(kitInstallationStateLabel(state).length).toBeGreaterThan(0);
      expect(kitInstallationStateExplanation(state).length).toBeGreaterThan(30);
      expect(['positive', 'warning', 'error', 'neutral', 'info']).toContain(
        kitInstallationStateTone(state),
      );
    }
    expect(kitInstallationStateTone('active')).toBe('positive');
    expect(kitInstallationStateTone('pending-review')).toBe('warning');
    expect(kitInstallationStateTone('rejected')).toBe('error');
    expect(kitInstallationStateTone('removed')).toBe('neutral');
  });

  it('liveness is exactly "not yet removed"', () => {
    for (const state of KIT_INSTALLATION_STATES) {
      expect(isLiveKitInstallation(state)).toBe(state !== 'removed');
    }
  });

  it('labels the verification postures', () => {
    expect(kitVerificationLabel('verified')).toBe('Verified');
    expect(kitVerificationLabel('failed')).toBe('Verification failed');
    expect(kitVerificationLabel('unverified')).toBe('Not verified');
  });
});

// ---------------------------------------------------------------------------
// The shipped starter kits (the pure read model)
// ---------------------------------------------------------------------------

describe('shipped starter kits read model', () => {
  it('lists exactly the two signed starter kits', () => {
    const kits = shippedStarterKits();
    expect(kits.map((kit) => kit.kitKey)).toEqual(
      expect.arrayContaining(['legal-case-management', 'accounting-ledger-erp']),
    );
    expect(kits).toHaveLength(STARTER_KITS.length);
  });

  it('carries each manifest\u2019s real digest and counts (never invented)', () => {
    for (const kit of shippedStarterKits()) {
      const manifest = STARTER_KITS.find((candidate) => candidate.kitKey === kit.kitKey)!;
      expect(kit.manifestDigest).toBe(digestKitManifest(manifest));
      expect(isManifestDigest(kit.manifestDigest)).toBe(true);
      expect(kit.version).toBe(manifest.version);
      expect(kit.verticalKey).toBe(manifest.verticalKey);
      expect(kit.capabilityCount).toBe(manifest.requiredCapabilities.length);
      expect(kit.extensionDefinitionCount).toBe(manifest.extensionDefinitions.length);
      expect(kit.agentDefinitionCount).toBe(manifest.agentDefinitions.length);
      expect(kit.integrationCount).toBe(manifest.edgeIntegrations.length);
      expect(kit.schemaHintCount).toBe(manifest.dataSchemaHints.length);
    }
  });

  it('finds a shipped kit by key and refuses unknown keys', () => {
    expect(findShippedKit('legal-case-management')?.displayName).toBeTruthy();
    expect(findShippedKit('accounting-ledger-erp')?.kitKey).toBe('accounting-ledger-erp');
    expect(findShippedKit('not-a-kit')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The catalog state derivation (the pill's strongest current fact)
// ---------------------------------------------------------------------------

describe('kit catalog state vocabulary', () => {
  it('labels and tones each derivation kind', () => {
    expect(kitCatalogStateLabel({ kind: 'shipped' })).toBe('Signed starter kit');
    expect(kitCatalogStateTone({ kind: 'shipped' })).toBe('info');
    expect(kitCatalogStateLabel({ kind: 'unknown' })).toBe('State unavailable');
    expect(kitCatalogStateLabel({ kind: 'installation', status: 'active' })).toBe('Active');
    expect(kitCatalogStateTone({ kind: 'installation', status: 'active' })).toBe('positive');
    expect(kitCatalogStateLabel({ kind: 'verification', state: 'verified' })).toBe('Verified');
    expect(kitCatalogStateTone({ kind: 'verification', state: 'failed' })).toBe('error');
    expect(kitCatalogStateTone({ kind: 'verification', state: 'unverified' })).toBe('neutral');
  });
});

// ---------------------------------------------------------------------------
// Action availability (the derivation the UI and the contract share)
// ---------------------------------------------------------------------------

const TENANT = '11111111-1111-4111-8111-111111111111';
const PRINCIPAL_A = '22222222-2222-4222-8222-222222222222';
const PRINCIPAL_B = '33333333-3333-4333-8333-333333333333';

const ADMIN = ['vertical-kits:administer'];
const APPROVER = ['vertical-kits:administer', 'actions:approve'];

function facts(overrides: Partial<KitActionFacts> = {}): KitActionFacts {
  return {
    shippedVersion: '1.0.0',
    registeredVersions: [],
    installation: null,
    ...overrides,
  };
}

describe('deriveKitActions', () => {
  it('an unscoped caller can do nothing (honest sign-in reasons)', () => {
    const actions = deriveKitActions(
      { tenantId: PUBLIC_CATALOG_TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      facts(),
    );
    expect(actions.scoped).toBe(false);
    expect(actions.canRegister).toBe(false);
    expect(actions.canRunVerification).toBe(false);
    expect(actions.canInstall).toBe(false);
    expect(actions.canDecideReview).toBe(false);
    expect(actions.registerBlockedReason).toContain('sign in');
  });

  it('a scoped caller without the claim can do nothing (the claim is named)', () => {
    const actions = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: [] },
      facts(),
    );
    expect(actions.canAdminister).toBe(false);
    expect(actions.canRegister).toBe(false);
    expect(actions.registerBlockedReason).toContain('vertical-kits:administer');
    expect(actions.canInstall).toBe(false);
    expect(actions.installBlockedReason).toContain('vertical-kits:administer');
  });

  it('an admin with nothing registered may register, but not install yet', () => {
    const actions = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      facts(),
    );
    expect(actions.canRegister).toBe(true);
    expect(actions.canRunVerification).toBe(false);
    expect(actions.verificationBlockedReason).toContain('no version');
    expect(actions.canInstall).toBe(false);
    expect(actions.installBlockedReason).toContain('register a version');
  });

  it('a registered but unverified version may be verified, not installed', () => {
    const registered = facts({
      registeredVersions: [{ version: '1.0.0', verificationState: 'unverified' }],
    });
    expect(shippedVersionRegistered(registered)).toBe(true);
    const actions = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      registered,
    );
    expect(actions.canRegister).toBe(false);
    expect(actions.registerBlockedReason).toContain('already registered');
    expect(actions.canRunVerification).toBe(true);
    expect(actions.canInstall).toBe(false);
    expect(actions.installBlockedReason).toContain('verified');
  });

  it('a verified version with no live installation may be installed', () => {
    const actions = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      facts({ registeredVersions: [{ version: '1.0.0', verificationState: 'verified' }] }),
    );
    expect(actions.canInstall).toBe(true);
    expect(actions.installBlockedReason).toBe(null);
  });

  it('a live installation blocks a second install and opens its own transitions', () => {
    const base = facts({
      registeredVersions: [{ version: '1.0.0', verificationState: 'verified' }],
    });
    const granted = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      { ...base, installation: { status: 'granted', installedBy: PRINCIPAL_A } },
    );
    expect(granted.canInstall).toBe(false);
    expect(granted.installBlockedReason).toContain('live installation');
    expect(granted.canActivate).toBe(true);
    expect(granted.canSuspend).toBe(false);

    const active = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      { ...base, installation: { status: 'active', installedBy: PRINCIPAL_A } },
    );
    expect(active.canSuspend).toBe(true);
    expect(active.canResume).toBe(false);
    expect(active.canRemove).toBe(true);

    const suspended = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      { ...base, installation: { status: 'suspended', installedBy: PRINCIPAL_A } },
    );
    expect(suspended.canResume).toBe(true);
    expect(suspended.canSuspend).toBe(false);
  });

  it('a pending grant review is decidable by ANOTHER authorized principal only', () => {
    const pending = facts({
      registeredVersions: [{ version: '1.0.0', verificationState: 'verified' }],
      installation: { status: 'pending-review', installedBy: PRINCIPAL_A },
    });
    const requester = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: APPROVER },
      pending,
    );
    expect(requester.canDecideReview).toBe(false);
    expect(requester.decideBlockedReason).toContain('separation of duties');

    const other = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_B, authority: APPROVER },
      pending,
    );
    expect(other.canDecideReview).toBe(true);

    const noApprove = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_B, authority: ADMIN },
      pending,
    );
    expect(noApprove.canDecideReview).toBe(false);
    expect(noApprove.decideBlockedReason).toContain('actions:approve');
  });

  it('a removed installation is terminal history — no transitions offered', () => {
    const actions = deriveKitActions(
      { tenantId: TENANT, principalId: PRINCIPAL_A, authority: ADMIN },
      facts({
        installation: { status: 'removed', installedBy: PRINCIPAL_A },
      }),
    );
    expect(actions.canActivate).toBe(false);
    expect(actions.canSuspend).toBe(false);
    expect(actions.canResume).toBe(false);
    expect(actions.canRemove).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The anonymous/unscoped view builders (pure halves, no database)
// ---------------------------------------------------------------------------

describe('unscoped kit view builders', () => {
  it('the catalog section lists the shipped kits with the signed state', async () => {
    const section = await buildKitCatalogSection({
      tenantId: PUBLIC_CATALOG_TENANT,
      principalId: PRINCIPAL_A,
      authority: [],
    });
    expect(section.ok).toBe(true);
    expect(section.tenantScoped).toBe(false);
    expect(section.items).toHaveLength(STARTER_KITS.length);
    for (const item of section.items) {
      expect(item.state.kind).toBe('shipped');
      expect(item.stateLabel).toBe('Signed starter kit');
      expect(item.tenant).toBe(null);
    }
  });

  it('the detail view of an unknown kit is the honest not-found', async () => {
    const result = await buildKitDetailView(
      { tenantId: PUBLIC_CATALOG_TENANT, principalId: PRINCIPAL_A, authority: [] },
      'not-a-kit',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('not_found');
  });

  it('the shipped detail view carries the digest, the checks and honest readiness', async () => {
    const result = await buildKitDetailView(
      { tenantId: PUBLIC_CATALOG_TENANT, principalId: PRINCIPAL_A, authority: [] },
      'legal-case-management',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const view = result.view;
    expect(view.manifestDigest).toBe(
      digestKitManifest(findShippedKit('legal-case-management')),
    );
    expect(isManifestDigest(view.manifestDigest)).toBe(true);
    expect(view.shippedChecksOutcome).toBe('verified');
    expect(view.shippedChecks.length).toBeGreaterThan(0);
    const manifest = findShippedKit('legal-case-management')!;
    expect(view.capabilities).toHaveLength(manifest.requiredCapabilities.length);
    expect(view.components).toHaveLength(
      manifest.extensionDefinitions.length + manifest.agentDefinitions.length,
    );
    expect(view.schemaHints).toHaveLength(manifest.dataSchemaHints.length);
    expect(view.integrations).toHaveLength(manifest.edgeIntegrations.length);
    expect(view.registry).toBe(null);
    expect(view.installation).toBe(null);
    expect(view.actions.scoped).toBe(false);
    // Honest integration readiness: no edge is wired in the unit world.
    expect(view.integrations.every((entry) => entry.readiness === 'deferred-on-w088')).toBe(true);
    // Starter components are 'defined' — never claimed as deployed software.
    expect(view.components.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// API parsers, action vocabulary and error mapping
// ---------------------------------------------------------------------------

describe('kit API parsers', () => {
  it('recognizes the exact kit action vocabulary', () => {
    for (const action of ['register', 'verify', 'install', 'decide-review', 'activate', 'suspend', 'resume', 'remove']) {
      expect(isKitAction(action)).toBe(true);
    }
    expect(isKitAction('deploy')).toBe(false);
    expect(isKitAction('submit')).toBe(false);
    expect(isKitAction('explode')).toBe(false);
  });

  it('parseKitVerifyBody requires the version id', () => {
    expect(parseKitVerifyBody({ kitVersionId: 'kv1' }).ok).toBe(true);
    expect(parseKitVerifyBody({}).ok).toBe(false);
    expect(parseKitVerifyBody(null).ok).toBe(false);
  });

  it('parseKitInstallBody keeps version and justification optional-but-typed', () => {
    const empty = parseKitInstallBody({});
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.version).toBe(null);
      expect(empty.justification).toBe(null);
    }
    const full = parseKitInstallBody({ version: '1.0.0', justification: '  legal ops  ' });
    expect(full.ok).toBe(true);
    if (full.ok) {
      expect(full.version).toBe('1.0.0');
      expect(full.justification).toBe('legal ops');
    }
    expect(parseKitInstallBody({ version: 5 }).ok).toBe(false);
    expect(parseKitInstallBody({ justification: [] }).ok).toBe(false);
    expect(parseKitInstallBody('nope').ok).toBe(false);
  });

  it('parseKitReviewBody mirrors the package review discipline', () => {
    const valid = parseKitReviewBody({ installationId: 'i1', decision: 'approve' });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.note).toBe(null);
    expect(parseKitReviewBody({ installationId: 'i1', decision: 'maybe' }).ok).toBe(false);
    expect(parseKitReviewBody({ decision: 'approve' }).ok).toBe(false);
    expect(parseKitReviewBody(null).ok).toBe(false);
  });

  it('parseKitLifecycleBody requires the installation and types the reason', () => {
    const valid = parseKitLifecycleBody({ installationId: 'i1', reason: ' parking  ' });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.reason).toBe('parking');
    expect(parseKitLifecycleBody({}).ok).toBe(false);
    expect(parseKitLifecycleBody({ installationId: 'i1', reason: 7 }).ok).toBe(false);
    expect(parseKitLifecycleBody(null).ok).toBe(false);
  });
});

describe('verticalKitsApiError mapping', () => {
  it('maps module codes to HTTP-ish outcomes', () => {
    expect(verticalKitsApiError({ code: 'forbidden', message: 'no claim' }).status).toBe(403);
    expect(verticalKitsApiError({ code: 'kit_version_not_found', message: 'gone' }).status).toBe(404);
    expect(verticalKitsApiError({ code: 'installation_not_found', message: 'gone' }).status).toBe(404);
    expect(verticalKitsApiError({ code: 'kit_not_shipped', message: 'nope' }).status).toBe(404);
    expect(verticalKitsApiError({ code: 'kit_not_verified', message: 'no' }).status).toBe(409);
    expect(verticalKitsApiError({ code: 'kit_already_installed', message: 'live' }).status).toBe(409);
    expect(verticalKitsApiError({ code: 'version_not_monotonic', message: 'old' }).status).toBe(409);
    expect(verticalKitsApiError({ code: 'separation_of_duties', message: 'self' }).status).toBe(409);
    expect(verticalKitsApiError({ code: 'installation_not_pending_review', message: 'x' }).status).toBe(409);
    expect(verticalKitsApiError({ code: 'invalid_input', message: 'shape' }).status).toBe(400);
    expect(verticalKitsApiError(new Error('boom')).status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Discoverability + the interim claim completion (the install lifeline)
// ---------------------------------------------------------------------------

describe('kit discoverability wiring', () => {
  it('the command registry carries the kits destination', () => {
    const destination = MARKETPLACE_DESTINATIONS.find((entry) => entry.id === 'kits');
    expect(destination).toBeDefined();
    expect(destination!.href).toBe('/marketplace#vertical-kits');
    const commands = buildShellCommands();
    const command = commands.find((candidate) => candidate.id === 'marketplace:kits');
    expect(command).toBeDefined();
    expect(command!.keywords).toContain('legal');
    expect(command!.keywords).toContain('accounting');
  });

  it('the More hub\u2019s extend group carries the kits entry', () => {
    const entry = capabilityEntries().find((candidate) => candidate.id === 'marketplace-kits');
    expect(entry).toBeDefined();
    // The hub entry targets the catalog ROUTE (where the kits section
    // lives); the command search lands on the section anchor.
    expect(entry!.href).toBe('/marketplace');
  });
});

describe('the vertical-kits administer claim rides owner/admin sessions', () => {
  it('completes the interim management set (the W066/W091 precedent)', () => {
    expect(MANAGEMENT_CLAIMS).toContain('vertical-kits:administer');
    expect(claimsForRole('owner')).toContain('vertical-kits:administer');
    expect(claimsForRole('admin')).toContain('vertical-kits:administer');
    expect(claimsForRole('member')).not.toContain('vertical-kits:administer');
    // Platform claims still never ride a tenant session.
    expect(claimsForRole('owner')).not.toContain('marketplace:administer');
    expect(claimsForRole('owner')).not.toContain('organizations:provision');
  });
});
