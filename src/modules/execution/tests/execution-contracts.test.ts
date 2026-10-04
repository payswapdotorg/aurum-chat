// Compile-level contract tests of the W131 frozen execution contracts
// (TYPES ONLY — there is no logic to test; these prove the types
// instantiate, the discriminated unions narrow, the literal-baked laws
// hold, and the frozen vocabulary constants match their unions).
//
// No database, no runtime wiring: the execution module ships no service
// by work-order law. Every assertion here is a CONTRACT assertion —
// W135/W137/W139 build against exactly this surface.

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CANONICAL_CLIENT_PLATFORM,
  CLIENT_DEGRADATION_STATES,
  CLIENT_OFFLINE_ADMISSION_NEGATIVES,
  CLIENT_PLATFORM_KINDS,
  CLIENT_QUEUED_INTENT_STATES,
  CLIENT_SESSION_STATES,
  COMPUTER_SESSION_CONTROL_MODES,
  COMPUTER_SESSION_PHASES,
  CONTINUITY_ANCHOR_KINDS,
  EXECUTION_ADAPTER_CAPABILITY_DOMAINS,
  EXECUTION_ADAPTER_HEALTH_STATES,
  EXECUTION_ENVIRONMENT_KINDS,
  EXECUTION_ENVIRONMENT_SESSION_PHASES,
  EXECUTION_CONTRACT_SCOPES,
  EXECUTION_CONTRACT_VERSION,
  TASK_WORKER_EVENT_KINDS,
  TASK_WORKER_RUN_CANCELLABLE_STATUSES,
  TASK_WORKER_RUN_RECOVERABLE_STATUSES,
  TASK_WORKER_RUN_STATUSES,
  TASK_WORKER_RUN_TERMINAL_STATUSES,
  type ClientOfflineAdmissionNegative,
  type ClientQueuedIntent,
  type ClientRealtimeSubscription,
  type ClientSessionRef,
  type ClientSessionState,
  type CompanyStateProjectionRef,
  type ComputerSessionControlContract,
  type ComputerSessionPhase,
  type ConsequentialActionBoundary,
  type ContinuityAnchor,
  type ContinuityConflict,
  type ContinuityHandoff,
  type ExecutionAdapter,
  type ExecutionAdapterCapability,
  type ExecutionAdapterVendorMetadata,
  type ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentKind,
  type ExecutionEnvironmentSession,
  type ExecutionSessionOpenRequest,
  type SessionIsolationProperties,
  type SessionObservationCapture,
  type TaskWorkerCancellation,
  type TaskWorkerCheckpoint,
  type TaskWorkerEvent,
  type TaskWorkerLease,
  type TaskWorkerRecovery,
  type TaskWorkerResumeSemantics,
  type TaskWorkerRun,
  type TaskWorkerRunStatus,
  type TaskWorkerStatusEvent,
  type TaskWorkerTakeover,
} from '../contract';

// ---------------------------------------------------------------------------
// Frozen fixtures (typed object literals — instantiation proof).
// ---------------------------------------------------------------------------

const iso = (n: number) => new Date(Date.UTC(2026, 9, 4, 0, n, 0)).toISOString();

const vendor: ExecutionAdapterVendorMetadata = {
  vendorName: 'fixture vendor',
  vendorProduct: 'fixture adapter',
  vendorAdapterVersion: '1.0.0',
};

const capabilities: ExecutionAdapterCapability[] = [
  { domain: 'filesystem', supported: true, limits: { outputCap: '256KiB' } },
  { domain: 'commands', supported: true, limits: { maxCommandSeconds: '30' } },
  { domain: 'network-egress', supported: false },
  { domain: 'observation-capture', supported: true },
];

const descriptor: ExecutionEnvironmentDescriptor = {
  adapterId: 'adapter-fixture-1',
  kind: 'remote-sandbox',
  displayName: 'Fixture Remote Sandbox',
  vendor,
  capabilities,
  health: 'available',
};

