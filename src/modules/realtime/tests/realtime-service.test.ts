// Integration tests for the realtime module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W086
// acceptance:
// "start/stop session, consent/recording state, interruption handling,
//  speaker attribution, live transcript, spoken Aurum response, durable
//  meeting artifact; transport provider can be swapped without domain
//  rewrite."
//
//  * connections — creation, idempotent re-registration as the
//    re-authorization path, uniform cross-tenant not-found (ADR-0001),
//    disabled connections refusing active operations;
//  * session lifecycle — the durable-first start (a `requested` intent,
//    the room handle, Aurum's own participant), explicit failed starts
//    (no transport / transport refusal — queryable `failed` rows, never
//    silent gaps), the telephony SIP dial-out, and the meeting-session
//    reference validated READ-ONLY through the meetings contract (W085);
//  * consent/recording — the all-party consent floor: a refused start is
//    an explicit `recording.blocked` ledger event; grants land from BOTH
//    the domain op (companion UI) and the provider event (telephony
//    DTMF); a revocation while recording STOPS the recording; provider
//    recording stops capture the recording artifact (opaque refs);
//  * speaker attribution + live transcript — turns attributed to the
//    participant registry, the read-only verified-email identity bridge
//    (W002), unattributed speech, monotonic turn numbering;
//  * spoken Aurum response — speak → attributed turn + lifecycle row,
//    one-in-flight discipline, completion and INTERRUPTION (barge-in
//    with the interrupting participant attributed);
//  * durable meeting artifact — the W080 workflow: stop starts the
//    finalization run; pumping the engine with this module's bindings
//    materializes the transcript artifact through the object-storage
//    port (deterministic key, checksum) and records the session-close
//    observation (W004, lineage `direct`); a FRESH engine resumes;
//    re-stops are idempotent; `pumpRealtimeFinalization` recovers the
//    crash window;
//  * dedupe — provider event redelivery applies exactly once;
//  * auto-end — the last non-Aurum participant leaving ends the session
//    and finalizes; provider-side ends and failures are explicit;
//  * provider swap (GOVERNANCE evidence) — the same canonical journey
//    through livekit and openai-realtime yields identical canonical
//    domain state (same rows modulo provider key + opaque ids), and the
//    transport port observes only provider-neutral requests;
//  * tenant isolation — another tenant's connections/sessions are
//    indistinguishable from missing; foreign event envelopes resolve to
//    nothing;
//  * storage discipline — events/turns/artifacts are append-only,
//    participant and session identity is frozen, the room/evidence
//    links are one-way fills;
//  * credential hygiene — join grants (ephemeral credentials) never
//    reach any domain table.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
delete process.env.BLOB_READ_WRITE_TOKEN;

