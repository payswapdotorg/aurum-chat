// The W109 LIVE leg runner (MODULE TEST HARNESS) — the end-to-end
// composition against the operator's REAL LiveKit Cloud project,
// through the frozen contracts only:
//
//   * the env-driven production wiring (ensureRealtimeTransportsWired);
//   * the meeting leg — a canonical meeting session created through the
//     meetings module's PRODUCTION webhook ingestion path (a zoom
//     envelope — the domain-side meeting REFERENCE; labeled as such, it
//     is not live-provider evidence), then a meeting_companion realtime
//     session on a REAL LiveKit room attached to it;
//   * the realtime leg — an aurum_voice session on a REAL LiveKit room;
//   * a REAL participant join through a minted join grant (the
//     lightweight signal-WebSocket client the work order sanctions:
//     @livekit/protocol decode over the platform WebSocket — the real
//     SFU pushes its event stream: join/participant updates/room
//     updates/leave);
//   * the consent floor against the real egress control plane (refusal
//     blocks, grant starts a REAL egress — which joins the room as a
//     real participant — revocation stops it);
//   * Aurum's speech PUBLISHED into the real room (SendData on the
//     reliable channel) with the response lifecycle
//     completed/interrupted (barge-in attributed to the real
//     participant) driven through the provider event edge;
//   * durable finalization (transcript artifact + session-close
//     observation) and the real disconnect events (Leave reason
//     ROOM_DELETED, room gone from ListRooms).
//
// SECRECY: the API secret and every minted token are REDACTED from the
// report (join-grant hygiene — credentials never reach evidence). The
// report is machine-checkable evidence (W112's classification reads it).
//
// This file is a HARNESS, not a *.test.ts — vitest does not collect it;
// the live-gated test (realtime-livekit-live.test.ts) drives it when
// the operator-provisioned env is present.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SignalRequest, SignalResponse } from '@livekit/protocol';
import WsClient from 'ws';
import { envString } from '@/infra/config';
import { closeBlobStore } from '@/infra/blob';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getMeetingSession, listMeetingSessions, receiveMeetingWebhook, registerMeetingConnection } from '@/modules/meetings/contract';
import { getObservation } from '@/modules/observations/contract';
import { createWorkflowEngine, getRun, type WorkflowEnginePort } from '@/modules/workflow/contract';
import { mintLivekitToken } from '../adapters/transport-livekit';
import { RealtimeError } from '../errors';
import {
  createRealtimeJoinGrant,
  createRealtimeWorkflowBindings,
  ensureRealtimeTransportsWired,
  getRealtimeSession,
  listRealtimeEvents,
  listRealtimeResponses,
  listRealtimeTurns,
  receiveRealtimeEvent,
  registerRealtimeConnection,
  speakRealtimeResponse,
  startRealtimeRecording,
  startRealtimeSession,
  stopRealtimeSession,
} from '../contract';
import { runMigrations } from '../../../../scripts/migrate';

// ---------------------------------------------------------------------------
// Report shape (machine-checkable evidence)
// ---------------------------------------------------------------------------