const isolation: SessionIsolationProperties = {
  tenantIsolated: true,
  profileScope: 'task',
  networkEgress: 'restricted',
  credentialHandling: 'opaque-ref-only',
};

const session: ExecutionEnvironmentSession = {
  sessionId: 'session-fixture-1',
  adapterId: descriptor.adapterId,
  phase: 'live',
  openedAt: iso(1),
  isolation,
  persistence: { survivesRestart: true, checkpoint: 'durable-checkpoint', persistentScope: '/workspace' },
  artifacts: [{ artifactRef: 'artifact-fixture-1', direction: 'out', artifactKind: 'screenshot', digest: 'a'.repeat(64) }],
};

const openRequest: ExecutionSessionOpenRequest = {
  tenantId: 'tenant-fixture',
  environmentKind: 'remote-sandbox',
  credentialRef: 'credref-fixture-1',
  profileScope: 'task',
};

const adapter: ExecutionAdapter = {
  adapterId: descriptor.adapterId,
  kind: 'remote-sandbox',
  probe: async () => descriptor,
  open: async () => session,
  resume: async () => session,
  close: async () => ({ ...session, phase: 'ended', endedAt: iso(2) }),
};

const lease: TaskWorkerLease = { leaseId: 'lease-1', leaseUntil: iso(30), lastHeartbeatAt: iso(3) };
const checkpoint: TaskWorkerCheckpoint = {
  checkpointId: 'checkpoint-1',
  cursor: 'opaque-cursor-grammar-owned-by-the-run-kind',
  recordedAt: iso(4),
  coveredEvidenceRefs: ['obs-1', 'obs-2'],
};
const takeover: TaskWorkerTakeover = {
  takenOverAt: iso(5),
  holder: 'human',
  reason: 'operator review before the consequential step',
  authorityActionRef: 'action-fixture-1',
};
const cancellation: TaskWorkerCancellation = { requestedAt: iso(6), finalizedAt: iso(7), reason: 'operator stopped the run' };
const recovery: TaskWorkerRecovery = {
  detectedAt: iso(8),
  recoveredAt: iso(9),
  recoveredFromCheckpointRef: checkpoint.checkpointId,
};
const resumeSemantics: TaskWorkerResumeSemantics = {
  resumeFrom: 'checkpoint',
  replay: 'never-reexecute-covered',
  freshSession: true,
};

const run: TaskWorkerRun = {
  runId: 'run-fixture-1',
  tenantId: 'tenant-fixture',
  runKind: 'cognition-pump',
  environmentSessionRef: session.sessionId,
  environmentAdapterRef: descriptor.adapterId,
  status: 'running',
  createdAt: iso(10),
  updatedAt: iso(11),
  lease,
  checkpoint,
  takeover,
  cancellation,
  recovery,
  evidenceRefs: ['obs-1', 'obs-2'],
  artifactRefs: ['artifact-fixture-1'],
  correlationId: 'corr-fixture-1',
  causationId: 'corr-fixture-0',
  resumeSemantics,
};

const boundary: ConsequentialActionBoundary = {
  requiresActionGateway: true,
  sessionLocalExecution: 'never-for-consequential',
  authorityActionRef: 'action-fixture-1',
  actionKindRef: 'external-communication',
};

const computerSession: ComputerSessionControlContract = {
  sessionId: 'csession-fixture-1',
  tenantId: 'tenant-fixture',
  phase: 'live',
  controlMode: 'automation',
  takeoverPoints: [
    {
      takeoverId: 'takeover-1',
      at: iso(12),
      from: 'automation',
      to: 'human',
      reason: 'operator took control of the browser session',
      resumePolicy: 'explicit-handback-only',
    },
  ],
  observations: [
    { captureKind: 'screenshot', artifactRef: 'artifact-fixture-1', redaction: 'applied', recordedAt: iso(13) },
    { captureKind: 'action-trace', artifactRef: 'artifact-fixture-2', redaction: 'applied', recordedAt: iso(14) },
  ],
  boundary,
  environmentSessionRef: session.sessionId,
  environmentAdapterRef: descriptor.adapterId,
};