import * as realtimeContract from '../contract';
import {
  createWorkflowEngine,
  getRun,
  type WorkflowEnginePort,
} from '@/modules/workflow/contract';
import * as meetingsContract from '@/modules/meetings/contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { getObservation } from '@/modules/observations/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeBlobStore, getBlobStore } from '@/infra/blob';
import { closeDb, getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { RealtimeError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';
import type {
  RealtimeRecordingArtifactInfo,
  RealtimeSession,
  RealtimeTransport,
} from '../types';

const {
  createRealtimeJoinGrant,
  createRealtimeWorkflowBindings,
  dialRealtimeParticipant,
  getRealtimeConnection,
  listRealtimeArtifacts,
  listRealtimeConnections,
  listRealtimeEvents,
  listRealtimeParticipants,
  listRealtimeResponses,
  listRealtimeSessions,
  listRealtimeTurns,
  pumpRealtimeFinalization,
  receiveRealtimeEvent,
  recordRealtimeConsent,
  registerRealtimeConnection,
  setRealtimeConnectionStatus,
  setRealtimeTransport,
  speakRealtimeResponse,
  startRealtimeRecording,
  startRealtimeSession,
  stopRealtimeRecording,
  stopRealtimeSession,
} = realtimeContract;

const BASE_TIME = Date.parse('2026-09-25T10:00:00Z');
let clockMs = BASE_TIME;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantConnections = newId();
const tenantLifecycle = newId();
const tenantConsent = newId();
const tenantTranscript = newId();
const tenantSpeak = newId();
const tenantFinalize = newId();
const tenantPump = newId();
const tenantAutoEnd = newId();
const tenantSwap = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantDedupe = newId();
const tenantB = newId();

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function identityManager(tenantId: string): TenantContext {
  return member(tenantId, ['identity:attest', 'identity:link']);
}

async function expectCode(
  code: RealtimeError['code'],
  fn: () => Promise<unknown> | unknown,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected RealtimeError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof RealtimeError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** A join-grant token assembled from fragments at runtime (never a full literal in source). */
function ephemeralToken(): string {
  return ['grant', 'ephemeral', Math.random().toString(36).slice(2, 12)].join('_');
}

// ---------------------------------------------------------------------------
// The scripted transport (provider-neutral; records every request)
// ---------------------------------------------------------------------------

class ScriptedRealtimeTransport implements RealtimeTransport {
  readonly provider: 'livekit' | 'openai-realtime';
  readonly requests: string[] = [];
  private failsStartRoom = false;
  recordingArtifact: RealtimeRecordingArtifactInfo | null = null;

  constructor(provider: 'livekit' | 'openai-realtime' = 'livekit') {
    this.provider = provider;
  }

  makeStartFail(): void {
    this.failsStartRoom = true;
  }

  private note(call: string, request: { sessionId: string }): void {
    this.requests.push(`${call}:${request.sessionId}`);
  }

  async startRoom(request: Parameters<RealtimeTransport['startRoom']>[0]) {
    this.note('startRoom', request);
    if (this.failsStartRoom) throw new Error('provider room quota exceeded');
    return {
      providerRoomId: `room-${this.provider}-${request.sessionId}`,
      agentParticipantId: request.agentParticipantId,
    };
  }

  async stopRoom(request: Parameters<RealtimeTransport['stopRoom']>[0]) {
    this.note('stopRoom', request);
  }

  async speak(request: Parameters<RealtimeTransport['speak']>[0]) {
    this.note('speak', request);
  }

  async startRecording(request: Parameters<RealtimeTransport['startRecording']>[0]) {
    this.note('startRecording', request);
  }

  async stopRecording(request: Parameters<RealtimeTransport['stopRecording']>[0]) {
    this.note('stopRecording', request);
    return { artifact: this.recordingArtifact };
  }

  async dial(request: Parameters<RealtimeTransport['dial']>[0]) {
    this.note('dial', request);
    return { providerParticipantId: `sip-${request.phoneNumber.replace('+', '')}` };
  }

  async createJoinGrant(request: Parameters<RealtimeTransport['createJoinGrant']>[0]) {
    this.note('createJoinGrant', request);
    return {
      url: `wss://example.invalid/realtime/${request.sessionId}`,
      token: ephemeralToken(),
      expiresAt: new Date(clockMs + 300_000).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Envelope builders (the documented adapter shapes — see adapters/*.ts)
// ---------------------------------------------------------------------------

const LIVEKIT_ACCOUNT = 'lk-proj-1';

/** The livekit envelope bound to one session's room (the transport mints room-<provider>-<sessionId>). */
function livekit(
  roomId: string,
  type: string,
  eventId: string,
  overrides: Record<string, unknown> = {},
  occurredAt = '2026-09-25T10:00:00Z',
): unknown {
  return {
    type,
    event_id: eventId,
    occurredAt,
    account: { id: LIVEKIT_ACCOUNT },
    room: { id: roomId },
    ...overrides,
  };
}

const OPENAI_PROJECT = 'oai-proj-1';

function openai(roomId: string, type: string, eventId: string, data: Record<string, unknown> = {}): unknown {
  return {
    type,
    event_id: eventId,
    ts: '2026-09-25T10:00:00Z',
    project_id: OPENAI_PROJECT,
    room_id: roomId,
    data,
  };
}

/** The provider room of a session as the scripted transports mint it. */
function roomOf(session: { providerRoomId: string | null }): string {
  expect(session.providerRoomId).not.toBeNull();
  return session.providerRoomId!;
}

async function registerLivekit(
  tenantId: string,
  overrides: Partial<Parameters<typeof registerRealtimeConnection>[0]> = {},
): Promise<string> {
  const { connection } = await registerRealtimeConnection(member(tenantId), {
    provider: 'livekit',
    providerAccountId: LIVEKIT_ACCOUNT,
    authKind: 'api_key',
    credentialRef: 'secret-store:livekit/1',
    ...overrides,
  });
  return connection.id;
}

async function startVoiceSession(
  tenantId: string,
  connectionId: string,
  kind: RealtimeSession['kind'] = 'aurum_voice',
): Promise<RealtimeSession> {
  const { session } = await startRealtimeSession(member(tenantId), {
    connectionId,
    kind,
    title: 'Morning sync',
  });
  return session;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let transport: ScriptedRealtimeTransport;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setRealtimeTransport(null);
  closeBlobStore();
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  transport = new ScriptedRealtimeTransport();
  setRealtimeTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setRealtimeTransport(null);
});

/** Drives one finalization run to a terminal state through a fresh engine. */
async function driveFinalize(
  ctx: TenantContext,
  runId: string,
): Promise<{ status: string; steps: number }> {
  const engine: WorkflowEnginePort = createWorkflowEngine(createRealtimeWorkflowBindings());
  let pumps = 0;
  for (let i = 0; i < 24; i += 1) {
    const outcome = await engine.pump(ctx);
    pumps += outcome.status === 'idle' ? 0 : 1;
    const run = await getRun(ctx, { runId });
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return { status: run.status, steps: pumps };
    }
  }
  throw new Error('finalization run did not reach a terminal state in 24 pumps');
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

describe('realtime connections', () => {
  it('creates, re-authorizes and lists connections (idempotent registration)', async () => {
    const ctx = member(tenantConnections);
    const first = await registerRealtimeConnection(ctx, {
      provider: 'livekit',
      providerAccountId: '  lk-proj-1  ',
      authKind: 'api_key',
      credentialRef: 'secret-store:livekit/1',
      displayName: 'Main LiveKit project',
    });
    expect(first.created).toBe(true);
    expect(first.connection.providerAccountId).toBe('lk-proj-1');
    expect(first.connection.status).toBe('active');

    const second = await registerRealtimeConnection(ctx, {
      provider: 'livekit',
      providerAccountId: 'lk-proj-1',
      authKind: 'oauth',
      credentialRef: 'secret-store:livekit/2',
      oauthScopes: ['rooms:write'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(second.created).toBe(false);
    expect(second.connection.id).toBe(first.connection.id);
    expect(second.connection.authKind).toBe('oauth');
    // The identity never moved; the authorization did.
    expect(second.connection.providerAccountId).toBe('lk-proj-1');

    const listed = await listRealtimeConnections(ctx, { provider: 'livekit' });
    expect(listed).toHaveLength(1);

    // Cross-tenant ids are indistinguishable from missing ones.
    await expectCode('connection_not_found', () =>
      getRealtimeConnection(member(tenantB), first.connection.id),
    );
  });

  it('refuses active operations on disabled connections', async () => {
    const connectionId = await registerLivekit(tenantConnections);
    const disabled = await setRealtimeConnectionStatus(member(tenantConnections), {
      connectionId,
      status: 'disabled',
    });
    expect(disabled.status).toBe('disabled');
    await expectCode('connection_disabled', () =>
      startRealtimeSession(member(tenantConnections), {
        connectionId,
        kind: 'aurum_voice',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Session lifecycle (start/stop — the acceptance core)
// ---------------------------------------------------------------------------

describe('realtime session lifecycle', () => {
  it('starts a voice session durably: requested intent → live room → aurum participant', async () => {
    const connectionId = await registerLivekit(tenantLifecycle);
    const session = await startVoiceSession(tenantLifecycle, connectionId);
    expect(session.status).toBe('live');
    expect(session.kind).toBe('aurum_voice');
    expect(session.providerRoomId).toBe(`room-livekit-${session.id}`);
    expect(session.startedAt).not.toBeNull();
    expect(session.recordingState).toBe('off');

    // Aurum's own participant is registered for speaker attribution.
    const participants = await listRealtimeParticipants(member(tenantLifecycle), {
      sessionId: session.id,
    });
    expect(participants).toHaveLength(1);
    expect(participants[0]!.role).toBe('aurum');
    expect(participants[0]!.providerParticipantId).toBe(`aurum-agent-${session.id}`);

    // The transport saw only provider-neutral facets (opaque credential ref).
    expect(transport.requests[0]).toBe(`startRoom:${session.id}`);
  });

  it('fails explicitly when no transport is wired (queryable failed row)', async () => {
    const tenantId = newId();
    const connectionId = await registerLivekit(tenantId);
    setRealtimeTransport(null);
    await expectCode('provider_unavailable', () =>
      startRealtimeSession(member(tenantId), { connectionId, kind: 'aurum_voice' }),
    );
    const failed = await listRealtimeSessions(member(tenantId), { status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.errorCode).toBe('provider_unavailable');
  });

  it('fails explicitly when the transport refuses the room', async () => {
    const tenantId = newId();
    const connectionId = await registerLivekit(tenantId);
    transport.makeStartFail();
    await expectCode('transport_failed', () =>
      startRealtimeSession(member(tenantId), { connectionId, kind: 'aurum_voice' }),
    );
    const failed = await listRealtimeSessions(member(tenantId), { status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.errorCode).toBe('transport_failed');
    expect(failed[0]!.errorDetail).toContain('quota');
  });

  it('mints ephemeral join grants that never reach any domain table', async () => {
    const connectionId = await registerLivekit(tenantLifecycle);
    const session = await startVoiceSession(tenantLifecycle, connectionId);
    const grant = await createRealtimeJoinGrant(member(tenantLifecycle), {
      sessionId: session.id,
      displayName: 'Dana Owner',
    });
    expect(grant.url).toContain(session.id);
    expect(grant.token).toMatch(/^grant_ephemeral_/);

    // Credential hygiene: the token and URL appear in NO realtime table.
    const tables = [
      'realtime_connections',
      'realtime_sessions',
      'realtime_participants',
      'realtime_events',
      'realtime_turns',
      'realtime_responses',
      'realtime_artifacts',
    ];
    for (const table of tables) {
      const rows = (await getDb().query<DbRow>(`SELECT * FROM ${table}`)).rows;
      const serialized = JSON.stringify(rows);
      expect(serialized.includes(grant.token)).toBe(false);
      expect(serialized.includes(grant.url)).toBe(false);
    }
  });

  it('places a telephony SIP dial-out and registers the phone participant', async () => {
    const connectionId = await registerLivekit(tenantLifecycle);
    const { session } = await startRealtimeSession(member(tenantLifecycle), {
      connectionId,
      kind: 'telephony',
      dial: { phoneNumber: '+15551234567', displayName: 'Sarah Field' },
    });
    expect(session.status).toBe('live');
    expect(session.kind).toBe('telephony');
    const participants = await listRealtimeParticipants(member(tenantLifecycle), {
      sessionId: session.id,
      role: 'phone',
    });
    expect(participants).toHaveLength(1);
    expect(participants[0]!.phone).toBe('+15551234567');
    expect(participants[0]!.displayName).toBe('Sarah Field');

    // A phone participant can also be dialed into a live session.
    const dialed = await dialRealtimeParticipant(member(tenantLifecycle), {
      sessionId: session.id,
      phoneNumber: '+447700900123',
    });
    expect(dialed.role).toBe('phone');
    expect(dialed.phone).toBe('+447700900123');
  });

  it('validates the meeting-session reference read-only through the meetings contract', async () => {
    const ctx = member(tenantLifecycle);
    const connectionId = await registerLivekit(tenantLifecycle);

    // A canonical meeting session captured through the meetings gateway
    // (W085) in the SAME tenant is a legal reference.
    const { connection: zoom } = await meetingsContract.registerMeetingConnection(ctx, {
      provider: 'zoom',
      providerAccountId: 'zoom-acct-1',
      authKind: 'oauth',
      credentialRef: 'secret-store:zoom/1',
      oauthScopes: ['meeting:read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    void zoom;
    await meetingsContract.receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: {
        event: 'meeting.started',
        event_id: 'zm-1',
        occurredAt: '2026-09-25T09:00:00Z',
        account: { id: 'zoom-acct-1' },
        meeting: { id: 'mtg-9', title: 'Supplier review' },
        session: {
          id: 'occ-9',
          status: 'started',
          started_at: '2026-09-25T09:00:30Z',
          ended_at: null,
          participants: [
            { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test', joined_at: '2026-09-25T09:00:30Z', left_at: null },
          ],
        },
      },
    });
    const [meetingSession] = await meetingsContract.listMeetingSessions(ctx, {
      status: 'started',
    });
    expect(meetingSession).toBeDefined();

    const { session: companion } = await startRealtimeSession(ctx, {
      connectionId,
      kind: 'meeting_companion',
      meetingSessionId: meetingSession!.id,
      title: 'Supplier review — companion',
    });
    expect(companion.meetingSessionId).toBe(meetingSession!.id);
    // The meetings registry was NOT written to (read-only bridge).
    const after = await meetingsContract.listMeetingSessions(ctx, { status: 'started' });
    expect(after).toHaveLength(1);

    // A bogus reference is rejected before any session exists.
    await expectCode('invalid_realtime_input', () =>
      startRealtimeSession(ctx, {
        connectionId,
        kind: 'meeting_participation',
        meetingSessionId: newId(),
      }),
    );
    // Cross-tenant meeting references are indistinguishable from missing.
    const foreignConnectionId = await registerLivekit(tenantB);
    await expectCode('invalid_realtime_input', () =>
      startRealtimeSession(member(tenantB), {
        connectionId: foreignConnectionId,
        kind: 'meeting_participation',
        meetingSessionId: meetingSession!.id,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Consent + recording (the consent floor)
// ---------------------------------------------------------------------------

describe('consent and recording state', () => {
  async function prepared(tenantId: string): Promise<{ session: RealtimeSession }> {
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId, 'meeting_companion');
    await receiveRealtimeEvent(member(tenantId), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 'c-1', {
        participant: { identity: 'p-dana', name: 'Dana Owner', email: 'dana@acme.test', phone: null },
      }),
    });
    await receiveRealtimeEvent(member(tenantId), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 'c-2', {
        participant: { identity: 'sip:+15551234567', name: 'Sarah (mobile)', email: null, phone: '+15551234567' },
      }),
    });
    return { session };
  }

  it('refuses a recording without all-party consent and leaves an explicit blocked event', async () => {
    const { session } = await prepared(tenantConsent);
    await expectCode('consent_required', () =>
      startRealtimeRecording(member(tenantConsent), { sessionId: session.id }),
    );
    const blocked = await listRealtimeEvents(member(tenantConsent), {
      sessionId: session.id,
      kind: 'recording.blocked',
    });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.source).toBe('domain');
    expect(blocked[0]!.detail.unconsented).toEqual(
      expect.arrayContaining(['p-dana', 'sip:+15551234567']),
    );
  });

  it('grants consent from both paths (domain op and provider event) and records the trail', async () => {
    const { session } = await prepared(tenantConsent);
    const participants = await listRealtimeParticipants(member(tenantConsent), {
      sessionId: session.id,
    });
    const dana = participants.find((p) => p.providerParticipantId === 'p-dana')!;

    // Domain path (companion UI).
    const granted = await recordRealtimeConsent(member(tenantConsent), {
      sessionId: session.id,
      participantId: dana.id,
      consent: 'granted',
    });
    expect(granted.consent).toBe('granted');

    // Provider path (telephony DTMF consent).
    await receiveRealtimeEvent(member(tenantConsent), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'consent.granted', 'c-3', {
        participant: { identity: 'sip:+15551234567' },
      }),
    });

    const trail = await listRealtimeEvents(member(tenantConsent), { sessionId: session.id });
    expect(trail.filter((e) => e.kind === 'consent.granted')).toHaveLength(2);
    expect(
      trail.filter((e) => e.kind === 'consent.granted').map((e) => e.source).sort(),
    ).toEqual(['domain', 'provider']);

    // Aurum's own participant cannot consent.
    const aurum = participants.find((p) => p.role === 'aurum')!;
    await expectCode('invalid_realtime_input', () =>
      recordRealtimeConsent(member(tenantConsent), {
        sessionId: session.id,
        participantId: aurum.id,
        consent: 'granted',
      }),
    );
  });

  it('runs the recording only under full consent; revocation stops it', async () => {
    const { session } = await prepared(tenantConsent);
    const participants = await listRealtimeParticipants(member(tenantConsent), {
      sessionId: session.id,
    });
    for (const participant of participants.filter((p) => p.role !== 'aurum')) {
      if (participant.providerParticipantId === 'p-dana') {
        await recordRealtimeConsent(member(tenantConsent), {
          sessionId: session.id,
          participantId: participant.id,
          consent: 'granted',
        });
      } else {
        await receiveRealtimeEvent(member(tenantConsent), {
          provider: 'livekit',
          payload: livekit(roomOf(session), 'consent.granted', `c-${participant.id.slice(0, 4)}`, {
            participant: { identity: participant.providerParticipantId },
          }),
        });
      }
    }

    const recording = await startRealtimeRecording(member(tenantConsent), { sessionId: session.id });
    expect(recording.recordingState).toBe('recording');

    // A provider confirmation event is a no-op state-wise (already recording).
    await receiveRealtimeEvent(member(tenantConsent), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'egress.started', 'c-rec-1'),
    });
    const confirmed = await realtimeContract.getRealtimeSession(member(tenantConsent), session.id);
    expect(confirmed.recordingState).toBe('recording');

    // Revocation while recording STOPS the recording (the floor holds
    // continuously).
    await receiveRealtimeEvent(member(tenantConsent), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'consent.revoked', 'c-rev', {
        participant: { identity: 'p-dana' },
      }),
    });
    const after = await realtimeContract.getRealtimeSession(member(tenantConsent), session.id);
    expect(after.recordingState).toBe('recorded');
    const trail = await listRealtimeEvents(member(tenantConsent), { sessionId: session.id });
    expect(trail.filter((e) => e.kind === 'recording.stopped')).toHaveLength(1);
    expect(trail.filter((e) => e.kind === 'consent.revoked')).toHaveLength(1);
  });

  it('captures the provider recording artifact on stop (opaque references)', async () => {
    const { session } = await prepared(tenantConsent);
    const consented = (
      await listRealtimeParticipants(member(tenantConsent), { sessionId: session.id })
    ).filter((p) => p.role !== 'aurum');
    expect(consented.length).toBeGreaterThan(0);
    await recordRealtimeConsent(member(tenantConsent), {
      sessionId: session.id,
      participantId: consented[0]!.id,
      consent: 'granted',
    });
    // The phone participant never consented → leave first so the gate can pass.
    await receiveRealtimeEvent(member(tenantConsent), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.disconnected', 'c-left', {
        participant: { identity: 'sip:+15551234567' },
      }),
    });
    await startRealtimeRecording(member(tenantConsent), { sessionId: session.id });

    transport.recordingArtifact = {
      providerArtifactId: 'egress-rec-1',
      storageRef: 'provider://livekit/egress-rec-1',
      mediaType: 'audio/ogg',
      byteSize: 4096,
      checksum: 'sha256:cd',
    };
    const stopped = await stopRealtimeRecording(member(tenantConsent), { sessionId: session.id });
    expect(stopped.session.recordingState).toBe('recorded');
    expect(stopped.artifact).not.toBeNull();
    expect(stopped.artifact!.kind).toBe('recording');
    expect(stopped.artifact!.providerArtifactId).toBe('egress-rec-1');
    expect(stopped.artifact!.storageRef).toBe('provider://livekit/egress-rec-1');

    // Stopping again is explicit: nothing is running.
    await expectCode('recording_not_running', () =>
      stopRealtimeRecording(member(tenantConsent), { sessionId: session.id }),
    );
  });
});

// ---------------------------------------------------------------------------
// Speaker attribution + live transcript
// ---------------------------------------------------------------------------

describe('live transcript and speaker attribution', () => {
  it('records attributed and unattributed turns with monotonic numbering and provenance', async () => {
    const tenantId = tenantTranscript;
    const ctx = member(tenantId);
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId, 'meeting_companion');

    // A verified, subject-linked email identity resolves the speaker.
    const subjectId = newId();
    const { identity } = await registerExternalIdentity(ctx, {
      provider: 'email',
      providerAccountId: 'dana@acme.test',
    });
    const verified = await attestIdentity(identityManager(tenantId), {
      identityId: identity.id,
      evidence: 'HR confirmed account ownership',
    });
    await attachVerifiedSubject(identityManager(tenantId), {
      identityId: verified.id,
      subjectId,
    });

    // The join carries the email; the verified-email bridge resolves the
    // organizational person when the participant is captured on sight.
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 't-0', {
        participant: { identity: 'p-dana', name: 'Dana Owner', email: 'dana@acme.test', phone: null },
      }),
    });
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'transcript.finalized', 't-1', {
        participant: { identity: 'p-dana' },
        transcript: {
          participant_id: 'p-dana',
          speaker_name: 'Dana',
          started_at: '2026-09-25T10:01:00Z',
          ended_at: '2026-09-25T10:01:12Z',
          text: 'Welcome everyone.',
          confidence: 0.97,
        },
      }),
    });
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'transcript.finalized', 't-2', {
        transcript: {
          participant_id: null,
          speaker_name: 'Unknown speaker',
          started_at: '2026-09-25T10:01:20Z',
          ended_at: null,
          text: 'Sorry, connection dropped.',
          confidence: null,
        },
      }),
    });

    const turns = await listRealtimeTurns(ctx, { sessionId: session.id });
    expect(turns).toHaveLength(2);
    expect(turns.map((t) => t.turnNo)).toEqual([1, 2]);
    expect(turns[0]!).toMatchObject({
      kind: 'human_speech',
      text: 'Welcome everyone.',
      confidence: 0.97,
    });
    // Speaker attribution: registry id + resolved organizational person.
    expect(turns[0]!.speakerParticipantId).not.toBeNull();
    const speaker = (
      await listRealtimeParticipants(ctx, { sessionId: session.id })
    ).find((p) => p.id === turns[0]!.speakerParticipantId)!;
    expect(speaker.subjectId).toBe(subjectId);
    expect(speaker.resolvedVia).toBe('verified_email_identity');
    // Provenance: the turn links the canonical event that produced it.
    expect(turns[0]!.eventId).not.toBeNull();
    // Unattributed speech keeps a display label but no registry speaker.
    expect(turns[1]!.speakerParticipantId).toBeNull();
    expect(turns[1]!.speakerName).toBe('Unknown speaker');
  });
});

// ---------------------------------------------------------------------------
// Spoken Aurum responses + interruption
// ---------------------------------------------------------------------------

describe('spoken aurum responses and interruption handling', () => {
  async function prepared(tenantId: string): Promise<RealtimeSession> {
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId);
    await receiveRealtimeEvent(member(tenantId), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 's-0', {
        participant: { identity: 'p-dana', name: 'Dana Owner', email: null, phone: null },
      }),
    });
    await receiveRealtimeEvent(member(tenantId), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'transcript.finalized', 's-1', {
        participant: { identity: 'p-dana' },
        transcript: {
          participant_id: 'p-dana',
          speaker_name: 'Dana',
          started_at: '2026-09-25T10:01:00Z',
          ended_at: '2026-09-25T10:01:05Z',
          text: 'Aurum, what should we watch this week?',
          confidence: 0.95,
        },
      }),
    });
    return session;
  }

  it('speaks a response: attributed turn + lifecycle row, one in flight at a time', async () => {
    const session = await prepared(tenantSpeak);
    const [question] = await listRealtimeTurns(member(tenantSpeak), { sessionId: session.id });

    const response = await speakRealtimeResponse(member(tenantSpeak), {
      sessionId: session.id,
      text: 'The supplier contract renewal and the two open unknowns on delivery risk.',
      inReplyToTurnId: question!.id,
    });
    expect(response.status).toBe('speaking');
    expect(response.requestTurnId).toBe(question!.id);
    expect(response.turnId).not.toBeNull();

    const turns = await listRealtimeTurns(member(tenantSpeak), {
      sessionId: session.id,
      kind: 'aurum_response',
    });
    expect(turns).toHaveLength(1);
    expect(turns[0]!.text).toContain('supplier contract renewal');
    expect(turns[0]!.speakerName).toBe('Aurum');
    const aurum = (
      await listRealtimeParticipants(member(tenantSpeak), { sessionId: session.id })
    ).find((p) => p.role === 'aurum')!;
    expect(turns[0]!.speakerParticipantId).toBe(aurum.id);

    // One response in flight at a time.
    await expectCode('response_in_flight', () =>
      speakRealtimeResponse(member(tenantSpeak), { sessionId: session.id, text: 'Also…' }),
    );

    // Completion releases the next speak.
    await receiveRealtimeEvent(member(tenantSpeak), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'response.completed', 's-2', { response: { id: response.id } }),
    });
    const [completed] = await listRealtimeResponses(member(tenantSpeak), { sessionId: session.id });
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
    expect(completed!.completedAt).not.toBeNull();
    const next = await speakRealtimeResponse(member(tenantSpeak), {
      sessionId: session.id,
      text: 'Anything else?',
    });
    expect(next.status).toBe('speaking');
  });

  it('records barge-in: the interrupted response attributes the interrupter', async () => {
    const session = await prepared(tenantSpeak);
    const response = await speakRealtimeResponse(member(tenantSpeak), {
      sessionId: session.id,
      text: 'Let me walk through the full risk analysis, starting with…',
    });
    expect(response.status).toBe('speaking');

    // Barge-in: Dana cuts Aurum short; the interrupting participant is
    // attributed on the response lifecycle row.
    await receiveRealtimeEvent(member(tenantSpeak), {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'response.interrupted', 's-3', {
        response: { id: response.id, interrupted_by: 'p-dana' },
      }),
    });
    const [interrupted] = await listRealtimeResponses(member(tenantSpeak), {
      sessionId: session.id,
    });
    expect(interrupted).toBeDefined();
    expect(interrupted!.status).toBe('interrupted');
    expect(interrupted!.interruptedAt).not.toBeNull();
    expect(interrupted!.interruptedByParticipantId).not.toBeNull();
    const interrupter = (
      await listRealtimeParticipants(member(tenantSpeak), { sessionId: session.id })
    ).find((p) => p.id === interrupted!.interruptedByParticipantId)!;
    expect(interrupter.providerParticipantId).toBe('p-dana');

    // The interruption is in the trail; a new speak is allowed.
    const trail = await listRealtimeEvents(member(tenantSpeak), {
      sessionId: session.id,
      kind: 'response.interrupted',
    });
    expect(trail).toHaveLength(1);
    const after = await speakRealtimeResponse(member(tenantSpeak), {
      sessionId: session.id,
      text: 'Of course — go ahead.',
    });
    expect(after.status).toBe('speaking');
  });

  it('refuses an echo for an unknown response id (loud, not silent)', async () => {
    const session = await prepared(tenantSpeak);
    await expectCode('response_not_found', () =>
      receiveRealtimeEvent(member(tenantSpeak), {
        provider: 'livekit',
        payload: livekit(roomOf(session), 'response.completed', 's-x', { response: { id: newId() } }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Stop + durable finalization (the W080 workflow)
// ---------------------------------------------------------------------------

describe('stop and durable meeting artifact', () => {
  async function journey(tenantId: string): Promise<RealtimeSession> {
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId, 'meeting_companion');
    const ctx = member(tenantId);
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 'f-1', {
        participant: { identity: 'p-dana', name: 'Dana Owner', email: 'dana@acme.test', phone: null },
      }),
    });
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'transcript.finalized', 'f-2', {
        participant: { identity: 'p-dana' },
        transcript: {
          participant_id: 'p-dana',
          speaker_name: 'Dana',
          started_at: '2026-09-25T10:01:00Z',
          ended_at: null,
          text: 'Decision: switch suppliers in Q4.',
          confidence: 0.9,
        },
      }),
    });
    return session;
  }

  it('ends durably, then the workflow materializes the transcript artifact and the session-close observation', async () => {
    const session = await journey(tenantFinalize);
    const ctx = member(tenantFinalize);
    const stopped = await stopRealtimeSession(ctx, { sessionId: session.id });
    expect(stopped.session.status).toBe('ended');
    expect(stopped.session.endedReason).toBe('caller_stopped');
    expect(stopped.session.endedAt).not.toBeNull();
    expect(stopped.finalizeRunId).not.toBeNull();

    const outcome = await driveFinalize(ctx, stopped.finalizeRunId!);
    expect(outcome.status).toBe('succeeded');

    // The durable transcript artifact: blob URL, checksum, one row.
    const artifacts = await listRealtimeArtifacts(ctx, { sessionId: session.id });
    expect(artifacts).toHaveLength(1);
    const [artifact] = artifacts;
    expect(artifact!.kind).toBe('transcript');
    expect(artifact!.storageRef).toContain(`realtime/${tenantFinalize}/${session.id}/transcript.json`);
    expect(artifact!.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(artifact!.mediaType).toBe('application/json');
    expect(artifact!.byteSize).toBeGreaterThan(0);

    // The artifact content is the canonical session state.
    const bytes = await getBlobStore().get(artifact!.storageRef);
    expect(bytes).not.toBeNull();
    const document = JSON.parse(new TextDecoder().decode(bytes!)) as {
      schema: string;
      turns: { text: string }[];
      participants: { role: string }[];
    };
    expect(document.schema).toBe('aurum.realtime.transcript/1');
    expect(document.turns.map((t) => t.text)).toContain('Decision: switch suppliers in Q4.');
    expect(document.participants.some((p) => p.role === 'aurum')).toBe(true);

    // The session-close observation (W004) with direct lineage.
    const after = await realtimeContract.getRealtimeSession(ctx, session.id);
    expect(after.evidenceObservationId).not.toBeNull();
    expect(after.finalizePending).toBe(false);
    const observation = await getObservation(ctx, after.evidenceObservationId!);
    expect(observation.kind).toBe('realtime.session');
    expect(observation.channel).toBe('livekit');
    expect(observation.lineage.method).toBe('direct');
    const payload = observation.payload as { turnCount: number; artifacts: { id: string }[] };
    expect(payload.turnCount).toBe(1);
    expect(payload.artifacts[0]!.id).toBe(artifact!.id);

    // The explicit caller-stop trail.
    const trail = await listRealtimeEvents(ctx, { sessionId: session.id, kind: 'session.ended' });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.source).toBe('domain');
    expect(trail[0]!.detail.reason).toBe('caller_stopped');
  });

  it('re-stops idempotently and resumes finalization through a FRESH engine (kill/restart)', async () => {
    const session = await journey(tenantFinalize);
    const ctx = member(tenantFinalize);
    const first = await stopRealtimeSession(ctx, { sessionId: session.id });

    // A crash before the run was driven: the run exists durably; a FRESH
    // engine (new bindings object, same database) resumes it — the W080
    // acceptance property applied to the durable meeting artifact.
    const outcome = await driveFinalize(ctx, first.finalizeRunId!);
    expect(outcome.status).toBe('succeeded');

    // Re-stopping replays the same run (idempotent) and changes nothing.
    const second = await stopRealtimeSession(ctx, { sessionId: session.id });
    expect(second.session.status).toBe('ended');
    expect(second.finalizeRunId).toBe(first.finalizeRunId);
    const artifacts = await listRealtimeArtifacts(ctx, { sessionId: session.id });
    expect(artifacts).toHaveLength(1);
  });

  it('stops a running recording on the way out and reports the provider room teardown', async () => {
    const connectionId = await registerLivekit(tenantFinalize);
    const session = await startVoiceSession(tenantFinalize, connectionId, 'meeting_companion');
    const ctx = member(tenantFinalize);
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 'f-3', {
        participant: { identity: 'p-dana', name: 'Dana', email: null, phone: null },
      }),
    });
    const consented = (
      await listRealtimeParticipants(ctx, { sessionId: session.id })
    ).filter((p) => p.role !== 'aurum');
    expect(consented.length).toBeGreaterThan(0);
    await recordRealtimeConsent(ctx, {
      sessionId: session.id,
      participantId: consented[0]!.id,
      consent: 'granted',
    });
    await startRealtimeRecording(ctx, { sessionId: session.id });

    const stopped = await stopRealtimeSession(ctx, { sessionId: session.id });
    expect(stopped.session.status).toBe('ended');
    expect(stopped.session.recordingState).toBe('recorded');
    expect(transport.requests).toContain(`stopRecording:${session.id}`);
    expect(transport.requests).toContain(`stopRoom:${session.id}`);
  });
});

