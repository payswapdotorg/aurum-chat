// Unit tests for the marketplace product surface's KIT-side pure logic
// (W105): the vertical-kit label/tone vocabularies, the lifecycle chain
// math, the action-availability derivation, the API body parsers and
// the error mapping — everything that must never drift between the
// server views, the client forms and the API layer. No database (the
// integration suite covers the contract compositions).

import { describe, expect, it } from 'vitest';
import {
  CLAIM_KIT_ADMINISTER,
  KIT_CHAIN,
  KIT_KIND_LABEL,
  KIT_TRANSITION_COPY,
  deriveKitActions,
  everyKitStateLabeled,
  kitCapabilityLines,
  kitChainReached,
  kitChainRejected,
  kitComponentCounts,
  kitInstallPosture,
  kitInstallationStateExplanation,
  kitInstallationStateLabel,
  kitInstallationStateTone,
  kitVerificationLabel,
  kitVerificationTone,
  shortDigest,
} from '../marketplace/lib/kit-labels';
import {
  KIT_INSTALLATION_STATES,
  KIT_INSTALLATION_TRANSITIONS,
  STARTER_KITS,
  digestKitManifest,
  verifyKitManifest,
} from '@/modules/vertical-kits/contract';
import {
  isKitAction,
  parseKitInstallBody,
  parseKitTargetBody,
  verticalKitsApiError,
} from '../marketplace/lib/kit-api';
import { VerticalKitsError } from '@/modules/vertical-kits/contract';
import {
  MARKETPLACE_DESTINATIONS,
  buildShellCommands,
  filterShellCommands,
} from '../lib/command-registry';
import { CAPABILITY_FAMILIES, capabilityEntry } from '../lib/capability-hub';
import { MANAGEMENT_CLAIMS } from '@/modules/auth/contract';

// ---------------------------------------------------------------------------
// The state vocabularies (totals: every kit state has human copy)
// ---------------------------------------------------------------------------