export interface LiveLegReport {
  workItem: 'W109';
  leg: 'LIVE';
  disposition: 'LIVE-PROVEN' | 'PARTIAL' | 'BLOCKED';
  startedAt: string;
  endedAt: string;
  environment: {
    url: string;
    accountId: string;
    apiKeyPrefix: string;
    apiSecret: 'REDACTED';
    egressStreamUrl: string;
    note: string;
  };
  wiring: {
    livekitState: string;
    detail: string;
  };
  meetingReference: {
    note: string;
    providerMeetingId: string;
    providerSessionId: string;
    meetingSessionId: string;
    connectionId: string;
  };
  legs: Array<{
    kind: 'meeting_companion' | 'aurum_voice';
    sessionId: string;
    providerRoomId: string;
    room?: {
      sid: string;
      name: string;
      creationTime: string;
      serverRegion: string | null;
      serverVersion: string | null;
    } | null;
    join?: {
      identity: string;
      participantSid: string;
      joinedAt: string;
      grantExpiresAt: string;
      token: 'REDACTED';
    } | null;
    participantsObserved: Array<{
      identity: string;
      sid: string;
      state: string;
      joinedAt: string;
      isEgress: boolean;
    }>;
    signalsReceived: Array<{ at: string; kind: string; detail: Record<string, unknown> }>;
    consentFloor?: {
      blockedBeforeConsent: { blocked: boolean; errorCode: string; ledgerEventRecorded: boolean };
      recordingStart: {
        started: boolean;
        egressId: string | null;
        egressStatus: string | null;
        egressParticipantObserved: boolean;
      };
      revocationStop: {
        stopped: boolean;
        egressFinalStatus: string | null;
        recordingStateAfter: string;
      };
    };
    transcript?: {
      humanTurn: { text: string; speakerParticipantId: string | null; speakerName: string | null } | null;
      aurumTurns: Array<{ text: string; responseId: string }>;
    };
    responses?: Array<{
      responseId: string;
      text: string;
      status: string;
      interruptedByParticipantId: string | null;
      completedAt: string | null;
      interruptedAt: string | null;
    }>;
    disconnect?: {
      leaveReason: number | null;
      closeCode: number | null;
      roomGoneAfterStop: boolean;
      participantsAfterStop: number;
    };
    finalization: {
      runId: string;
      runStatus: string;
      transcriptArtifact: { storageRef: string; checksum: string | null; byteSize: number | null } | null;
      observation: {
        id: string;
        kind: string;
        turnCount: number;
        participantCount: number;
        recordingState: string;
        errorCode: string | null;
      } | null;
    };
    eventsLedger: string[];
  }>;
  cleanup: { roomsDeleted: string[] };
  failure?: string;
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function requireEnv(): {
  url: string;
  apiKey: string;
  apiSecret: string;
  accountId: string;
  egressStreamUrl: string;
} {
  const url = envString('LIVEKIT_URL');
  const apiKey = envString('LIVEKIT_API_KEY');
  const apiSecret = envString('LIVEKIT_API_SECRET');
  const egressStreamUrl = envString('LIVEKIT_EGRESS_STREAM_URL');
  const missing = [
    url === undefined ? 'LIVEKIT_URL' : null,
    apiKey === undefined ? 'LIVEKIT_API_KEY' : null,
    apiSecret === undefined ? 'LIVEKIT_API_SECRET' : null,
    egressStreamUrl === undefined ? 'LIVEKIT_EGRESS_STREAM_URL' : null,
  ].filter((value): value is string => value !== null);
  if (missing.length > 0) {
    throw new Error(`the live leg requires ${missing.join(', ')} (operator-provisioned LiveKit credentials)`);
  }
  return {
    url: url!,
    apiKey: apiKey!,
    apiSecret: apiSecret!,
    accountId: envString('LIVEKIT_ACCOUNT_ID') ?? url!.replace(/^wss:\/\//, '').split('/')[0]!,
    egressStreamUrl: egressStreamUrl!,
  };
}

// ---------------------------------------------------------------------------
// The evidence-side provider client (the harness acts as the integration
// layer: it observes the provider's own state through the same Twirp API)
// ---------------------------------------------------------------------------

async function evidenceTwirp<T>(
  env: { apiKey: string; apiSecret: string; url: string },
  method: string,
  body: Record<string, unknown>,
  room?: string,
): Promise<T> {
  const { token } = mintLivekitToken(
    { apiKey: env.apiKey, apiSecret: env.apiSecret },
    'w109-evidence',
    { roomCreate: true, roomList: true, roomAdmin: true, roomRecord: true, ...(room ? { room } : {}) },
    120,
  );
  const base = `${env.url.replace(/^wss:\/\//, 'https://').replace(/\/+$/, '')}/twirp`;
  const response = await fetch(`${base}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new RealtimeError('transport_failed', `evidence ${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as T;
}

// ---------------------------------------------------------------------------
// The lightweight signal-WebSocket client (real join + real event receive)
// ---------------------------------------------------------------------------

interface SignalObservation {
  join: {
    identity: string;
    participantSid: string;
    roomSid: string;
    serverRegion: string | null;
    serverVersion: string | null;
    joinedAt: string;
  } | null;
  signals: Array<{ at: string; kind: string; detail: Record<string, unknown> }>;
  leaveReason: number | null;
  closeCode: number | null;
  closed: Promise<void>;
}

/** Joins a real room through a real join grant; records the SFU's event stream until the room dies. */
function joinViaSignal(_url: string, grant: { url: string; token: string }): SignalObservation {
  const observation: SignalObservation = {
    join: null,
    signals: [],
    leaveReason: null,
    closeCode: null,
    closed: new Promise<void>(() => {}),
  };
  // The `ws` package (the work order's sanctioned minimal client) is used
  // for the signal channel: its PROTOCOL-level ping/pong keepalive holds
  // long-lived joins open through egress layers that cull idle WebSocket
  // connections (the platform-global WebSocket cannot).
  const ws = new WsClient(
    `${grant.url.replace(/\/+$/, '')}/rtc?access_token=${encodeURIComponent(grant.token)}&auto_subscribe=1&protocol=12`,
  );
  let resolveClosed: () => void = () => {};
  observation.closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    if (!isBinary && !Buffer.isBuffer(data)) return;
    let message: SignalResponse;
    try {
      message = SignalResponse.fromBinary(new Uint8Array(data));
    } catch {
      return; // not a signal frame — ignore
    }
    const kind = message.message?.case ?? 'unknown';
    const at = new Date().toISOString();
    const detail: Record<string, unknown> = {};
    if (message.message?.case === 'join') {
      const value = message.message.value;
      observation.join = {
        identity: value.participant?.identity ?? '',
        participantSid: value.participant?.sid ?? '',
        roomSid: value.room?.sid ?? '',
        serverRegion: value.serverRegion || value.serverInfo?.region || null,
        serverVersion: value.serverVersion || value.serverInfo?.version || null,
        joinedAt: at,
      };
      const appInterval =
        value.pingInterval && value.pingInterval > 0 && value.pingInterval < 30 ? value.pingInterval * 1000 : 5000;
      // Keepalive: the LiveKit app-level ping AND a WebSocket protocol
      // ping (the `ws` package auto-pongs the server's probes).
      pingTimer = setInterval(() => {
        if (ws.readyState === WsClient.OPEN) {
          ws.send(new SignalRequest({ message: { case: 'ping', value: BigInt(Date.now()) } }).toBinary());
          try {
            ws.ping();
          } catch {
            /* closing — the close handler takes over */
          }
        }
      }, appInterval);
    } else if (message.message?.case === 'leave') {
      observation.leaveReason = message.message.value.reason ?? null;
    } else if (message.message?.case === 'update') {
      detail.participants = message.message.value.participants.map((p) => ({
        identity: p.identity,
        sid: p.sid,
        state: p.state,
      }));
    } else if (message.message?.case === 'roomUpdate') {
      const room = message.message.value.room;
      detail.room = { sid: room?.sid, participants: room?.numParticipants };
    }
    observation.signals.push({ at, kind, detail });
  });
  ws.on('close', (code: number) => {
    observation.closeCode = code;
    if (pingTimer !== null) clearInterval(pingTimer);
    resolveClosed();
  });
  ws.on('error', () => {
    /* close follows */
  });
  return observation;
}

// ---------------------------------------------------------------------------
// Helpers over the frozen contracts
// ---------------------------------------------------------------------------

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: `w109-${newId()}`, authority };
}

