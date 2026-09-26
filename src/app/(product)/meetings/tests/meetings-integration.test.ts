// Integration tests for the meetings surface (W104 — J17) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// THE JOURNEY'S USER-VISIBLE PATH, proven end to end through the REAL
// meetings contract: the demo-style zoom webhook chain (metadata → ended
// session with participants → transcript → artifact) registers the
// capture registry AND the immutable evidence, and the surface's view
// builders read it back exactly:
//
//   * the HUB view — the captured meeting rows (title, provider, schedule,
//     session counts from the one-call session window), the capture
//     connection, the participant identity registry and the (empty)
//     access-failure history;
//   * the DETAIL view — the meeting metadata, the session with its
//     attendance, and the session-scoped transcripts (preview + evidence
//     link) and artifacts (kind + evidence link);
//   * the HONEST NOT-FOUND — a foreign or malformed meeting id throws the
//     contract's own meeting_not_found (the page renders the not-found
//     state; no existence leak);
//   * TENANCY (ADR-0001) — tenant B's hub is empty and tenant A's meeting
//     id reads as missing for tenant B.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';
import { provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import * as meetings from '@/modules/meetings/contract';
import { buildMeetingDetailView, buildMeetingsHomeView } from '../lib/views';

const ZOOM_ACCOUNT = 'zoom-acct-meetings-surface';

function zoomEnvelope(
  event: string,
  event_id: string,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    event,
    event_id,
    occurredAt: '2026-10-06T09:00:00Z',
    account: { id: ZOOM_ACCOUNT },
    meeting: { id: 'mtg-surface' },
    ...overrides,
  };
}

let tenant: Tenant;
let isoTenant: Tenant;
let ctx: TenantContext;
let isoCtx: TenantContext;
let meetingId = '';

