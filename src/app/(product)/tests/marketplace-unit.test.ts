// Unit tests for the marketplace product surface's PURE logic (W064):
// the label/tone vocabularies, the permission-inspection copy, the
// action-availability derivation, the API body parsers and the error
// mapping — everything that must never drift between the server views,
// the client forms and the API layer. No database (the integration
// suite covers the contract compositions).

import { describe, expect, it } from 'vitest';
import {
  AGENT_SCOPE_COPY,
  EXTENSION_PERMISSION_COPY,
  PACKAGE_CHAIN,
  agentProviderLabel,
  buildPhaseExplanation,
  buildPhaseLabel,
  buildPhaseTone,
  canUseDeveloperSurface,
  capabilityLines,
  chainPosition,
  derivePackageActions,
  extensionStateExplanation,
  extensionStateLabel,
  extensionStateTone,
  formatBytes,
  packageKindLabel,
  packageStateExplanation,
  packageStateLabel,
  packageStateTone,
  permissionLines,
  quotaLines,
  verificationTone,
} from '../marketplace/lib/labels';
import {
  EXTENSION_PERMISSIONS,
  EXTENSION_LIFECYCLE_STATES,
} from '@/modules/extensions/contract';
import { AGENT_PERMISSION_SCOPES, AGENT_RUNTIME_PROVIDERS } from '@/modules/agents/contract';
import { MARKETPLACE_PACKAGE_STATES } from '@/modules/marketplace/contract';
import type { MarketplacePackage, MarketplacePackageState } from '@/modules/marketplace/contract';
import {
  isDeveloperAction,
  isExtensionAction,
  isPackageAction,
  marketplaceApiError,
  parseCancelBody,
  parseCreateAgentPackageBody,
  parseCreateExtensionPackageBody,
  parseDeployBody,
  parseIdBody,
  parsePermissionList,
  parseRequestBuildBody,
  parseReviewBody,
  parseRollbackBody,
} from '../marketplace/lib/api';
import { MARKETPLACE_DESTINATIONS, buildShellCommands } from '../lib/command-registry';

// ---------------------------------------------------------------------------
// The state vocabularies (totals: every domain state has human copy)
// ---------------------------------------------------------------------------

describe('package state vocabulary', () => {
  it('labels, tones and explains every marketplace state', () => {
    for (const state of MARKETPLACE_PACKAGE_STATES) {
      expect(packageStateLabel(state).length).toBeGreaterThan(0);
      expect(packageStateExplanation(state).length).toBeGreaterThan(20);
      const tone = packageStateTone(state);
      expect(['positive', 'warning', 'error', 'neutral', 'info']).toContain(tone);
    }
    expect(packageStateTone('PENDING_REVIEW')).toBe('warning');
    expect(packageStateTone('REJECTED')).toBe('error');
    expect(packageStateTone('INSTALLABLE')).toBe('positive');
    expect(packageStateTone('DRAFT')).toBe('neutral');
  });

  it('renders the chain in the state machine\u2019s own order', () => {
    expect(PACKAGE_CHAIN).toEqual([
      'DRAFT',
      'SUBMITTED',
      'AUTOMATED_VERIFICATION',
      'PENDING_REVIEW',
      'APPROVED',
      'PUBLISHED',
      'INSTALLABLE',
    ]);
  });

  it('hangs REJECTED at the review position', () => {
    expect(chainPosition('REJECTED')).toBe(chainPosition('PENDING_REVIEW'));
    expect(chainPosition('INSTALLABLE')).toBeGreaterThan(chainPosition('APPROVED'));
  });

  it('labels both package kinds', () => {
    expect(packageKindLabel('extension')).toBe('Extension package');
    expect(packageKindLabel('agent')).toBe('Agent package');
  });
});

describe('extension lifecycle vocabulary', () => {
  it('labels, tones and explains every lifecycle state', () => {
    for (const state of EXTENSION_LIFECYCLE_STATES) {
      expect(extensionStateLabel(state).length).toBeGreaterThan(0);
      expect(extensionStateExplanation(state).length).toBeGreaterThan(20);
      expect(['positive', 'warning', 'error', 'neutral', 'info']).toContain(
        extensionStateTone(state),
      );
    }
    expect(extensionStateTone('ACTIVE')).toBe('positive');
    expect(extensionStateTone('SUSPENDED')).toBe('warning');
  });
});

