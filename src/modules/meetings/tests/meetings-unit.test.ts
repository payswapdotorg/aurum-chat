// Unit tests for the meetings module (W085) — pure logic, no database:
// the provider adapters (provider-native envelope → canonical records)
// and the validation layer (the canonical contract guards).
//
// Provider envelope fixtures are the documented shapes each adapter's
// header comment defines (the sources module's discipline: adapters parse
// the envelope shape the provider's transport delivers).

import { describe, expect, it } from 'vitest';
import { getMeetingAdapter } from '../adapters';
import { zoomAdapter } from '../adapters/zoom';
import { microsoftTeamsAdapter } from '../adapters/microsoft-teams';
import { googleMeetAdapter } from '../adapters/google-meet';
import { recallAdapter } from '../adapters/recall';
import { MeetingsError } from '../errors';
import type { CanonicalMeetingRecord } from '../types';
import {
  cursorAdvance,
  isMeetingAccessCode,
  isMeetingProvider,
  validateCanonicalMeetingRecord,
  validateFetchResult,
  validateListMeetingsQuery,
  validateReceiveWebhookInput,
  validateRecordBatch,
  validateRegisterConnectionInput,
  validateWebhookParseResult,
} from '../validation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectPayloadError(fn: () => unknown, message?: RegExp): void {
  try {
    fn();
    throw new Error('expected MeetingsError(invalid_provider_payload) but the call succeeded');
  } catch (error) {
    if (!(error instanceof MeetingsError)) throw error;
    expect(error.code).toBe('invalid_provider_payload');
    if (message !== undefined) expect(error.message).toMatch(message);
  }
}

/** Asserts a MeetingsError with the given code (codes, not messages, are control flow). */
function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected MeetingsError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MeetingsError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** Parses one envelope and asserts exactly one canonical record came out. */
function parseOne(adapter: { parseWebhook(payload: unknown): { records: CanonicalMeetingRecord[] } }, payload: unknown): CanonicalMeetingRecord {
  const parsed = adapter.parseWebhook(payload);
  expect(parsed.records).toHaveLength(1);
  return parsed.records[0]!;
}

// ---------------------------------------------------------------------------
// Fixture envelopes (the documented provider shapes)
// ---------------------------------------------------------------------------

function zoomEnvelope(event: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event,
    event_id: 'ev-0001',
    occurredAt: '2026-09-24T09:00:00Z',
    account: { id: 'zoom-acct-1' },
    meeting: { id: 'mtg-77', title: 'Weekly supplier review' },
    ...overrides,
  };
}

function teamsEnvelope(
  changeType: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'note-0001',
    tenantId: '7ab91c0e-1111-4222-8333-444455556666',
    occurredAt: '2026-09-24T10:30:00Z',
    changeType,
    resourceData: {
      onlineMeetingId: 'teams-meet-1',
      callId: 'call-1',
      title: 'Roadmap sync',
      ...overrides,
    },
    ...overrides,
  };
}

function meetEnvelope(
  eventType: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventUuid: 'meet-evt-1',
    occurredAt: '2026-09-24T11:15:00Z',
    workspace: { id: 'workspace-1' },
    eventType,
    conferenceRecord: { meetingId: 'spaces/conference-1' },
    ...overrides,
  };
}