describe('kit installation state vocabulary', () => {
  it('labels, tones and explains every kit installation state', () => {
    for (const state of KIT_INSTALLATION_STATES) {
      expect(kitInstallationStateLabel(state).length).toBeGreaterThan(0);
      expect(kitInstallationStateExplanation(state).length).toBeGreaterThan(20);
      expect(['positive', 'warning', 'error', 'neutral', 'info']).toContain(
        kitInstallationStateTone(state),
      );
    }
    expect(kitInstallationStateTone('active')).toBe('positive');
    expect(kitInstallationStateTone('pending-review')).toBe('warning');
    expect(kitInstallationStateTone('rejected')).toBe('error');
    expect(kitInstallationStateTone('removed')).toBe('neutral');
    expect(everyKitStateLabeled()).toBe(true);
  });

  it('labels the not-installed posture neutrally', () => {
    expect(kitInstallPosture(null)).toEqual({ label: 'Not installed', tone: 'neutral' });
    expect(kitInstallPosture('active')).toEqual({ label: 'Active', tone: 'positive' });
    expect(kitInstallPosture('pending-review').label).toBe('Pending grant review');
  });

  it('renders the lifecycle chain in the module’s own happy-path order', () => {
    expect(KIT_CHAIN).toEqual(['pending-review', 'granted', 'active', 'suspended', 'removed']);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle chain math (reached nodes, computed from status + events)
// ---------------------------------------------------------------------------

describe('kit chain reached', () => {
  it('a pending install has reached only the gate', () => {
    expect(kitChainReached('pending-review', ['installed'])).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(kitChainRejected('pending-review')).toBe(false);
  });

  it('a granted install reached the review approval', () => {
    expect(kitChainReached('granted', ['installed', 'review-approved', 'grant-minted'])).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('an active install reached activation; suspension parks it visibly', () => {
    expect(kitChainReached('active', ['installed', 'review-approved', 'activated'])).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(kitChainReached('suspended', ['installed', 'review-approved', 'activated', 'suspended'])).toEqual([
      true,
      true,
      true,
      true,
      false,
    ]);
    // a resumed kit was suspended once — the trail keeps the node reached
    expect(
      kitChainReached('active', ['installed', 'review-approved', 'activated', 'suspended', 'resumed']),
    ).toEqual([true, true, true, true, false]);
  });

  it('a rejected install hangs at the gate node', () => {
    expect(kitChainRejected('rejected')).toBe(true);
    expect(kitChainRejected('granted')).toBe(false);
    expect(kitChainReached('rejected', ['installed', 'review-rejected'])).toEqual([
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('a removed installation is terminal', () => {
    expect(kitChainReached('removed', ['installed', 'review-approved', 'removed'])).toEqual([
      true,
      true,
      false,
      false,
      true,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The signed-manifest + verification vocabulary
// ---------------------------------------------------------------------------

describe('kit verification vocabulary', () => {
  it('labels and tones the three postures', () => {
    expect(kitVerificationLabel('verified')).toBe('Verified');
    expect(kitVerificationLabel('failed')).toBe('Failed');
    expect(kitVerificationLabel('unverified')).toBe('Unverified');
    expect(kitVerificationTone('verified')).toBe('positive');
    expect(kitVerificationTone('failed')).toBe('error');
    expect(kitVerificationTone('unverified')).toBe('neutral');
  });

  it('shortens digests without hiding their identity (full value rides the title)', () => {
    const digest = digestKitManifest(STARTER_KITS[0]);
    expect(shortDigest(digest)).toBe(`${digest.slice(0, 16)}…`);
    expect(shortDigest(digest).length).toBe(17);
  });

  it('the shipped starter kits are SIGNED and pass the deterministic checks (their real states)', () => {
    expect(STARTER_KITS).toHaveLength(2);
    for (const manifest of STARTER_KITS) {
      const outcome = verifyKitManifest(manifest);
      expect(outcome.outcome, `${manifest.kitKey}: ${outcome.summary}`).toBe('verified');
      // the surface’s copy mirrors the module’s own check vocabulary
      expect(outcome.checks.map((check) => check.check)).toEqual([
        'manifest-shape',
        'manifest-integrity',
        'capability-declarations',
        'extension-definitions',
        'agent-definitions',
        'integration-references',
        'schema-hints',
      ]);
    }
  });

  it('flattens the required capabilities into reviewer-facing lines', () => {
    const lines = kitCapabilityLines(STARTER_KITS[0]!.requiredCapabilities);
    expect(lines.length).toBe(STARTER_KITS[0]!.requiredCapabilities.length);
    for (const line of lines) {
      expect(line.key).toMatch(/^(read|write)\./);
      expect(line.label.length).toBeGreaterThan(0);
      expect(['read', 'write']).toContain(line.mode);
    }
  });

  it('counts the components of each shipped kit', () => {
    for (const manifest of STARTER_KITS) {
      const counts = kitComponentCounts(manifest);
      expect(counts.capabilities).toBe(manifest.requiredCapabilities.length);
      expect(counts.extensions).toBe(manifest.extensionDefinitions.length);
      expect(counts.agents).toBe(manifest.agentDefinitions.length);
      expect(counts.integrations).toBe(manifest.edgeIntegrations.length);
      expect(counts.schemaHints).toBe(manifest.dataSchemaHints.length);
    }
  });

  it('carries the kind label of the distinct kit category', () => {
    expect(KIT_KIND_LABEL).toBe('Vertical starter kit');
  });
});

// ---------------------------------------------------------------------------
// Action derivation (the same rules the vertical-kits contract enforces)
// ---------------------------------------------------------------------------

describe('deriveKitActions', () => {
  const admin = { authority: [CLAIM_KIT_ADMINISTER] };
  const plain = { authority: [] };

  it('gates every write on the administer claim', () => {
    const actions = deriveKitActions(plain, {
      registered: false,
      verificationState: null,
      installation: null,
    });
    expect(actions.canGovern).toBe(false);
    expect(actions.canInstall).toBe(false);
    expect(actions.installBlockedReason).toBe(
      `installing a kit requires the '${CLAIM_KIT_ADMINISTER}' authority claim`,
    );
    expect(actions.canReview).toBe(false);
    expect(actions.canRemove).toBe(false);
  });

  it('lets an administer holder install a shipped kit that is not yet registered', () => {
    const actions = deriveKitActions(admin, {
      registered: false,
      verificationState: null,
      installation: null,
    });
    expect(actions.canInstall).toBe(true);
    expect(actions.installBlockedReason).toBeNull();
  });

  it('refuses install when the registered version is not VERIFIED (the module’s own rule)', () => {
    const actions = deriveKitActions(admin, {
      registered: true,
      verificationState: 'unverified',
      installation: null,
    });
    expect(actions.canInstall).toBe(false);
    expect(actions.installBlockedReason).toContain('unverified');
  });

  it('refuses install when a live lifecycle already exists (one per kit)', () => {
    const actions = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'active' },
    });
    expect(actions.canInstall).toBe(false);
    expect(actions.installBlockedReason).toContain("live installation ('active')");
  });

  it('derives the legal transitions from the lifecycle state machine', () => {
    // pending-review: the human review decides; nothing else applies
    const pending = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'pending-review' },
    });
    expect(pending.canReview).toBe(true);
    expect(pending.canActivate).toBe(false);
    expect(pending.canSuspend).toBe(false);
    expect(pending.canRemove).toBe(true);

    // granted: activation
    const granted = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'granted' },
    });
    expect(granted.canReview).toBe(false);
    expect(granted.canActivate).toBe(true);

    // active: suspension
    const active = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'active' },
    });
    expect(active.canSuspend).toBe(true);
    expect(active.canResume).toBe(false);

    // suspended: resumption
    const suspended = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'suspended' },
    });
    expect(suspended.canResume).toBe(true);

    // rejected/removed: only removal (cleanup) — terminal states
    const rejected = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'rejected' },
    });
    expect(rejected.canReview).toBe(false);
    expect(rejected.canRemove).toBe(true);
    const removed = deriveKitActions(admin, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'removed' },
    });
    expect(removed.canRemove).toBe(false);
  });

  it('a plain caller holding no claim never derives a lifecycle write', () => {
    const actions = deriveKitActions(plain, {
      registered: true,
      verificationState: 'verified',
      installation: { status: 'active' },
    });
    expect(actions.canSuspend).toBe(false);
    expect(actions.canRemove).toBe(false);
  });

  it('covers every named transition with governance copy', () => {
    for (const transition of KIT_INSTALLATION_TRANSITIONS) {
      expect(KIT_TRANSITION_COPY[transition].label.length).toBeGreaterThan(0);
      expect(KIT_TRANSITION_COPY[transition].description.length).toBeGreaterThan(20);
    }
  });
});