describe('builder phase vocabulary', () => {
  it('labels known phases and renders unknown ones as-is', () => {
    for (const phase of [
      'designing',
      'building',
      'built',
      'verified',
      'deploying',
      'deployed',
      'failed',
      'cancelled',
    ]) {
      expect(buildPhaseLabel(phase).length).toBeGreaterThan(0);
      expect(buildPhaseExplanation(phase).length).toBeGreaterThan(10);
      expect(['positive', 'warning', 'error', 'neutral', 'info']).toContain(
        buildPhaseTone(phase),
      );
    }
    expect(buildPhaseLabel('weird-phase')).toBe('weird-phase');
    expect(buildPhaseExplanation('weird-phase')).toBe('weird-phase');
    expect(buildPhaseTone('weird-phase')).toBe('info');
  });
});

// ---------------------------------------------------------------------------
// Permission inspection copy (coverage over BOTH closed vocabularies)
// ---------------------------------------------------------------------------

describe('permission inspection copy', () => {
  it('covers every extension permission in the closed vocabulary', () => {
    for (const permission of EXTENSION_PERMISSIONS) {
      const copy = EXTENSION_PERMISSION_COPY[permission];
      expect(copy, `missing copy for ${permission}`).toBeDefined();
      expect(copy!.label.length).toBeGreaterThan(2);
      expect(copy!.description.length).toBeGreaterThan(10);
    }
  });

  it('covers every agent permission scope in the closed vocabulary', () => {
    for (const scope of AGENT_PERMISSION_SCOPES) {
      const copy = AGENT_SCOPE_COPY[scope];
      expect(copy, `missing copy for ${scope}`).toBeDefined();
      expect(copy!.description.length).toBeGreaterThan(10);
    }
  });

  it('renders unknown permission keys honestly (no silent drop)', () => {
    const lines = permissionLines(['state:read', 'not-a-permission'], EXTENSION_PERMISSION_COPY);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.label).toBe('not-a-permission');
    expect(lines[1]!.description).toContain('Unrecognized');
  });

  it('labels agent runtime providers from the closed set', () => {
    expect(AGENT_RUNTIME_PROVIDERS.length).toBeGreaterThan(0);
    expect(agentProviderLabel(AGENT_RUNTIME_PROVIDERS[0]!)).toBe(AGENT_RUNTIME_PROVIDERS[0]);
  });
});

// ---------------------------------------------------------------------------
// Capability summary + quotas
// ---------------------------------------------------------------------------

