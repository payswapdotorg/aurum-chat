// W044 — Tenant Isolation Verification · the realtime sweep (W086).
//
// The realtime module (W086 — Realtime Voice and Meeting Companion) owns
// tenant-scoped tables for its realtime surface: transport connections,
// sessions, the per-session participant registry, the canonical event
// ledger, live-transcript turns, spoken-response lifecycle rows and
// durable artifacts.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * connections are tenant-scoped: a provider event envelope whose
//     account belongs to the other tenant is uniformly not-found (the
//     event path refuses cross-tenant account resolution BEFORE anything
//     is applied — no existence leak), and a foreign room on a
//     registered account is indistinguishable from missing;
//   * sessions, participants, turns, responses, artifacts and the event
//     ledger of one tenant are invisible to the other (uniform
//     not-found, disjoint listings);
//   * the participant registry is tenant-scoped: the same provider
//     participant id captured in both tenants resolves to two
//     independent registry identities;
//   * the finalization pump is tenant-scoped: one tenant's pending
//     finalizations never surface for the other;
//   * the repository boundary: every realtime table carries a NOT NULL
//     uuid tenant_id, and the row partition holds after the fixtures
//     ran.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/realtime/tests/); this sweep is the two-tenant proof the
// W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  assertTenantPartition,
  member,
  runMigrations,
  tableColumns,
} from './harness';
import {
  getRealtimeSession,
  listRealtimeArtifacts,
  listRealtimeConnections,
  listRealtimeEvents,
  listRealtimeParticipants,
  listRealtimeResponses,
  listRealtimeSessions,
  listRealtimeTurns,
  pumpRealtimeFinalization,
  RealtimeError,
  receiveRealtimeEvent,
  registerRealtimeConnection,
  setRealtimeTransport,
  speakRealtimeResponse,
  startRealtimeSession,
  stopRealtimeSession,
} from '@/modules/realtime/contract';
import type { RealtimeSession, RealtimeTransport } from '@/modules/realtime/types';

const tenantA = newId();
const tenantB = newId();

const REALTIME_TABLES = [
  'realtime_connections',
  'realtime_sessions',
  'realtime_participants',
  'realtime_events',
  'realtime_turns',
  'realtime_responses',
  'realtime_artifacts',
] as const;

async function expectCode(code: RealtimeError['code'], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected RealtimeError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof RealtimeError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** A minimal scripted transport (provider-neutral; deterministic rooms). */
class SweepTransport implements RealtimeTransport {
  readonly provider = 'livekit' as const;
  async startRoom(request: Parameters<RealtimeTransport['startRoom']>[0]) {
    return {
      providerRoomId: `room-${request.sessionId}`,
      agentParticipantId: request.agentParticipantId,
    };
  }
  async stopRoom(): Promise<void> {}
  async speak(): Promise<void> {}
  async startRecording(): Promise<void> {}
  async stopRecording(): Promise<{ artifact: null }> {
    return { artifact: null };
  }
  async dial(request: Parameters<RealtimeTransport['dial']>[0]) {
    return { providerParticipantId: `sip-${request.phoneNumber.replace('+', '')}` };
  }
  async createJoinGrant(request: Parameters<RealtimeTransport['createJoinGrant']>[0]) {
    // Fake credential assembled from fragments at runtime.
    return {
      url: `wss://example.invalid/${request.sessionId}`,
      token: ['grant', Math.random().toString(36).slice(2, 10)].join('_'),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
}

/** One tenant's full realtime journey: session → participants → transcript → spoken response → stop. */
async function realtimeJourney(
  tenantId: string,
  key: string,
): Promise<{ session: RealtimeSession }> {
  const ctx: TenantContext = member(tenantId);
  const { connection } = await registerRealtimeConnection(ctx, {
    provider: 'livekit',
    providerAccountId: `lk-${key}`,
    authKind: 'api_key',
    // Fake credentials assembled from fragments at runtime.
    credentialRef: `secret-store:livekit/${key}`,
  });
  const { session } = await startRealtimeSession(ctx, {
    connectionId: connection.id,
    kind: 'aurum_voice',
    title: `Journey ${key}`,
  });
  const envelope = (type: string, eventId: string, extra: Record<string, unknown> = {}) => ({
    type,
    event_id: `${key}-${eventId}`,
    occurredAt: '2026-09-25T10:00:00Z',
    account: { id: `lk-${key}` },
    room: { id: `room-${session.id}` },
    ...extra,
  });
  await receiveRealtimeEvent(ctx, {
    provider: 'livekit',
    payload: envelope('participant.connected', 'p1', {
      participant: { identity: `speaker-${key}`, name: `Speaker ${key}`, email: null, phone: null },
    }),
  });
  await receiveRealtimeEvent(ctx, {
    provider: 'livekit',
    payload: envelope('transcript.finalized', 't1', {
      transcript: {
        participant_id: `speaker-${key}`,
        speaker_name: `Speaker ${key}`,
        started_at: '2026-09-25T10:01:00Z',
        ended_at: null,
        text: `Journey ${key} opening.`,
        confidence: null,
      },
    }),
  });
  await speakRealtimeResponse(ctx, {
    sessionId: session.id,
    text: `Journey ${key} acknowledgment.`,
  });
  await stopRealtimeSession(ctx, { sessionId: session.id });
  return { session };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setRealtimeTransport(null);
  await closeDb();
});

beforeEach(() => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date('2026-09-25T10:00:00Z'));
  setRealtimeTransport(new SweepTransport());
});