const origin: ClientSessionRef = { sessionId: 'session-web-1', platform: 'web' };
const projectionRef: CompanyStateProjectionRef = {
  projectionKind: 'company-state',
  targetId: 'goal-fixture-1',
  tenantId: 'tenant-fixture',
  revision: 7,
  digest: 'b'.repeat(64),
};
const subscription: ClientRealtimeSubscription = {
  subscriptionId: 'sub-1',
  topicKind: 'realtime-session-stream',
  lastSeenCursor: 'cursor-1',
  state: 'live',
};
const queuedIntent: ClientQueuedIntent = {
  queueId: 'queue-1',
  sessionId: origin.sessionId,
  tenantId: 'tenant-fixture',
  intentClass: 'pending-projection',
  idempotencyKey: 'idem-1',
  operationRef: 'operation-fixture-1',
  enqueuedAt: iso(15),
  state: 'pending',
  attempts: 0,
};

const anchor: ContinuityAnchor = {
  anchorId: 'anchor-1',
  tenantId: 'tenant-fixture',
  anchorKind: 'task-run',
  focusRef: run.runId,
  focusRevision: 3,
  origin,
  anchorRevision: 2,
  lastActiveAt: iso(16),
  openOn: 'web',
};
const handoff: ContinuityHandoff = {
  handoffId: 'handoff-1',
  anchorRef: anchor.anchorId,
  from: origin,
  to: { sessionId: 'session-desktop-1', platform: 'desktop' },
  at: iso(17),
  semantics: { reprojection: 'from-server-state', authorityTransfer: 'none', payload: 'projection-refs-only' },
};
const conflict: ContinuityConflict = {
  conflictId: 'conflict-1',
  anchorRef: anchor.anchorId,
  conflictKind: 'stale-client-projection',
  resolution: 'server-state-wins',
  discardedClientRevision: 2,
  resolvedAt: iso(18),
};

// ---------------------------------------------------------------------------
// The contract tests.
// ---------------------------------------------------------------------------

describe('W131 execution contracts — vocabulary constants', () => {
  it('freezes the execution environment kind vocabulary', () => {
    expect(EXECUTION_ENVIRONMENT_KINDS).toEqual(['local', 'browser', 'workspace', 'remote-sandbox']);
    expectTypeOf<ExecutionEnvironmentKind>().toEqualTypeOf<'local' | 'browser' | 'workspace' | 'remote-sandbox'>();
  });

  it('freezes the task worker run status vocabulary (cancellation + recovery first-class)', () => {
    expect(TASK_WORKER_RUN_STATUSES).toHaveLength(10);
    expect(TASK_WORKER_RUN_STATUSES).toContain('cancelling');
    expect(TASK_WORKER_RUN_STATUSES).toContain('cancelled');
    expect(TASK_WORKER_RUN_STATUSES).toContain('lost');
    expect(TASK_WORKER_RUN_STATUSES).toContain('recovering');
    // terminal / cancellable / recoverable subsets are frozen and disjoint in law
    expect(TASK_WORKER_RUN_TERMINAL_STATUSES).toEqual(['cancelled', 'succeeded', 'failed']);
    expect(TASK_WORKER_RUN_CANCELLABLE_STATUSES).toEqual(['queued', 'running', 'suspended', 'awaiting_approval']);
    expect(TASK_WORKER_RUN_RECOVERABLE_STATUSES).toEqual(['lost']);
  });

  it('freezes the remaining closed vocabularies', () => {
    expect(EXECUTION_ADAPTER_CAPABILITY_DOMAINS).toHaveLength(9);
    expect(EXECUTION_ADAPTER_HEALTH_STATES).toEqual(['available', 'degraded', 'unavailable', 'unconfigured']);
    expect(EXECUTION_ENVIRONMENT_SESSION_PHASES).toHaveLength(7);
    expect(TASK_WORKER_EVENT_KINDS).toHaveLength(7);
    expect(COMPUTER_SESSION_CONTROL_MODES).toEqual(['automation', 'human', 'automation-yielding']);
    expect(COMPUTER_SESSION_PHASES).toHaveLength(6);
    expect(CLIENT_PLATFORM_KINDS).toEqual(['web', 'desktop', 'mobile']);
    expect(CANONICAL_CLIENT_PLATFORM).toBe('web');
    expect(CLIENT_SESSION_STATES).toEqual(['active', 'expired', 'revoked']);
    expect(CLIENT_DEGRADATION_STATES).toEqual(['online', 'degraded', 'offline']);
    expect(CLIENT_OFFLINE_ADMISSION_NEGATIVES).toHaveLength(5);
    expect(CLIENT_QUEUED_INTENT_STATES).toEqual(['pending', 'draining', 'drained', 'rejected']);
    expect(CONTINUITY_ANCHOR_KINDS).toEqual(['task-run', 'session', 'review', 'approval']);
    expect(EXECUTION_CONTRACT_SCOPES).toHaveLength(5);
    expect(EXECUTION_CONTRACT_VERSION).toBe('1.0.0');
  });
});