// ---------------------------------------------------------------------------
// The API surface: body parsers, action vocabulary, error mapping
// ---------------------------------------------------------------------------

describe('kit API parsing', () => {
  it('accepts an optional justification on install', () => {
    expect(parseKitInstallBody({})).toEqual({ ok: true, justification: null });
    expect(parseKitInstallBody({ justification: 'we run a law firm' })).toEqual({
      ok: true,
      justification: 'we run a law firm',
    });
    expect(parseKitInstallBody(null)).toEqual({ ok: false, error: 'body must be a JSON object' });
    expect(parseKitInstallBody({ justification: 5 }).ok).toBe(false);
  });

  it('requires the installation id on lifecycle targets', () => {
    expect(parseKitTargetBody({ installationId: 'kit-inst-1' }, false)).toEqual({
      ok: true,
      installationId: 'kit-inst-1',
      reason: null,
    });
    expect(parseKitTargetBody({}, false).ok).toBe(false);
    expect(parseKitTargetBody({ installationId: '  ' }, false).ok).toBe(false);
    expect(parseKitTargetBody({ installationId: 'x', reason: 7 }, false).ok).toBe(false);
  });

  it('requires a reason only for removal (the terminal, grant-revoking step)', () => {
    expect(parseKitTargetBody({ installationId: 'x' }, true).ok).toBe(false);
    expect(parseKitTargetBody({ installationId: 'x', reason: 'switching ERPs' }, true).ok).toBe(
      true,
    );
    expect(parseKitTargetBody({ installationId: 'x' }, false).ok).toBe(true);
  });

  it('recognizes the exact kit action vocabulary', () => {
    for (const action of ['install', 'review', 'activate', 'suspend', 'resume', 'remove']) {
      expect(isKitAction(action)).toBe(true);
    }
    for (const action of ['publish', 'deploy', 'verify', 'submit', '']) {
      expect(isKitAction(action)).toBe(false);
    }
  });
});

