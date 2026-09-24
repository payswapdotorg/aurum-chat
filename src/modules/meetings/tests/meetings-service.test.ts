// Integration tests for the meetings module against the embedded PostgreSQL
// (PGlite, `:memory:`) through the db port. Covers the W085 acceptance:
// "meeting metadata, participant identity, transcript/artifact and
// provenance are captured into the canonical evidence model;
// provider-specific schemas remain inside adapters; failed/expired meeting
// access is explicit."
//
//  * registration — creation, idempotent re-registration as the
//    re-authorization path (authorization fields move, identity does not),
//    account normalization, uniform cross-tenant not-found discipline
//    (ADR-0001);
//  * webhook capture — the zoom end-to-end journey (metadata → session with
//    participants → transcript → artifact → access failure): registry rows,
//    immutable observations through the observations contract (W004) with
//    provenance/channel/lineage/confidence, ledger links;
//  * participant identity — get-or-create on sight (one registry row across
//    sessions), display facets move forward without erasure, and the
//    read-only W002 verified-email bridge resolves (and refuses to resolve)
//    organizational persons;
//  * dedupe — webhook redelivery, poll re-fetch of the same window and
//    poll/webhook overlap all suppress against the ingestion ledger: one
//    observation per provider record id, ever;
//  * polling — fetch through the provider-neutral transport port (opaque
//    credentialRef, cursor advance, hasMore), fetch failures leave the
//    cursor unchanged, transport-reported grant refreshes update the
//    recorded expiry;
//  * explicit access failures — a lapsed recorded OAuth grant fails fast
//    (`meeting_authorization_expired`) AND leaves a queryable access event;
//    provider-delivered access failures become access events AND
//    observations;
//  * provider swap evidence (GOVERNANCE) — the same canonical meeting
//    journey captured through zoom, microsoft-teams, google-meet and recall
//    yields identical canonical domain state (same observation kinds and
//    registry shapes, provider keys aside);
//  * tenant isolation — another tenant's connections, meetings, sessions,
//    participants and access events are indistinguishable from missing;
//  * storage discipline — transcripts/artifacts/access events are
//    append-only (UPDATE/DELETE/TRUNCATE rejected), the ingestion ledger
//    link is one-way, session identity is frozen from creation;
//  * crash recovery — a claim that never linked is re-captured when the
//    provider delivers the record again;
//  * serialization — a concurrent capture pass on the same connection
//    fails explicitly with `ingestion_busy`.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as meetingsContract from '../contract';
import {
  attestIdentity,
  attachVerifiedSubject,
  registerExternalIdentity,
} from '@/modules/identity/contract';
import { getObservation, listObservations } from '@/modules/observations/contract';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { getLock } from '@/infra/lock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { MeetingsError } from '../errors';
import { runMigrations } from '../../../../scripts/migrate';
import type { MeetingFetchRequest, MeetingFetchResult, MeetingTransport } from '../types';

const {
  getMeeting,
  getMeetingConnection,
  getMeetingSession,
  listMeetingAccessEvents,
  listMeetingArtifacts,
  listMeetingConnections,
  listMeetingParticipants,
  listMeetings,
  listMeetingSessions,
  listMeetingTranscripts,
  pollMeetingConnection,
  receiveMeetingWebhook,
  registerMeetingConnection,
  setMeetingConnectionStatus,
  setMeetingTransport,
} = meetingsContract;

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantRegister = newId();
const tenantRegisterList = newId();
const tenantJourney = newId();
const tenantSkeleton = newId();
const tenantParticipants = newId();
const tenantDedupe = newId();
const tenantPoll = newId();
const tenantAccess = newId();
const tenantAccessProvider = newId();
const tenantSwap = newId();
const tenantIsolation = newId();
const tenantStorage = newId();
const tenantRecovery = newId();
const tenantBusy = newId();
const tenantB = newId();
const tenantC = newId();

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

function identityManager(tenantId: string): TenantContext {
  return member(tenantId, ['identity:attest', 'identity:link']);
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

// ---------------------------------------------------------------------------
// Fixtures — the documented zoom envelope shape (see adapters/zoom.ts)
// ---------------------------------------------------------------------------

function zoomEnvelope(
  event: string,
  event_id: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    event,
    event_id,
    occurredAt: '2026-09-24T09:00:00Z',
    account: { id: 'zoom-acct-1' },
    meeting: { id: 'mtg-77', title: 'Weekly supplier review' },
    ...overrides,
  };
}