describe('W131 execution contracts — types instantiate', () => {
  it('instantiates the Group 1 environment adapter surface', () => {
    expect(descriptor.kind).toBe('remote-sandbox');
    expect(session.isolation.tenantIsolated).toBe(true);
    expect(adapter.kind).toBe('remote-sandbox');
    expect(openRequest.credentialRef).toBe('credref-fixture-1');
    expectTypeOf<Parameters<typeof adapter.open>[0]>().toEqualTypeOf<ExecutionSessionOpenRequest>();
    expectTypeOf<Awaited<ReturnType<typeof adapter.probe>>>().toEqualTypeOf<ExecutionEnvironmentDescriptor>();
  });

  it('instantiates the Group 2 durable run surface', () => {
    expect(run.status).toBe('running');
    expect(run.lease?.leaseId).toBe('lease-1');
    expect(run.checkpoint?.coveredEvidenceRefs).toHaveLength(2);
    expect(run.resumeSemantics.replay).toBe('never-reexecute-covered');
    expectTypeOf(run.resumeSemantics.freshSession).toEqualTypeOf<true>();
  });

  it('instantiates the Group 3 computer session control surface', () => {
    expect(computerSession.controlMode).toBe('automation');
    expect(computerSession.takeoverPoints[0]?.resumePolicy).toBe('explicit-handback-only');
    expect(computerSession.observations[0]?.redaction).toBe('applied');
    expect(computerSession.boundary.requiresActionGateway).toBe(true);
  });

  it('instantiates the Group 4 shared client/runtime surface', () => {
    expect(projectionRef.digest).toHaveLength(64);
    expect(queuedIntent.intentClass).toBe('pending-projection');
    expect(queuedIntent.idempotencyKey).toBe('idem-1');
    expect(subscription.state).toBe('live');
    expect(subscription.lastSeenCursor).toBe('cursor-1');
    expectTypeOf<ClientSessionState>().toEqualTypeOf<'active' | 'expired' | 'revoked'>();
  });

  it('instantiates the Group 5 continuity surface', () => {
    expect(anchor.openOn).toBe('web');
    expect(handoff.semantics.authorityTransfer).toBe('none');
    expect(conflict.resolution).toBe('server-state-wins');
  });
});

