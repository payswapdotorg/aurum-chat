// Unit proofs for the execution-fabric module — PURE, no database, no
// clock, no network (the org-lab discipline). Covers:
//
//   * THE STATE MACHINE — fabricLeaseTransitionProblem (the single
//     deterministic legality definition) accepts every legal lifecycle
//     move, refuses every illegal one with a deterministic reason, and
//     admits nothing out of a terminal status;
//   * THE VALIDATION SURFACE — the definition/acquire/lifecycle/
//     artifact/evidence/checkpoint/query guards (vocabularies, bounds,
//     grammars, the opaque-credential law);
//   * ADAPTER LEGALITY — all three catalog paths satisfy the frozen W131
//     FabricAdapter shape, serve their frozen kinds, and declare their
//     capabilities HONESTLY (each path's descriptor names what it cannot
//     do with supported:false);
//   * VENDOR-REMOVAL NEUTRALITY AT THE UNIT LEVEL — vendor identity is
//     metadata on the descriptor ONLY: no adapter-produced session or
//     domain shape carries a vendor name, and the fake-browser and
//     fake-remote paths produce structurally identical session shapes
//     behind their fakes (the service suite proves the full domain-flow
//     clause);
//   * THE REMOTE WIRE — the E2B-equivalent adapter behind the fake
//     transport speaks the documented protocol and its envelopes carry
//     NO credential material.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';

import {
  createLocalContainerAdapter,
  createBrowserEnvironmentAdapter,
  createFakeRemoteSandboxTransport,
  createRemoteSandboxAdapter,
  fabricLeaseTransitionProblem,
  isFabricLeaseStatus,
  isTerminalFabricLeaseStatus,
  validateAcquireFabricLeaseInput,
  validateListFabricLeasesQuery,
  validateRecordArtifactHandoffInput,
  validateRecordLeaseCheckpointInput,
  validateRecordLeaseEvidenceInput,
  validateRegisterEnvironmentDefinitionInput,
  validateTakeoverFabricLeaseInput,
  FABRIC_LEASE_STATUSES,
  FABRIC_LEASE_TERMINAL_STATUSES,
} from '../contract';
import { ExecutionFabricError } from '../contract';
import type { FabricLeaseStatus, FabricLeaseTransition } from '../contract';
import type { BrowserDriver } from '@/modules/computer-use/contract';

function expectProblem(code: string, fn: () => unknown): ExecutionFabricError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionFabricError);
    const typed = error as ExecutionFabricError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