function recallEnvelope(
  event: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event,
    event_id: 'recall-evt-1',
    occurredAt: '2026-09-24T13:45:00Z',
    account: { id: 'recall-acct-1' },
    platform: 'zoom',
    meeting: { id: 'recall-mtg-1', title: 'Customer onboarding' },
    session: { id: 'recall-session-1' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Zoom adapter
// ---------------------------------------------------------------------------

describe('zoom adapter', () => {
  it('parses meeting metadata events', () => {
    const record = parseOne(
      zoomAdapter,
      zoomEnvelope('meeting.updated', {
        meeting: {
          id: 'mtg-77',
          title: 'Weekly supplier review',
          agenda: 'Prices, deliveries',
          scheduled_start: '2026-09-24T09:00:00Z',
          scheduled_end: '2026-09-24T10:00:00Z',
          host: { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test' },
        },
      }),
    );
    expect(record).toEqual({
      kind: 'meeting.updated',
      providerRecordId: 'ev-0001',
      occurredAt: '2026-09-24T09:00:00Z',
      providerMeetingId: 'mtg-77',
      title: 'Weekly supplier review',
      agenda: 'Prices, deliveries',
      scheduledStartAt: '2026-09-24T09:00:00Z',
      scheduledEndAt: '2026-09-24T10:00:00Z',
      underlyingPlatform: 'zoom',
      host: {
        providerParticipantId: 'host-1',
        displayName: 'Dana Owner',
        email: 'dana@acme.test',
      },
    });
  });

  it('parses session started/ended events with participants', () => {
    const record = parseOne(
      zoomAdapter,
      zoomEnvelope('meeting.ended', {
        meeting: { id: 'mtg-77' },
        session: {
          id: 'occ-1',
          status: 'ended',
          started_at: '2026-09-24T09:00:30Z',
          ended_at: '2026-09-24T09:57:00Z',
          participants: [
            { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test', joined_at: '2026-09-24T09:00:30Z', left_at: '2026-09-24T09:57:00Z' },
            { id: 'guest-2', name: 'Sam Supplier', email: null, joined_at: '2026-09-24T09:05:00Z', left_at: null },
          ],
        },
      }),
    );
    expect(record).toMatchObject({
      kind: 'session.updated',
      providerSessionId: 'occ-1',
      status: 'ended',
      startedAt: '2026-09-24T09:00:30Z',
      endedAt: '2026-09-24T09:57:00Z',
    });
    if (record.kind === 'session.updated') {
      expect(record.participants).toEqual([
        {
          participant: { providerParticipantId: 'host-1', displayName: 'Dana Owner', email: 'dana@acme.test' },
          joinedAt: '2026-09-24T09:00:30Z',
          leftAt: '2026-09-24T09:57:00Z',
        },
        {
          participant: { providerParticipantId: 'guest-2', displayName: 'Sam Supplier', email: null },
          joinedAt: '2026-09-24T09:05:00Z',
          leftAt: null,
        },
      ]);
    }
  });

  it('parses transcript completions with speaker attribution', () => {
    const record = parseOne(
      zoomAdapter,
      zoomEnvelope('recording.transcript_completed', {
        meeting: { id: 'mtg-77' },
        session: { id: 'occ-1' },
        transcript: {
          id: 'tr-1',
          language: 'en-US',
          segments: [
            { participant_id: 'host-1', speaker_name: 'Dana', started_at: '2026-09-24T09:01:00Z', ended_at: '2026-09-24T09:01:20Z', text: 'Welcome everyone.', confidence: 0.97 },
            { participant_id: null, speaker_name: 'Unknown', started_at: '2026-09-24T09:01:25Z', ended_at: null, text: 'Hello.', confidence: null },
          ],
        },
      }),
    );
    expect(record).toMatchObject({
      kind: 'transcript.available',
      providerTranscriptId: 'tr-1',
      language: 'en-US',
    });
    if (record.kind === 'transcript.available') {
      expect(record.segments).toEqual([
        { providerParticipantId: 'host-1', speakerName: 'Dana', startedAt: '2026-09-24T09:01:00Z', endedAt: '2026-09-24T09:01:20Z', text: 'Welcome everyone.', confidence: 0.97 },
        { providerParticipantId: null, speakerName: 'Unknown', startedAt: '2026-09-24T09:01:25Z', endedAt: null, text: 'Hello.', confidence: null },
      ]);
    }
  });

  it('parses recording completions into canonical artifacts (unknown types → other)', () => {
    const base = {
      meeting: { id: 'mtg-77' },
      session: { id: 'occ-1' },
    };
    const record = parseOne(
      zoomAdapter,
      zoomEnvelope('recording.completed', {
        ...base,
        artifact: { id: 'rec-1', type: 'recording', name: 'GMT20260924.mp4', media_type: 'video/mp4', size_bytes: 1048576, storage_ref: 'provider://zoom/rec-1', checksum: 'sha256:abc' },
      }),
    );
    expect(record).toMatchObject({
      kind: 'artifact.available',
      providerArtifactId: 'rec-1',
      artifactKind: 'recording',
      byteSize: 1048576,
    });
    const exotic = parseOne(
      zoomAdapter,
      zoomEnvelope('recording.completed', {
        ...base,
        artifact: { id: 'rec-2', type: 'whiteboard' },
      }),
    );
    expect(exotic).toMatchObject({ artifactKind: 'other' });
  });

  it('parses access-denied events with canonical codes', () => {
    const record = parseOne(
      zoomAdapter,
      zoomEnvelope('meeting.access_denied', {
        access: { code: 'recording_unavailable', detail: 'Recording expired', meeting_id: 'mtg-77' },
      }),
    );
    expect(record).toEqual({
      kind: 'access.failed',
      providerRecordId: 'ev-0001',
      occurredAt: '2026-09-24T09:00:00Z',
      providerMeetingId: 'mtg-77',
      accessCode: 'recording_unavailable',
      detail: 'Recording expired',
    });
  });

  it('rejects malformed envelopes and unsupported events', () => {
    expectPayloadError(() => zoomAdapter.parseWebhook('not an object'));
    expectPayloadError(() => zoomAdapter.parseWebhook({ event: 'meeting.ended' }));
    expectCode('unsupported_provider_event', () =>
      zoomAdapter.parseWebhook(zoomEnvelope('meeting.alert')),
    );
    expectCode('unsupported_provider_event', () =>
      zoomAdapter.parseWebhook(zoomEnvelope('meeting.updated', { handshake: { challenge: 'x' } })),
    );
    expectPayloadError(() =>
      zoomAdapter.parseWebhook(
        zoomEnvelope('meeting.updated', { meeting: { id: 'mtg-77', title: 'x', scheduled_start: 'yesterday' } }),
      ),
    );
    expectPayloadError(() =>
      zoomAdapter.parseWebhook(zoomEnvelope('meeting.access_denied', { access: { code: 'nope' } })),
    );
  });

  it('normalizes account and participant ids by trimming', () => {
    expect(zoomAdapter.normalizeAccountId('  zoom-acct-1 ')).toBe('zoom-acct-1');
    expect(zoomAdapter.normalizeParticipantId(' host-1 ')).toBe('host-1');
    expectCode('invalid_meeting_input', () => zoomAdapter.normalizeAccountId('   '));
  });
});

// ---------------------------------------------------------------------------
// Microsoft Teams adapter
// ---------------------------------------------------------------------------

describe('microsoft-teams adapter', () => {
  it('parses call records and lowercases GUID identities', () => {
    const record = parseOne(
      microsoftTeamsAdapter,
      teamsEnvelope('callEnded', {
        startedAt: '2026-09-24T10:30:10Z',
        endedAt: '2026-09-24T11:25:00Z',
        participants: [
          { aadId: 'AAAAAAAA-0000-0000-0000-000000000001', displayName: 'Dana Owner', email: 'Dana@Acme.test', joinedAt: '2026-09-24T10:30:10Z', leftAt: '2026-09-24T11:25:00Z' },
        ],
      }),
    );
    expect(microsoftTeamsAdapter.parseWebhook(teamsEnvelope('callEnded')).providerAccountId).toBe(
      '7ab91c0e-1111-4222-8333-444455556666',
    );
    expect(record).toMatchObject({
      kind: 'session.updated',
      providerMeetingId: 'teams-meet-1',
      providerSessionId: 'call-1',
      status: 'ended',
    });
    if (record.kind === 'session.updated') {
      expect(record.participants[0]!.participant.providerParticipantId).toBe(
        'aaaaaaaa-0000-0000-0000-000000000001',
      );
      expect(record.participants[0]!.participant.email).toBe('Dana@Acme.test');
    }
  });

  it('parses transcript, recording and access notifications', () => {
    const transcript = parseOne(
      microsoftTeamsAdapter,
      teamsEnvelope('transcriptReady', {
        transcript: {
          id: 'tr-t1',
          language: 'en-US',
          segments: [
            { participantId: 'aaaaaaaa-0000-0000-0000-000000000001', speakerName: 'Dana', startedAt: '2026-09-24T10:31:00Z', endedAt: '2026-09-24T10:31:15Z', text: ' kicking off', confidence: 0.91 },
          ],
        },
      }),
    );
    expect(transcript).toMatchObject({ kind: 'transcript.available', providerTranscriptId: 'tr-t1' });

    const recording = parseOne(
      microsoftTeamsAdapter,
      teamsEnvelope('recordingReady', {
        recording: { id: 'rec-t1', displayName: 'Roadmap.mp4', mediaType: 'video/mp4', sizeBytes: 2048, storageRef: 'provider://teams/rec-t1', checksum: null },
      }),
    );
    expect(recording).toMatchObject({ kind: 'artifact.available', artifactKind: 'recording', byteSize: 2048 });

    const access = parseOne(
      microsoftTeamsAdapter,
      teamsEnvelope('accessDenied', { access: { code: 'access_denied', detail: 'Policy' } }),
    );
    expect(access).toMatchObject({ kind: 'access.failed', accessCode: 'access_denied' });
  });

  it('rejects validation handshakes, malformed payloads and unknown change types', () => {
    expectCode('unsupported_provider_event', () =>
      microsoftTeamsAdapter.parseWebhook({ validationToken: 'abc', ...teamsEnvelope('callEnded') }),
    );
    expectPayloadError(() =>
      microsoftTeamsAdapter.parseWebhook(teamsEnvelope('callEnded', { resourceData: 'oops' })),
    );
    expectCode('unsupported_provider_event', () =>
      microsoftTeamsAdapter.parseWebhook(teamsEnvelope('chatMessageReceived')),
    );
  });
});

// ---------------------------------------------------------------------------
// Google Meet adapter
// ---------------------------------------------------------------------------

describe('google-meet adapter', () => {
  it('parses conference records and canonicalizes kind/id resource names', () => {
    const record = parseOne(
      googleMeetAdapter,
      meetEnvelope('conferenceRecordUpdated', {
        conferenceRecord: {
          meetingId: 'spaces/conference-1',
          title: 'Design crit',
          scheduledStart: '2026-09-24T11:15:00Z',
          scheduledEnd: '2026-09-24T12:00:00Z',
          host: { userId: 'users/dana-1', name: 'Dana Owner', email: 'dana@acme.test' },
        },
      }),
    );
    expect(record).toEqual({
      kind: 'meeting.updated',
      providerRecordId: 'meet-evt-1',
      occurredAt: '2026-09-24T11:15:00Z',
      providerMeetingId: 'conference-1',
      title: 'Design crit',
      agenda: null,
      scheduledStartAt: '2026-09-24T11:15:00Z',
      scheduledEndAt: '2026-09-24T12:00:00Z',
      underlyingPlatform: 'google-meet',
      host: { providerParticipantId: 'dana-1', displayName: 'Dana Owner', email: 'dana@acme.test' },
    });
  });

  it('parses ended sessions, transcripts, recordings and access failures', () => {
    const session = parseOne(
      googleMeetAdapter,
      meetEnvelope('conferenceSessionEnded', {
        session: {
          sessionId: 'sessions/occ-9',
          startedAt: '2026-09-24T11:15:05Z',
          endedAt: '2026-09-24T12:01:00Z',
          participants: [{ userId: 'users/dana-1', name: 'Dana Owner', email: null, joinedAt: '2026-09-24T11:15:05Z', leftAt: '2026-09-24T12:01:00Z' }],
        },
      }),
    );
    expect(session).toMatchObject({ kind: 'session.updated', providerSessionId: 'occ-9', status: 'ended' });

    const transcript = parseOne(
      googleMeetAdapter,
      meetEnvelope('transcriptReady', {
        session: { sessionId: 'sessions/occ-9' },
        transcript: {
          transcriptId: 'transcripts/tr-9',
          language: 'en-US',
          segments: [{ userId: null, speakerName: 'Dana', startedAt: '2026-09-24T11:16:00Z', endedAt: null, text: 'Hi all', confidence: null }],
        },
      }),
    );
    expect(transcript).toMatchObject({ kind: 'transcript.available', providerTranscriptId: 'tr-9' });

    const recording = parseOne(
      googleMeetAdapter,
      meetEnvelope('recordingReady', {
        session: { sessionId: 'sessions/occ-9' },
        recording: { recordingId: 'recordings/rec-9', name: 'Design crit', mediaType: 'video/mp4', sizeBytes: 4096 },
      }),
    );
    expect(recording).toMatchObject({ kind: 'artifact.available', providerArtifactId: 'rec-9', byteSize: 4096 });

    const access = parseOne(
      googleMeetAdapter,
      meetEnvelope('accessDenied', { access: { code: 'not_found', detail: 'Conference record deleted' } }),
    );
    expect(access).toMatchObject({ kind: 'access.failed', accessCode: 'not_found' });
    expectPayloadError(() =>
      googleMeetAdapter.parseWebhook(meetEnvelope('accessDenied', { access: { code: 'weird' } })),
    );
  });

  it('rejects malformed payloads and unknown event types', () => {
    expectCode('unsupported_provider_event', () =>
      googleMeetAdapter.parseWebhook(meetEnvelope('spaceUpdated')));
    expectCode('unsupported_provider_event', () =>
      googleMeetAdapter.parseWebhook(meetEnvelope('unknownKind')));
    expectPayloadError(() =>
      googleMeetAdapter.parseWebhook(
        meetEnvelope('conferenceSessionEnded', { session: { sessionId: 'x', endedAt: 'soon' } }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Recall adapter (the cross-platform meeting-bot)
// ---------------------------------------------------------------------------

describe('recall adapter', () => {
  it('captures cross-platform bot events with the underlying platform key', () => {
    const record = parseOne(
      recallAdapter,
      recallEnvelope('bot.session_ended', {
        session: {
          id: 'recall-session-1',
          started_at: '2026-09-24T13:45:02Z',
          ended_at: '2026-09-24T14:30:00Z',
          participants: [{ id: 'bot-participant-1', name: 'Dana Owner', email: 'dana@acme.test', joined_at: '2026-09-24T13:45:02Z', left_at: '2026-09-24T14:30:00Z' }],
        },
      }),
    );
    expect(record).toMatchObject({
      kind: 'session.updated',
      status: 'ended',
      providerSessionId: 'recall-session-1',
    });
  });

  it('parses bot meeting metadata, transcripts, artifacts and access failures', () => {
    const metadata = parseOne(
      recallAdapter,
      recallEnvelope('bot.meeting_updated', {
        meeting: { id: 'recall-mtg-1', title: 'Customer onboarding', agenda: null, scheduled_start: null, scheduled_end: null, host: null },
      }),
    );
    expect(metadata).toMatchObject({ kind: 'meeting.updated', underlyingPlatform: 'zoom' });

    const transcript = parseOne(
      recallAdapter,
      recallEnvelope('transcript.completed', {
        session: { id: 'recall-session-1' },
        transcript: {
          id: 'recall-tr-1',
          language: 'en-US',
          segments: [{ participant_id: 'bot-participant-1', speaker_name: null, started_at: '2026-09-24T13:46:00Z', ended_at: null, text: 'Thanks for joining.', confidence: 0.88 }],
        },
      }),
    );
    expect(transcript).toMatchObject({ kind: 'transcript.available', providerTranscriptId: 'recall-tr-1' });

    const artifact = parseOne(
      recallAdapter,
      recallEnvelope('artifact.completed', {
        session: { id: 'recall-session-1' },
        artifact: { id: 'recall-art-1', type: 'chat', name: 'chat.txt', media_type: 'text/plain', size_bytes: 512, storage_ref: 'provider://recall/art-1', checksum: null },
      }),
    );
    expect(artifact).toMatchObject({ kind: 'artifact.available', artifactKind: 'chat' });

    const access = parseOne(
      recallAdapter,
      recallEnvelope('access.failed', { access: { code: 'authorization_expired', detail: 'Bot token expired' } }),
    );
    expect(access).toMatchObject({ kind: 'access.failed', accessCode: 'authorization_expired' });
  });

  it('rejects malformed platform keys and unsupported events', () => {
    expectPayloadError(() =>
      recallAdapter.parseWebhook(recallEnvelope('bot.session_ended', { platform: 'Not A Key' })),
    );
    expectCode('unsupported_provider_event', () =>
      recallAdapter.parseWebhook(recallEnvelope('bot.joined')),
    );
    expectPayloadError(() =>
      recallAdapter.parseWebhook(
        recallEnvelope('transcript.completed', { transcript: { id: 'x', segments: [] } }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

describe('adapter registry', () => {
  it('serves every canonical provider and reports its capture modes', () => {
    for (const provider of ['zoom', 'microsoft-teams', 'google-meet', 'recall'] as const) {
      const adapter = getMeetingAdapter(provider);
      expect(adapter.provider).toBe(provider);
      expect(adapter.modes).toContain('webhook');
      expect(adapter.modes).toContain('polling');
    }
    expectCode('unsupported_provider', () => getMeetingAdapter('webex'));
  });
});

// ---------------------------------------------------------------------------
// Validation layer
// ---------------------------------------------------------------------------

describe('connection input validation', () => {
  it('accepts a coherent oauth registration and rejects incoherent ones', () => {
    const valid = validateRegisterConnectionInput({
      provider: 'zoom',
      providerAccountId: 'zoom-acct-1',
      authKind: 'oauth',
      credentialRef: 'secret-store://zoom/acme',
      oauthScopes: ['meeting:read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(valid.provider).toBe('zoom');
    expect(valid.oauthScopes).toEqual(['meeting:read']);

    expectCode('invalid_meeting_input', () =>
      validateRegisterConnectionInput({ provider: 'webex', providerAccountId: 'x', authKind: 'oauth', credentialRef: 's', oauthScopes: ['a'] } as never),
    );
    expectCode('invalid_meeting_input', () =>
      validateRegisterConnectionInput({ provider: 'zoom', providerAccountId: 'x', authKind: 'credentials', credentialRef: 's', oauthScopes: ['a'] } as never),
    );
    expectCode('invalid_meeting_input', () =>
      validateRegisterConnectionInput({ provider: 'zoom', providerAccountId: 'x', authKind: 'oauth', credentialRef: 's', oauthScopes: [] } as never),
    );
    expectCode('invalid_meeting_input', () =>
      validateRegisterConnectionInput({ provider: 'zoom', providerAccountId: 'x', authKind: 'oauth', credentialRef: 's', oauthScopes: ['a'], extra: true } as never),
    );
  });

  it('validates list/poll/webhook inputs', () => {
    expect(validateListMeetingsQuery({}).limit).toBe(50);
    expectCode('invalid_meeting_query', () => validateListMeetingsQuery({ limit: 0 } as never));
    expectCode('invalid_meeting_query', () =>
      validateListMeetingsQuery({ scheduledFrom: '2026-09-24T00:00:00Z', scheduledTo: '2026-09-23T00:00:00Z' }),
    );
    expectCode('invalid_provider_payload', () =>
      validateReceiveWebhookInput({ provider: 'zoom', payload: [] } as never),
    );
    expectCode('invalid_meeting_input', () =>
      validateReceiveWebhookInput({ provider: 'webex', payload: {} } as never),
    );
  });
});

describe('canonical record validation (defense in depth)', () => {
  const validRecords = {
    meetingUpdated: {
      kind: 'meeting.updated',
      providerRecordId: 'ev-1',
      occurredAt: '2026-09-24T09:00:00Z',
      providerMeetingId: 'mtg-1',
      title: 'Weekly',
      agenda: null,
      scheduledStartAt: null,
      scheduledEndAt: null,
      underlyingPlatform: null,
      host: null,
    },
    sessionUpdated: {
      kind: 'session.updated',
      providerRecordId: 'ev-2',
      occurredAt: '2026-09-24T09:00:00Z',
      providerMeetingId: 'mtg-1',
      providerSessionId: 'occ-1',
      status: 'ended',
      title: null,
      startedAt: '2026-09-24T09:00:00Z',
      endedAt: '2026-09-24T10:00:00Z',
      participants: [],
    },
    transcriptAvailable: {
      kind: 'transcript.available',
      providerRecordId: 'ev-3',
      occurredAt: '2026-09-24T10:05:00Z',
      providerMeetingId: 'mtg-1',
      providerSessionId: 'occ-1',
      providerTranscriptId: 'tr-1',
      language: 'en-US',
      segments: [
        { providerParticipantId: 'p-1', speakerName: null, startedAt: '2026-09-24T09:01:00Z', endedAt: null, text: 'Hello', confidence: 0.9 },
      ],
    },
    artifactAvailable: {
      kind: 'artifact.available',
      providerRecordId: 'ev-4',
      occurredAt: '2026-09-24T10:10:00Z',
      providerMeetingId: 'mtg-1',
      providerSessionId: 'occ-1',
      providerArtifactId: 'rec-1',
      artifactKind: 'recording',
      displayName: null,
      mediaType: 'video/mp4',
      byteSize: 1,
      storageRef: null,
      checksum: null,
    },
    accessFailed: {
      kind: 'access.failed',
      providerRecordId: 'ev-5',
      occurredAt: '2026-09-24T10:15:00Z',
      providerMeetingId: 'mtg-1',
      accessCode: 'recording_unavailable',
      detail: 'expired',
    },
  } as const;

  const fail = (m: string): MeetingsError => new MeetingsError('invalid_provider_payload', m);

  it('accepts every valid record kind', () => {
    for (const record of Object.values(validRecords)) {
      expect(() => validateCanonicalMeetingRecord(record, fail)).not.toThrow();
    }
  });

  it('rejects the canonical failure modes per kind', () => {
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.meetingUpdated, kind: 'nope' }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.meetingUpdated, extra: 1 }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.meetingUpdated, occurredAt: '2026-09-24' }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.meetingUpdated, underlyingPlatform: 'Not-A-Key' }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.sessionUpdated, status: 'started', startedAt: null }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.sessionUpdated, endedAt: '2026-09-24T08:00:00Z' }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.transcriptAvailable, segments: [] }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord(
        {
          ...validRecords.transcriptAvailable,
          segments: [
            { providerParticipantId: null, speakerName: null, startedAt: '2026-09-24T09:02:00Z', endedAt: null, text: 'second', confidence: null },
            { providerParticipantId: null, speakerName: null, startedAt: '2026-09-24T09:01:00Z', endedAt: null, text: 'first', confidence: null },
          ],
        },
        fail,
      ));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord(
        {
          ...validRecords.transcriptAvailable,
          segments: [
            { providerParticipantId: 'p-1', speakerName: null, startedAt: '2026-09-24T09:01:00Z', endedAt: null, text: 'x', confidence: 1.5 },
          ],
        },
        fail,
      ));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.artifactAvailable, artifactKind: 'spaceship' }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.artifactAvailable, byteSize: -1 }, fail));
    expectCode('invalid_provider_payload', () =>
      validateCanonicalMeetingRecord({ ...validRecords.accessFailed, accessCode: 'meh' }, fail));
  });

  it('rejects duplicate record ids inside one batch and oversized batches', () => {
    const fetchFail = (m: string): MeetingsError => new MeetingsError('invalid_fetch_result', m);
    expectCode('invalid_fetch_result', () =>
      validateRecordBatch([validRecords.accessFailed, validRecords.accessFailed], fetchFail));
    const big = Array.from({ length: 201 }, (_, index) => ({
      ...validRecords.accessFailed,
      providerRecordId: `ev-${index}`,
    }));
    expectCode('invalid_fetch_result', () => validateRecordBatch(big, fetchFail));
  });

  it('validates webhook parse results and fetch results uniformly', () => {
    expect(() =>
      validateWebhookParseResult({ providerAccountId: 'acct-1', records: [validRecords.accessFailed] }),
    ).not.toThrow();
    expectCode('invalid_provider_payload', () =>
      validateWebhookParseResult({ providerAccountId: '', records: [] }));

    const fetchResult = {
      records: [validRecords.sessionUpdated],
      nextCursor: 'cursor-2',
      hasMore: true,
      authorizationExpiresAt: '2027-02-01T00:00:00Z',
    };
    expect(validateFetchResult(fetchResult)).toMatchObject({ nextCursor: 'cursor-2', hasMore: true });
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({ ...fetchResult, hasMore: 'yes' }));
    expectCode('invalid_fetch_result', () =>
      validateFetchResult({ ...fetchResult, nextCursor: 'x'.repeat(1025) }));
  });

  it('computes cursor advance semantics', () => {
    expect(cursorAdvance(null, 'c1')).toBe(true);
    expect(cursorAdvance('c1', 'c2')).toBe(true);
    expect(cursorAdvance('c1', 'c1')).toBe(false);
    expect(cursorAdvance('c1', null)).toBe(false);
  });

  it('guards the vocabulary predicates', () => {
    expect(isMeetingProvider('recall')).toBe(true);
    expect(isMeetingProvider('webex')).toBe(false);
    expect(isMeetingAccessCode('not_found')).toBe(true);
    expect(isMeetingAccessCode('lost')).toBe(false);
  });
});
