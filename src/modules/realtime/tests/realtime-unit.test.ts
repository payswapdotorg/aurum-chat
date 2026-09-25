// Unit tests for the realtime module's PURE surface (W086): validation
// vocabulary, input guards, adapter envelope parsing and the
// defense-in-depth re-validation — no database, no clock, no network.
//
//  * vocabulary guards — providers, session kinds/statuses, event kinds,
//    E.164/uuid/ISO primitives;
//  * connection registration — api_key/oauth coherence (an api_key
//    connection carries no OAuth state; an oauth one declares scopes);
//  * session start — kind/dial coupling (telephony requires a dial
//    target, others forbid one), meetingSessionId coupling
//    (aurum_voice/telephony carry none);
//  * speak/dial/consent/query guards — bounds, uuid checks, unknown-key
//    rejection (a caller can never smuggle identity or tenancy);
//  * livekit adapter — envelope → canonical events for every kind,
//    batch envelopes, malformed envelopes, unsupported (non-record)
//    envelopes, failure-code canonicalization, deterministic agent
//    identity;
//  * openai-realtime adapter — the same canonical journey from a
//    materially different wire shape (provider-swap evidence, GOVERNANCE:
//    the same canonical capability through two providers);
//  * defense in depth — adapter output re-validation rejects unknown
//    kinds, domain-only kinds from providers, unknown facets and
//    out-of-bound values; provider-swap structural identity — the same
//    journey through both adapters yields identical canonical shapes
//    (kind/occurredAt/facets) modulo provider-minted opaque ids.

import { describe, expect, it } from 'vitest';
import { livekitAdapter } from '../adapters/livekit';
import { openaiRealtimeAdapter } from '../adapters/openai-realtime';
import { allRealtimeAdapters } from '../adapters';
import { RealtimeError } from '../errors';
import {
  isE164,
  isRealtimeProvider,
  isUuid,
  validateCanonicalEvent,
  validateDialInput,
  validateEventParseResult,
  validateListSessionsQuery,
  validateRecordConsentInput,
  validateRegisterConnectionInput,
  validateSpeakInput,
  validateStartSessionInput,
} from '../validation';

const UUID = '7f9c1f4a-51d6-4a8e-9c3b-2d6e8f0a1b2c';
const OTHER_UUID = '0a1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d';

function expectCode(code: RealtimeError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected RealtimeError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof RealtimeError)) throw error;
    expect(error.code).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