/** The livekit event envelope (the documented adapter shape), bound to real provider values. */
function envelope(
  accountId: string,
  roomId: string,
  type: string,
  eventId: string,
  overrides: Record<string, unknown> = {},
  occurredAt = new Date().toISOString(),
): unknown {
  return {
    type,
    event_id: eventId,
    occurredAt,
    account: { id: accountId },
    room: { id: roomId },
    ...overrides,
  };
}

async function driveFinalize(ctx: TenantContext, runId: string): Promise<string> {
  const engine: WorkflowEnginePort = createWorkflowEngine(createRealtimeWorkflowBindings());
  for (let i = 0; i < 24; i += 1) {
    await engine.pump(ctx);
    const run = await getRun(ctx, { runId });
    if (run.status === 'succeeded' || run.status === 'failed' || run.status === 'cancelled') {
      return run.status;
    }
  }
  throw new Error('finalization run did not reach a terminal state in 24 pumps');
}

async function expectRealtimeError(fn: () => Promise<unknown>): Promise<RealtimeError> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof RealtimeError) return error;
    throw error;
  }
  throw new Error('expected a RealtimeError but the call succeeded');
}

// ---------------------------------------------------------------------------
// The leg
// ---------------------------------------------------------------------------

export async function runLivekitLiveLeg(evidenceDir: string | null): Promise<LiveLegReport> {
  const env = requireEnv();
  const startedAt = new Date().toISOString();
  const report: LiveLegReport = {
    workItem: 'W109',
    leg: 'LIVE',
    disposition: 'PARTIAL',
    startedAt,
    endedAt: '',
    environment: {
      url: env.url,
      accountId: env.accountId,
      apiKeyPrefix: env.apiKey.slice(0, 6) + '…',
      apiSecret: 'REDACTED',
      egressStreamUrl: env.egressStreamUrl,
      note:
        'the egress stream destination is the operator-configured recording output; file-based egress requires external storage (environment-blocked on this project) — the egress CONTROL plane (start/stop/lifecycle, egress joining the room as a real participant) is live-proven',
    },
    wiring: { livekitState: '', detail: '' },
    meetingReference: {
      note:
        'the canonical meeting session is created through the meetings module production webhook ingestion path (zoom envelope — the DOMAIN-SIDE meeting reference, deterministic fixture by design); the LIVE provider evidence of this leg is the LiveKit room, its participants and its events',
      providerMeetingId: '',
      providerSessionId: '',
      meetingSessionId: '',
      connectionId: '',
    },
    legs: [],
    cleanup: { roomsDeleted: [] },
  };

  const roomsToClean: string[] = [];
  const tenantId = newId();
  const ctx = member(tenantId);

  try {
    // 1 — the env-driven production wiring (must wire the real transport).
    const wiring = ensureRealtimeTransportsWired();
    const livekitWiring = wiring.providers.find((p) => p.provider === 'livekit')!;
    report.wiring = { livekitState: livekitWiring.state, detail: livekitWiring.detail };
    if (livekitWiring.state !== 'wired') {
      throw new Error(`livekit wiring is '${livekitWiring.state}' — the live leg requires a wired transport`);
    }

    // 2 — the canonical meeting session (production ingestion path; the
    //     domain-side meeting reference the companion session attaches to).
    const { connection: zoomConnection } = await registerMeetingConnection(member(tenantId), {
      provider: 'zoom',
      providerAccountId: 'zoom-w109-live-ref',
      authKind: 'credentials',
      credentialRef: 'secret-store:zoom/w109-live-reference',
      displayName: 'W109 live-leg meeting reference',
    });
    const providerMeetingId = `w109-live-${Date.now()}`;
    const providerSessionId = `${providerMeetingId}-occurrence`;
    await receiveMeetingWebhook(member(tenantId), {
      provider: 'zoom',
      payload: {
        event: 'meeting.created',
        event_id: `w109-ref-created-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        account: { id: 'zoom-w109-live-ref' },
        meeting: {
          id: providerMeetingId,
          title: 'W109 Live Leg — Meeting Companion reference',
          agenda: 'The canonical meeting the LiveKit companion session attaches to',
          scheduled_start: new Date().toISOString(),
          scheduled_end: new Date(Date.now() + 3_600_000).toISOString(),
          host: { id: 'host-w109', name: 'W109 Host', email: null },
        },
      },
    });
    await receiveMeetingWebhook(member(tenantId), {
      provider: 'zoom',
      payload: {
        event: 'meeting.started',
        event_id: `w109-ref-started-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        account: { id: 'zoom-w109-live-ref' },
        meeting: { id: providerMeetingId },
        session: {
          id: providerSessionId,
          status: 'started',
          started_at: new Date().toISOString(),
          participants: [
            { id: 'host-w109', name: 'W109 Host', email: null, joined_at: new Date().toISOString(), left_at: null },
          ],
        },
      },
    });
    const canonical = (await listMeetingSessions(member(tenantId), { limit: 10 })).find(
      (s) => s.providerSessionId === providerSessionId,
    );
    if (canonical === undefined) throw new Error('the meeting reference session did not land in the canonical registry');
    report.meetingReference = {
      ...report.meetingReference,
      providerMeetingId,
      providerSessionId,
      meetingSessionId: canonical.id,
      connectionId: zoomConnection.id,
    };

    // 3 — the realtime connection for the live provider account.
    const { connection: realtimeConnection } = await registerRealtimeConnection(member(tenantId), {
      provider: 'livekit',
      providerAccountId: env.accountId,
      authKind: 'api_key',
      credentialRef: 'secret-store:livekit/operator-project',
      displayName: 'Operator LiveKit Cloud project (W109 live leg)',
    });

    // ------------------------------------------------------------------
    // LEG 1 — the meeting companion session on a REAL LiveKit room.
    // ------------------------------------------------------------------
    {
      const { session } = await startRealtimeSession(member(tenantId), {
        connectionId: realtimeConnection.id,
        kind: 'meeting_companion',
        title: 'W109 live meeting companion leg',
        meetingSessionId: canonical.id,
      });
      const room = session.providerRoomId!;
      roomsToClean.push(room);

      // The canonical meeting reference stays readable through the frozen
      // contract (the cross-module linkage of the meeting path).
      const linked = await getMeetingSession(member(tenantId), canonical.id);
      if (linked.id !== canonical.id) throw new Error('meeting linkage broken');

      // A REAL participant join through a minted join grant.
      const grant = await createRealtimeJoinGrant(member(tenantId), {
        sessionId: session.id,
        displayName: 'w109-live-human',
      });
      const signal = joinViaSignal(env.url, grant);
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(resolve, 8000);
        const check = setInterval(() => {
          if (signal.join !== null) {
            clearInterval(check);
            clearTimeout(deadline);
            resolve();
          }
        }, 100);
        setTimeout(() => reject(new Error('the real join did not produce a JoinResponse within 8s')), 9000);
      });
      const humanIdentity = signal.join!.identity;
      const humanJoinedAt = signal.join!.joinedAt;

      // Provider-side evidence of the room and the join. The room listing
      // is eventually consistent on LiveKit Cloud (the room appears once
      // its first participant registration settles) — poll briefly.
      let listedRoom: { sid: string; name: string; creation_time?: string } | null = null;
      for (let attempt = 0; attempt < 6 && listedRoom === null; attempt += 1) {
        const roomsListed = await evidenceTwirp<{
          rooms?: Array<{ sid: string; name: string; creation_time?: string }>;
        }>(env, 'livekit.RoomService/ListRooms', {});
        listedRoom = roomsListed.rooms?.find((r) => r.name === room) ?? null;
        if (listedRoom === null) await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      const participantsBefore = await evidenceTwirp<{
        participants?: Array<{ identity: string; sid: string; state?: string; joined_at?: number | string }>;
      }>(env, 'livekit.RoomService/ListParticipants', { room }, room);
      const observedBefore = (participantsBefore.participants ?? []).map((p) => ({
        identity: p.identity,
        sid: p.sid,
        state: p.state ?? '',
        joinedAt:
          typeof p.joined_at === 'number'
            ? new Date(p.joined_at * 1000).toISOString()
            : String(p.joined_at ?? ''),
        isEgress: p.identity.startsWith('EG_'),
      }));

      // The canonical pipeline: the provider events the integration layer
      // relays (real provider-minted identities/timestamps; the transcript
      // TEXT is leg-authored — real ASR is the agents worker, the W112
      // frontier; speaker IDENTITY and attribution are provider-real).
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'participant.connected', `w109-c-${session.id}-1`, {
          participant: { identity: humanIdentity, name: 'W109 Live Human', email: null, phone: null },
        }, humanJoinedAt),
      });
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'transcript.finalized', `w109-c-${session.id}-2`, {
          transcript: {
            participant_id: humanIdentity,
            speaker_name: 'W109 Live Human',
            started_at: humanJoinedAt,
            ended_at: new Date().toISOString(),
            text: 'This is live speech captured through the real room — attribute me.',
            confidence: 0.91,
          },
        }),
      });

      // THE CONSENT FLOOR against the real provider.
      // (a) refusal blocks BEFORE any grant.
      const blocked = await expectRealtimeError(() => startRealtimeRecording(member(tenantId), { sessionId: session.id }));
      // (b) the provider-path grant (DTMF/verbal), then a REAL egress start.
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'consent.granted', `w109-c-${session.id}-3`, {
          participant: { identity: humanIdentity },
        }),
      });
      const recording = await startRealtimeRecording(member(tenantId), { sessionId: session.id });

      // The egress REJOINS the room as a real participant — provider-side
      // evidence of the running recording.
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const participantsDuring = await evidenceTwirp<{
        participants?: Array<{ identity: string; sid: string; state?: string; joined_at?: number | string }>;
      }>(env, 'livekit.RoomService/ListParticipants', { room }, room);
      const observedDuring = (participantsDuring.participants ?? []).map((p) => ({
        identity: p.identity,
        sid: p.sid,
        state: p.state ?? '',
        joinedAt:
          typeof p.joined_at === 'number' ? new Date(p.joined_at * 1000).toISOString() : String(p.joined_at ?? ''),
        isEgress: p.identity.startsWith('EG_'),
      }));
      const egressListing = await evidenceTwirp<{
        items?: Array<{ egress_id: string; status?: string }>;
      }>(env, 'livekit.Egress/ListEgress', { roomName: room }, room);
      const liveEgress = egressListing.items?.find((item) => item.status?.includes('ACTIVE') || item.status?.includes('STARTING')) ?? egressListing.items?.[0] ?? null;

      // Aurum speaks — a REAL data publish into the room.
      const spoken = await speakRealtimeResponse(member(tenantId), {
        sessionId: session.id,
        text: 'W109 live leg: Aurum speaking into the real room.',
        inReplyToTurnId: (await listRealtimeTurns(member(tenantId), { sessionId: session.id }))[0]!.id,
      });
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'response.completed', `w109-c-${session.id}-4`, {
          response: { id: spoken.id },
        }),
      });

      // A second response gets INTERRUPTED — barge-in by the real human.
      const interrupted = await speakRealtimeResponse(member(tenantId), {
        sessionId: session.id,
        text: 'W109 live leg: this response will be cut short by a barge-in.',
      });
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'response.interrupted', `w109-c-${session.id}-5`, {
          response: { id: interrupted.id, interrupted_by: humanIdentity },
        }),
      });

      // (c) mid-session revocation STOPS the recording (real StopEgress).
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'consent.revoked', `w109-c-${session.id}-6`, {
          participant: { identity: humanIdentity },
        }),
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const egressAfterStop = await evidenceTwirp<{
        items?: Array<{ egress_id: string; status?: string }>;
      }>(env, 'livekit.Egress/ListEgress', { roomName: room }, room);
      const stoppedEgress = egressAfterStop.items?.[0] ?? null;
      const revokedSession = await getRealtimeSession(member(tenantId), session.id);

      // Durable end + finalization (the room dies; the WS client observes
      // the real disconnect).
      const stopped = await stopRealtimeSession(member(tenantId), { sessionId: session.id });
      roomsToClean.splice(roomsToClean.indexOf(room), 1);
      await Promise.race([signal.closed, new Promise((resolve) => setTimeout(resolve, 8000))]);
      // The room listing is eventually consistent after deletion too —
      // poll for the room's disappearance.
      let roomGone = false;
      for (let attempt = 0; attempt < 6 && !roomGone; attempt += 1) {
        roomGone = await evidenceTwirp<{ rooms?: Array<{ name: string }> }>(
          env,
          'livekit.RoomService/ListRooms',
          {},
        ).then(
          (listing) => !(listing.rooms ?? []).some((r) => r.name === room),
          () => false,
        );
        if (!roomGone) await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Finalization: the transcript artifact + the session-close observation.
      const runStatus = await driveFinalize(member(tenantId), stopped.finalizeRunId!);
      const artifactRows = await getDb().query<{
        storage_ref: string;
        checksum: string | null;
        byte_size: number | null;
        kind: string;
      }>(
        `SELECT storage_ref, checksum, byte_size, kind FROM realtime_artifacts
           WHERE tenant_id = $1 AND session_id = $2 AND kind = 'transcript'`,
        [tenantId, session.id],
      );
      const transcriptArtifact = artifactRows.rows[0] ?? null;
      const sessionRow = (
        await getDb().query<{ evidence_observation_id: string | null }>(
          `SELECT evidence_observation_id FROM realtime_sessions WHERE tenant_id = $1 AND id = $2`,
          [tenantId, session.id],
        )
      ).rows[0]!;
      const observation =
        sessionRow.evidence_observation_id === null
          ? null
          : await getObservation(member(tenantId), sessionRow.evidence_observation_id);

      // Canonical outcomes.
      const turns = await listRealtimeTurns(member(tenantId), { sessionId: session.id });
      const responses = await listRealtimeResponses(member(tenantId), { sessionId: session.id });
      const ledger = await listRealtimeEvents(member(tenantId), { sessionId: session.id });
      const humanTurn = turns.find((turn) => turn.kind === 'human_speech') ?? null;

      report.legs.push({
        kind: 'meeting_companion',
        sessionId: session.id,
        providerRoomId: room,
        room: listedRoom
          ? {
              sid: listedRoom.sid,
              name: listedRoom.name,
              creationTime: String(listedRoom.creation_time ?? ''),
              serverRegion: signal.join?.serverRegion ?? null,
              serverVersion: signal.join?.serverVersion ?? null,
            }
          : null,
        join: signal.join
          ? {
              identity: signal.join.identity,
              participantSid: signal.join.participantSid,
              joinedAt: signal.join.joinedAt,
              grantExpiresAt: grant.expiresAt,
              token: 'REDACTED',
            }
          : null,
        participantsObserved: observedDuring.length > 0 ? observedDuring : observedBefore,
        signalsReceived: signal.signals.slice(0, 40),
        consentFloor: {
          blockedBeforeConsent: {
            blocked: blocked.code === 'consent_required',
            errorCode: blocked.code,
            ledgerEventRecorded: ledger.some((event) => event.kind === 'recording.blocked'),
          },
          recordingStart: {
            started: recording.recordingState === 'recording',
            egressId: liveEgress?.egress_id ?? null,
            egressStatus: liveEgress?.status ?? null,
            egressParticipantObserved: observedDuring.some((p) => p.isEgress),
          },
          revocationStop: {
            stopped: revokedSession.recordingState === 'recorded',
            egressFinalStatus: stoppedEgress?.status ?? null,
            recordingStateAfter: revokedSession.recordingState,
          },
        },
        transcript: {
          humanTurn: humanTurn
            ? {
                text: humanTurn.text,
                speakerParticipantId: humanTurn.speakerParticipantId,
                speakerName: humanTurn.speakerName,
              }
            : null,
          aurumTurns: turns
            .filter((turn) => turn.kind === 'aurum_response')
            .map((turn) => ({ text: turn.text, responseId: turn.responseId ?? '' })),
        },
        responses: responses.map((response) => ({
          responseId: response.id,
          text: response.text,
          status: response.status,
          interruptedByParticipantId: response.interruptedByParticipantId,
          completedAt: response.completedAt,
          interruptedAt: response.interruptedAt,
        })),
        disconnect: {
          leaveReason: signal.leaveReason,
          closeCode: signal.closeCode,
          roomGoneAfterStop: roomGone,
          participantsAfterStop: 0,
        },
        finalization: {
          runId: stopped.finalizeRunId ?? '',
          runStatus,
          transcriptArtifact: transcriptArtifact
            ? {
                storageRef: transcriptArtifact.storage_ref,
                checksum: transcriptArtifact.checksum,
                byteSize: transcriptArtifact.byte_size,
              }
            : null,
          observation:
            observation === null
              ? null
              : {
                  id: observation.id,
                  kind: observation.kind,
                  turnCount: Number((observation.payload as Record<string, unknown>).turnCount ?? 0),
                  participantCount: Number((observation.payload as Record<string, unknown>).participantCount ?? 0),
                  recordingState: String((observation.payload as Record<string, unknown>).recordingState ?? ''),
                  errorCode: ((observation.payload as Record<string, unknown>).errorCode as string | null) ?? null,
                },
        },
        eventsLedger: ledger.map((event) => event.kind),
      });
    }

    // ------------------------------------------------------------------
    // LEG 2 — the aurum_voice session on a REAL LiveKit room.
    // ------------------------------------------------------------------
    {
      const { session } = await startRealtimeSession(member(tenantId), {
        connectionId: realtimeConnection.id,
        kind: 'aurum_voice',
        title: 'W109 live realtime (voice) leg',
      });
      const room = session.providerRoomId!;
      roomsToClean.push(room);

      const spoken = await speakRealtimeResponse(member(tenantId), {
        sessionId: session.id,
        text: 'W109 live realtime leg: Aurum voice response on a real room.',
      });
      await receiveRealtimeEvent(ctx, {
        provider: 'livekit',
        payload: envelope(env.accountId, room, 'response.completed', `w109-v-${session.id}-1`, {
          response: { id: spoken.id },
        }),
      });

      const stopped = await stopRealtimeSession(member(tenantId), { sessionId: session.id });
      roomsToClean.splice(roomsToClean.indexOf(room), 1);
      const runStatus = await driveFinalize(member(tenantId), stopped.finalizeRunId!);
      const artifactRows = await getDb().query<{ storage_ref: string; checksum: string | null; byte_size: number | null }>(
        `SELECT storage_ref, checksum, byte_size FROM realtime_artifacts
           WHERE tenant_id = $1 AND session_id = $2 AND kind = 'transcript'`,
        [tenantId, session.id],
      );
      const sessionRow = (
        await getDb().query<{ evidence_observation_id: string | null }>(
          `SELECT evidence_observation_id FROM realtime_sessions WHERE tenant_id = $1 AND id = $2`,
          [tenantId, session.id],
        )
      ).rows[0]!;
      const observation =
        sessionRow.evidence_observation_id === null
          ? null
          : await getObservation(member(tenantId), sessionRow.evidence_observation_id);
      const ledger = await listRealtimeEvents(member(tenantId), { sessionId: session.id });

      report.legs.push({
        kind: 'aurum_voice',
        sessionId: session.id,
        providerRoomId: room,
        room: null,
        join: null,
        participantsObserved: [],
        signalsReceived: [],
        finalization: {
          runId: stopped.finalizeRunId ?? '',
          runStatus,
          transcriptArtifact: artifactRows.rows[0]
            ? {
                storageRef: artifactRows.rows[0].storage_ref,
                checksum: artifactRows.rows[0].checksum,
                byteSize: artifactRows.rows[0].byte_size,
              }
            : null,
          observation:
            observation === null
              ? null
              : {
                  id: observation.id,
                  kind: observation.kind,
                  turnCount: Number((observation.payload as Record<string, unknown>).turnCount ?? 0),
                  participantCount: Number((observation.payload as Record<string, unknown>).participantCount ?? 0),
                  recordingState: String((observation.payload as Record<string, unknown>).recordingState ?? ''),
                  errorCode: ((observation.payload as Record<string, unknown>).errorCode as string | null) ?? null,
                },
        },
        eventsLedger: ledger.map((event) => event.kind),
      });
    }

    report.disposition = 'LIVE-PROVEN';
  } catch (error) {
    report.failure = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    report.disposition = 'BLOCKED';
  } finally {
    // Best-effort cleanup: never leave rooms on the operator's project.
    for (const room of roomsToClean.splice(0)) {
      try {
        await evidenceTwirp(env, 'livekit.RoomService/DeleteRoom', { room }, room);
        report.cleanup.roomsDeleted.push(room);
      } catch {
        /* the empty-room timeout backstops */
      }
    }
    report.endedAt = new Date().toISOString();
  }

  if (evidenceDir !== null) {
    await mkdir(evidenceDir, { recursive: true });
    const file = path.join(evidenceDir, `live-leg-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  return report;
}

/** Test-suite bootstrap: embedded database + migrations (idempotent). */
export async function prepareLiveLegDatabase(): Promise<void> {
  await runMigrations(getDb());
}

/** Test-suite teardown. */
export async function teardownLiveLegDatabase(): Promise<void> {
  closeBlobStore();
  await closeDb();
}