describe('capability lines', () => {
  it('flattens a full declaration', () => {
    const lines = capabilityLines({
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel'],
      schedules: [{ name: 'nightly', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.paid'],
      externalParticipants: [{ label: 'Invoices', origin: 'https://api.example.com' }],
      telemetry: true,
    });
    const labels = lines.map((line) => line.label);
    expect(labels).toContain('Persistent state');
    expect(labels).toContain('Host-rendered UI');
    expect(labels).toContain('Schedules');
    expect(labels).toContain('Event subscriptions');
    expect(labels).toContain('External participants');
    expect(labels).toContain('Telemetry');
  });

  it('says "no capabilities" for an empty declaration', () => {
    const lines = capabilityLines({
      stateScope: 'none',
      uiSurfaces: [],
      schedules: [],
      eventSubscriptions: [],
      externalParticipants: [],
      telemetry: false,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.label).toBe('No capabilities');
  });

  it('renders quotas humanly', () => {
    const lines = quotaLines({
      maxStateBytes: 1_048_576,
      maxScheduleInvocationsPerDay: 24,
      maxExternalCallsPerDay: 1000,
    });
    expect(lines[0]!.detail).toContain('MiB');
    expect(lines[1]!.detail).toBe('24');
  });

  it('formats bytes at the KiB boundary', () => {
    expect(formatBytes(2_048)).toBe('2 KiB');
    expect(formatBytes(512)).toBe('512 B');
  });
});

// ---------------------------------------------------------------------------
// Action availability (the derivation the UI and the contract share)
// ---------------------------------------------------------------------------

const VENDOR_TENANT = '11111111-1111-4111-8111-111111111111';
const VENDOR_PRINCIPAL = '22222222-2222-4222-8222-222222222222';
const PLATFORM_TENANT = '33333333-3333-4333-8333-333333333333';
const PLATFORM_PRINCIPAL = '44444444-4444-4444-8444-444444444444';

function package_(
  overrides: Partial<{
    kind: 'extension' | 'agent';
    state: MarketplacePackageState;
    vendorTenant: string;
    vendorPrincipal: string;
  }> = {},
): Pick<MarketplacePackage, 'kind' | 'state' | 'vendorTenant' | 'vendorPrincipal'> {
  return {
    kind: 'extension',
    state: 'DRAFT',
    vendorTenant: VENDOR_TENANT,
    vendorPrincipal: VENDOR_PRINCIPAL,
    ...overrides,
  };
}

describe('derivePackageActions', () => {
  const vendor = {
    tenantId: VENDOR_TENANT,
    principalId: VENDOR_PRINCIPAL,
    authority: ['marketplace:submit'],
  };

  it('lets the vendor submit its own DRAFT (and nobody else)', () => {
    expect(derivePackageActions(vendor, package_()).canSubmit).toBe(true);
    expect(
      derivePackageActions(
        { ...vendor, tenantId: '55555555-5555-4555-8555-555555555555' },
        package_(),
      ).canSubmit,
    ).toBe(false);
    expect(derivePackageActions({ ...vendor, authority: [] }, package_()).canSubmit).toBe(false);
    expect(derivePackageActions(vendor, package_({ state: 'SUBMITTED' })).canSubmit).toBe(false);
  });

  it('gates the platform pipeline on the administer claim and the state', () => {
    const platform = {
      tenantId: PLATFORM_TENANT,
      principalId: PLATFORM_PRINCIPAL,
      authority: ['marketplace:administer'],
    };
    expect(derivePackageActions(platform, package_({ state: 'SUBMITTED' })).canRunVerification).toBe(true);
    expect(
      derivePackageActions(platform, package_({ state: 'PENDING_REVIEW' })).canReview,
    ).toBe(true);
    expect(derivePackageActions(platform, package_({ state: 'APPROVED' })).canPublish).toBe(true);
    expect(derivePackageActions(platform, package_({ state: 'PUBLISHED' })).canMakeInstallable).toBe(
      true,
    );
    expect(derivePackageActions(platform, package_({ state: 'DRAFT' })).canRunVerification).toBe(false);
    expect(derivePackageActions({ ...platform, authority: [] }, package_({ state: 'SUBMITTED' })).canRunVerification).toBe(false);
  });

  it('blocks a vendor from reviewing its own package (separation of duties)', () => {
    const rogue = {
      tenantId: VENDOR_TENANT,
      principalId: VENDOR_PRINCIPAL,
      authority: ['marketplace:administer', 'marketplace:submit'],
    };
    const actions = derivePackageActions(rogue, package_({ state: 'PENDING_REVIEW' }));
    expect(actions.canReview).toBe(false);
    expect(actions.reviewBlockedBySeparation).toBe(true);
    // Even the vendor\u2019s OTHER principal is blocked (vendor tenant match).
    const otherPrincipal = { ...rogue, principalId: '66666666-6666-4666-8666-666666666666' };
    expect(derivePackageActions(otherPrincipal, package_({ state: 'PENDING_REVIEW' })).canReview).toBe(
      false,
    );
  });

  it('derives installability: state first, then the kind\u2019s administer claim', () => {
    const installer = {
      tenantId: '55555555-5555-4555-8555-555555555555',
      principalId: '77777777-7777-4777-8777-777777777777',
      authority: ['extensions:administer'],
    };
    expect(derivePackageActions(installer, package_({ state: 'INSTALLABLE' })).canInstall).toBe(true);
    expect(
      derivePackageActions(
        { ...installer, authority: ['agents:administer'] },
        package_({ state: 'INSTALLABLE' }),
      ).installBlockedReason,
    ).toContain('extensions:administer');
    expect(
      derivePackageActions(
        { ...installer, authority: [] },
        package_({ kind: 'agent', state: 'INSTALLABLE' }),
      ).installBlockedReason,
    ).toContain('agents:administer');
    expect(
      derivePackageActions(installer, package_({ state: 'PUBLISHED' })).installBlockedReason,
    ).toContain('only INSTALLABLE');
    // The vendor may install its own published package like anyone else.
    expect(
      derivePackageActions(vendor, package_({ state: 'INSTALLABLE' })).canInstall,
    ).toBe(false); // no administer claim in this fixture
  });

  it('verification tone mapping', () => {
    expect(verificationTone('verified')).toBe('positive');
    expect(verificationTone('failed')).toBe('error');
    expect(verificationTone('unverified')).toBe('neutral');
  });
});

describe('canUseDeveloperSurface', () => {
  it('needs one of the three claims', () => {
    expect(canUseDeveloperSurface([])).toBe(false);
    expect(canUseDeveloperSurface(['marketplace:submit'])).toBe(true);
    expect(canUseDeveloperSurface(['marketplace:administer'])).toBe(true);
    expect(canUseDeveloperSurface(['extensions:administer'])).toBe(true);
    expect(canUseDeveloperSurface(['actions:approve'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// API body parsers
// ---------------------------------------------------------------------------

describe('parseReviewBody', () => {
  it('accepts an approval (reason optional)', () => {
    const parsed = parseReviewBody({ decision: 'approve' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.decision).toBe('approve');
      expect(parsed.reason).toBe(null);
    }
  });

  it('requires a reason on rejection (the terminal decision\u2019s why)', () => {
    const parsed = parseReviewBody({ decision: 'reject' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('reason');
    const withReason = parseReviewBody({ decision: 'reject', reason: 'permission set unjustified' });
    expect(withReason.ok).toBe(true);
  });

  it('rejects malformed bodies', () => {
    expect(parseReviewBody(null).ok).toBe(false);
    expect(parseReviewBody({ decision: 'maybe' }).ok).toBe(false);
    expect(parseReviewBody({ decision: 'approve', reason: 5 }).ok).toBe(false);
  });
});

describe('parseCreateExtensionPackageBody', () => {
  it('requires the manifest id, keeps the catalog key optional', () => {
    const parsed = parseCreateExtensionPackageBody({ manifestId: 'abc' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.manifestId).toBe('abc');
      expect(parsed.packageKey).toBe(null);
    }
    expect(parseCreateExtensionPackageBody({}).ok).toBe(false);
    expect(parseCreateExtensionPackageBody({ manifestId: 'x', packageKey: '' }).ok).toBe(false);
  });
});

describe('parseCreateAgentPackageBody', () => {
  const valid = {
    packageKey: 'collections-negotiator',
    version: '1.0.0',
    displayName: 'Collections Negotiator',
    role: 'negotiate invoices',
    instructions: 'Be polite, be firm.',
    provider: 'langgraph',
    permissions: ['observe', 'propose'],
  };

  it('accepts a full blueprint', () => {
    const parsed = parseCreateAgentPackageBody(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.permissions).toEqual(['observe', 'propose']);
  });

  it('requires every string field and a non-empty scope list', () => {
    for (const key of Object.keys(valid)) {
      const body = { ...valid, [key]: '' };
      if (key === 'permissions') continue;
      expect(parseCreateAgentPackageBody(body).ok).toBe(false);
    }
    expect(parseCreateAgentPackageBody({ ...valid, permissions: [] }).ok).toBe(false);
    expect(parseCreateAgentPackageBody({ ...valid, permissions: 'observe' }).ok).toBe(false);
  });
});

describe('parseRequestBuildBody and parseIdBody', () => {
  it('requires all four build fields', () => {
    const valid = { extensionKey: 'k', version: '1.0.0', brief: 'b', agentId: 'a' };
    expect(parseRequestBuildBody(valid).ok).toBe(true);
    for (const key of Object.keys(valid)) {
      expect(parseRequestBuildBody({ ...valid, [key]: '' }).ok).toBe(false);
    }
    expect(parseIdBody({ buildId: 'x' }, 'buildId').ok).toBe(true);
    expect(parseIdBody({}, 'buildId').ok).toBe(false);
    expect(parseIdBody(null, 'buildId').ok).toBe(false);
  });
});

describe('parseDeployBody and parseRollbackBody', () => {
  it('needs one of manifestId/version; defaults the install key', () => {
    const parsed = parseDeployBody({ manifestId: 'm1' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.installKey).toBe('default');
      expect(parsed.grantedPermissions).toBe(null);
    }
    expect(parseDeployBody({}).ok).toBe(false);
    expect(parseDeployBody({ manifestId: null, version: null }).ok).toBe(false);
    expect(
      parseDeployBody({ version: '1.2.0', grantedPermissions: ['state:read', 'state:read'] }).ok,
    ).toBe(true);
  });

  it('requires the rollback target', () => {
    expect(parseRollbackBody({ targetDeploymentId: 'd1' }).ok).toBe(true);
    expect(parseRollbackBody({}).ok).toBe(false);
    const withInstall = parseRollbackBody({ targetDeploymentId: 'd1', installKey: 'staging' });
    expect(withInstall.ok && withInstall.installKey).toBe('staging');
  });

  it('requires a cancellation reason', () => {
    expect(parseCancelBody({ reason: 'wrong brief' }).ok).toBe(true);
    expect(parseCancelBody({}).ok).toBe(false);
  });

  it('parses permission lists defensively (dedup, no empties, no non-strings)', () => {
    expect(parsePermissionList(['a', 'a', 'b'])).toEqual(['a', 'b']);
    expect(parsePermissionList('a')).toBe(null);
    expect(parsePermissionList(undefined)).toBe(null);
    expect(parsePermissionList([1, 'a'])).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Action + error mapping
// ---------------------------------------------------------------------------

describe('action and error mapping', () => {
  it('recognizes the exact action vocabularies', () => {
    expect(isPackageAction('submit')).toBe(true);
    expect(isPackageAction('install')).toBe(true);
    expect(isPackageAction('explode')).toBe(false);
    expect(isExtensionAction('deploy')).toBe(true);
    expect(isExtensionAction('rollback')).toBe(true);
    expect(isExtensionAction('activate')).toBe(true);
    expect(isExtensionAction('deprecate')).toBe(true);
    expect(isExtensionAction('delete')).toBe(false);
    expect(isDeveloperAction('create-agent-package')).toBe(true);
    expect(isDeveloperAction('advance-build')).toBe(true);
    expect(isDeveloperAction('run-build')).toBe(false);
  });

  it('maps module error codes to HTTP-ish outcomes', () => {
    const forbidden = marketplaceApiError({ code: 'forbidden', message: 'no claim' });
    expect(forbidden.status).toBe(403);
    const transition = marketplaceApiError({ code: 'invalid_transition', message: 'bad state' });
    expect(transition.status).toBe(409);
    const separation = marketplaceApiError({ code: 'separation_of_duties', message: 'vendor' });
    expect(separation.status).toBe(409);
    const missing = marketplaceApiError({ code: 'package_not_found', message: 'gone' });
    expect(missing.status).toBe(404);
    const invalid = marketplaceApiError({ code: 'invalid_input', message: 'shape' });
    expect(invalid.status).toBe(400);
    const internal = marketplaceApiError(new Error('boom'));
    expect(internal.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Command-search integration (discoverability of the area's surfaces)
// ---------------------------------------------------------------------------

describe('command registry marketplace destinations', () => {
  it('exposes the three marketplace destinations as commands', () => {
    const commands = buildShellCommands();
    for (const destination of MARKETPLACE_DESTINATIONS) {
      const command = commands.find((candidate) => candidate.id === `marketplace:${destination.id}`);
      expect(command, `missing command ${destination.id}`).toBeDefined();
      expect(command!.target.kind).toBe('navigate');
      if (command!.target.kind === 'navigate') {
        expect(command!.target.href).toBe(destination.href);
      }
    }
  });

  it('the registry keeps exactly one command per destination (no drift)', () => {
    const commands = buildShellCommands();
    const marketplaceCommands = commands.filter((command) => command.id.startsWith('marketplace:'));
    expect(marketplaceCommands).toHaveLength(MARKETPLACE_DESTINATIONS.length);
  });
});