const ZOOM_META = (eventId: string) =>
  zoomEnvelope('meeting.updated', eventId, {
    meeting: {
      id: 'mtg-77',
      title: 'Weekly supplier review',
      agenda: 'Prices, deliveries',
      scheduled_start: '2026-09-24T09:00:00Z',
      scheduled_end: '2026-09-24T10:00:00Z',
      host: { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test' },
    },
  });

/** A metadata envelope whose meeting/account are parameterized. */
const zoomMetaFor = (eventId: string, accountId: string, meetingId: string, title: string) =>
  zoomEnvelope('meeting.updated', eventId, {
    account: { id: accountId },
    meeting: {
      id: meetingId,
      title,
      agenda: null,
      scheduled_start: null,
      scheduled_end: null,
      host: null,
    },
  });

const ZOOM_SESSION = (eventId: string, status: 'started' | 'ended') =>
  zoomEnvelope(status === 'started' ? 'meeting.started' : 'meeting.ended', eventId, {
    meeting: { id: 'mtg-77' },
    session: {
      id: 'occ-1',
      status,
      started_at: '2026-09-24T09:00:30Z',
      ended_at: status === 'ended' ? '2026-09-24T09:57:00Z' : null,
      participants: [
        { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test', joined_at: '2026-09-24T09:00:30Z', left_at: status === 'ended' ? '2026-09-24T09:57:00Z' : null },
        { id: 'guest-2', name: 'Sam Supplier', email: null, joined_at: '2026-09-24T09:05:00Z', left_at: null },
      ],
    },
  });

const ZOOM_TRANSCRIPT = (eventId: string) =>
  zoomEnvelope('recording.transcript_completed', eventId, {
    meeting: { id: 'mtg-77' },
    session: { id: 'occ-1' },
    transcript: {
      id: 'tr-1',
      language: 'en-US',
      segments: [
        { participant_id: 'host-1', speaker_name: 'Dana', started_at: '2026-09-24T09:01:00Z', ended_at: '2026-09-24T09:01:20Z', text: 'Welcome everyone.', confidence: 0.97 },
        { participant_id: 'guest-2', speaker_name: 'Sam', started_at: '2026-09-24T09:01:25Z', ended_at: null, text: 'Thanks for having me.', confidence: 0.88 },
      ],
    },
  });

const ZOOM_ARTIFACT = (eventId: string) =>
  zoomEnvelope('recording.completed', eventId, {
    meeting: { id: 'mtg-77' },
    session: { id: 'occ-1' },
    artifact: { id: 'rec-1', type: 'recording', name: 'GMT20260924.mp4', media_type: 'video/mp4', size_bytes: 1048576, storage_ref: 'provider://zoom/rec-1', checksum: 'sha256:abc' },
  });

const ZOOM_ACCESS = (eventId: string) =>
  zoomEnvelope('meeting.access_denied', eventId, {
    access: { code: 'recording_unavailable', detail: 'Recording expired', meeting_id: 'mtg-77' },
  });

/** A provider-neutral transport that records every fetch request. */
class ScriptedTransport implements MeetingTransport {
  readonly requests: MeetingFetchRequest[] = [];
  private scripted: (MeetingFetchResult | Error)[] = [];

  /** Queue exact results/throws (consumed in order); unscripted fetches return an empty exhausted window. */
  script(...results: (MeetingFetchResult | Error)[]): void {
    this.scripted.push(...results);
  }

  async fetch(request: MeetingFetchRequest): Promise<MeetingFetchResult> {
    this.requests.push(request);
    const next = this.scripted.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

let transport: ScriptedTransport;

const BASE_TIME = Date.parse('2026-09-24T08:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

/** A polled canonical record (what a real zoom transport would normalize). */
function polledTranscript(eventId: string, providerTranscriptId: string): MeetingFetchResult {
  return {
    records: [
      {
        kind: 'transcript.available',
        providerRecordId: eventId,
        occurredAt: '2026-09-24T10:05:00Z',
        providerMeetingId: 'mtg-77',
        providerSessionId: 'occ-1',
        providerTranscriptId,
        language: 'en-US',
        segments: [
          { providerParticipantId: 'host-1', speakerName: null, startedAt: '2026-09-24T09:01:00Z', endedAt: null, text: 'Welcome everyone.', confidence: null },
        ],
      },
    ],
    nextCursor: 'poll-cursor-1',
    hasMore: false,
  };
}

let accountCounter = 0;
async function registerZoom(
  tenantId: string,
  overrides: Partial<Parameters<typeof registerMeetingConnection>[1]> = {},
): Promise<string> {
  // Default account ids are unique per call so every test owns a fresh
  // connection even inside a shared tenant (fixed accounts are passed
  // explicitly where a webhook envelope must resolve onto the connection).
  accountCounter += 1;
  const { connection } = await registerMeetingConnection(member(tenantId), {
    provider: 'zoom',
    providerAccountId: `zoom-acct-${accountCounter}`,
    displayName: 'Acme Zoom',
    authKind: 'oauth',
    credentialRef: 'secret-store://zoom/acme',
    oauthScopes: ['meeting:read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
    ...overrides,
  });
  return connection.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setMeetingTransport(null);
  await closeDb();
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
  transport = new ScriptedTransport();
  setMeetingTransport(transport);
});

afterEach(() => {
  vi.restoreAllMocks();
  setMeetingTransport(null);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe('connection registration', () => {
  it('creates a connection with canonical account id and derived modes', async () => {
    const { connection, created } = await registerMeetingConnection(member(tenantRegister), {
      provider: 'microsoft-teams',
      providerAccountId: '  7AB91C0E-1111-4222-8333-444455556666  ',
      authKind: 'oauth',
      credentialRef: 'secret-store://teams/acme',
      oauthScopes: ['onlineMeeting.read'],
      oauthExpiresAt: '2027-06-01T00:00:00Z',
    });
    expect(created).toBe(true);
    expect(connection.provider).toBe('microsoft-teams');
    expect(connection.providerAccountId).toBe('7ab91c0e-1111-4222-8333-444455556666');
    expect(connection.modes).toEqual(['webhook', 'polling']);
    expect(connection.status).toBe('active');
    expect(connection.credentialRef).toBe('secret-store://teams/acme');
  });

  it('re-registers as the re-authorization path (identity never moves)', async () => {
    const ctx = member(tenantRegister);
    const first = await registerMeetingConnection(ctx, {
      provider: 'zoom',
      providerAccountId: 'zoom-fixed-1',
      authKind: 'oauth',
      credentialRef: 'secret-store://zoom/old',
      oauthScopes: ['meeting:read'],
      oauthExpiresAt: '2026-12-01T00:00:00Z',
    });
    expect(first.created).toBe(true);
    advance(60);
    const second = await registerMeetingConnection(ctx, {
      provider: 'zoom',
      providerAccountId: 'zoom-fixed-1',
      displayName: 'Renamed',
      authKind: 'credentials',
      credentialRef: 'secret-store://zoom/new',
    });
    expect(second.created).toBe(false);
    expect(second.connection.id).toBe(first.connection.id);
    expect(second.connection.authKind).toBe('credentials');
    expect(second.connection.credentialRef).toBe('secret-store://zoom/new');
    expect(second.connection.oauthScopes).toEqual([]);
    expect(second.connection.oauthExpiresAt).toBeNull();
    // Authorization state moved; creation audit did not.
    expect(second.connection.createdAt).toBe(first.connection.createdAt);
  });

  it('lists by provider/status and flips status', async () => {
    const ctx = member(tenantRegisterList);
    const zoomId = await registerZoom(tenantRegisterList);
    await registerMeetingConnection(ctx, {
      provider: 'recall',
      providerAccountId: 'recall-ops',
      authKind: 'credentials',
      credentialRef: 'secret-store://recall/ops',
    });
    const zoomOnly = await listMeetingConnections(ctx, { provider: 'zoom' });
    expect(zoomOnly).toHaveLength(1);
    expect(zoomOnly[0]!.id).toBe(zoomId);

    const disabled = await setMeetingConnectionStatus(ctx, { connectionId: zoomId, status: 'disabled' });
    expect(disabled.status).toBe('disabled');
    const activeOnly = await listMeetingConnections(ctx, { status: 'active' });
    expect(activeOnly.every((connection) => connection.provider !== 'zoom' || connection.id !== zoomId)).toBe(true);

    await expectCode('connection_not_found', () =>
      setMeetingConnectionStatus(member(tenantB), { connectionId: zoomId, status: 'active' }));
    await expectCode('connection_not_found', () => getMeetingConnection(member(tenantB), zoomId));
  });

  it('rejects incoherent registrations before touching the database', async () => {
    const ctx = member(tenantRegister);
    await expectCode('invalid_meeting_input', () =>
      registerMeetingConnection(ctx, {
        provider: 'zoom',
        providerAccountId: 'x',
        authKind: 'credentials',
        credentialRef: 's',
        oauthScopes: ['a'],
      } as never));
    await expectCode('invalid_meeting_input', () =>
      registerMeetingConnection(ctx, {
        provider: 'webex',
        providerAccountId: 'x',
        authKind: 'credentials',
        credentialRef: 's',
      } as never));
  });
});

// ---------------------------------------------------------------------------
// The zoom capture journey (webhook path, end to end)
// ---------------------------------------------------------------------------

describe('webhook capture — the canonical evidence model', () => {
  it('captures meeting metadata, sessions, participants, transcripts, artifacts and access failures', async () => {
    const ctx = member(tenantJourney);
    const connectionId = await registerZoom(tenantJourney, { providerAccountId: 'zoom-acct-1' });

    // 1. metadata
    const meta = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('ev-meta') });
    expect(meta.ingested).toBe(1);
    expect(meta.records[0]!.providerRecordId).toBe('ev-meta');

    const meeting = (await listMeetings(ctx, {}))[0]!;
    expect(meeting.provider).toBe('zoom');
    expect(meeting.providerMeetingId).toBe('mtg-77');
    expect(meeting.title).toBe('Weekly supplier review');
    expect(meeting.agenda).toBe('Prices, deliveries');
    expect(meeting.scheduledStartAt).toBe('2026-09-24T09:00:00.000Z');
    expect(meeting.underlyingPlatform).toBe('zoom');
    expect(meeting.hostParticipantId).not.toBeNull();

    // 2. session started, then ended
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_SESSION('ev-start', 'started') });
    advance(120);
    const ended = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_SESSION('ev-end', 'ended') });
    expect(ended.ingested).toBe(1);

    const sessions = await listMeetingSessions(ctx, { meetingId: meeting.id });
    expect(sessions).toHaveLength(1);
    const session = sessions[0]!;
    expect(session.providerSessionId).toBe('occ-1');
    expect(session.status).toBe('ended');
    expect(session.startedAt).toBe('2026-09-24T09:00:30.000Z');
    expect(session.endedAt).toBe('2026-09-24T09:57:00.000Z');
    expect(session.participants).toHaveLength(2);
    expect(session.participants[0]!.providerParticipantId).toBe('host-1');
    expect(session.participants[1]!.providerParticipantId).toBe('guest-2');

    // 3. transcript
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_TRANSCRIPT('ev-tr') });
    const transcripts = await listMeetingTranscripts(ctx, { sessionId: session.id });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.providerTranscriptId).toBe('tr-1');
    expect(transcripts[0]!.language).toBe('en-US');
    expect(transcripts[0]!.segments).toHaveLength(2);
    expect(transcripts[0]!.segments[0]!.participantId).not.toBeNull();
    expect(transcripts[0]!.segments[0]!.text).toBe('Welcome everyone.');
    expect(transcripts[0]!.capturedVia).toBe('webhook');

    // 4. artifact
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_ARTIFACT('ev-art') });
    const artifacts = await listMeetingArtifacts(ctx, { sessionId: session.id });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.kind).toBe('recording');
    expect(artifacts[0]!.providerArtifactId).toBe('rec-1');
    expect(artifacts[0]!.byteSize).toBe(1048576);
    expect(artifacts[0]!.storageRef).toBe('provider://zoom/rec-1');

    // 5. explicit access failure
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_ACCESS('ev-acc') });
    const access = await listMeetingAccessEvents(ctx, { connectionId });
    expect(access).toHaveLength(1);
    expect(access[0]!.code).toBe('recording_unavailable');
    expect(access[0]!.providerMeetingId).toBe('mtg-77');

    // 6. EVERYTHING above became immutable observations with provenance.
    const observed = await listObservations(ctx, { channel: 'zoom' });
    expect(observed).toHaveLength(6);
    const kinds = observed.map((observation) => observation.kind).sort();
    expect(kinds).toEqual([
      'meeting.access',
      'meeting.artifact',
      'meeting.metadata',
      'meeting.session',
      'meeting.session',
      'meeting.transcript',
    ]);
    for (const observation of observed) {
      // Provenance: the capture connection, the gateway label, the
      // provider key as channel, connector lineage, explicit confidence.
      expect(observation.source).toEqual({ kind: 'external', id: connectionId, label: 'meetings' });
      expect(observation.channel).toBe('zoom');
      expect(observation.lineage.method).toBe('connector');
      expect(observation.lineage.parents).toEqual([]);
      expect(observation.confidence.value).toBe(1);
      expect(observation.confidence.method).toBe('meeting_gateway');
      expect(observation.observedAt).toBe('2026-09-24T09:00:00.000Z');
    }

    // The transcript observation carries the segment-level speaker
    // attribution (participant identity captured into the evidence model).
    const transcriptObservation = observed.find((observation) => observation.kind === 'meeting.transcript')!;
    const payload = transcriptObservation.payload as {
      segments: { participantId: string | null; text: string }[];
    };
    expect(payload.segments[0]!.text).toBe('Welcome everyone.');
    expect(payload.segments[0]!.participantId).not.toBeNull();

    // The ledger links every provider record to its observation.
    const ledger = await getDb().query<{ provider_record_id: string; observation_id: string }>(
      `SELECT provider_record_id, observation_id FROM meeting_ingestion
         WHERE tenant_id = $1 AND connection_id = $2 ORDER BY claimed_at`,
      [tenantJourney, connectionId],
    );
    expect(ledger.rows).toHaveLength(6);
    expect(ledger.rows.every((row) => row.observation_id !== null)).toBe(true);
    const linked = await getObservation(ctx, ledger.rows[0]!.observation_id);
    expect(linked.id).toBe(ledger.rows[0]!.observation_id);
  });

  it('creates skeletons when sessions arrive before metadata', async () => {
    const ctx = member(tenantSkeleton);
    await registerZoom(tenantSkeleton, { providerAccountId: 'zoom-acct-1' });
    await receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: zoomEnvelope('recording.transcript_completed', 'ev-tr-first', {
        meeting: { id: 'mtg-88' },
        session: { id: 'occ-2' },
        transcript: {
          id: 'tr-early',
          language: 'en-US',
          segments: [
            { participant_id: 'host-1', speaker_name: null, started_at: '2026-09-24T09:01:00Z', ended_at: null, text: 'Hello.', confidence: null },
          ],
        },
      }),
    });
    const meetings = await listMeetings(ctx, {});
    expect(meetings).toHaveLength(1);
    expect(meetings[0]!.providerMeetingId).toBe('mtg-88');
    expect(meetings[0]!.title).toBeNull();
    const sessions = await listMeetingSessions(ctx, { meetingId: meetings[0]!.id });
    expect(sessions[0]!.status).toBe('ended');

    // Metadata arriving later fills the skeleton in place (no fork).
    await receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: zoomMetaFor('ev-meta-late', 'zoom-acct-1', 'mtg-88', 'Late metadata'),
    });
    const filled = (await listMeetings(ctx, {}))[0]!;
    expect(filled.id).toBe(meetings[0]!.id);
    expect(filled.title).toBe('Late metadata');
  });

  it('rejects foreign accounts, disabled connections and malformed payloads uniformly', async () => {
    const ctx = member(tenantJourney);
    // The account belongs to tenantB — indistinguishable from unknown.
    await registerMeetingConnection(member(tenantB), {
      provider: 'zoom',
      providerAccountId: 'zoom-acct-b',
      authKind: 'credentials',
      credentialRef: 'secret-store://zoom/b',
    });
    await expectCode('connection_not_found', () =>
      receiveMeetingWebhook(ctx, { provider: 'zoom', payload: zoomEnvelope('meeting.updated', 'ev-x', { account: { id: 'zoom-acct-b' } }) }));

    const own = await registerZoom(tenantJourney, { providerAccountId: 'zoom-acct-own' });
    await setMeetingConnectionStatus(ctx, { connectionId: own, status: 'disabled' });
    await expectCode('connection_disabled', () =>
      receiveMeetingWebhook(ctx, { provider: 'zoom', payload: zoomMetaFor('ev-disabled', 'zoom-acct-own', 'mtg-77', 'Disabled') }));

    await setMeetingConnectionStatus(ctx, { connectionId: own, status: 'active' });
    await expectCode('invalid_provider_payload', () =>
      receiveMeetingWebhook(ctx, { provider: 'zoom', payload: { event: 'meeting.updated' } }));
    await expectCode('unsupported_provider_event', () =>
      receiveMeetingWebhook(ctx, { provider: 'zoom', payload: zoomEnvelope('meeting.alert', 'ev-alert') }));
  });
});

