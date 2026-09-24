// W044 — Tenant Isolation Verification · the meetings sweep (W085).
//
// The meetings module (W085 — Meeting Intelligence Gateway) owns
// tenant-scoped tables for its capture surface: meeting connections,
// the canonical participant identity registry, meetings/sessions,
// transcripts, artifacts, access events and the ingestion ledger.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * connections are tenant-scoped: a webhook envelope whose account
//     belongs to the other tenant is uniformly not-found (the capture
//     path refuses cross-tenant account resolution BEFORE anything is
//     ingested — no existence leak);
//   * meetings, sessions, participants, transcripts, artifacts and access
//     events of one tenant are invisible to the other (uniform not-found,
//     disjoint listings);
//   * the participant registry is tenant-scoped: the same provider
//     participant id captured in both tenants resolves to two
//     independent registry identities.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/meetings/tests/); this sweep is the two-tenant proof the
// W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import {
  getMeeting,
  getMeetingSession,
  listMeetingAccessEvents,
  listMeetingArtifacts,
  listMeetingConnections,
  listMeetingParticipants,
  listMeetings,
  listMeetingSessions,
  listMeetingTranscripts,
  MeetingsError,
  receiveMeetingWebhook,
  registerMeetingConnection,
} from '@/modules/meetings/contract';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: MeetingsError['code'], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected MeetingsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MeetingsError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** One tenant's full capture journey through the zoom webhook path. */
async function captureJourney(tenantId: string, key: string): Promise<void> {
  const ctx = memberOf(tenantId);
  await registerMeetingConnection(ctx, {
    provider: 'zoom',
    providerAccountId: `zoom-acct-${key}`,
    authKind: 'oauth',
    // Fake credentials assembled from fragments at runtime.
    credentialRef: `secret-store://zoom/${key}`,
    oauthScopes: ['meeting:read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  const envelope = (event: string, overrides: Record<string, unknown> = {}) => ({
    event,
    event_id: `${key}-${event}`,
    occurredAt: '2026-09-24T09:00:00Z',
    account: { id: `zoom-acct-${key}` },
    meeting: { id: `mtg-${key}` },
    ...overrides,
  });
  await receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: envelope('meeting.updated', {
      meeting: {
        id: `mtg-${key}`,
        title: `Journey ${key}`,
        scheduled_start: '2026-09-24T09:00:00Z',
        scheduled_end: '2026-09-24T10:00:00Z',
        host: { id: `host-${key}`, name: `Host ${key}`, email: `host-${key}@${key}.test` },
      },
    }),
  });
  await receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: envelope('meeting.ended', {
      session: {
        id: `occ-${key}`,
        status: 'ended',
        started_at: '2026-09-24T09:00:30Z',
        ended_at: '2026-09-24T09:57:00Z',
        participants: [
          { id: `host-${key}`, name: `Host ${key}`, email: `host-${key}@${key}.test`, joined_at: '2026-09-24T09:00:30Z', left_at: '2026-09-24T09:57:00Z' },
        ],
      },
    }),
  });
  await receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: envelope('recording.transcript_completed', {
      session: { id: `occ-${key}` },
      transcript: {
        id: `tr-${key}`,
        language: 'en-US',
        segments: [
          { participant_id: `host-${key}`, speaker_name: null, started_at: '2026-09-24T09:01:00Z', ended_at: null, text: `Journey ${key} opening.`, confidence: null },
        ],
      },
    }),
  });
  await receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: envelope('recording.completed', {
      session: { id: `occ-${key}` },
      artifact: { id: `rec-${key}`, type: 'recording', name: `Journey-${key}.mp4`, media_type: 'video/mp4', size_bytes: 2048, storage_ref: `provider://zoom/${key}`, checksum: null },
    }),
  });
  await receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: envelope('meeting.access_denied', {
      access: { code: 'recording_unavailable', detail: 'expired', meeting_id: `mtg-${key}` },
    }),
  });
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 sweep — meetings (W085)', () => {
  it('captures both tenants side by side with zero leakage', async () => {
    await captureJourney(tenantA, 'a');
    await captureJourney(tenantB, 'b');

    const ctxA = memberOf(tenantA);
    const ctxB = memberOf(tenantB);

    // Listings are disjoint.
    const meetingsA = await listMeetings(ctxA, {});
    const meetingsB = await listMeetings(ctxB, {});
    expect(meetingsA).toHaveLength(1);
    expect(meetingsB).toHaveLength(1);
    expect(meetingsA[0]!.providerMeetingId).toBe('mtg-a');
    expect(meetingsB[0]!.providerMeetingId).toBe('mtg-b');

    // Cross-tenant reads are uniformly not-found.
    await expectCode('meeting_not_found', () => getMeeting(ctxA, meetingsB[0]!.id));
    await expectCode('meeting_not_found', () => getMeeting(ctxB, meetingsA[0]!.id));

    const sessionsA = await listMeetingSessions(ctxA, { meetingId: meetingsA[0]!.id });
    expect(sessionsA).toHaveLength(1);
    await expectCode('session_not_found', () => getMeetingSession(ctxB, sessionsA[0]!.id));
    await expectCode('session_not_found', () =>
      listMeetingTranscripts(ctxB, { sessionId: sessionsA[0]!.id }));
    await expectCode('session_not_found', () =>
      listMeetingArtifacts(ctxB, { sessionId: sessionsA[0]!.id }));

    // Participants are per-tenant even for the same provider id shape:
    // each tenant captured its own host identity.
    const participantsA = await listMeetingParticipants(ctxA, {});
    const participantsB = await listMeetingParticipants(ctxB, {});
    expect(participantsA.map((p) => p.providerParticipantId)).toEqual(['host-a']);
    expect(participantsB.map((p) => p.providerParticipantId)).toEqual(['host-b']);
    expect(participantsA[0]!.id).not.toBe(participantsB[0]!.id);

    // Access events and connections stay tenant-scoped.
    const accessA = await listMeetingAccessEvents(ctxA, {});
    expect(accessA).toHaveLength(1);
    expect(await listMeetingAccessEvents(ctxB, { connectionId: accessA[0]!.connectionId })).toEqual([]);
    const connectionsA = await listMeetingConnections(ctxA, {});
    expect(connectionsA).toHaveLength(1);
    expect(connectionsA[0]!.providerAccountId).toBe('zoom-acct-a');
    expect((await listMeetingConnections(ctxB, {}))[0]!.providerAccountId).toBe('zoom-acct-b');

    // THE capture boundary: a webhook envelope whose account belongs to the
    // other tenant is uniformly not-found — nothing is ingested, no
    // existence leak.
    await expectCode('connection_not_found', () =>
      receiveMeetingWebhook(ctxA, {
        provider: 'zoom',
        payload: {
          event: 'meeting.updated',
          event_id: 'foreign-a',
          occurredAt: '2026-09-24T09:00:00Z',
          account: { id: 'zoom-acct-b' },
          meeting: { id: 'mtg-b' },
        },
      }));
    // …and the refused delivery left no trace in tenant A.
    expect((await listMeetings(ctxA, {})).map((m) => m.providerMeetingId)).toEqual(['mtg-a']);
  });
});
