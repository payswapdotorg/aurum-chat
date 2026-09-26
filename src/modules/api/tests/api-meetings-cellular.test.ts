// W104 — the v1 public API's meetings + cellular families, integration
// tested against the embedded PostgreSQL (PGlite, `:memory:`) through the
// FULL kernel pipeline (handleApiRequest), exactly as the Next.js adapter
// drives it. Complements api-service.test.ts (the W038 core) with the
// surfaces that unblock journeys J17/J18:
//
//   * DISCOVERY — the v1 discovery document lists every new operation
//     (the count grows: the mirror test in api-unit.test.ts adapts
//     dynamically; here the meeting/cellular families are pinned by name);
//   * ROUTING — static segments beat captures (/meetings/participants and
//     /meetings/connections never mis-capture :meetingId; the session
//     subpaths resolve as designed; wrong methods 405);
//   * HAPPY PATHS — every new operation delegates to the owning contract
//     (seeds are written through the REAL contracts: a zoom webhook chain
//     for meetings, a registered twilio connection + a reach request for
//     cellular);
//   * SCOPES — a meetings:read key cannot touch cellular, a cellular:read
//     key cannot register connections, an unauthenticated caller gets 401,
//     and a read-only key gets 403 missing_scope on the one write;
//   * TENANCY (ADR-0001) — another tenant's meeting, session, reach and
//     connection ids are uniformly not_found (no existence leak);
//   * ENVIRONMENT HONESTY — no cellular transport is wired by default, so
//     the seeded reach records the module's own report: status 'failed'
//     with failureCode 'provider_unavailable' and per-leg attempt rows —
//     surfaced through GET /cellular/reach/:id EXACTLY as recorded, never
//     faked; and the error taxonomy maps a thrown provider_unavailable to
//     the retryable 503.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';
import * as api from '../contract';
import * as organizations from '@/modules/organizations/contract';
import * as meetings from '@/modules/meetings/contract';
import * as cellular from '@/modules/cellular/contract';
import { mapDomainError } from '../errors';

const { handleApiRequest } = api;

// --- tenants, principals, contexts, keys -----------------------------------

const platform: organizations.PlatformContext = {
  principalId: newId(),
  authority: ['organizations:provision'],
};

let tenantMain: organizations.Tenant;
let tenantIso: organizations.Tenant;

const ownerMain = newId();
const ownerIso = newId();

let fullKey = ''; // meetings:read + cellular:read + cellular:write
let meetingsKey = ''; // meetings:read only
let cellularReadKey = ''; // cellular:read only

function ctx(tenantId: string, principalId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId, authority };
}

function adminCtx(tenantId: string, principalId: string): TenantContext {
  return ctx(tenantId, principalId, ['api:administer']);
}

/** Drive the kernel exactly as the Next.js adapter does. */
async function call(
  key: string | null,
  method: string,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<api.ApiResponse> {
  const headers: Record<string, string> = {};
  if (key !== null) headers.authorization = `Bearer ${key}`;
  return handleApiRequest({ method, path, headers, query: options.query ?? {}, body: options.body });
}

async function callExpectJson<T = unknown>(
  key: string | null,
  method: string,
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await call(key, method, path, options);
  return { status: response.status, body: response.body as T };
}

function errorOf(response: api.ApiResponse): { code: string; message: string } {
  const body = response.body as { error?: { code?: string; message?: string } };
  return { code: body?.error?.code ?? '', message: body?.error?.message ?? '' };
}

// --- meeting seeding through the REAL contract (the documented zoom
//     webhook envelope shapes — the module's own fixture discipline) -------

function zoomEnvelope(
  event: string,
  event_id: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    event,
    event_id,
    occurredAt: '2026-10-06T09:00:00Z',
    account: { id: 'zoom-acct-w104' },
    meeting: { id: 'mtg-w104' },
    ...overrides,
  };
}

let meetingId = '';
let sessionId = '';
let transcriptObservationId = '';