// ---------------------------------------------------------------------------
// Participant identity (registry + the W002 verified-email bridge)
// ---------------------------------------------------------------------------

describe('participant identity capture', () => {
  it('captures participants on sight with stable registry ids across sessions', async () => {
    const ctx = member(tenantParticipants);
    await registerZoom(tenantParticipants, { providerAccountId: 'zoom-acct-1' });
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_SESSION('ev-s1', 'ended') });

    const participants = await listMeetingParticipants(ctx, { provider: 'zoom' });
    expect(participants).toHaveLength(2);
    const dana = participants.find((p) => p.providerParticipantId === 'host-1')!;
    expect(dana.displayName).toBe('Dana Owner');
    expect(dana.email).toBe('dana@acme.test');
    expect(dana.subjectId).toBeNull();
    expect(dana.resolvedVia).toBeNull();

    // A second session with the same participant reuses the registry row.
    await receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: zoomEnvelope('meeting.ended', 'ev-s2', {
        meeting: { id: 'mtg-99' },
        session: {
          id: 'occ-2',
          status: 'ended',
          started_at: '2026-09-25T09:00:00Z',
          ended_at: '2026-09-25T09:30:00Z',
          participants: [{ id: 'host-1', name: 'Dana Q. Owner', email: null, joined_at: null, left_at: null }],
        },
      }),
    });
    const after = await listMeetingParticipants(ctx, { provider: 'zoom' });
    expect(after).toHaveLength(2);
    const danaAgain = after.find((p) => p.providerParticipantId === 'host-1')!;
    expect(danaAgain.id).toBe(dana.id);
    // Richer display facets move forward; nulls never erase what was learned.
    expect(danaAgain.displayName).toBe('Dana Q. Owner');
    expect(danaAgain.email).toBe('dana@acme.test');
  });

  it('resolves participants onto persons through VERIFIED email identities only', async () => {
    const ctx = member(tenantParticipants);
    const manager = identityManager(tenantParticipants);
    const subjectId = newId();

    // An UNVERIFIED email identity must NOT resolve the participant.
    await registerExternalIdentity(ctx, {
      provider: 'email',
      providerAccountId: 'unverified@acme.test',
    });
    // A VERIFIED, subject-linked email identity MUST.
    const { identity } = await registerExternalIdentity(ctx, {
      provider: 'email',
      providerAccountId: 'verified@acme.test',
    });
    const verified = await attestIdentity(manager, {
      identityId: identity.id,
      evidence: 'HR confirmed account ownership',
    });
    await attachVerifiedSubject(manager, { identityId: verified.id, subjectId });

    await registerZoom(tenantParticipants, { providerAccountId: 'zoom-acct-1' });
    await receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: zoomEnvelope('meeting.ended', 'ev-res', {
        meeting: { id: 'mtg-1' },
        session: {
          id: 'occ-1',
          status: 'ended',
          started_at: '2026-09-24T09:00:00Z',
          ended_at: '2026-09-24T09:30:00Z',
          participants: [
            { id: 'u-1', name: 'Unverified Person', email: 'unverified@acme.test', joined_at: null, left_at: null },
            { id: 'v-1', name: 'Verified Person', email: 'verified@acme.test', joined_at: null, left_at: null },
            { id: 'n-1', name: 'No Email', email: null, joined_at: null, left_at: null },
          ],
        },
      }),
    });

    const participants = await listMeetingParticipants(ctx, { provider: 'zoom' });
    const unverified = participants.find((p) => p.providerParticipantId === 'u-1')!;
    const verifiedP = participants.find((p) => p.providerParticipantId === 'v-1')!;
    const noEmail = participants.find((p) => p.providerParticipantId === 'n-1')!;
    expect(unverified.subjectId).toBeNull();
    expect(verifiedP.subjectId).toBe(subjectId);
    expect(verifiedP.resolvedVia).toBe('verified_email_identity');
    expect(noEmail.subjectId).toBeNull();

    // A later capture may resolve what an earlier one could not: the
    // participant gains an email in a subsequent session.
    await registerExternalIdentity(ctx, { provider: 'email', providerAccountId: 'noemail@acme.test' });
    const lateIdentity = await attestIdentity(manager, {
      identityId: (await registerExternalIdentity(ctx, { provider: 'email', providerAccountId: 'noemail@acme.test' })).identity.id,
      evidence: 'late confirmation',
    });
    await attachVerifiedSubject(manager, { identityId: lateIdentity.id, subjectId: newId() });
    await receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: zoomEnvelope('meeting.ended', 'ev-res-2', {
        meeting: { id: 'mtg-2' },
        session: {
          id: 'occ-9',
          status: 'ended',
          started_at: '2026-09-25T09:00:00Z',
          ended_at: '2026-09-25T09:30:00Z',
          participants: [{ id: 'n-1', name: 'No Email', email: 'noemail@acme.test', joined_at: null, left_at: null }],
        },
      }),
    });
    const resolvedLate = (await listMeetingParticipants(ctx, { provider: 'zoom' })).find(
      (p) => p.providerParticipantId === 'n-1',
    )!;
    expect(resolvedLate.subjectId).not.toBeNull();
    expect(resolvedLate.resolvedVia).toBe('verified_email_identity');
  });
});