async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected error code '${code}' but the call succeeded`);
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    expect(actual).toBe(code);
  }
}

beforeAll(async () => {
  await runMigrations(getDb());

  const platform = { principalId: newId(), authority: ['organizations:provision'] };
  tenant = await provisionTenant(platform, { name: 'Meetings Surface Co', ownerPrincipalId: newId() });
  isoTenant = await provisionTenant(platform, { name: 'Meetings Iso Co', ownerPrincipalId: newId() });
  ctx = { tenantId: tenant.id, principalId: newId(), authority: [] };
  isoCtx = { tenantId: isoTenant.id, principalId: newId(), authority: [] };

  await meetings.registerMeetingConnection(ctx, {
    provider: 'zoom',
    providerAccountId: ZOOM_ACCOUNT,
    displayName: 'Surface Zoom',
    authKind: 'oauth',
    credentialRef: 'secret-store://zoom/surface',
    oauthScopes: ['meeting:read'],
    oauthExpiresAt: '2027-03-01T00:00:00Z',
  });
  await meetings.receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: zoomEnvelope('meeting.updated', 'surface-meta', {
      meeting: {
        id: 'mtg-surface',
        title: 'Surface supplier review',
        agenda: 'The surface acceptance chain',
        scheduled_start: '2026-10-06T09:00:00Z',
        scheduled_end: '2026-10-06T10:00:00Z',
        host: { id: 'host-surface', name: 'June Park', email: 'june@surface.test' },
      },
    }),
  });
  await meetings.receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: zoomEnvelope('meeting.ended', 'surface-session', {
      session: {
        id: 'occ-surface',
        status: 'ended',
        started_at: '2026-10-06T09:00:23Z',
        ended_at: '2026-10-06T09:54:10Z',
        participants: [
          {
            id: 'host-surface',
            name: 'June Park',
            email: 'june@surface.test',
            joined_at: '2026-10-06T09:00:23Z',
            left_at: '2026-10-06T09:54:10Z',
          },
          { id: 'guest-surface', name: 'Sam Okafor', email: null, joined_at: null, left_at: null },
        ],
      },
    }),
  });
  await meetings.receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: zoomEnvelope('recording.transcript_completed', 'surface-transcript', {
      session: { id: 'occ-surface' },
      transcript: {
        id: 'tr-surface',
        language: 'en-US',
        segments: [
          {
            participant_id: 'host-surface',
            speaker_name: 'June Park',
            started_at: '2026-10-06T09:01:05Z',
            ended_at: '2026-10-06T09:01:30Z',
            text: 'The surface reads exactly what the contract captured.',
            confidence: 0.97,
          },
        ],
      },
    }),
  });
  await meetings.receiveMeetingWebhook(ctx, {
    provider: 'zoom',
    payload: zoomEnvelope('recording.completed', 'surface-artifact', {
      session: { id: 'occ-surface' },
      artifact: {
        id: 'rec-surface',
        type: 'recording',
        name: 'surface.mp4',
        media_type: 'video/mp4',
        size_bytes: 2097152,
        storage_ref: 'provider://zoom/rec-surface',
        checksum: 'sha256:surface',
      },
    }),
  });
  const [meeting] = (await meetings.listMeetings(ctx, {})).filter(
    (candidate) => candidate.providerMeetingId === 'mtg-surface',
  );
  expect(meeting).toBeDefined();
  meetingId = meeting!.id;
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The hub view
// ---------------------------------------------------------------------------

describe('buildMeetingsHomeView', () => {
  it('composes the captured registry, connections, participants and access history', async () => {
    const view = await buildMeetingsHomeView(ctx);
    expect(view.degraded).toEqual([]);
    expect(view.meetings).toHaveLength(1);
    const row = view.meetings[0]!;
    expect(row.title).toBe('Surface supplier review');
    expect(row.provider).toBe('zoom');
    expect(row.sessionCount).toBe(1);
    expect(row.lastActivityAt).toMatch(/^2026-10-06T09:54:10(\.000)?Z$/);
    expect(row.href).toBe(`/meetings/${meetingId}`);

    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]!.providerAccountId).toBe(ZOOM_ACCOUNT);
    expect(view.connections[0]!.status).toBe('active');
    expect(view.connections[0]!.modes).toContain('webhook');

    expect(view.participants.length).toBe(2);
    expect(view.participants.map((participant) => participant.displayName)).toContain('June Park');

    expect(view.accessEvents).toEqual([]);
  });

  it('an empty tenant sees honest empty families (never fake emptiness)', async () => {
    const view = await buildMeetingsHomeView(isoCtx);
    expect(view.meetings).toEqual([]);
    expect(view.connections).toEqual([]);
    expect(view.participants).toEqual([]);
    expect(view.accessEvents).toEqual([]);
    expect(view.degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The detail view
// ---------------------------------------------------------------------------

describe('buildMeetingDetailView', () => {
  it('composes the meeting, its session with attendance, transcripts and artifacts', async () => {
    const view = await buildMeetingDetailView(ctx, meetingId);
    expect(view.degraded).toEqual([]);
    expect(view.meeting.title).toBe('Surface supplier review');
    expect(view.meeting.hostParticipantId).not.toBeNull();

    expect(view.sessions).toHaveLength(1);
    const session = view.sessions[0]!;
    expect(session.status).toBe('ended');
    expect(session.participants).toHaveLength(2);
    expect(session.participants[0]!.displayName).toBe('June Park');

    expect(session.transcripts).toHaveLength(1);
    const transcript = session.transcripts[0]!;
    expect(transcript.language).toBe('en-US');
    expect(transcript.segmentCount).toBe(1);
    expect(transcript.preview).toContain('surface reads exactly');
    expect(transcript.evidenceObservationId).not.toBe('');

    expect(session.artifacts).toHaveLength(1);
    expect(session.artifacts[0]!.kind).toBe('recording');
    expect(session.artifacts[0]!.byteSize).toBe(2097152);
    expect(session.artifacts[0]!.evidenceObservationId).not.toBe('');
  });

  it('a foreign or malformed meeting id throws the contract not-found (the honest 404 path)', async () => {
    await expectCode('meeting_not_found', () => buildMeetingDetailView(ctx, newId()));
    await expectCode('meeting_not_found', () => buildMeetingDetailView(ctx, 'not-a-uuid'));
  });

  it('another tenant sees tenant A\'s meeting as missing (no existence leak)', async () => {
    await expectCode('meeting_not_found', () => buildMeetingDetailView(isoCtx, meetingId));
  });
});
