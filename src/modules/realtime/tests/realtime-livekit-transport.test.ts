// Deterministic tests for the REAL livekit transport (W109) — the
// vendor-shape layer in the W108 cellular discipline: every provider
// call is exercised against a LOCAL Twirp stub over real HTTP (no
// external network), asserting the EXACT wire shapes the LiveKit API
// expects (paths, JSON bodies, Bearer JWT grants) and the honest failure
// taxonomy. The stub is the deterministic double of LiveKit Cloud; the
// LIVE leg against the operator's real project is a separately-labeled,
// credential-gated test (realtime-livekit-live.test.ts).
//
//  * wire shapes — CreateRoom/DeleteRoom/SendData/StartRoomCompositeEgress/
//    StopEgress/ListEgress/CreateSIPParticipant requests carry the exact
//    documented fields; the admin token is a verifiable HS256 JWT with
//    the expected per-call video grants;
//  * room lifecycle — startRoom mints the deterministic room name and
//    echoes the agent identity; stopRoom deletes by name;
//  * speech publish — SendData base64 payload carries the response id
//    (the transport's idempotency key), the agent identity and the text;
//  * join grants — minted tokens carry roomJoin/canSubscribe/
//    canPublishData for exactly the target room and never the admin
//    grants; the url is the project WebSocket URL;
//  * recording control — without an egress destination the transport
//    fails provider_unavailable BEFORE any provider call; with one, the
//    egress lifecycle is driven and a file result maps to the canonical
//    opaque artifact info (a stream-only egress honestly reports none);
//  * telephony — without a SIP trunk the transport fails
//    provider_unavailable before any provider call;
//  * failure taxonomy — provider 4xx/5xx bodies surface as
//    transport_failed carrying the provider's own code; a non-JSON body
//    and a network refusal are equally explicit; nothing is a fake
//    success;
//  * provider isolation — nothing the transport returns or throws
//    carries a provider SDK object: only opaque ids and canonical codes.

import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createLivekitTransport,
  type LivekitTransportConfig,
} from '../adapters/transport-livekit';
import { LivekitStubServer, type RecordedCall } from './livekit-stub-server';
import { RealtimeError } from '../errors';

// ---------------------------------------------------------------------------
// JWT verification (the stub side of the auth contract)
// ---------------------------------------------------------------------------

const API_KEY = 'APItestkey0000000000000000000000000000000000000';
const API_SECRET = 'secret-under-test-00000000000000000000000000000000';