describe('fabricLeaseTransitionProblem — the single legality definition', () => {
  const legal: [FabricLeaseTransition, FabricLeaseStatus][] = [
    ['prepare', 'preparing'],
    ['takeover', 'live'],
    ['handback', 'suspended'],
    ['markLost', 'live'],
    ['markLost', 'suspended'],
    ['recover', 'lost'],
    ['cancel', 'preparing'],
    ['cancel', 'live'],
    ['cancel', 'suspended'],
    ['cancel', 'lost'],
    ['release', 'preparing'],
    ['release', 'live'],
    ['fail', 'preparing'],
    ['fail', 'live'],
    ['fail', 'suspended'],
    ['fail', 'lost'],
  ];

  it('accepts every legal move', () => {
    for (const [transition, from] of legal) {
      expect(fabricLeaseTransitionProblem(transition, from)).toBeNull();
    }
  });

  it('refuses every illegal move with a deterministic reason', () => {
    const total = FABRIC_LEASE_STATUSES.length;
    let illegal = 0;
    for (const transition of [
      'prepare',
      'takeover',
      'handback',
      'markLost',
      'recover',
      'cancel',
      'release',
      'fail',
    ] as FabricLeaseTransition[]) {
      for (const from of FABRIC_LEASE_STATUSES) {
        const isLegal = legal.some(([t, f]) => t === transition && f === from);
        const problem = fabricLeaseTransitionProblem(transition, from);
        if (isLegal) continue;
        illegal += 1;
        expect(typeof problem).toBe('string');
        expect(problem!.length).toBeGreaterThan(0);
      }
    }
    // Sanity: the matrix is meaningfully populated.
    expect(illegal).toBe(8 * total - legal.length);
  });

  it('admits nothing out of a terminal status', () => {
    for (const terminal of FABRIC_LEASE_TERMINAL_STATUSES) {
      expect(isTerminalFabricLeaseStatus(terminal)).toBe(true);
      for (const transition of [
        'prepare',
        'takeover',
        'handback',
        'markLost',
        'recover',
        'cancel',
        'release',
        'fail',
      ] as FabricLeaseTransition[]) {
        expect(fabricLeaseTransitionProblem(transition, terminal)).toMatch(
          /terminal — the lifecycle is one-way/,
        );
      }
    }
  });

  it('mirrors the storage guard vocabulary (statuses and terminals)', () => {
    expect([...FABRIC_LEASE_STATUSES]).toEqual([
      'preparing',
      'live',
      'suspended',
      'lost',
      'released',
      'cancelled',
      'failed',
    ]);
    expect([...FABRIC_LEASE_TERMINAL_STATUSES]).toEqual(['released', 'cancelled', 'failed']);
    expect(isFabricLeaseStatus('live')).toBe(true);
    expect(isFabricLeaseStatus('zombie')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The validation surface
// ---------------------------------------------------------------------------

describe('registerEnvironmentDefinition validation', () => {
  const good = {
    defKey: 'site-workspace',
    displayName: 'Site workspace',
    kind: 'workspace',
    profileScope: 'task',
    networkEgress: 'restricted',
    survivesRestart: true,
    checkpoint: 'durable-checkpoint',
    persistentScope: '/workspace',
    requiredCapabilities: ['filesystem', 'commands'],
  };

  it('accepts and normalizes the retained shape', () => {
    const valid = validateRegisterEnvironmentDefinitionInput(good);
    expect(valid).toEqual({
      defKey: 'site-workspace',
      displayName: 'Site workspace',
      kind: 'workspace',
      profileScope: 'task',
      networkEgress: 'restricted',
      survivesRestart: true,
      checkpoint: 'durable-checkpoint',
      persistentScope: '/workspace',
      requiredCapabilities: ['filesystem', 'commands'],
      note: null,
    });
  });

  it('refuses non-object input, bad grammars and unknown vocabularies', () => {
    expectProblem('invalid_definition_input', () => validateRegisterEnvironmentDefinitionInput(null));
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, defKey: 'Bad_Key' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, displayName: '   ' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, kind: 'mainframe' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, profileScope: 'global' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, networkEgress: 'wild' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, checkpoint: 'maybe' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, survivesRestart: 'yes' }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({ ...good, requiredCapabilities: ['telepathy'] }),
    );
    expectProblem('invalid_definition_input', () =>
      validateRegisterEnvironmentDefinitionInput({
        ...good,
        requiredCapabilities: ['filesystem', 'filesystem'],
      }),
    );
  });
});

describe('acquireFabricLease validation', () => {
  const runId = newId();
  const good = {
    definitionId: newId(),
    planId: newId(),
    executionRunId: runId,
    credentialRef: 'vault://env/site-ssh-key',
    leaseMinutes: 90,
  };

  it('accepts the retained shape and defaults the window', () => {
    const valid = validateAcquireFabricLeaseInput(good);
    expect(valid.leaseMinutes).toBe(90);
    expect(valid.credentialRef).toBe('vault://env/site-ssh-key');
    const defaulted = validateAcquireFabricLeaseInput({
      definitionId: newId(),
      planId: newId(),
      executionRunId: runId,
    });
    expect(defaulted.leaseMinutes).toBe(60);
    expect(defaulted.credentialRef).toBeNull();
  });

  it('refuses non-uuid refs and out-of-bounds windows (opaque ref bounded, never a value check)', () => {
    expectProblem('invalid_lease_input', () => validateAcquireFabricLeaseInput(null));
    expectProblem('invalid_lease_input', () =>
      validateAcquireFabricLeaseInput({ ...good, definitionId: 'not-a-uuid' }),
    );
    expectProblem('invalid_lease_input', () =>
      validateAcquireFabricLeaseInput({ ...good, leaseMinutes: 0 }),
    );
    expectProblem('invalid_lease_input', () =>
      validateAcquireFabricLeaseInput({ ...good, leaseMinutes: 1441 }),
    );
    expectProblem('invalid_lease_input', () =>
      validateAcquireFabricLeaseInput({ ...good, leaseMinutes: 12.5 }),
    );
  });
});

describe('lifecycle / evidence / checkpoint / query validation', () => {
  it('takeover requires a reason and a uuid authorityActionRef when present', () => {
    const leaseId = newId();
    expect(validateTakeoverFabricLeaseInput({ leaseId, reason: 'inspect' })).toEqual({
      leaseId,
      reason: 'inspect',
      authorityActionRef: null,
    });
    expectProblem('invalid_lifecycle_input', () =>
      validateTakeoverFabricLeaseInput({ leaseId, reason: '' }),
    );
    expectProblem('invalid_lifecycle_input', () =>
      validateTakeoverFabricLeaseInput({ leaseId, reason: 'inspect', authorityActionRef: 'nope' }),
    );
  });

  it('artifact handoff bounds the opaque ref, the kind and the digest grammar', () => {
    const leaseId = newId();
    expect(
      validateRecordArtifactHandoffInput({
        leaseId,
        direction: 'out',
        artifactRef: 'artifact://site-report',
        artifactKind: 'report',
        digest: 'a1b2c3d4e5f6a7b8',
      }),
    ).toMatchObject({ digest: 'a1b2c3d4e5f6a7b8' });
    expectProblem('invalid_artifact_input', () =>
      validateRecordArtifactHandoffInput({ leaseId, direction: 'sideways', artifactRef: 'x', artifactKind: 'k' }),
    );
    expectProblem('invalid_artifact_input', () =>
      validateRecordArtifactHandoffInput({ leaseId, direction: 'in', artifactRef: '', artifactKind: 'k' }),
    );
    expectProblem('invalid_artifact_input', () =>
      validateRecordArtifactHandoffInput({ leaseId, direction: 'in', artifactRef: 'r', artifactKind: 'k', digest: 'zzzz' }),
    );
  });

  it('evidence enforces the frozen capture vocabulary and the verification triad', () => {
    const leaseId = newId();
    expect(
      validateRecordLeaseEvidenceInput({
        leaseId,
        captureKind: 'dom-snapshot',
        artifactRef: 'artifact://dom',
        verification: 'mismatched',
      }),
    ).toMatchObject({ captureKind: 'dom-snapshot', verification: 'mismatched' });
    expectProblem('invalid_evidence_input', () =>
      validateRecordLeaseEvidenceInput({ leaseId, captureKind: 'smell', artifactRef: 'r', verification: 'verified' }),
    );
    expectProblem('invalid_evidence_input', () =>
      validateRecordLeaseEvidenceInput({ leaseId, captureKind: 'console', artifactRef: 'r', verification: 'maybe' }),
    );
  });

  it('checkpoints bound the opaque cursor and dedupe covered evidence refs', () => {
    const leaseId = newId();
    expect(
      validateRecordLeaseCheckpointInput({
        leaseId,
        cursor: 'session-1@cursor-7',
        coveredEvidenceRefs: ['ev-1', 'ev-2'],
      }),
    ).toMatchObject({ cursor: 'session-1@cursor-7', coveredEvidenceRefs: ['ev-1', 'ev-2'] });
    expectProblem('invalid_checkpoint_input', () =>
      validateRecordLeaseCheckpointInput({ leaseId, cursor: '' }),
    );
    expectProblem('invalid_checkpoint_input', () =>
      validateRecordLeaseCheckpointInput({ leaseId, cursor: 'c', coveredEvidenceRefs: ['ev-1', 'ev-1'] }),
    );
  });

  it('lease list queries validate the filter vocabulary and the limit bounds', () => {
    expect(validateListFabricLeasesQuery({ status: 'lost', limit: 10 })).toEqual({
      executionRunId: null,
      definitionId: null,
      status: 'lost',
      limit: 10,
    });
    expect(validateListFabricLeasesQuery({}).limit).toBe(50);
    expectProblem('invalid_query', () => validateListFabricLeasesQuery({ status: 'zombie' }));
    expectProblem('invalid_query', () => validateListFabricLeasesQuery({ limit: 0 }));
    expectProblem('invalid_query', () => validateListFabricLeasesQuery({ limit: 501 }));
    expectProblem('invalid_query', () =>
      validateListFabricLeasesQuery({ executionRunId: 'not-a-uuid' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter legality (the three catalog paths behind the frozen shape)
// ---------------------------------------------------------------------------

const FAKE_DRIVER: BrowserDriver = {
  startSession: async () => ({ sessionKey: `brow-${newId()}` }),
  performAction: async () => {
    throw new Error('the fabric never drives browser actions (computer-use owns that)');
  },
  endSession: async () => {},
};

describe('adapter legality — the frozen W131 shape, served honestly', () => {
  it('the local-container path serves the workspace kind with honest capabilities', async () => {
    const adapter = createLocalContainerAdapter();
    expect(adapter.kind).toBe('workspace');
    const descriptor = await adapter.probe();
    expect(descriptor.kind).toBe('workspace');
    expect(descriptor.health).toBe('available');
    const byDomain = new Map(descriptor.capabilities.map((c) => [c.domain, c.supported]));
    expect(byDomain.get('filesystem')).toBe(true);
    expect(byDomain.get('commands')).toBe(true);
    expect(byDomain.get('display')).toBe(false); // honest: no display in a headless container sim
    expect(byDomain.get('browser-profile')).toBe(false);
    const session = await adapter.open({
      tenantId: newId(),
      environmentKind: 'workspace',
      profileScope: 'task',
      subjectRef: newId(),
    });
    expect(session.phase).toBe('live');
    expect(session.isolation.tenantIsolated).toBe(true);
    expect(session.isolation.credentialHandling).toBe('opaque-ref-only');
    expect(session.persistence.survivesRestart).toBe(true);
    expect(session.persistence.checkpoint).toBe('durable-checkpoint');
    const closed = await adapter.close(session.sessionId, 'done');
    expect(closed.phase).toBe('ended');
  });

  it('the browser path serves the browser kind with honest capabilities', async () => {
    const adapter = createBrowserEnvironmentAdapter({
      driver: FAKE_DRIVER,
      allowlist: { urlGlobs: ['https://example.com/*'], verbs: ['goto', 'read'] },
    });
    expect(adapter.kind).toBe('browser');
    const descriptor = await adapter.probe();
    expect(descriptor.kind).toBe('browser');
    const byDomain = new Map(descriptor.capabilities.map((c) => [c.domain, c.supported]));
    expect(byDomain.get('display')).toBe(true);
    expect(byDomain.get('browser-profile')).toBe(true);
    expect(byDomain.get('filesystem')).toBe(false); // honest: a browser is not a filesystem
    expect(byDomain.get('commands')).toBe(false);
    const session = await adapter.open({
      tenantId: newId(),
      environmentKind: 'browser',
      profileScope: 'task',
      subjectRef: newId(),
      credentialRef: 'vault://browser/site-login',
    });
    expect(session.phase).toBe('live');
    expect(session.isolation.tenantIsolated).toBe(true);
    expect(session.isolation.credentialHandling).toBe('opaque-ref-only');
    expect(session.persistence.checkpoint).toBe('session');
    // The credential ref is handed through as an OPAQUE ref: the session
    // shape carries no secret and the started record holds the ref, not a value.
    expect(JSON.stringify(session)).not.toContain('site-login');
  });

  it('the remote-sandbox path serves the remote-sandbox kind with honest capabilities', async () => {
    const transport = createFakeRemoteSandboxTransport();
    const adapter = createRemoteSandboxAdapter({
      apiBaseUrl: 'https://sandbox.vendor.example',
      transport,
    });
    expect(adapter.kind).toBe('remote-sandbox');
    const descriptor = await adapter.probe();
    expect(descriptor.kind).toBe('remote-sandbox');
    expect(descriptor.health).toBe('available');
    const byDomain = new Map(descriptor.capabilities.map((c) => [c.domain, c.supported]));
    expect(byDomain.get('filesystem')).toBe(true);
    expect(byDomain.get('commands')).toBe(true);
    expect(byDomain.get('display')).toBe(true);
    expect(byDomain.get('browser-profile')).toBe(false); // honest: a computer, not a governed browser
    const session = await adapter.open({
      tenantId: newId(),
      environmentKind: 'remote-sandbox',
      profileScope: 'task',
      subjectRef: newId(),
    });
    expect(session.phase).toBe('live');
    expect(session.persistence.survivesRestart).toBe(true);
    expect(session.persistence.checkpoint).toBe('durable-checkpoint');
    const resumed = await adapter.resume(`${session.sessionId}@cursor-1`);
    expect(resumed.sessionId).not.toBe(session.sessionId); // FRESH session
    expect(resumed.persistence.persistentScope).toBe(session.persistence.persistentScope); // same isolated profile
    await adapter.close(session.sessionId, 'done');
    expect(adapter.state.closeCalls).toBe(1);
  });

  it('the remote path reports an unreachable vendor honestly (never fabricated)', async () => {
    const failing = createFakeRemoteSandboxTransport({
      failures: [{ pathIncludes: '/health', status: 503, body: 'overloaded' }],
    });
    const adapter = createRemoteSandboxAdapter({
      apiBaseUrl: 'https://sandbox.vendor.example',
      transport: failing,
    });
    const descriptor = await adapter.probe();
    expect(descriptor.health).toBe('unavailable');
  });

  it('the remote wire speaks the documented protocol with NO credential material', async () => {
    const transport = createFakeRemoteSandboxTransport();
    const adapter = createRemoteSandboxAdapter({
      apiBaseUrl: 'https://sandbox.vendor.example',
      transport,
    });
    const session = await adapter.open({
      tenantId: newId(),
      environmentKind: 'remote-sandbox',
      profileScope: 'task',
      subjectRef: newId(),
      credentialRef: 'vault://remote/vendor-key',
    });
    await adapter.resume(session.sessionId);
    await adapter.close(session.sessionId, 'done');
    const requests = adapter.state.requests;
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'POST https://sandbox.vendor.example/sandboxes',
      'POST https://sandbox.vendor.example/sandboxes',
      `DELETE https://sandbox.vendor.example/sandboxes/${session.sessionId}`,
    ]);
    // The envelopes the ADAPTER builds carry no credential: the wire
    // bodies are the create/resume markers only, and the headers hold
    // nothing but the JSON content type (vendor auth belongs to the
    // production transport wrapper, never here).
    for (const request of requests) {
      expect(request.body === null || !request.body.includes('vault://')).toBe(true);
    }
    const secondCreate = JSON.parse(requests[1]!.body!) as { resumeOf?: string };
    expect(secondCreate.resumeOf).toBe(session.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Vendor-removal neutrality at the unit level
// ---------------------------------------------------------------------------

describe('vendor-removal neutrality (unit level)', () => {
  const VENDOR_STRINGS = ['e2b', 'playwright', 'docker', 'chromium'];

  async function sessionThrough(kind: 'browser' | 'remote-sandbox') {
    if (kind === 'browser') {
      const adapter = createBrowserEnvironmentAdapter({
        driver: FAKE_DRIVER,
        allowlist: { urlGlobs: ['https://example.com/*'], verbs: ['goto', 'read'] },
      });
      return adapter.open({
        tenantId: '11111111-1111-4111-8111-111111111111',
        environmentKind: 'browser',
        profileScope: 'task',
        subjectRef: '22222222-2222-4222-8222-222222222222',
      });
    }
    const adapter = createRemoteSandboxAdapter({
      apiBaseUrl: 'https://sandbox.vendor.example',
      transport: createFakeRemoteSandboxTransport(),
    });
    return adapter.open({
      tenantId: '11111111-1111-4111-8111-111111111111',
      environmentKind: 'remote-sandbox',
      profileScope: 'task',
      subjectRef: '22222222-2222-4222-8222-222222222222',
    });
  }

  it('no vendor name rides in any adapter-produced session (metadata only)', async () => {
    for (const kind of ['browser', 'remote-sandbox'] as const) {
      const session = await sessionThrough(kind);
      const serialized = JSON.stringify(session).toLowerCase();
      for (const vendor of VENDOR_STRINGS) {
        expect(serialized).not.toContain(vendor);
      }
      // The structural shape is IDENTICAL across the two vendor paths
      // (the service suite proves the full domain-flow clause). A live
      // session has exactly these keys (endedAt appears only when ended).
      expect(Object.keys(session).sort()).toEqual([
        'adapterId',
        'artifacts',
        'isolation',
        'openedAt',
        'persistence',
        'phase',
        'sessionId',
      ]);
      expect(session.isolation.tenantIsolated).toBe(true);
      expect(session.isolation.credentialHandling).toBe('opaque-ref-only');
    }
  });

  it('the isolated profile keys are tenant-scoped on every path (the W093 discipline)', async () => {
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '33333333-3333-4333-8333-333333333333';
    const subject = '22222222-2222-4222-8222-222222222222';

    const local = createLocalContainerAdapter();
    await local.open({ tenantId: tenantA, environmentKind: 'workspace', profileScope: 'task', subjectRef: subject });
    await local.open({ tenantId: tenantB, environmentKind: 'workspace', profileScope: 'task', subjectRef: subject });
    const localKeys = local.state.profileKeys;
    expect(localKeys).toHaveLength(2);
    expect(localKeys[0]).not.toBe(localKeys[1]);

    const browser = createBrowserEnvironmentAdapter({
      driver: FAKE_DRIVER,
      allowlist: { urlGlobs: ['https://example.com/*'], verbs: ['goto'] },
    });
    await browser.open({ tenantId: tenantA, environmentKind: 'browser', profileScope: 'task', subjectRef: subject });
    await browser.open({ tenantId: tenantB, environmentKind: 'browser', profileScope: 'task', subjectRef: subject });
    expect(new Set(browser.state.profileKeys).size).toBe(2);

    const remote = createRemoteSandboxAdapter({
      apiBaseUrl: 'https://sandbox.vendor.example',
      transport: createFakeRemoteSandboxTransport(),
    });
    await remote.open({ tenantId: tenantA, environmentKind: 'remote-sandbox', profileScope: 'task', subjectRef: subject });
    await remote.open({ tenantId: tenantB, environmentKind: 'remote-sandbox', profileScope: 'task', subjectRef: subject });
    expect(new Set(remote.state.profileKeys).size).toBe(2);
  });
});