describe('verticalKitsApiError mapping', () => {
  it('maps the module’s own codes to HTTP-ish outcomes', () => {
    expect(verticalKitsApiError(new VerticalKitsError('forbidden', 'no claim'))).toMatchObject({
      status: 403,
    });
    expect(
      verticalKitsApiError(new VerticalKitsError('kit_version_not_found', 'missing')),
    ).toMatchObject({ status: 404 });
    expect(
      verticalKitsApiError(new VerticalKitsError('installation_not_found', 'missing')),
    ).toMatchObject({ status: 404 });
    expect(
      verticalKitsApiError(new VerticalKitsError('kit_already_installed', 'live')),
    ).toMatchObject({ status: 409 });
    expect(
      verticalKitsApiError(new VerticalKitsError('kit_not_verified', 'unverified')),
    ).toMatchObject({ status: 409 });
    expect(
      verticalKitsApiError(new VerticalKitsError('installation_not_pending_review', 'nope')),
    ).toMatchObject({ status: 409 });
    expect(
      verticalKitsApiError(new VerticalKitsError('invalid_input', 'bad shape')),
    ).toMatchObject({ status: 400 });
    expect(
      verticalKitsApiError(new VerticalKitsError('invalid_query', 'bad query')),
    ).toMatchObject({ status: 400 });
    expect(verticalKitsApiError(new Error('boom'))).toMatchObject({ status: 500 });
  });
});

// ---------------------------------------------------------------------------
// Discoverability (command search + capability hub)
// ---------------------------------------------------------------------------

describe('kit discoverability', () => {
  it('exposes the vertical-kits catalog section as a command destination', () => {
    const destination = MARKETPLACE_DESTINATIONS.find((entry) => entry.id === 'vertical-kits');
    expect(destination).toBeDefined();
    expect(destination!.href).toBe('/marketplace');
    const command = buildShellCommands().find(
      (candidate) => candidate.id === 'marketplace:vertical-kits',
    );
    expect(command).toBeDefined();
    expect(command!.target.kind).toBe('navigate');
    if (command!.target.kind === 'navigate') {
      expect(command!.target.href).toBe('/marketplace');
    }
  });

  it('a user typing a vertical TASK finds the kits destination', () => {
    const commands = buildShellCommands();
    for (const query of ['legal', 'accounting', 'ledger', 'starter kit', 'docket']) {
      const results = filterShellCommands(commands, query);
      expect(
        results.some((entry) => entry.command.id === 'marketplace:vertical-kits'),
        `query '${query}' should reach the vertical-kits destination`,
      ).toBe(true);
    }
  });

  it('the capability hub carries the kit intent entry in the extend family', () => {
    const entry = capabilityEntry('marketplace-kits');
    expect(entry.href).toBe('/marketplace');
    expect(entry.label).toMatch(/starter kit/i);
    const extend = CAPABILITY_FAMILIES.find((family) => family.id === 'extend');
    expect(extend!.entries.some((candidate) => candidate.id === 'marketplace-kits')).toBe(true);
  });

  it('the kit administer claim rides owner/admin sessions (the interim completion posture)', () => {
    expect(MANAGEMENT_CLAIMS).toContain('vertical-kits:administer');
  });
});