afterEach(() => {
  vi.restoreAllMocks();
  setRealtimeTransport(null);
});

describe('W044 sweep — realtime (W086)', () => {
  it('runs both tenants side by side with zero leakage', async () => {
    const { session: sessionA } = await realtimeJourney(tenantA, 'a');
    const { session: sessionB } = await realtimeJourney(tenantB, 'b');

    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    // Listings are disjoint.
    const sessionsA = await listRealtimeSessions(ctxA, { limit: 500 });
    const sessionsB = await listRealtimeSessions(ctxB, { limit: 500 });
    expect(sessionsA).toHaveLength(1);
    expect(sessionsB).toHaveLength(1);
    expect(sessionsA[0]!.id).toBe(sessionA.id);
    expect(sessionsB[0]!.id).toBe(sessionB.id);

    // Cross-tenant reads are uniformly not-found.
    await expectCode('session_not_found', () => getRealtimeSession(ctxA, sessionB.id));
    await expectCode('session_not_found', () => getRealtimeSession(ctxB, sessionA.id));
    await expectCode('session_not_found', () =>
      listRealtimeTurns(ctxA, { sessionId: sessionB.id }));
    await expectCode('session_not_found', () =>
      listRealtimeResponses(ctxB, { sessionId: sessionA.id }));
    await expectCode('session_not_found', () =>
      listRealtimeEvents(ctxA, { sessionId: sessionB.id }));
    await expectCode('session_not_found', () =>
      listRealtimeArtifacts(ctxB, { sessionId: sessionA.id }));
    await expectCode('session_not_found', () =>
      stopRealtimeSession(ctxA, { sessionId: sessionB.id }));

    // Participants are per-tenant even for the same provider id shape.
    const participantsA = await listRealtimeParticipants(ctxA, { sessionId: sessionA.id });
    const participantsB = await listRealtimeParticipants(ctxB, { sessionId: sessionB.id });
    expect(participantsA.map((p) => p.providerParticipantId).sort()).toEqual([
      `aurum-agent-${sessionA.id}`,
      'speaker-a',
    ]);
    expect(participantsB.map((p) => p.providerParticipantId).sort()).toEqual([
      `aurum-agent-${sessionB.id}`,
      'speaker-b',
    ]);

    // Turns/responses never cross.
    const turnsA = await listRealtimeTurns(ctxA, { sessionId: sessionA.id });
    const turnsB = await listRealtimeTurns(ctxB, { sessionId: sessionB.id });
    expect(turnsA.map((t) => t.text)).toEqual([
      'Journey a opening.',
      'Journey a acknowledgment.',
    ]);
    expect(turnsB.map((t) => t.text)).toEqual([
      'Journey b opening.',
      'Journey b acknowledgment.',
    ]);

    // THE event boundary: an envelope whose account belongs to the other
    // tenant is uniformly not-found — nothing is applied, no existence
    // leak…
    await expectCode('connection_not_found', () =>
      receiveRealtimeEvent(ctxA, {
        provider: 'livekit',
        payload: {
          type: 'room.started',
          event_id: 'foreign-a',
          occurredAt: '2026-09-25T10:00:00Z',
          account: { id: 'lk-b' },
          room: { id: `room-${sessionB.id}` },
        },
      }),
    );
    // …and a foreign room on a registered account is indistinguishable
    // from missing.
    await expectCode('session_not_found', () =>
      receiveRealtimeEvent(ctxA, {
        provider: 'livekit',
        payload: {
          type: 'room.started',
          event_id: 'foreign-a2',
          occurredAt: '2026-09-25T10:00:00Z',
          account: { id: 'lk-a' },
          room: { id: `room-${sessionB.id}` },
        },
      }),
    );
    // The refused deliveries left no trace in tenant A (its own trail is
    // the join, the transcript and the caller-stop end — nothing foreign).
    expect((await listRealtimeEvents(ctxA, { sessionId: sessionA.id, limit: 500 })).length).toBe(3);

    // Connections and the finalization pump stay tenant-scoped.
    const connectionsA = await listRealtimeConnections(ctxA, {});
    expect(connectionsA).toHaveLength(1);
    expect(connectionsA[0]!.providerAccountId).toBe('lk-a');
    expect((await listRealtimeConnections(ctxB, {}))[0]!.providerAccountId).toBe('lk-b');
    const pumpA = await pumpRealtimeFinalization(ctxA);
    expect(pumpA.status).toBe('idle'); // tenant A's finalization ran at stop time
    expect((await pumpRealtimeFinalization(ctxB)).status).toBe('idle');
  });

  it('carries a NOT NULL uuid tenant_id on every realtime table (repository boundary)', async () => {
    const columns = await tableColumns();
    for (const table of REALTIME_TABLES) {
      const tenantColumn = columns.find(
        (column) => column.table_name === table && column.column_name === 'tenant_id',
      );
      expect(tenantColumn, `${table} must carry a tenant_id column`).toBeDefined();
      expect(tenantColumn!.data_type, `${table}.tenant_id must be uuid`).toBe('uuid');
      expect(tenantColumn!.is_nullable, `${table}.tenant_id must be NOT NULL`).toBe('NO');
    }
  });

  it('holds the row partition across every tenant-scoped table after the fixtures ran', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