// ---------------------------------------------------------------------------
// Dedupe (the ingestion ledger)
// ---------------------------------------------------------------------------

describe('dedupe', () => {
  it('suppresses webhook redeliveries, poll re-fetches and poll/webhook overlap', async () => {
    const ctx = member(tenantDedupe);
    const connectionId = await registerZoom(tenantDedupe, { providerAccountId: 'zoom-acct-1' });

    const first = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_TRANSCRIPT('ev-tr') });
    expect(first.ingested).toBe(1);

    const redelivery = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_TRANSCRIPT('ev-tr') });
    expect(redelivery.fetched).toBe(1);
    expect(redelivery.ingested).toBe(0);
    expect(redelivery.duplicates).toBe(1);

    // Poll overlap: the transport re-delivers the same record id.
    transport.script(polledTranscript('ev-tr', 'tr-1'));
    const poll = await pollMeetingConnection(ctx, { connectionId });
    expect(poll.fetched).toBe(1);
    expect(poll.ingested).toBe(0);
    expect(poll.duplicates).toBe(1);

    // A fresh record id inside the same window ingests exactly once.
    transport.script(polledTranscript('ev-tr-2', 'tr-2'));
    const poll2 = await pollMeetingConnection(ctx, { connectionId });
    expect(poll2.ingested).toBe(1);
    expect(poll2.duplicates).toBe(0);

    const observed = await listObservations(ctx, { channel: 'zoom' });
    expect(observed).toHaveLength(2); // ev-tr and ev-tr-2 (redelivery suppressed)
    const transcripts = await getDb().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM meeting_transcripts WHERE tenant_id = $1`,
      [tenantDedupe],
    );
    expect(Number(transcripts.rows[0]!.count)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

describe('polling', () => {
  it('fetches through the transport port with opaque credentials and advances the cursor', async () => {
    const ctx = member(tenantPoll);
    const connectionId = await registerZoom(tenantPoll, { providerAccountId: 'zoom-acct-1' });

    transport.script(polledTranscript('ev-tr', 'tr-1'));
    const result = await pollMeetingConnection(ctx, { connectionId });
    expect(result.ingested).toBe(1);
    expect(result.hasMore).toBe(false);
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      provider: 'zoom',
      tenantId: tenantPoll,
      connectionId,
      providerAccountId: 'zoom-acct-1',
      credentialRef: 'secret-store://zoom/acme',
      cursor: null,
      maxRecords: 50,
    });

    const cursorRow = await getDb().query<{ cursor: string }>(
      `SELECT cursor FROM meeting_ingestion_cursors WHERE tenant_id = $1 AND connection_id = $2`,
      [tenantPoll, connectionId],
    );
    expect(cursorRow.rows[0]!.cursor).toBe('poll-cursor-1');

    // The next poll resumes from the recorded cursor.
    transport.script({ records: [], nextCursor: 'poll-cursor-2', hasMore: true });
    await pollMeetingConnection(ctx, { connectionId, maxRecords: 10 });
    expect(transport.requests[1]!.cursor).toBe('poll-cursor-1');
    expect(transport.requests[1]!.maxRecords).toBe(10);
  });

  it('fails explicitly without a transport or on fetch errors (cursor unchanged)', async () => {
    const ctx = member(tenantPoll);
    const connectionId = await registerZoom(tenantPoll, { providerAccountId: 'zoom-acct-1' });

    setMeetingTransport(null);
    await expectCode('provider_unavailable', () => pollMeetingConnection(ctx, { connectionId }));
    setMeetingTransport(transport);

    transport.script(polledTranscript('ev-tr', 'tr-1'));
    await pollMeetingConnection(ctx, { connectionId });
    transport.script(new Error('connection reset'));
    await expectCode('fetch_failed', () => pollMeetingConnection(ctx, { connectionId }));
    // The cursor is unchanged after the failed poll.
    const cursorRow = await getDb().query<{ cursor: string }>(
      `SELECT cursor FROM meeting_ingestion_cursors WHERE tenant_id = $1 AND connection_id = $2`,
      [tenantPoll, connectionId],
    );
    expect(cursorRow.rows[0]!.cursor).toBe('poll-cursor-1');
  });

  it('records transport-reported grant refreshes and refuses foreign connections', async () => {
    const ctx = member(tenantPoll);
    const connectionId = await registerZoom(tenantPoll, { providerAccountId: 'zoom-acct-1' });

    transport.script({
      records: [],
      nextCursor: null,
      hasMore: false,
      authorizationExpiresAt: '2028-03-01T00:00:00Z',
    });
    const refreshed = await pollMeetingConnection(ctx, { connectionId });
    expect(refreshed.connection.oauthExpiresAt).toBe('2028-03-01T00:00:00.000Z');

    await expectCode('connection_not_found', () =>
      pollMeetingConnection(member(tenantB), { connectionId }));
  });
});

// ---------------------------------------------------------------------------
// Explicit failed/expired access
// ---------------------------------------------------------------------------

describe('explicit access failures', () => {
  it('fails fast on a lapsed grant AND records a queryable access event', async () => {
    const ctx = member(tenantAccess);
    const connectionId = await registerZoom(tenantAccess, {
      providerAccountId: 'zoom-acct-1',
      oauthExpiresAt: '2026-09-24T08:30:00Z', // lapses mid-test
    });

    // Before expiry: capture works.
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('ev-meta') });
    expect((await listMeetings(ctx, {})).length).toBe(1);

    advance(3600); // past the grant expiry

    await expectCode('meeting_authorization_expired', () =>
      receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_SESSION('ev-after', 'started') }));
    await expectCode('meeting_authorization_expired', () =>
      pollMeetingConnection(ctx, { connectionId }));

    const events = await listMeetingAccessEvents(ctx, { connectionId, code: 'authorization_expired' });
    expect(events).toHaveLength(1);
    expect(events[0]!.occurredAt).toBe('2026-09-24T09:00:00.000Z');

    // Re-registering (the re-authorization path) unblocks capture.
    await registerMeetingConnection(ctx, {
      provider: 'zoom',
      providerAccountId: 'zoom-acct-1',
      authKind: 'oauth',
      credentialRef: 'secret-store://zoom/acme',
      oauthScopes: ['meeting:read'],
      oauthExpiresAt: '2027-01-01T00:00:00Z',
    });
    const recovered = await receiveMeetingWebhook(ctx, {
      provider: 'zoom',
      payload: ZOOM_SESSION('ev-after', 'started'),
    });
    expect(recovered.ingested).toBe(1);
  });

  it('records provider-delivered access failures as events AND observations', async () => {
    const ctx = member(tenantAccessProvider);
    const connectionId = await registerZoom(tenantAccessProvider, { providerAccountId: 'zoom-acct-1' });
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_ACCESS('ev-acc') });

    const events = await listMeetingAccessEvents(ctx, { connectionId });
    expect(events).toHaveLength(1);
    const observations = await listObservations(ctx, { kind: 'meeting.access' });
    expect(observations).toHaveLength(1);
    expect((observations[0]!.payload as { accessCode: string }).accessCode).toBe('recording_unavailable');
  });
});

// ---------------------------------------------------------------------------
// Provider swap evidence (GOVERNANCE)
// ---------------------------------------------------------------------------

describe('provider swap evidence — one canonical model, four providers', () => {
  it('captures the same meeting journey through zoom, teams, meet and recall into identical canonical shapes', async () => {
    const journeys: Array<{
      provider: 'zoom' | 'microsoft-teams' | 'google-meet' | 'recall';
      register: () => Promise<string>;
      metadata: unknown;
      session: unknown;
      transcript: unknown;
      artifact: unknown;
    }> = [
      {
        provider: 'zoom',
        register: () => registerZoom(tenantSwap, { providerAccountId: 'zoom-acct-1' }),
        metadata: zoomEnvelope('meeting.updated', 'swap-zoom-meta', {
          meeting: {
            id: 'mtg-77',
            title: 'Provider swap journey',
            agenda: null,
            scheduled_start: '2026-09-24T09:00:00Z',
            scheduled_end: '2026-09-24T10:00:00Z',
            host: { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test' },
          },
        }),
        session: zoomEnvelope('meeting.ended', 'swap-zoom-end', {
          meeting: { id: 'mtg-77' },
          session: {
            id: 'occ-1',
            status: 'ended',
            started_at: '2026-09-24T09:00:30Z',
            ended_at: '2026-09-24T09:57:00Z',
            participants: [
              { id: 'host-1', name: 'Dana Owner', email: 'dana@acme.test', joined_at: '2026-09-24T09:00:30Z', left_at: '2026-09-24T09:57:00Z' },
            ],
          },
        }),
        transcript: ZOOM_TRANSCRIPT('swap-zoom-tr'),
        artifact: ZOOM_ARTIFACT('swap-zoom-art'),
      },
      {
        provider: 'microsoft-teams',
        register: () =>
          registerMeetingConnection(member(tenantSwap), {
            provider: 'microsoft-teams',
            providerAccountId: '7ab91c0e-1111-4222-8333-444455556666',
            authKind: 'oauth',
            credentialRef: 'secret-store://teams/acme',
            oauthScopes: ['onlineMeeting.read'],
            oauthExpiresAt: '2027-01-01T00:00:00Z',
          }).then((r) => r.connection.id),
        metadata: {
          id: 'swap-teams-meta',
          tenantId: '7ab91c0e-1111-4222-8333-444455556666',
          occurredAt: '2026-09-24T09:00:00Z',
          changeType: 'onlineMeetingUpdated',
          resourceData: {
            onlineMeetingId: 'teams-meet-1',
            title: 'Provider swap journey',
            agenda: null,
            scheduledStart: '2026-09-24T09:00:00Z',
            scheduledEnd: '2026-09-24T10:00:00Z',
            host: { aadId: 'AAAAAAAA-0000-0000-0000-000000000001', displayName: 'Dana Owner', email: 'dana@acme.test' },
          },
        },
        session: {
          id: 'swap-teams-end',
          tenantId: '7ab91c0e-1111-4222-8333-444455556666',
          occurredAt: '2026-09-24T09:57:00Z',
          changeType: 'callEnded',
          resourceData: {
            onlineMeetingId: 'teams-meet-1',
            callId: 'call-1',
            startedAt: '2026-09-24T09:00:30Z',
            endedAt: '2026-09-24T09:57:00Z',
            participants: [
              { aadId: 'AAAAAAAA-0000-0000-0000-000000000001', displayName: 'Dana Owner', email: 'dana@acme.test', joinedAt: '2026-09-24T09:00:30Z', leftAt: '2026-09-24T09:57:00Z' },
            ],
          },
        },
        transcript: {
          id: 'swap-teams-tr',
          tenantId: '7ab91c0e-1111-4222-8333-444455556666',
          occurredAt: '2026-09-24T10:05:00Z',
          changeType: 'transcriptReady',
          resourceData: {
            onlineMeetingId: 'teams-meet-1',
            callId: 'call-1',
            transcript: {
              id: 'tr-teams-1',
              language: 'en-US',
              segments: [
                { participantId: 'AAAAAAAA-0000-0000-0000-000000000001', speakerName: null, startedAt: '2026-09-24T09:01:00Z', endedAt: null, text: 'Welcome everyone.', confidence: null },
              ],
            },
          },
        },
        artifact: {
          id: 'swap-teams-art',
          tenantId: '7ab91c0e-1111-4222-8333-444455556666',
          occurredAt: '2026-09-24T10:10:00Z',
          changeType: 'recordingReady',
          resourceData: {
            onlineMeetingId: 'teams-meet-1',
            callId: 'call-1',
            recording: { id: 'rec-teams-1', displayName: 'Journey.mp4', mediaType: 'video/mp4', sizeBytes: 2048, storageRef: 'provider://teams/rec-1', checksum: null },
          },
        },
      },
      {
        provider: 'google-meet',
        register: () =>
          registerMeetingConnection(member(tenantSwap), {
            provider: 'google-meet',
            providerAccountId: 'workspace-1',
            authKind: 'credentials',
            credentialRef: 'secret-store://meet/acme',
          }).then((r) => r.connection.id),
        metadata: {
          eventUuid: 'swap-meet-meta',
          occurredAt: '2026-09-24T09:00:00Z',
          workspace: { id: 'workspace-1' },
          eventType: 'conferenceRecordUpdated',
          conferenceRecord: {
            meetingId: 'spaces/conference-1',
            title: 'Provider swap journey',
            scheduledStart: '2026-09-24T09:00:00Z',
            scheduledEnd: '2026-09-24T10:00:00Z',
            host: { userId: 'users/dana-1', name: 'Dana Owner', email: 'dana@acme.test' },
          },
        },
        session: {
          eventUuid: 'swap-meet-end',
          occurredAt: '2026-09-24T09:57:00Z',
          workspace: { id: 'workspace-1' },
          eventType: 'conferenceSessionEnded',
          conferenceRecord: { meetingId: 'spaces/conference-1' },
          session: {
            sessionId: 'sessions/occ-1',
            startedAt: '2026-09-24T09:00:30Z',
            endedAt: '2026-09-24T09:57:00Z',
            participants: [
              { userId: 'users/dana-1', name: 'Dana Owner', email: 'dana@acme.test', joinedAt: '2026-09-24T09:00:30Z', leftAt: '2026-09-24T09:57:00Z' },
            ],
          },
        },
        transcript: {
          eventUuid: 'swap-meet-tr',
          occurredAt: '2026-09-24T10:05:00Z',
          workspace: { id: 'workspace-1' },
          eventType: 'transcriptReady',
          conferenceRecord: { meetingId: 'spaces/conference-1' },
          session: { sessionId: 'sessions/occ-1' },
          transcript: {
            transcriptId: 'transcripts/tr-1',
            language: 'en-US',
            segments: [
              { userId: 'users/dana-1', speakerName: null, startedAt: '2026-09-24T09:01:00Z', endedAt: null, text: 'Welcome everyone.', confidence: null },
            ],
          },
        },
        artifact: {
          eventUuid: 'swap-meet-art',
          occurredAt: '2026-09-24T10:10:00Z',
          workspace: { id: 'workspace-1' },
          eventType: 'recordingReady',
          conferenceRecord: { meetingId: 'spaces/conference-1' },
          session: { sessionId: 'sessions/occ-1' },
          recording: { recordingId: 'recordings/rec-1', name: 'Journey', mediaType: 'video/mp4', sizeBytes: 4096 },
        },
      },
      {
        provider: 'recall',
        register: () =>
          registerMeetingConnection(member(tenantSwap), {
            provider: 'recall',
            providerAccountId: 'recall-acct-1',
            authKind: 'credentials',
            credentialRef: 'secret-store://recall/ops',
          }).then((r) => r.connection.id),
        metadata: {
          event: 'bot.meeting_updated',
          event_id: 'swap-recall-meta',
          occurredAt: '2026-09-24T09:00:00Z',
          account: { id: 'recall-acct-1' },
          platform: 'zoom',
          meeting: { id: 'recall-mtg-1', title: 'Provider swap journey', agenda: null, scheduled_start: '2026-09-24T09:00:00Z', scheduled_end: '2026-09-24T10:00:00Z', host: { id: 'bot-participant-1', name: 'Dana Owner', email: 'dana@acme.test' } },
        },
        session: {
          event: 'bot.session_ended',
          event_id: 'swap-recall-end',
          occurredAt: '2026-09-24T09:57:00Z',
          account: { id: 'recall-acct-1' },
          platform: 'zoom',
          meeting: { id: 'recall-mtg-1' },
          session: { id: 'recall-session-1', started_at: '2026-09-24T09:00:30Z', ended_at: '2026-09-24T09:57:00Z', participants: [{ id: 'bot-participant-1', name: 'Dana Owner', email: 'dana@acme.test', joined_at: '2026-09-24T09:00:30Z', left_at: '2026-09-24T09:57:00Z' }] },
        },
        transcript: {
          event: 'transcript.completed',
          event_id: 'swap-recall-tr',
          occurredAt: '2026-09-24T10:05:00Z',
          account: { id: 'recall-acct-1' },
          platform: 'zoom',
          meeting: { id: 'recall-mtg-1' },
          session: { id: 'recall-session-1' },
          transcript: { id: 'recall-tr-1', language: 'en-US', segments: [{ participant_id: 'bot-participant-1', speaker_name: null, started_at: '2026-09-24T09:01:00Z', ended_at: null, text: 'Welcome everyone.', confidence: null }] },
        },
        artifact: {
          event: 'artifact.completed',
          event_id: 'swap-recall-art',
          occurredAt: '2026-09-24T10:10:00Z',
          account: { id: 'recall-acct-1' },
          platform: 'zoom',
          meeting: { id: 'recall-mtg-1' },
          session: { id: 'recall-session-1' },
          artifact: { id: 'recall-art-1', type: 'recording', name: 'Journey', media_type: 'video/mp4', size_bytes: 512, storage_ref: 'provider://recall/art-1', checksum: null },
        },
      },
    ];

    const ctx = member(tenantSwap);
    for (const journey of journeys) {
      await journey.register();
      await receiveMeetingWebhook(ctx, { provider: journey.provider, payload: journey.metadata });
      await receiveMeetingWebhook(ctx, { provider: journey.provider, payload: journey.session });
      await receiveMeetingWebhook(ctx, { provider: journey.provider, payload: journey.transcript });
      await receiveMeetingWebhook(ctx, { provider: journey.provider, payload: journey.artifact });
    }

    // Domain semantics identical per provider: one meeting with metadata +
    // one ended session + one attributed segment + one recording artifact.
    const meetings = await listMeetings(ctx, {});
    expect(meetings).toHaveLength(4);
    for (const meeting of meetings) {
      expect(meeting.title).toBe('Provider swap journey');
      expect(meeting.scheduledStartAt).toBe('2026-09-24T09:00:00.000Z');
      expect(meeting.hostParticipantId).not.toBeNull();
      const sessions = await listMeetingSessions(ctx, { meetingId: meeting.id });
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.status).toBe('ended');
      expect(sessions[0]!.participants).toHaveLength(1);
      const transcripts = await listMeetingTranscripts(ctx, { sessionId: sessions[0]!.id });
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]!.segments[0]!.text).toBe('Welcome everyone.');
      expect(transcripts[0]!.segments[0]!.participantId).not.toBeNull();
      const artifacts = await listMeetingArtifacts(ctx, { sessionId: sessions[0]!.id });
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.kind).toBe('recording');
    }

    // Every observation carries its provider key as channel with identical
    // kinds — swapping the provider changed nothing canonical.
    for (const provider of ['zoom', 'microsoft-teams', 'google-meet', 'recall']) {
      const observed = await listObservations(ctx, { channel: provider });
      expect(observed.map((o) => o.kind).sort()).toEqual([
        'meeting.artifact',
        'meeting.metadata',
        'meeting.session',
        'meeting.transcript',
      ]);
      expect(observed.every((o) => o.source.label === 'meetings' && o.lineage.method === 'connector')).toBe(true);
    }

    // The meeting-bot capture records the underlying platform.
    const recallMeeting = meetings.find((m) => m.provider === 'recall')!;
    expect(recallMeeting.underlyingPlatform).toBe('zoom');
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------------

describe('tenant isolation', () => {
  it('keeps every registry read tenant-scoped (uniform not-found)', async () => {
    const ctxA = member(tenantIsolation);
    await registerZoom(tenantIsolation, { providerAccountId: 'zoom-acct-1' });
    await receiveMeetingWebhook(ctxA, { provider: 'zoom', payload: ZOOM_META('iso-meta') });
    await receiveMeetingWebhook(ctxA, { provider: 'zoom', payload: ZOOM_SESSION('iso-end', 'ended') });
    await receiveMeetingWebhook(ctxA, { provider: 'zoom', payload: ZOOM_TRANSCRIPT('iso-tr') });
    await receiveMeetingWebhook(ctxA, { provider: 'zoom', payload: ZOOM_ARTIFACT('iso-art') });
    await receiveMeetingWebhook(ctxA, { provider: 'zoom', payload: ZOOM_ACCESS('iso-acc') });

    const meeting = (await listMeetings(ctxA, {}))[0]!;
    const session = (await listMeetingSessions(ctxA, { meetingId: meeting.id }))[0]!;

    const ctxB = member(tenantB);
    const ctxC = member(tenantC); // a tenant that captured nothing at all
    await expectCode('meeting_not_found', () => getMeeting(ctxC, meeting.id));
    await expectCode('session_not_found', () => getMeetingSession(ctxC, session.id));
    expect(await listMeetings(ctxC, {})).toEqual([]);
    expect(await listMeetingSessions(ctxC, {})).toEqual([]);
    expect(await listMeetingParticipants(ctxC, {})).toEqual([]);
    expect(await listMeetingAccessEvents(ctxC, {})).toEqual([]);
    expect(await listMeetingConnections(ctxC, {})).toEqual([]);
    await expectCode('session_not_found', () =>
      listMeetingTranscripts(ctxC, { sessionId: session.id }));
    await expectCode('session_not_found', () =>
      listMeetingArtifacts(ctxC, { sessionId: session.id }));
    // tenantB owns no meeting intelligence either (its single connection is
    // an endpoint registration, not captured meetings).
    await expectCode('meeting_not_found', () => getMeeting(ctxB, meeting.id));
    expect(await listMeetings(ctxB, {})).toEqual([]);
    expect(await listMeetingSessions(ctxB, {})).toEqual([]);

    // tenantA still reads everything it captured.
    expect((await listMeetings(ctxA, {})).length).toBe(1);
    expect((await listMeetingTranscripts(ctxA, { sessionId: session.id })).length).toBe(1);
    expect((await listMeetingArtifacts(ctxA, { sessionId: session.id })).length).toBe(1);
    expect((await listMeetingAccessEvents(ctxA, {})).length).toBe(1);
    expect((await listMeetingParticipants(ctxA, {})).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Storage discipline (append-only capture evidence)
// ---------------------------------------------------------------------------

describe('storage discipline', () => {
  it('rejects mutation of append-only capture evidence and frozen identities', async () => {
    const ctx = member(tenantStorage);
    const connectionId = await registerZoom(tenantStorage, { providerAccountId: 'zoom-acct-1' });
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('st-meta') });
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_SESSION('st-end', 'ended') });
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_TRANSCRIPT('st-tr') });
    await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_ARTIFACT('st-art') });

    const expectRejects = async (sql: string): Promise<void> => {
      await expect(getDb().query(sql)).rejects.toThrowError(/W085 meetings/);
    };

    await expectRejects(`UPDATE meeting_transcripts SET segments = '[]'::jsonb`);
    await expectRejects(`DELETE FROM meeting_transcripts`);
    await expectRejects(`TRUNCATE meeting_transcripts`);
    await expectRejects(`UPDATE meeting_artifacts SET display_name = 'x'`);
    await expectRejects(`DELETE FROM meeting_artifacts`);
    await expectRejects(`UPDATE meeting_access_events SET code = 'not_found'`);
    await expectRejects(`DELETE FROM meeting_ingestion`);
    // Session identity is frozen from creation (only capture state moves).
    await expectRejects(`UPDATE meeting_sessions SET provider_session_id = 'other'`);
    await expectRejects(`UPDATE meeting_sessions SET meeting_id = gen_random_uuid()`);
    await expectRejects(`DELETE FROM meeting_sessions`);
    // Participant identity is frozen (display facets may move).
    await expectRejects(`UPDATE meeting_participants SET provider_participant_id = 'x'`);
    await expectRejects(`DELETE FROM meeting_participants`);
    // Cursor rows cannot be repointed or deleted.
    await expectRejects(`DELETE FROM meeting_ingestion_cursors`);
    await expect(getDb().query(`UPDATE meeting_ingestion_cursors SET cursor = 'c' WHERE tenant_id = '${tenantStorage}'`)).resolves.toBeTruthy();

    // The ledger link is one-way: re-linking a linked row is rejected.
    const linked = await getDb().query<{ id: string; observation_id: string }>(
      `SELECT id, observation_id FROM meeting_ingestion WHERE tenant_id = $1 AND connection_id = $2 LIMIT 1`,
      [tenantStorage, connectionId],
    );
    const row = linked.rows[0]!;
    await expectRejects(
      `UPDATE meeting_ingestion SET observation_id = gen_random_uuid() WHERE id = '${row.id}'`,
    );
    // …but filling a NULL link once remains legal (the crash-recovery path).
    await getDb().query(
      `INSERT INTO meeting_ingestion (
         tenant_id, connection_id, provider_record_id, ingested_via, claimed_at
       ) VALUES ($1, $2, 'unlinked-record', 'webhook', $3)`,
      [tenantStorage, connectionId, new Date(clockMs)],
    );
    await expect(
      getDb().query(
        `UPDATE meeting_ingestion SET observation_id = $3, ingested_at = $4
           WHERE tenant_id = $1 AND connection_id = $2 AND provider_record_id = 'unlinked-record'`,
        [tenantStorage, connectionId, row.observation_id, new Date(clockMs)],
      ),
    ).resolves.toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

describe('crash recovery', () => {
  it('re-captures records whose claim never linked', async () => {
    const ctx = member(tenantRecovery);
    const connectionId = await registerZoom(tenantRecovery, { providerAccountId: 'zoom-acct-1' });

    // Simulate a crash between claim and link: a ledger row with NULL
    // observation_id exists for a record the service never applied.
    await getDb().query(
      `INSERT INTO meeting_ingestion (
         tenant_id, connection_id, provider_record_id, ingested_via, claimed_at
       ) VALUES ($1, $2, 'ev-crash', 'webhook', $3)`,
      [tenantRecovery, connectionId, new Date(clockMs)],
    );

    // The provider redelivers the record.
    const redelivered = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('ev-crash') });
    expect(redelivered.ingested).toBe(1);
    expect(redelivered.duplicates).toBe(0);

    // The claim is now linked; a third delivery is a pure duplicate.
    const third = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('ev-crash') });
    expect(third.ingested).toBe(0);
    expect(third.duplicates).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serialization', () => {
  it('fails explicitly while another capture pass holds the lock', async () => {
    const ctx = member(tenantBusy);
    const connectionId = await registerZoom(tenantBusy, { providerAccountId: 'zoom-acct-1' });

    const lock = getLock();
    const token = await lock.acquire(`meetings:ingest:${connectionId}`, 5_000);
    expect(token).not.toBeNull();
    try {
      await expectCode('ingestion_busy', () =>
        receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('ev-busy') }));
    } finally {
      await lock.release(`meetings:ingest:${connectionId}`, token!);
    }

    // With the lock released, the same delivery ingests.
    const result = await receiveMeetingWebhook(ctx, { provider: 'zoom', payload: ZOOM_META('ev-busy') });
    expect(result.ingested).toBe(1);
  });
});