describe('W131 execution contracts — discriminated unions narrow', () => {
  it('narrows TaskWorkerEvent on `kind`', () => {
    const events: TaskWorkerEvent[] = [
      { kind: 'progress', eventId: 'e1', runRef: run.runId, at: iso(19), fraction: 0.5, note: 'halfway' },
      { kind: 'evidence', eventId: 'e2', runRef: run.runId, at: iso(20), observationRef: 'obs-3', evidenceKind: 'observation' },
      { kind: 'artifact', eventId: 'e3', runRef: run.runId, at: iso(21), artifactRef: 'artifact-fixture-3', artifactKind: 'pdf', digest: 'c'.repeat(64) },
      { kind: 'status', eventId: 'e4', runRef: run.runId, at: iso(22), from: 'running', to: 'lost', reason: 'lease expired' },
      { kind: 'takeover', eventId: 'e5', runRef: run.runId, at: iso(23), holder: 'human', reason: 'operator review' },
      { kind: 'recovery', eventId: 'e6', runRef: run.runId, at: iso(24), recoveredFromCheckpointRef: 'checkpoint-1' },
      { kind: 'cancellation', eventId: 'e7', runRef: run.runId, at: iso(25), reason: 'operator stopped the run' },
    ];

    for (const event of events) {
      switch (event.kind) {
        case 'progress':
          expectTypeOf(event.fraction).toEqualTypeOf<number | undefined>();
          expect(event.fraction).toBe(0.5);
          break;
        case 'evidence':
          expectTypeOf(event.observationRef).toEqualTypeOf<string>();
          expect(event.observationRef).toBe('obs-3');
          break;
        case 'artifact':
          expectTypeOf(event.artifactRef).toEqualTypeOf<string>();
          expect(event.artifactKind).toBe('pdf');
          break;
        case 'status':
          expectTypeOf(event.from).toEqualTypeOf<TaskWorkerRunStatus>();
          expectTypeOf(event.to).toEqualTypeOf<TaskWorkerRunStatus>();
          expect((event as TaskWorkerStatusEvent).to).toBe('lost');
          break;
        case 'takeover':
          expectTypeOf(event.holder).toEqualTypeOf<'human'>();
          expect(event.holder).toBe('human');
          break;
        case 'recovery':
          expectTypeOf(event.recoveredFromCheckpointRef).toEqualTypeOf<string>();
          break;
        case 'cancellation':
          expectTypeOf(event.reason).toEqualTypeOf<string>();
          break;
      }
    }
    expect(events).toHaveLength(7);
  });

  it('narrows the session phase and control-mode unions', () => {
    const phase: ComputerSessionPhase = 'live';
    const control: ComputerSessionControlContract['controlMode'] = 'automation-yielding';
    expect(phase).toBe('live');
    expect(control).toBe('automation-yielding');
    expectTypeOf<ComputerSessionPhase>().not.toEqualTypeOf<string>();
  });
});