async function seedMeetingChain(tenantId: string, principalId: string): Promise<void> {
  const seedCtx = ctx(tenantId, principalId);
  await meetings.registerMeetingConnection(seedCtx, {
    provider: 'zoom',
    providerAccountId: 'zoom-acct-w104',
    displayName: 'W104 Zoom',
    authKind: 'oauth',
    credentialRef: 'secret-store://zoom/w104',
    oauthScopes: ['meeting:read'],
    oauthExpiresAt: '2027-03-01T00:00:00Z',
  });
  await meetings.receiveMeetingWebhook(seedCtx, {
    provider: 'zoom',
    payload: zoomEnvelope('meeting.updated', 'w104-meta', {
      meeting: {
        id: 'mtg-w104',
        title: 'W104 supplier review',
        agenda: 'The W104 acceptance chain',
        scheduled_start: '2026-10-06T09:00:00Z',
        scheduled_end: '2026-10-06T10:00:00Z',
        host: { id: 'host-w104', name: 'June Park', email: 'june@w104.test' },
      },
    }),
  });
  await meetings.receiveMeetingWebhook(seedCtx, {
    provider: 'zoom',
    payload: zoomEnvelope('meeting.ended', 'w104-session', {
      session: {
        id: 'occ-w104',
        status: 'ended',
        started_at: '2026-10-06T09:00:23Z',
        ended_at: '2026-10-06T09:54:10Z',
        participants: [
          {
            id: 'host-w104',
            name: 'June Park',
            email: 'june@w104.test',
            joined_at: '2026-10-06T09:00:23Z',
            left_at: '2026-10-06T09:54:10Z',
          },
        ],
      },
    }),
  });
  await meetings.receiveMeetingWebhook(seedCtx, {
    provider: 'zoom',
    payload: zoomEnvelope('recording.transcript_completed', 'w104-transcript', {
      session: { id: 'occ-w104' },
      transcript: {
        id: 'tr-w104',
        language: 'en-US',
        segments: [
          {
            participant_id: 'host-w104',
            speaker_name: 'June',
            started_at: '2026-10-06T09:01:05Z',
            ended_at: '2026-10-06T09:01:30Z',
            text: 'The W104 acceptance chain covers the full surface.',
            confidence: 0.97,
          },
        ],
      },
    }),
  });
  await meetings.receiveMeetingWebhook(seedCtx, {
    provider: 'zoom',
    payload: zoomEnvelope('recording.completed', 'w104-artifact', {
      session: { id: 'occ-w104' },
      artifact: {
        id: 'rec-w104',
        type: 'recording',
        name: 'w104.mp4',
        media_type: 'video/mp4',
        size_bytes: 1048576,
        storage_ref: 'provider://zoom/rec-w104',
        checksum: 'sha256:w104',
      },
    }),
  });
  const [meeting] = (await meetings.listMeetings(seedCtx, {})).filter(
    (candidate) => candidate.providerMeetingId === 'mtg-w104',
  );
  expect(meeting).toBeDefined();
  meetingId = meeting!.id;
  const [session] = await meetings.listMeetingSessions(seedCtx, { meetingId });
  expect(session).toBeDefined();
  sessionId = session!.id;
  const [transcript] = await meetings.listMeetingTranscripts(seedCtx, { sessionId });
  expect(transcript).toBeDefined();
  transcriptObservationId = transcript!.evidenceObservationId;
}

// --- cellular seeding through the REAL contract ----------------------------

let cellularConnectionId = '';
let reachId = '';

async function seedCellularChain(tenantId: string, principalId: string): Promise<void> {
  const seedCtx = ctx(tenantId, principalId);
  // One SMS attempt then voice escalation: with no transport wired the
  // reach records the module's honest retryable provider_unavailable.
  await cellular.setCellularPolicy(ctx(tenantId, principalId, ['cellular:administer']), {
    reachKind: 'tell',
    voiceFallback: 'on_sms_failure',
    smsMaxAttempts: 1,
  });
  const { connection } = await cellular.registerCellularConnection(seedCtx, {
    provider: 'twilio',
    providerAccountId: 'twilio-acct-w104',
    phoneNumber: '+15550100104',
    displayName: 'W104 Twilio',
    credentialRef: 'secret-store://twilio/w104',
  });
  cellularConnectionId = connection.id;
  const reach = await cellular.reachAnyone(seedCtx, {
    phoneNumber: '+15550100604',
    kind: 'tell',
    text: 'The W104 review moved to 15:00.',
  });
  reachId = reach.id;
}