describe('realtime vocabulary guards', () => {
  it('accepts exactly the two canonical transport providers', () => {
    expect(isRealtimeProvider('livekit')).toBe(true);
    expect(isRealtimeProvider('openai-realtime')).toBe(true);
    expect(isRealtimeProvider('twilio')).toBe(false);
    expect(isRealtimeProvider('')).toBe(false);
    expect(isRealtimeProvider(null)).toBe(false);
  });

  it('validates uuids and E.164 numbers', () => {
    expect(isUuid(UUID)).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isE164('+15551234567')).toBe(true);
    expect(isE164('5551234567')).toBe(false);
    expect(isE164('+0155123456')).toBe(false);
  });

  it('registers one adapter per canonical provider (exhaustiveness)', () => {
    expect(allRealtimeAdapters().map((a) => a.provider).sort()).toEqual([
      'livekit',
      'openai-realtime',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Connection registration
// ---------------------------------------------------------------------------

describe('realtime connection registration validation', () => {
  it('accepts an api_key connection and normalizes the account id', () => {
    const valid = validateRegisterConnectionInput({
      provider: 'livekit',
      providerAccountId: '  proj-main  ',
      authKind: 'api_key',
      credentialRef: 'secret-store:ref-1',
    });
    expect(valid.providerAccountId).toBe('proj-main');
    expect(valid.oauthScopes).toEqual([]);
    expect(valid.oauthExpiresAt).toBeNull();
  });

  it('rejects OAuth state on an api_key connection', () => {
    expectCode('invalid_realtime_input', () =>
      validateRegisterConnectionInput({
        provider: 'livekit',
        providerAccountId: 'proj-main',
        authKind: 'api_key',
        credentialRef: 'secret-store:ref-1',
        oauthScopes: ['rooms:write'],
      }),
    );
  });

  it('requires scopes on an oauth connection', () => {
    expectCode('invalid_realtime_input', () =>
      validateRegisterConnectionInput({
        provider: 'openai-realtime',
        providerAccountId: 'proj_x',
        authKind: 'oauth',
        credentialRef: 'secret-store:ref-1',
      }),
    );
    const valid = validateRegisterConnectionInput({
      provider: 'openai-realtime',
      providerAccountId: 'proj_x',
      authKind: 'oauth',
      credentialRef: 'secret-store:ref-1',
      oauthScopes: ['realtime:sessions'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    expect(valid.oauthScopes).toEqual(['realtime:sessions']);
  });

  it('rejects unknown fields (no identity/tenancy smuggling)', () => {
    expectCode('invalid_realtime_input', () =>
      validateRegisterConnectionInput({
        provider: 'livekit',
        providerAccountId: 'proj-main',
        authKind: 'api_key',
        credentialRef: 'secret-store:ref-1',
        tenantId: UUID,
      } as Parameters<typeof validateRegisterConnectionInput>[0]),
    );
  });
});

// ---------------------------------------------------------------------------
// Session start / dial / consent / speak
// ---------------------------------------------------------------------------

describe('realtime session input validation', () => {
  it('couples the telephony kind to a dial target', () => {
    expectCode('invalid_realtime_input', () =>
      validateStartSessionInput({ connectionId: UUID, kind: 'telephony' }),
    );
    expectCode('invalid_realtime_input', () =>
      validateStartSessionInput({
        connectionId: UUID,
        kind: 'aurum_voice',
        dial: { phoneNumber: '+15551234567' },
      }),
    );
    const valid = validateStartSessionInput({
      connectionId: UUID,
      kind: 'telephony',
      dial: { phoneNumber: '+15551234567', displayName: 'Sarah Field' },
    });
    expect(valid.dial).toEqual({ phoneNumber: '+15551234567', displayName: 'Sarah Field' });
  });

  it('rejects malformed dial numbers', () => {
    expectCode('invalid_realtime_input', () =>
      validateStartSessionInput({
        connectionId: UUID,
        kind: 'telephony',
        dial: { phoneNumber: '555-1234' },
      }),
    );
    expectCode('invalid_realtime_input', () =>
      validateDialInput({ sessionId: UUID, phoneNumber: 'call sarah' }),
    );
  });

  it('couples meetingSessionId to the meeting kinds', () => {
    expectCode('invalid_realtime_input', () =>
      validateStartSessionInput({
        connectionId: UUID,
        kind: 'aurum_voice',
        meetingSessionId: UUID,
      }),
    );
    const valid = validateStartSessionInput({
      connectionId: UUID,
      kind: 'meeting_companion',
      meetingSessionId: UUID,
      title: 'Site walk',
    });
    expect(valid.meetingSessionId).toBe(UUID);
    expect(valid.title).toBe('Site walk');
  });

  it('guards consent, speak and query inputs', () => {
    expectCode('invalid_realtime_input', () =>
      validateRecordConsentInput({
        sessionId: UUID,
        participantId: OTHER_UUID,
        consent: 'maybe',
      } as unknown as Parameters<typeof validateRecordConsentInput>[0]),
    );
    expectCode('invalid_realtime_input', () =>
      validateSpeakInput({ sessionId: UUID, text: '' }),
    );
    expect(
      validateSpeakInput({ sessionId: UUID, text: 'Understood.', inReplyToTurnId: OTHER_UUID }),
    ).toEqual({ sessionId: UUID, text: 'Understood.', inReplyToTurnId: OTHER_UUID });
    expectCode('invalid_realtime_query', () =>
      validateListSessionsQuery({ limit: 0 } as Parameters<typeof validateListSessionsQuery>[0]),
    );
    expect(validateListSessionsQuery({})).toEqual({
      connectionId: null,
      kind: null,
      status: null,
      limit: 50,
    });
  });
});

// ---------------------------------------------------------------------------
// The livekit adapter
// ---------------------------------------------------------------------------

const LIVEKIT_ROOM = 'RM_room-1';
const LIVEKIT_ACCOUNT = 'proj-main';

function livekitEnvelope(
  type: string,
  eventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    event_id: eventId,
    occurredAt: '2026-09-25T10:00:00Z',
    account: { id: LIVEKIT_ACCOUNT },
    room: { id: LIVEKIT_ROOM },
    ...overrides,
  };
}

describe('livekit adapter', () => {
  it('parses the room lifecycle', () => {
    const started = livekitAdapter.parseEvent(livekitEnvelope('room.started', 'evt-1'));
    expect(started).toEqual({
      providerAccountId: LIVEKIT_ACCOUNT,
      events: [
        {
          kind: 'session.started',
          providerEventId: 'evt-1',
          occurredAt: '2026-09-25T10:00:00Z',
          providerRoomId: LIVEKIT_ROOM,
        },
      ],
    });
    const ended = livekitAdapter.parseEvent(
      livekitEnvelope('room.finished', 'evt-2', { end: { reason: 'finished' } }),
    );
    expect(ended.events[0]).toMatchObject({
      kind: 'session.ended',
      reason: 'provider_ended',
      endedAt: '2026-09-25T10:00:00Z',
    });
  });

  it('parses participant joins with the phone path', () => {
    const joined = livekitAdapter.parseEvent(
      livekitEnvelope('participant.connected', 'evt-3', {
        participant: {
          identity: 'sip:+15551234567',
          name: 'Sarah (mobile)',
          email: null,
          phone: '+15551234567',
        },
      }),
    );
    expect(joined.events[0]).toMatchObject({
      kind: 'participant.joined',
      providerParticipantId: 'sip:+15551234567',
      phone: '+15551234567',
      joinedAt: '2026-09-25T10:00:00Z',
    });
  });

  it('parses a finalized transcript with speaker attribution', () => {
    const parsed = livekitAdapter.parseEvent(
      livekitEnvelope('transcript.finalized', 'evt-4', {
        transcript: {
          participant_id: 'p-dana',
          speaker_name: 'Dana',
          started_at: '2026-09-25T10:01:00Z',
          ended_at: '2026-09-25T10:01:12Z',
          text: 'Welcome everyone.',
          confidence: 0.97,
        },
      }),
    );
    expect(parsed.events[0]).toMatchObject({
      kind: 'transcript.final',
      providerParticipantId: 'p-dana',
      text: 'Welcome everyone.',
      confidence: 0.97,
    });
  });

  it('parses response lifecycle, consent, recording and failure events', () => {
    expect(
      livekitAdapter.parseEvent(
        livekitEnvelope('response.interrupted', 'evt-5', {
          response: { id: UUID, interrupted_by: 'p-dana' },
        }),
      ).events[0],
    ).toMatchObject({
      kind: 'response.interrupted',
      responseId: UUID,
      interruptingProviderParticipantId: 'p-dana',
    });
    expect(
      livekitAdapter.parseEvent(
        livekitEnvelope('consent.granted', 'evt-6', { participant: { identity: 'p-dana' } }),
      ).events[0],
    ).toMatchObject({ kind: 'consent.granted', providerParticipantId: 'p-dana' });
    expect(
      livekitAdapter.parseEvent(
        livekitEnvelope('egress.ended', 'evt-7', {
          recording: {
            artifact: {
              id: 'rec-9',
              storage_ref: 'provider://livekit/rec-9',
              media_type: 'audio/ogg',
              size_bytes: 2048,
              checksum: 'sha256:aa',
            },
          },
        }),
      ).events[0],
    ).toMatchObject({
      kind: 'recording.stopped',
      artifact: { providerArtifactId: 'rec-9', byteSize: 2048 },
    });
    expect(
      livekitAdapter.parseEvent(
        livekitEnvelope('agent.failed', 'evt-8', {
          failure: { code: 'agent_disconnected', detail: 'worker died' },
        }),
      ).events[0],
    ).toMatchObject({ kind: 'session.failed', code: 'agent_disconnected' });
    expect(
      livekitAdapter.parseEvent(
        livekitEnvelope('agent.failed', 'evt-9', { failure: { code: 'weird_code' } }),
      ).events[0],
    ).toMatchObject({ kind: 'session.failed', code: 'provider_error' });
  });

  it('parses batch envelopes and rejects cross-account batches', () => {
    const batch = livekitAdapter.parseEvent({
      events: [
        livekitEnvelope('room.started', 'b-1'),
        livekitEnvelope('participant.connected', 'b-2', {
          participant: { identity: 'p-dana', name: 'Dana', email: null, phone: null },
        }),
      ],
    });
    expect(batch.events).toHaveLength(2);
    expectCode('invalid_provider_payload', () =>
      livekitAdapter.parseEvent({
        events: [
          livekitEnvelope('room.started', 'b-3'),
          livekitEnvelope('room.started', 'b-4', { account: { id: 'other' } }),
        ],
      }),
    );
  });

  it('rejects malformed and non-record envelopes', () => {
    expectCode('invalid_provider_payload', () =>
      livekitAdapter.parseEvent({ type: 'room.started', event_id: '' }),
    );
    expectCode('invalid_provider_payload', () =>
      livekitAdapter.parseEvent({ type: 'teleport.requested', event_id: 'x' }),
    );
    expectCode('unsupported_provider_event', () =>
      livekitAdapter.parseEvent(livekitEnvelope('webhook.verify', 'evt-v')),
    );
  });

  it('mints a deterministic per-session agent identity', () => {
    expect(livekitAdapter.agentParticipantId(UUID)).toBe(`aurum-agent-${UUID}`);
    expect(livekitAdapter.agentParticipantId(UUID)).toBe(livekitAdapter.agentParticipantId(UUID));
  });
});

// ---------------------------------------------------------------------------
// The openai-realtime adapter (the second conforming provider)
// ---------------------------------------------------------------------------

const OPENAI_ROOM = 'sess_AA1';
const OPENAI_PROJECT = 'proj_x';

function openaiEnvelope(
  type: string,
  eventId: string,
  data: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    event_id: eventId,
    ts: '2026-09-25T10:00:00Z',
    project_id: OPENAI_PROJECT,
    room_id: OPENAI_ROOM,
    data,
  };
}

describe('openai-realtime adapter', () => {
  it('parses the same canonical journey from a different wire shape', () => {
    expect(openaiRealtimeAdapter.parseEvent(openaiEnvelope('session.created', 'o-1')).events[0])
      .toMatchObject({
        kind: 'session.started',
        providerEventId: 'o-1',
        occurredAt: '2026-09-25T10:00:00Z',
        providerRoomId: OPENAI_ROOM,
      });
    expect(
      openaiRealtimeAdapter.parseEvent(
        openaiEnvelope('participant.joined', 'o-2', {
          participant_id: 'p-dana',
          display_name: 'Dana',
          email: 'dana@acme.test',
        }),
      ).events[0],
    ).toMatchObject({
      kind: 'participant.joined',
      providerParticipantId: 'p-dana',
      displayName: 'Dana',
      email: 'dana@acme.test',
    });
    expect(
      openaiRealtimeAdapter.parseEvent(
        openaiEnvelope('conversation.item.input_transcribed', 'o-3', {
          participant_id: 'p-dana',
          text: 'Welcome everyone.',
          confidence: 0.91,
        }),
      ).events[0],
    ).toMatchObject({ kind: 'transcript.final', text: 'Welcome everyone.' });
    expect(
      openaiRealtimeAdapter.parseEvent(
        openaiEnvelope('response.cancelled', 'o-4', {
          response_id: UUID,
          interrupted_by: 'p-dana',
        }),
      ).events[0],
    ).toMatchObject({
      kind: 'response.interrupted',
      responseId: UUID,
      interruptingProviderParticipantId: 'p-dana',
    });
    expect(
      openaiRealtimeAdapter.parseEvent(
        openaiEnvelope('recording.stopped', 'o-5', {
          artifact: { artifact_id: 'rec-1', bytes: 512, sha256: 'sha256:bb' },
        }),
      ).events[0],
    ).toMatchObject({
      kind: 'recording.stopped',
      artifact: { providerArtifactId: 'rec-1', byteSize: 512, checksum: 'sha256:bb' },
    });
    expect(
      openaiRealtimeAdapter.parseEvent(
        openaiEnvelope('session.error', 'o-6', { error_code: 'server_error' }),
      ).events[0],
    ).toMatchObject({ kind: 'session.failed', code: 'provider_error' });
  });

  it('rejects malformed envelopes and health pings', () => {
    expectCode('invalid_provider_payload', () =>
      openaiRealtimeAdapter.parseEvent({ type: 'session.created' }),
    );
    expectCode('unsupported_provider_event', () =>
      openaiRealtimeAdapter.parseEvent(openaiEnvelope('health.ping', 'o-7')),
    );
  });

  it('mints its own deterministic agent identity style', () => {
    expect(openaiRealtimeAdapter.agentParticipantId(UUID)).toBe(`aurum_${UUID}`);
  });
});

// ---------------------------------------------------------------------------
// Provider-swap structural identity (GOVERNANCE provider swap evidence)
// ---------------------------------------------------------------------------

describe('provider swap evidence (structural)', () => {
  it('the same canonical journey through both providers yields identical canonical shapes', () => {
    const when = '2026-09-25T10:00:00Z';
    const viaLivekit = livekitAdapter.parseEvent(
      livekitEnvelope('participant.connected', 'evt-x', {
        participant: { identity: 'p-1', name: 'Dana', email: 'dana@acme.test', phone: null },
      }),
    ).events;
    const viaOpenai = openaiRealtimeAdapter.parseEvent(
      openaiEnvelope('participant.joined', 'o-x', {
        participant_id: 'p-1',
        display_name: 'Dana',
        email: 'dana@acme.test',
      }),
    ).events;
    expect(viaLivekit).toHaveLength(1);
    expect(viaOpenai).toHaveLength(1);
    // Identical canonical facets; only the provider-minted ids differ.
    const { providerEventId: _lk, providerRoomId: _lkr, ...lkFacets } = viaLivekit[0]!;
    const { providerEventId: _oa, providerRoomId: _oar, ...oaFacets } = viaOpenai[0]!;
    expect(_lkr).not.toBe(_oar); // provider-minted opaque room refs
    expect(lkFacets).toEqual(oaFacets);
    expect(lkFacets).toMatchObject({
      kind: 'participant.joined',
      occurredAt: when,
      providerParticipantId: 'p-1',
      displayName: 'Dana',
      email: 'dana@acme.test',
    });
  });
});

// ---------------------------------------------------------------------------
// Defense in depth — adapter output re-validation
// ---------------------------------------------------------------------------

describe('canonical event re-validation (defense in depth)', () => {
  it('accepts a well-formed canonical event', () => {
    const valid = validateCanonicalEvent({
      kind: 'session.started',
      providerEventId: 'evt-1',
      occurredAt: '2026-09-25T10:00:00Z',
      providerRoomId: LIVEKIT_ROOM,
    });
    expect(valid.kind).toBe('session.started');
  });

  it('rejects unknown and domain-only kinds from a provider path', () => {
    expectCode('invalid_provider_payload', () =>
      validateCanonicalEvent({
        kind: 'teleport.requested',
        providerEventId: 'x',
        occurredAt: '2026-09-25T10:00:00Z',
        providerRoomId: 'r',
      }),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalEvent({
        kind: 'recording.blocked', // domain-only — providers cannot deliver it
        providerEventId: 'x',
        occurredAt: '2026-09-25T10:00:00Z',
        providerRoomId: 'r',
      }),
    );
  });

  it('rejects unknown facets and out-of-bound values', () => {
    expectCode('invalid_provider_payload', () =>
      validateCanonicalEvent({
        kind: 'session.started',
        providerEventId: 'evt-1',
        occurredAt: '2026-09-25T10:00:00Z',
        providerRoomId: LIVEKIT_ROOM,
        sneaky: 'provider object',
      }),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalEvent({
        kind: 'transcript.final',
        providerEventId: 'evt-2',
        occurredAt: '2026-09-25T10:00:00Z',
        providerRoomId: LIVEKIT_ROOM,
        startedAt: '2026-09-25T10:00:00Z',
        text: 'x'.repeat(8001),
      }),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalEvent({
        kind: 'transcript.final',
        providerEventId: 'evt-3',
        occurredAt: '2026-09-25T10:00:00Z',
        providerRoomId: LIVEKIT_ROOM,
        startedAt: '2026-09-25T10:00:00Z',
        text: 'hi',
        confidence: 1.5,
      }),
    );
  });

  it('re-validates a whole parse result and bounds batch sizes', () => {
    const parsed = livekitAdapter.parseEvent(
      livekitEnvelope('room.started', 'evt-ok'),
    );
    expect(validateEventParseResult(parsed).events).toHaveLength(1);
    const oversized = {
      providerAccountId: LIVEKIT_ACCOUNT,
      events: Array.from({ length: 201 }, (_, i) =>
        validateCanonicalEvent({
          kind: 'session.started',
          providerEventId: `evt-${i}`,
          occurredAt: '2026-09-25T10:00:00Z',
          providerRoomId: LIVEKIT_ROOM,
        }),
      ),
    };
    expectCode('invalid_provider_payload', () => validateEventParseResult(oversized));
  });
});