describe('W131 execution contracts — the baked-in laws', () => {
  it('makes non-tenant-isolated sessions inexpressible', () => {
    expectTypeOf<SessionIsolationProperties['tenantIsolated']>().toEqualTypeOf<true>();
    expectTypeOf<SessionIsolationProperties['credentialHandling']>().toEqualTypeOf<'opaque-ref-only'>();
    // @ts-expect-error — a non-isolated session does not typecheck (lock 3)
    const bad: SessionIsolationProperties = { tenantIsolated: false, profileScope: 'task', networkEgress: 'restricted', credentialHandling: 'opaque-ref-only' };
    void bad;
  });

  it('makes session-local consequential execution inexpressible', () => {
    expectTypeOf<ConsequentialActionBoundary['requiresActionGateway']>().toEqualTypeOf<true>();
    expectTypeOf<ConsequentialActionBoundary['sessionLocalExecution']>().toEqualTypeOf<'never-for-consequential'>();
    // @ts-expect-error — weakening the boundary does not typecheck
    const bad: ConsequentialActionBoundary = { requiresActionGateway: false, sessionLocalExecution: 'never-for-consequential' };
    void bad;
    // @ts-expect-error — session-local execution of consequential actions does not typecheck
    const worse: ConsequentialActionBoundary = { requiresActionGateway: true, sessionLocalExecution: 'allowed' };
    void worse;
  });

  it('makes authority transfer and competing semantic state inexpressible', () => {
    expectTypeOf<ContinuityHandoff['semantics']['authorityTransfer']>().toEqualTypeOf<'none'>();
    expectTypeOf<ContinuityHandoff['semantics']['payload']>().toEqualTypeOf<'projection-refs-only'>();
    expectTypeOf<ContinuityConflict['resolution']>().toEqualTypeOf<'server-state-wins'>();
    // @ts-expect-error — a handoff that transfers authority does not typecheck
    const bad: ContinuityHandoffSemanticsLiteral = { reprojection: 'from-server-state', authorityTransfer: 'to-recipient', payload: 'projection-refs-only' };
    void bad;
    // @ts-expect-error — a client winning a conflict does not typecheck
    const worse: ContinuityConflict['resolution'] = 'client-state-wins';
    void worse;
  });

  it('keeps takeover human-only and resume never-reexecuting', () => {
    expectTypeOf<TaskWorkerTakeover['holder']>().toEqualTypeOf<'human'>();
    expectTypeOf<TaskWorkerResumeSemantics['replay']>().toEqualTypeOf<'never-reexecute-covered'>();
    expectTypeOf<TaskWorkerResumeSemantics['freshSession']>().toEqualTypeOf<true>();
    // @ts-expect-error — an automated takeover does not typecheck
    const bad: TaskWorkerTakeover = { takenOverAt: iso(26), holder: 'automation', reason: 'no' };
    void bad;
  });

  it('keeps offline intents projection-only', () => {
    expectTypeOf<ClientQueuedIntent['intentClass']>().toEqualTypeOf<'pending-projection'>();
    // @ts-expect-error — a queued local decision does not typecheck
    const bad: ClientQueuedIntent = { queueId: 'q', sessionId: 's', tenantId: 't', intentClass: 'local-decision', idempotencyKey: 'k', operationRef: 'o', enqueuedAt: iso(27), state: 'pending', attempts: 0 };
    void bad;
    expectTypeOf<ClientOfflineAdmissionNegative>().toEqualTypeOf<
      | 'local-approval-not-authority'
      | 'local-semantic-mutation-rejected'
      | 'local-identity-minting-rejected'
      | 'local-digest-forgery-rejected'
      | 'idempotency-key-required'
    >();
  });

  it('bakes observation redaction into the capture shape', () => {
    expectTypeOf<SessionObservationCapture['redaction']>().toEqualTypeOf<'applied'>();
    // @ts-expect-error — unredacted captures do not typecheck
    const bad: SessionObservationCapture = { captureKind: 'screenshot', artifactRef: 'a', redaction: 'skipped', recordedAt: iso(28) };
    void bad;
  });

  it('keeps the module law: vendor identity is metadata, never a kind', () => {
    // The environment kind vocabulary is vendor-neutral by construction.
    expectTypeOf<ExecutionEnvironmentKind>().not.toEqualTypeOf<string>();
    expect(EXECUTION_ENVIRONMENT_KINDS.join(',')).not.toMatch(/e2b|playwright|docker|livekit/i);
    expect(EXECUTION_ADAPTER_CAPABILITY_DOMAINS.join(',')).not.toMatch(/e2b|playwright|docker|livekit/i);
    expect(vendor.vendorName).toBe('fixture vendor');
    expectTypeOf<ExecutionAdapterVendorMetadata['vendorName']>().toEqualTypeOf<string>();
  });
});

// A local alias used by the @ts-expect-error assertions above (type-only).
type ContinuityHandoffSemanticsLiteral = ContinuityHandoff['semantics'];