function decodeToken(call: RecordedCall): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const bearer = call.token;
  if (!bearer.startsWith('Bearer ')) throw new Error('missing Bearer authorization');
  const token = bearer.slice('Bearer '.length);
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  const expected = createHmac('sha256', API_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  expect(parts[2]).toBe(expected); // the signature must verify against the configured secret
  return {
    header: JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let stub: LivekitStubServer;

function transport(overrides: Partial<LivekitTransportConfig> = {}) {
  return createLivekitTransport({
    url: stub.url,
    apiKey: API_KEY,
    apiSecret: API_SECRET,
    accountId: 'stub-project.example',
    egressStreamUrl: 'rtmp://egress.invalid/live/aurum-test',
    sipTrunkId: 'st-stub-trunk',
    ...overrides,
  });
}

/** The provider-neutral request facets every transport call carries. */
function callFacets(sessionId: string, room: string) {
  return {
    provider: 'livekit' as const,
    tenantId: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    providerAccountId: 'stub-project.example',
    credentialRef: 'secret-store:livekit/test',
    sessionId,
    providerRoomId: room,
  };
}

function expectTransportError(fn: () => Promise<unknown>, messagePart: string): Promise<void> {
  return fn().then(
    () => {
      throw new Error('expected a transport failure but the call succeeded');
    },
    (error: unknown) => {
      if (!(error instanceof RealtimeError)) throw error;
      expect(error.code).toBe('transport_failed');
      expect(error.message).toContain(messagePart);
    },
  );
}

beforeAll(async () => {
  stub = new LivekitStubServer();
  await stub.start();
});

afterAll(async () => {
  await stub.close();
});

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

describe('livekit transport — room lifecycle wire shapes', () => {
  it('startRoom calls CreateRoom with the deterministic room name and scoped admin grants', async () => {
    const t = transport();
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const handle = await t.startRoom({
      ...callFacets(sessionId, 'aurum-irrelevant'),
      kind: 'meeting_companion',
      agentParticipantId: `aurum-agent-${sessionId}`,
      title: 'W109 shape test',
    });
    expect(handle).toEqual({
      providerRoomId: `aurum-${sessionId}`,
      agentParticipantId: `aurum-agent-${sessionId}`,
    });
    const call = stub.callsOf('livekit.RoomService/CreateRoom')[0]!;
    expect(call.body).toEqual({ name: `aurum-${sessionId}`, empty_timeout: 300 });
    const { payload } = decodeToken(call);
    expect(payload.iss).toBe(API_KEY);
    expect(payload.video).toMatchObject({
      roomCreate: true,
      roomList: true,
      roomAdmin: true,
      roomRecord: true,
      room: `aurum-${sessionId}`,
    });
    // Short-lived admin token.
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(300);
  });

  it('rejects a CreateRoom answer without a usable room handle', async () => {
    stub.breakCreateRoom = true;
    try {
      const t = transport();
      await expectTransportError(
        () =>
          t.startRoom({
            ...callFacets('44444444-4444-4444-8444-444444444444', 'x'),
            kind: 'aurum_voice',
            agentParticipantId: 'aurum-agent-x',
            title: null,
          }),
        'unusable room handle',
      );
    } finally {
      stub.breakCreateRoom = false;
    }
  });

  it('stopRoom calls DeleteRoom with the room name', async () => {
    const t = transport();
    const room = 'aurum-55555555-5555-4555-8555-555555555555';
    await t.stopRoom({ ...callFacets('55555555-5555-4555-8555-555555555555', room) });
    const call = stub.callsOf('livekit.RoomService/DeleteRoom').at(-1)!;
    expect(call.body).toEqual({ room });
    const { payload } = decodeToken(call);
    expect(payload.video).toMatchObject({ roomAdmin: true, room });
  });
});

describe('livekit transport — speech publish (SendData)', () => {
  it('publishes the response payload on the reliable channel under the aurum topic', async () => {
    const t = transport();
    const sessionId = '66666666-6666-4666-8666-666666666666';
    const room = `aurum-${sessionId}`;
    await t.speak({
      ...callFacets(sessionId, room),
      responseId: 'resp-shape-1',
      agentParticipantId: `aurum-agent-${sessionId}`,
      text: 'Hello from the deterministic shape test',
    });
    const call = stub.callsOf('livekit.RoomService/SendData')[0]!;
    expect(call.body).toEqual({
      room,
      data: Buffer.from(
        JSON.stringify({
          responseId: 'resp-shape-1',
          agentParticipantId: `aurum-agent-${sessionId}`,
          text: 'Hello from the deterministic shape test',
        }),
        'utf8',
      ).toString('base64'),
      kind: 'RELIABLE',
      topic: 'aurum.response',
    });
  });
});

describe('livekit transport — join grants', () => {
  it('mints a room-scoped join token without admin grants and returns the project URL', async () => {
    const t = transport();
    const room = 'aurum-77777777-7777-4777-8777-777777777777';
    const grant = await t.createJoinGrant({
      ...callFacets('77777777-7777-4777-8777-777777777777', room),
      displayName: 'W109 Shape Tester',
    });
    expect(grant.url).toBe(stub.url);
    expect(grant.expiresAt).toBeTruthy();
    const parts = grant.token.split('.');
    expect(parts).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    expect(payload.iss).toBe(API_KEY);
    expect(payload.sub).toBe('W109-Shape-Tester');
    expect(payload.video).toEqual({
      roomJoin: true,
      room,
      canSubscribe: true,
      canPublish: false,
      canPublishData: true,
    });
    // A join grant is never an admin credential.
    expect(payload.video).not.toHaveProperty('roomAdmin');
    expect(payload.video).not.toHaveProperty('roomCreate');
  });

  it('sanitizes display names into LiveKit-acceptable identities and defaults guests', async () => {
    const t = transport();
    const room = 'aurum-88888888-8888-4888-8888-888888888888';
    const hostile = await t.createJoinGrant({
      ...callFacets('88888888-8888-4888-8888-888888888888', room),
      displayName: 'weird identity!! with spaces/and/slashes',
    });
    const payload = JSON.parse(
      Buffer.from(hostile.token.split('.')[1]!, 'base64url').toString('utf8'),
    );
    expect(payload.sub).toBe('weird-identity---with-spaces-and-slashes');
    const guest = await t.createJoinGrant({
      ...callFacets('88888888-8888-4888-8888-888888888888', room),
      displayName: null,
    });
    const guestPayload = JSON.parse(
      Buffer.from(guest.token.split('.')[1]!, 'base64url').toString('utf8'),
    );
    expect(guestPayload.sub).toMatch(/^guest-\d+$/);
  });
});

describe('livekit transport — recording control (egress)', () => {
  it('fails provider_unavailable BEFORE any provider call when no egress destination is configured', async () => {
    const t = transport({ egressStreamUrl: null });
    const before = stub.calls.length;
    await expect(() =>
      t.startRecording(callFacets('99999999-9999-4999-8999-999999999999', 'aurum-x')),
    ).rejects.toMatchObject({
      code: 'provider_unavailable',
      message: expect.stringContaining('LIVEKIT_EGRESS_STREAM_URL'),
    });
    expect(stub.calls.length).toBe(before);
  });

  it('starts the audio-only room-composite egress on the configured stream and stops it', async () => {
    const t = transport();
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const room = `aurum-${sessionId}`;
    await t.startRecording(callFacets(sessionId, room));
    const start = stub.callsOf('livekit.Egress/StartRoomCompositeEgress')[0]!;
    expect(start.body).toEqual({
      roomName: room,
      audioOnly: true,
      stream: { protocol: 'RTMP', urls: ['rtmp://egress.invalid/live/aurum-test'] },
    });
    const { payload } = decodeToken(start);
    expect(payload.video).toMatchObject({ roomRecord: true, room });

    const stopped = await t.stopRecording(callFacets(sessionId, room));
    expect(stopped.artifact).toBeNull(); // a stream-only egress has no file artifact
    const stop = stub.callsOf('livekit.Egress/StopEgress')[0]!;
    expect(stop.body).toEqual({ egressId: 'EG_stub_1' });
  });

  it('maps a real egress file result onto the canonical opaque artifact info', async () => {
    stub.egressStop = {
      egress_id: 'EG_stub_file',
      status: 'EGRESS_COMPLETE',
      file_results: [
        {
          filename: 'aurum-session-recording',
          size: '4096',
          location: 's3://bucket/aurum-session.ogg',
        },
      ],
    };
    try {
      const t = transport();
      const sessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const room = `aurum-${sessionId}`;
      await t.startRecording(callFacets(sessionId, room));
      const { artifact } = await t.stopRecording(callFacets(sessionId, room));
      expect(artifact).toEqual({
        providerArtifactId: 'EG_stub_file',
        storageRef: 's3://bucket/aurum-session.ogg',
        mediaType: 'audio/ogg',
        byteSize: 4096,
        checksum: null,
      });
    } finally {
      stub.egressStop = { egress_id: 'EG_stub_1', status: 'EGRESS_COMPLETE' };
    }
  });

  it('recovers the egress id through ListEgress after a transport reconstruction', async () => {
    const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const room = `aurum-${sessionId}`;
    const first = transport();
    await first.startRecording(callFacets(sessionId, room));
    // A NEW transport instance (process restart) knows no egress mapping.
    const second = transport();
    await second.stopRecording(callFacets(sessionId, room));
    const list = stub.callsOf('livekit.Egress/ListEgress')[0]!;
    expect(list.body).toEqual({ roomName: room });
    const stop = stub.callsOf('livekit.Egress/StopEgress').at(-1)!;
    expect(stop.body).toEqual({ egressId: 'EG_stub_recovered' });
  });
});

describe('livekit transport — telephony (SIP dial-out)', () => {
  it('fails provider_unavailable BEFORE any provider call when no trunk is configured', async () => {
    const t = transport({ sipTrunkId: null });
    const before = stub.calls.length;
    await expect(() =>
      t.dial({
        ...callFacets('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'aurum-x'),
        phoneNumber: '+15551234567',
        displayName: 'Test Party',
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(stub.calls.length).toBe(before);
  });

  it('dials through CreateSIPParticipant with the documented fields', async () => {
    const t = transport();
    const sessionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const room = `aurum-${sessionId}`;
    const dialed = await t.dial({
      ...callFacets(sessionId, room),
      phoneNumber: '+15551234567',
      displayName: 'Test Party',
    });
    expect(dialed.providerParticipantId).toBe('PA_sip_1');
    const call = stub.callsOf('livekit.SIP/CreateSIPParticipant')[0]!;
    expect(call.body).toEqual({
      sipTrunkId: 'st-stub-trunk',
      sipCallTo: '+15551234567',
      roomName: room,
      participantIdentity: 'sip-15551234567',
    });
  });

  it('surfaces the provider refusal honestly', async () => {
    stub.sipParticipant = {
      status: 401,
      body: JSON.stringify({ code: 'unauthenticated', msg: 'permissions denied' }),
    };
    try {
      const t = transport();
      await expectTransportError(
        () =>
          t.dial({
            ...callFacets('ffffffff-ffff-4fff-8fff-ffffffffffff', 'aurum-x'),
            phoneNumber: '+15551234567',
            displayName: null,
          }),
        'permissions denied',
      );
    } finally {
      stub.sipParticipant = { participant_id: 'PA_sip_1' };
    }
  });
});

describe('livekit transport — the honest failure taxonomy', () => {
  it('maps provider 4xx/5xx bodies onto transport_failed with the provider code', async () => {
    stub.failMode = {
      status: 500,
      body: JSON.stringify({ code: 'internal', msg: 'egress service overloaded' }),
    };
    try {
      const t = transport();
      await expectTransportError(
        () => t.stopRoom(callFacents2()),
        'egress service overloaded',
      );
    } finally {
      stub.failMode = null;
    }
  });

  it('maps a non-JSON provider body onto transport_failed', async () => {
    stub.failMode = { status: 200, body: 'OK' };
    try {
      const t = transport();
      const sessionId = '12121212-1212-4121-8121-121212121212';
      await expectTransportError(
        () =>
          t.startRoom({
            ...callFacets(sessionId, 'x'),
            kind: 'aurum_voice',
            agentParticipantId: 'a',
            title: null,
          }),
        'non-JSON',
      );
    } finally {
      stub.failMode = null;
    }
  });

  it('maps a network refusal onto transport_failed (never a fake success)', async () => {
    const t = createLivekitTransport({
      url: 'http://127.0.0.1:1', // nothing listens here
      apiKey: API_KEY,
      apiSecret: API_SECRET,
      accountId: 'dead',
      egressStreamUrl: null,
      sipTrunkId: null,
    });
    await expectTransportError(
      () =>
        t.startRoom({
          ...callFacets('13131313-1313-4131-8131-131313131313', 'x'),
          kind: 'aurum_voice',
          agentParticipantId: 'a',
          title: null,
        }),
      'did not reach the provider',
    );
  });
});

function callFacents2() {
  return callFacets('14141414-1414-4141-8141-141414141414', 'aurum-x');
}