beforeAll(async () => {
  await runMigrations(getDb());

  tenantMain = await organizations.provisionTenant(platform, {
    name: 'W104 Main Co',
    ownerPrincipalId: ownerMain,
  });
  tenantIso = await organizations.provisionTenant(platform, {
    name: 'W104 Iso Co',
    ownerPrincipalId: ownerIso,
  });

  fullKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'w104-full',
      scopes: ['meetings:read', 'cellular:read', 'cellular:write'],
    })
  ).key;
  meetingsKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'w104-meetings',
      scopes: ['meetings:read'],
    })
  ).key;
  cellularReadKey = (
    await api.createApiKey(adminCtx(tenantMain.id, ownerMain), {
      label: 'w104-cellular-read',
      scopes: ['cellular:read'],
    })
  ).key;

  await seedMeetingChain(tenantMain.id, ownerMain);
  await seedCellularChain(tenantMain.id, ownerMain);
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// discovery + routing
// ---------------------------------------------------------------------------

describe('W104 discovery + routing', () => {
  it('the discovery document lists the meetings and cellular families', async () => {
    const { status, body } = await callExpectJson<{
      operations: { operation: string; path: string; scope: string | null }[];
    }>(null, 'GET', '/api/v1');
    expect(status).toBe(200);
    const operations = body.operations.map((entry) => entry.operation);
    // The meeting family, pinned by name (the count grew: 49 → 66).
    for (const operation of [
      'meetings.list',
      'meetings.get',
      'meetings.sessions',
      'meetings.session',
      'meetings.transcripts',
      'meetings.artifacts',
      'meetings.participants',
      'meetings.connections',
      'meetings.accessEvents',
    ]) {
      expect(operations).toContain(operation);
    }
    // The cellular family, pinned by name.
    for (const operation of [
      'cellular.connections.list',
      'cellular.connections.register',
      'cellular.connections.get',
      'cellular.reach.list',
      'cellular.reach.get',
      'cellular.reach.attempts',
      'cellular.reach.replies',
      'cellular.policies.list',
    ]) {
      expect(operations).toContain(operation);
    }
    // The new scopes ride the document's scope vocabulary.
    expect(body.operations.find((entry) => entry.operation === 'meetings.list')?.scope).toBe(
      'meetings:read',
    );
    expect(body.operations.find((entry) => entry.operation === 'cellular.reach.get')?.scope).toBe(
      'cellular:read',
    );
  });

  it('static segments beat captures in the meeting family', async () => {
    const participants = await call(fullKey, 'GET', '/api/v1/meetings/participants');
    expect(participants.status).toBe(200);
    const connections = await call(fullKey, 'GET', '/api/v1/meetings/connections');
    expect(connections.status).toBe(200);
    const accessEvents = await call(fullKey, 'GET', '/api/v1/meetings/access-events');
    expect(accessEvents.status).toBe(200);
    // The session subpaths resolve as designed (the agents-family shape).
    const session = await call(fullKey, 'GET', `/api/v1/meetings/sessions/${sessionId}`);
    expect(session.status).toBe(200);
    const transcripts = await call(fullKey, 'GET', `/api/v1/meetings/sessions/${sessionId}/transcripts`);
    expect(transcripts.status).toBe(200);
    const artifacts = await call(fullKey, 'GET', `/api/v1/meetings/sessions/${sessionId}/artifacts`);
    expect(artifacts.status).toBe(200);
    const byMeeting = await call(fullKey, 'GET', `/api/v1/meetings/${meetingId}/sessions`);
    expect(byMeeting.status).toBe(200);
  });

  it('known paths with wrong methods 405 (with Allow)', async () => {
    const del = await call(fullKey, 'DELETE', '/api/v1/meetings');
    expect(del.status).toBe(405);
    expect(errorOf(del).code).toBe('method_not_allowed');
    expect(del.headers?.allow).toBe('GET');
    const patch = await call(fullKey, 'PATCH', '/api/v1/cellular/connections');
    expect(patch.status).toBe(405);
    expect(patch.headers?.allow).toBe('GET, POST');
  });

  it('unknown paths stay 404', async () => {
    const missing = await call(fullKey, 'GET', '/api/v1/meetings/nope/extra');
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// meetings family — happy paths
// ---------------------------------------------------------------------------

describe('W104 meetings operations', () => {
  it('lists and gets the captured registry', async () => {
    const list = await callExpectJson<{ items: meetings.Meeting[] }>(fullKey, 'GET', '/api/v1/meetings');
    expect(list.status).toBe(200);
    expect(list.body.items.map((entry) => entry.id)).toContain(meetingId);

    const one = await callExpectJson<meetings.Meeting>(fullKey, 'GET', `/api/v1/meetings/${meetingId}`);
    expect(one.status).toBe(200);
    expect(one.body.providerMeetingId).toBe('mtg-w104');
    expect(one.body.title).toBe('W104 supplier review');

    const sessions = await callExpectJson<{ items: meetings.MeetingSession[] }>(
      fullKey,
      'GET',
      `/api/v1/meetings/${meetingId}/sessions`,
    );
    expect(sessions.status).toBe(200);
    expect(sessions.body.items).toHaveLength(1);
    expect(sessions.body.items[0]!.participants).toHaveLength(1);
  });

  it('reads session transcripts and artifacts with their evidence links', async () => {
    const transcripts = await callExpectJson<{ items: meetings.MeetingTranscript[] }>(
      fullKey,
      'GET',
      `/api/v1/meetings/sessions/${sessionId}/transcripts`,
    );
    expect(transcripts.status).toBe(200);
    expect(transcripts.body.items).toHaveLength(1);
    expect(transcripts.body.items[0]!.evidenceObservationId).toBe(transcriptObservationId);

    const artifacts = await callExpectJson<{ items: meetings.MeetingArtifact[] }>(
      fullKey,
      'GET',
      `/api/v1/meetings/sessions/${sessionId}/artifacts`,
    );
    expect(artifacts.status).toBe(200);
    expect(artifacts.body.items).toHaveLength(1);
    expect(artifacts.body.items[0]!.kind).toBe('recording');
  });

  it('lists participants, connections and access events', async () => {
    const participants = await callExpectJson<{ items: meetings.MeetingParticipant[] }>(
      fullKey,
      'GET',
      '/api/v1/meetings/participants',
    );
    expect(participants.status).toBe(200);
    expect(participants.body.items.length).toBeGreaterThan(0);

    const connections = await callExpectJson<{ items: meetings.MeetingConnection[] }>(
      fullKey,
      'GET',
      '/api/v1/meetings/connections',
    );
    expect(connections.status).toBe(200);
    expect(connections.body.items).toHaveLength(1);
    expect(connections.body.items[0]!.providerAccountId).toBe('zoom-acct-w104');

    const accessEvents = await callExpectJson<{ items: meetings.MeetingAccessEvent[] }>(
      fullKey,
      'GET',
      '/api/v1/meetings/access-events',
    );
    expect(accessEvents.status).toBe(200);
  });

  it('maps a foreign or malformed meeting to a uniform 404 (no existence leak)', async () => {
    const foreign = await call(meetingsKey, 'GET', `/api/v1/meetings/${newId()}`);
    expect(foreign.status).toBe(404);
    expect(errorOf(foreign).code).toBe('meeting_not_found');
    const malformed = await call(meetingsKey, 'GET', '/api/v1/meetings/not-a-uuid');
    expect(malformed.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// cellular family — happy paths + the honest environment state
// ---------------------------------------------------------------------------

describe('W104 cellular operations', () => {
  it('lists and gets connections, and registers one through the write scope (201)', async () => {
    const list = await callExpectJson<{ items: cellular.CellularConnection[] }>(
      cellularReadKey,
      'GET',
      '/api/v1/cellular/connections',
    );
    expect(list.status).toBe(200);
    expect(list.body.items.map((entry) => entry.id)).toContain(cellularConnectionId);

    const one = await callExpectJson<cellular.CellularConnection>(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/connections/${cellularConnectionId}`,
    );
    expect(one.status).toBe(200);
    expect(one.body.provider).toBe('twilio');
    expect(one.body.phoneNumber).toBe('+15550100104');

    const created = await callExpectJson<{ connection: cellular.CellularConnection; created: boolean }>(
      fullKey,
      'POST',
      '/api/v1/cellular/connections',
      {
        body: {
          provider: 'telnyx',
          providerAccountId: 'telnyx-acct-w104',
          phoneNumber: '+15550100105',
          displayName: 'W104 Telnyx',
          credentialRef: 'secret-store://telnyx/w104',
        },
      },
    );
    expect(created.status).toBe(201);
    expect(created.body.created).toBe(true);

    // Re-registration is the re-authorization path (created: false).
    const reRegistered = await callExpectJson<{ created: boolean }>(
      fullKey,
      'POST',
      '/api/v1/cellular/connections',
      {
        body: {
          provider: 'telnyx',
          providerAccountId: 'telnyx-acct-w104',
          phoneNumber: '+15550100106',
          credentialRef: 'secret-store://telnyx/w104-2',
        },
      },
    );
    expect(reRegistered.status).toBe(201);
    expect(reRegistered.body.created).toBe(false);
  });

  it('lists policies and reach, and reads one reach with its attempts and replies', async () => {
    const policies = await callExpectJson<{ items: cellular.CellularPolicy[] }>(
      cellularReadKey,
      'GET',
      '/api/v1/cellular/policies',
    );
    expect(policies.status).toBe(200);
    expect(policies.body.items.map((entry) => entry.reachKind)).toContain('tell');

    const feed = await callExpectJson<{ items: cellular.CellularReach[] }>(
      cellularReadKey,
      'GET',
      '/api/v1/cellular/reach',
    );
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((entry) => entry.id)).toContain(reachId);

    const one = await callExpectJson<cellular.CellularReach>(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/reach/${reachId}`,
    );
    expect(one.status).toBe(200);

    const attempts = await callExpectJson<{ items: cellular.CellularAttempt[] }>(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/reach/${reachId}/attempts`,
    );
    expect(attempts.status).toBe(200);
    expect(attempts.body.items.length).toBeGreaterThan(0);

    const replies = await callExpectJson<{ items: cellular.CellularReply[] }>(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/reach/${reachId}/replies`,
    );
    expect(replies.status).toBe(200);
  });

  it('surfaces the environment limit EXACTLY as the module reports it (provider_unavailable, retryable)', async () => {
    // No transport is wired in this environment — the module's own honest
    // state, read back through the public surface as data (never faked):
    const reach = await callExpectJson<cellular.CellularReach>(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/reach/${reachId}`,
    );
    expect(reach.status).toBe(200);
    expect(reach.body.status).toBe('failed');
    expect(reach.body.failureCode).toBe('provider_unavailable');

    // The per-leg evidence: an honest "tried and could not send" attempt
    // (no connection placed) per leg — SMS then voice escalation.
    const attempts = await callExpectJson<{ items: cellular.CellularAttempt[] }>(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/reach/${reachId}/attempts`,
    );
    const legs = attempts.body.items.map((attempt) => attempt.leg);
    expect(legs).toContain('sms');
    expect(legs).toContain('voice');
    for (const attempt of attempts.body.items) {
      expect(attempt.status).toBe('failed');
      expect(attempt.connectionId).toBeNull(); // no leg was placed — honest
      expect(attempt.detail).toContain('no cellular transport is wired');
    }

    // And the error taxonomy maps a THROWN provider_unavailable onto the
    // retryable 503 (the honest HTTP shape for a delegated call that
    // throws it — the same code the cellular module throws at transport
    // time; shaped here without importing another module's internals).
    const thrown = Object.assign(new Error('no cellular transport is wired'), {
      code: 'provider_unavailable',
    });
    const mapped = mapDomainError(thrown);
    expect(mapped).toMatchObject({ status: 503, code: 'provider_unavailable' });
  });

  it('maps a foreign or malformed reach/connection to a uniform 404 (no existence leak)', async () => {
    const foreignReach = await call(cellularReadKey, 'GET', `/api/v1/cellular/reach/${newId()}`);
    expect(foreignReach.status).toBe(404);
    expect(errorOf(foreignReach).code).toBe('reach_not_found');
    const foreignConnection = await call(
      cellularReadKey,
      'GET',
      `/api/v1/cellular/connections/${newId()}`,
    );
    expect(foreignConnection.status).toBe(404);
    expect(errorOf(foreignConnection).code).toBe('connection_not_found');
    // The cellular family validates the uuid shape FIRST
    // (invalid_cellular_input, 400) — the meetings family treats it as
    // not_found; both are the owning modules' own honest disciplines,
    // asserted as they are.
    const malformed = await call(cellularReadKey, 'GET', '/api/v1/cellular/reach/not-a-uuid');
    expect(malformed.status).toBe(400);
    expect(errorOf(malformed).code).toBe('invalid_cellular_input');
  });
});

// ---------------------------------------------------------------------------
// scope enforcement
// ---------------------------------------------------------------------------

describe('W104 capability scopes', () => {
  it('a meetings-only key cannot touch cellular (403 missing_scope)', async () => {
    const response = await call(meetingsKey, 'GET', '/api/v1/cellular/reach');
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('missing_scope');
    expect(errorOf(response).message).toContain('cellular:read');
  });

  it('a cellular-read key cannot touch meetings and cannot register connections', async () => {
    const meetingsResponse = await call(cellularReadKey, 'GET', '/api/v1/meetings');
    expect(meetingsResponse.status).toBe(403);
    expect(errorOf(meetingsResponse).code).toBe('missing_scope');
    expect(errorOf(meetingsResponse).message).toContain('meetings:read');

    const register = await call(cellularReadKey, 'POST', '/api/v1/cellular/connections', {
      body: {
        provider: 'twilio',
        providerAccountId: 'twilio-acct-unauthorized',
        phoneNumber: '+15550100109',
        credentialRef: 'secret-store://twilio/nope',
      },
    });
    expect(register.status).toBe(403);
    expect(errorOf(register).code).toBe('missing_scope');
    expect(errorOf(register).message).toContain('cellular:write');
  });

  it('an unauthenticated caller gets 401 everywhere on the new families', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/meetings'],
      ['GET', '/api/v1/cellular/reach'],
      ['POST', '/api/v1/cellular/connections'],
    ] as const) {
      const response = await call(null, method, path);
      expect(response.status).toBe(401);
      expect(errorOf(response).code).toBe('unauthenticated');
    }
  });

  it('invalid bodies and queries map to the 400 family', async () => {
    const noBody = await call(fullKey, 'POST', '/api/v1/cellular/connections', { body: 'not-an-object' });
    expect(noBody.status).toBe(400);
    expect(errorOf(noBody).code).toBe('invalid_body');

    const badProvider = await call(fullKey, 'POST', '/api/v1/cellular/connections', {
      body: {
        provider: 'not-a-vendor',
        providerAccountId: 'x',
        phoneNumber: '+15550100110',
        credentialRef: 'secret-store://twilio/x',
      },
    });
    expect(badProvider.status).toBe(400);

    const badLimit = await call(fullKey, 'GET', '/api/v1/meetings', { query: { limit: 'zero' } });
    expect(badLimit.status).toBe(400);
    expect(errorOf(badLimit).code).toBe('invalid_query');
  });
});

// ---------------------------------------------------------------------------
// tenancy isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('W104 tenancy isolation', () => {
  let isoKey = '';

  beforeAll(async () => {
    isoKey = (
      await api.createApiKey(adminCtx(tenantIso.id, ownerIso), {
        label: 'w104-iso',
        scopes: ['meetings:read', 'cellular:read', 'cellular:write'],
      })
    ).key;
  });

  it("another tenant sees tenant A's meeting as uniformly missing", async () => {
    const one = await call(isoKey, 'GET', `/api/v1/meetings/${meetingId}`);
    expect(one.status).toBe(404);
    expect(errorOf(one).code).toBe('meeting_not_found');

    const sessions = await call(isoKey, 'GET', `/api/v1/meetings/${meetingId}/sessions`);
    expect(sessions.status).toBe(200); // the meeting has no sessions in ISO's scope
    const listed = sessions.body as { items: unknown[] };
    expect(listed.items).toHaveLength(0);

    const session = await call(isoKey, 'GET', `/api/v1/meetings/sessions/${sessionId}`);
    expect(session.status).toBe(404);
    expect(errorOf(session).code).toBe('session_not_found');

    const transcripts = await call(
      isoKey,
      'GET',
      `/api/v1/meetings/sessions/${sessionId}/transcripts`,
    );
    expect(transcripts.status).toBe(404);

    const connections = await callExpectJson<{ items: unknown[] }>(isoKey, 'GET', '/api/v1/meetings/connections');
    expect(connections.status).toBe(200);
    expect(connections.body.items).toHaveLength(0);
  });

  it("another tenant sees tenant A's reach and connection as uniformly missing", async () => {
    const reach = await call(isoKey, 'GET', `/api/v1/cellular/reach/${reachId}`);
    expect(reach.status).toBe(404);
    expect(errorOf(reach).code).toBe('reach_not_found');

    const attempts = await call(isoKey, 'GET', `/api/v1/cellular/reach/${reachId}/attempts`);
    expect(attempts.status).toBe(404);
    expect(errorOf(attempts).code).toBe('reach_not_found');

    const connection = await call(isoKey, 'GET', `/api/v1/cellular/connections/${cellularConnectionId}`);
    expect(connection.status).toBe(404);
    expect(errorOf(connection).code).toBe('connection_not_found');

    const feed = await callExpectJson<{ items: unknown[] }>(isoKey, 'GET', '/api/v1/cellular/reach');
    expect(feed.status).toBe(200);
    expect(feed.body.items).toHaveLength(0);
  });
});