// ---------------------------------------------------------------------------
// The finalization recovery pump
// ---------------------------------------------------------------------------

describe('pumpRealtimeFinalization (the W080 recovery seam)', () => {
  it('is idle when nothing is pending', async () => {
    const outcome = await pumpRealtimeFinalization(member(tenantPump));
    expect(outcome.status).toBe('idle');
  });

  it('recovers the crash window between a terminal transition and its run', async () => {
    const tenantId = tenantPump;
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId);
    const ctx = member(tenantId);

    // Simulate the crash window honestly: the session ended durably, but
    // the finalization run was never started (craft the durable state
    // directly — the workflow resumption-test discipline).
    await getDb().query(
      `UPDATE realtime_sessions SET
           status = 'ended', ended_reason = 'provider_ended',
           finalize_pending = true, ended_at = $3, updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
      [tenantId, session.id, new Date()],
    );

    const outcome = await pumpRealtimeFinalization(ctx);
    expect(outcome.status).toBe('ensured');
    expect(outcome.sessionId).toBe(session.id);
    expect(outcome.runId).not.toBeNull();

    // The run completes through a fresh engine; the artifact exists.
    const driven = await driveFinalize(ctx, outcome.runId!);
    expect(driven.status).toBe('succeeded');
    const artifacts = await listRealtimeArtifacts(ctx, { sessionId: session.id });
    expect(artifacts).toHaveLength(1);

    // Nothing further is pending.
    const idle = await pumpRealtimeFinalization(ctx);
    expect(idle.status).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// Provider-side ends, failures and dedupe
// ---------------------------------------------------------------------------

describe('provider-side lifecycle and dedupe', () => {
  it('ends the session on the provider room-finished event and finalizes', async () => {
    const tenantId = tenantAutoEnd;
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId);
    const ctx = member(tenantId);
    const result = await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'room.finished', 'end-1', { end: { reason: 'finished' } }),
    });
    expect(result.applied).toBe(1);
    const after = await realtimeContract.getRealtimeSession(ctx, session.id);
    expect(after.status).toBe('ended');
    expect(after.endedReason).toBe('provider_ended');
    expect(after.finalizeRunId).not.toBeNull();
  });

  it('fails the session explicitly on a provider failure event and finalizes', async () => {
    const tenantId = tenantAutoEnd;
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId);
    const ctx = member(tenantId);
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'agent.failed', 'fail-1', {
        failure: { code: 'agent_disconnected', detail: 'agent worker died' },
      }),
    });
    const after = await realtimeContract.getRealtimeSession(ctx, session.id);
    expect(after.status).toBe('failed');
    expect(after.errorCode).toBe('agent_disconnected');
    expect(after.finalizeRunId).not.toBeNull();
  });

  it('auto-ends when the last non-aurum participant leaves', async () => {
    const tenantId = tenantAutoEnd;
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId, 'aurum_voice');
    const ctx = member(tenantId);
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.connected', 'ae-1', {
        participant: { identity: 'p-dana', name: 'Dana', email: null, phone: null },
      }),
    });
    // Still live while Dana is in the room.
    expect((await realtimeContract.getRealtimeSession(ctx, session.id)).status).toBe('live');
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'participant.disconnected', 'ae-2', {
        participant: { identity: 'p-dana' },
      }),
    });
    const after = await realtimeContract.getRealtimeSession(ctx, session.id);
    expect(after.status).toBe('ended');
    expect(after.endedReason).toBe('last_participant_left');
    expect(after.finalizeRunId).not.toBeNull();
    const trail = await listRealtimeEvents(ctx, { sessionId: session.id, kind: 'session.ended' });
    expect(trail.some((e) => e.detail.reason === 'last_participant_left')).toBe(true);
  });

  it('applies a redelivered envelope exactly once (dedupe)', async () => {
    const tenantId = tenantDedupe;
    const connectionId = await registerLivekit(tenantId);
    const session = await startVoiceSession(tenantId, connectionId);
    const ctx = member(tenantId);
    const envelope = livekit(roomOf(session), 'transcript.finalized', 'dup-1', {
      transcript: {
        participant_id: null,
        speaker_name: 'Dana',
        started_at: '2026-09-25T10:02:00Z',
        ended_at: null,
        text: 'Said once.',
        confidence: null,
      },
    });
    const first = await receiveRealtimeEvent(ctx, { provider: 'livekit', payload: envelope });
    expect(first).toMatchObject({ received: 1, applied: 1, duplicates: 0 });
    const second = await receiveRealtimeEvent(ctx, { provider: 'livekit', payload: envelope });
    expect(second).toMatchObject({ received: 1, applied: 0, duplicates: 1 });
    const turns = await listRealtimeTurns(ctx, { sessionId: session.id });
    expect(turns).toHaveLength(1);
  });

  it('resolves envelopes through the tenant connection (no cross-tenant leak)', async () => {
    const tenantId = tenantDedupe;
    await registerLivekit(tenantId);
    const [connection] = await listRealtimeConnections(member(tenantId), {});
    const session = await startVoiceSession(tenantId, connection!.id);
    // An account the foreign tenant never registered resolves to nothing.
    await expectCode('connection_not_found', () =>
      receiveRealtimeEvent(member(tenantB), {
        provider: 'livekit',
        payload: {
          type: 'room.started',
          event_id: 'iso-1',
          occurredAt: '2026-09-25T10:00:00Z',
          account: { id: 'account-never-registered' },
          room: { id: 'room-unknown' },
        },
      }),
    );
    // A foreign room on a registered account is indistinguishable from
    // missing (no existence leak).
    await expectCode('session_not_found', () =>
      receiveRealtimeEvent(member(tenantB), {
        provider: 'livekit',
        payload: livekit(roomOf(session), 'room.started', 'iso-2'),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Provider swap (GOVERNANCE provider-swap evidence)
// ---------------------------------------------------------------------------

describe('provider swap evidence (livekit → openai-realtime)', () => {
  it('the same canonical journey through both providers yields identical canonical domain state', async () => {
    const journeys: RealtimeSession[] = [];
    const transportsUsed: ScriptedRealtimeTransport[] = [];
    for (const provider of ['livekit', 'openai-realtime'] as const) {
      const tenantId = tenantSwap;
      const localTransport = new ScriptedRealtimeTransport(provider);
      transportsUsed.push(localTransport);
      setRealtimeTransport(localTransport);
      const { connection } = await registerRealtimeConnection(member(tenantId), {
        provider,
        providerAccountId: provider === 'livekit' ? LIVEKIT_ACCOUNT : OPENAI_PROJECT,
        authKind: 'api_key',
        credentialRef: `secret-store:${provider}/1`,
      });
      const { session } = await startRealtimeSession(member(tenantId), {
        connectionId: connection.id,
        kind: 'aurum_voice',
        title: 'Swap journey',
      });
      const ctx = member(tenantId);

      if (provider === 'livekit') {
        await receiveRealtimeEvent(ctx, {
          provider,
          payload: livekit(roomOf(session), 'participant.connected', 'sw-1', {
            participant: { identity: 'p-1', name: 'Dana', email: null, phone: null },
          }),
        });
        await receiveRealtimeEvent(ctx, {
          provider,
          payload: livekit(roomOf(session), 'transcript.finalized', 'sw-2', {
            transcript: {
              participant_id: 'p-1',
              speaker_name: 'Dana',
              started_at: '2026-09-25T10:01:00Z',
              ended_at: null,
              text: 'Swap check.',
              confidence: 0.9,
            },
          }),
        });
      } else {
        await receiveRealtimeEvent(ctx, {
          provider,
          payload: openai(roomOf(session), 'participant.joined', 'sw-1', {
            participant_id: 'p-1',
            display_name: 'Dana',
          }),
        });
        await receiveRealtimeEvent(ctx, {
          provider,
          payload: openai(roomOf(session), 'conversation.item.input_transcribed', 'sw-2', {
            participant_id: 'p-1',
            text: 'Swap check.',
            confidence: 0.9,
          }),
        });
      }

      const response = await speakRealtimeResponse(ctx, {
        sessionId: session.id,
        text: 'Swap check acknowledged.',
      });
      if (provider === 'livekit') {
        await receiveRealtimeEvent(ctx, {
          provider,
          payload: livekit(roomOf(session), 'response.completed', 'sw-3', { response: { id: response.id } }),
        });
      } else {
        await receiveRealtimeEvent(ctx, {
          provider,
          payload: openai(roomOf(session), 'response.done', 'sw-3', { response_id: response.id }),
        });
      }
      journeys.push(session);
    }

    // The canonical domain state is structurally identical: same session
    // shape, participant roles, turn kinds/order, response statuses —
    // only the provider key and provider-minted opaque ids differ.
    const [viaLivekit, viaOpenai] = journeys;
    const lk = member(tenantSwap);
    const [lkSession, oaSession] = await Promise.all([
      realtimeContract.getRealtimeSession(lk, viaLivekit!.id),
      realtimeContract.getRealtimeSession(lk, viaOpenai!.id),
    ]);
    expect(lkSession.provider).toBe('livekit');
    expect(oaSession.provider).toBe('openai-realtime');
    const shape = (s: RealtimeSession) => ({
      ...s,
      // Provider-minted / caller-minted opaque values are not structural;
      // the provider KEY itself is the one deliberate difference.
      id: null,
      provider: null,
      providerRoomId: null,
      connectionId: null,
      createdBy: null,
      createdAt: null,
      updatedAt: null,
    });
    expect(shape(lkSession)).toEqual(shape(oaSession));

    for (const session of [lkSession, oaSession]) {
      const participants = await listRealtimeParticipants(lk, { sessionId: session.id });
      expect(participants.map((p) => p.role).sort()).toEqual(['aurum', 'human']);
      const turns = await listRealtimeTurns(lk, { sessionId: session.id });
      expect(turns.map((t) => t.kind)).toEqual(['human_speech', 'aurum_response']);
      expect(turns.map((t) => t.text)).toEqual(['Swap check.', 'Swap check acknowledged.']);
      const responses = await listRealtimeResponses(lk, { sessionId: session.id });
      expect(responses.map((r) => r.status)).toEqual(['completed']);
    }

    // Both transports observed only provider-neutral request facets (the
    // port carries opaque credential refs and neutral kinds — never a
    // provider object).
    expect(transportsUsed[0]!.requests.length).toBeGreaterThan(0);
    expect(transportsUsed[1]!.requests.length).toBeGreaterThan(0);
    for (const used of transportsUsed) {
      expect(used.requests.every((entry) => !entry.includes('undefined'))).toBe(true);
    }
  });

  it('swaps the wired transport without touching domain state (hot swap)', async () => {
    const tenantId = tenantSwap;
    const { connection } = await registerRealtimeConnection(member(tenantId), {
      provider: 'openai-realtime',
      providerAccountId: OPENAI_PROJECT,
      authKind: 'api_key',
      credentialRef: 'secret-store:openai/2',
    });
    // Wire a DIFFERENT transport instance for the same provider: the
    // domain sees only the port.
    const second = new ScriptedRealtimeTransport('openai-realtime');
    setRealtimeTransport(second);
    const { session } = await startRealtimeSession(member(tenantId), {
      connectionId: connection.id,
      kind: 'aurum_voice',
    });
    expect(session.providerRoomId).toBe(`room-openai-realtime-${session.id}`);
    expect(second.requests).toContain(`startRoom:${session.id}`);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it("renders another tenant's realtime state indistinguishable from missing", async () => {
    const connectionId = await registerLivekit(tenantIsolation);
    const session = await startVoiceSession(tenantIsolation, connectionId);
    const ctxA = member(tenantIsolation);
    await receiveRealtimeEvent(ctxA, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'transcript.finalized', 'iso-2', {
        transcript: {
          participant_id: null,
          speaker_name: 'Dana',
          started_at: '2026-09-25T10:01:00Z',
          ended_at: null,
          text: 'Tenant A content.',
          confidence: null,
        },
      }),
    });
    const ctxB = member(tenantB);
    await expectCode('session_not_found', () =>
      realtimeContract.getRealtimeSession(ctxB, session.id),
    );
    expect(await listRealtimeSessions(ctxB, { limit: 500 })).toHaveLength(0);
    await expectCode('session_not_found', () =>
      listRealtimeTurns(ctxB, { sessionId: session.id }));
    await expectCode('session_not_found', () =>
      listRealtimeEvents(ctxB, { sessionId: session.id }));
    await expectCode('session_not_found', () =>
      listRealtimeArtifacts(ctxB, { sessionId: session.id }));
    await expectCode('session_not_found', () =>
      listRealtimeResponses(ctxB, { sessionId: session.id }));
    await expectCode('session_not_found', () =>
      recordRealtimeConsent(ctxB, { sessionId: session.id, participantId: newId(), consent: 'granted' }),
    );
    await expectCode('session_not_found', () =>
      stopRealtimeSession(ctxB, { sessionId: session.id }),
    );
    // The pump is tenant-scoped too.
    expect((await pumpRealtimeFinalization(ctxB)).status).toBe('idle');
    // And tenant A still sees everything.
    expect((await listRealtimeTurns(ctxA, { sessionId: session.id })).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('keeps events, turns and artifacts append-only (UPDATE/DELETE/TRUNCATE rejected)', async () => {
    const connectionId = await registerLivekit(tenantStorage);
    const session = await startVoiceSession(tenantStorage, connectionId);
    const ctx = member(tenantStorage);
    await receiveRealtimeEvent(ctx, {
      provider: 'livekit',
      payload: livekit(roomOf(session), 'transcript.finalized', 'st-1', {
        transcript: {
          participant_id: null,
          speaker_name: 'Dana',
          started_at: '2026-09-25T10:01:00Z',
          ended_at: null,
          text: 'Immutable.',
          confidence: null,
        },
      }),
    });
    const [turn] = await listRealtimeTurns(ctx, { sessionId: session.id });
    const [event] = await listRealtimeEvents(ctx, { sessionId: session.id });
    for (const statement of [
      `UPDATE realtime_turns SET text = 'tampered' WHERE id = '${turn!.id}'`,
      `DELETE FROM realtime_turns WHERE id = '${turn!.id}'`,
      `UPDATE realtime_events SET detail = '{}' WHERE id = '${event!.id}'`,
      `DELETE FROM realtime_events WHERE id = '${event!.id}'`,
      `UPDATE realtime_artifacts SET storage_ref = 'x'`,
      `DELETE FROM realtime_artifacts`,
    ]) {
      await expect(getDb().query(statement)).rejects.toThrow();
    }
  });

  it('freezes session and participant identity; room/evidence links are one-way', async () => {
    const connectionId = await registerLivekit(tenantStorage);
    const session = await startVoiceSession(tenantStorage, connectionId);
    await expect(
      getDb().query(`UPDATE realtime_sessions SET kind = 'telephony' WHERE id = $1`, [session.id]),
    ).rejects.toThrow();
    await expect(
      getDb().query(`UPDATE realtime_sessions SET meeting_session_id = $2 WHERE id = $1`, [
        session.id,
        newId(),
      ]),
    ).rejects.toThrow();
    // Provider room id is a one-way fill: set once, then frozen.
    await getDb().query(
      `UPDATE realtime_sessions SET provider_room_id = $2 WHERE id = $1 AND provider_room_id IS NULL`,
      [session.id, 'room-manual'],
    );
    await expect(
      getDb().query(`UPDATE realtime_sessions SET provider_room_id = $2 WHERE id = $1`, [
        session.id,
        'room-other',
      ]),
    ).rejects.toThrow();
    const participants = await listRealtimeParticipants(member(tenantStorage), {
      sessionId: session.id,
    });
    await expect(
      getDb().query(`UPDATE realtime_participants SET role = 'phone' WHERE id = $1`, [
        participants[0]!.id,
      ]),
    ).rejects.toThrow();
    await expect(
      getDb().query(`DELETE FROM realtime_participants WHERE id = $1`, [participants[0]!.id]),
    ).rejects.toThrow();
  });
});
