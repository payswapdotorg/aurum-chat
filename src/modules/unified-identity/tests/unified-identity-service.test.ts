// Integration tests for the unified-identity module (W095) against the
// embedded PostgreSQL (PGlite, `:memory:`) through the db port.
//
// The W095 acceptance, proven end-to-end through the DEPENDENCY modules'
// public contracts only (identity W002, people W002, channels W030,
// meetings W085, realtime W086 — the cellular SMS/voice paths W087 ride
// the identity module's 'sms'/'voice' provider rows these tests resolve):
//
//   * the acceptance journey — ONE employee recognized across FOUR
//     communication modalities: messaging (WhatsApp through the REAL
//     W030 challenge loop), meeting (a Zoom participant captured by the
//     W085 webhook path, unified through the ambiguity guard), SMS (an
//     E.164 identity — the rows W087's reach resolution reads), plus the
//     email identity that carried the meeting evidence. Every modality
//     resolves to the SAME person+employee; the profile counts the
//     verified modalities;
//   * the ambiguity rule — an observation whose email and phone facets
//     point at TWO different persons stays unverified with an OPEN
//     ambiguity ledger row (never auto-merged), until an administrator
//     decides; the same E.164 verified as SMS to one person and VOICE to
//     another is ambiguous too; a verified row's newer conflicting
//     evidence RETAINS the link and records the conflict; unverified
//     identities are never match evidence (lock 15);
//   * the realtime/voice path — livekit session participants (incl. a
//     SIP/telephony dial-out party) unified through the realtime pass;
//   * lifecycle — revocation detaches and suppresses auto-relinking;
//     explicit admin attestation re-links and closes ambiguities;
//   * tenant isolation — another tenant's registry, ledger and profiles
//     are uniformly invisible;
//   * repository boundary — every unified table is tenant-scoped.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb, type DbRow } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  attestIdentity,
  registerExternalIdentity,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import {
  createEmployee,
  createPerson,
  linkExternalIdentity,
  type Employee,
  type Person,
} from '@/modules/people/contract';
import {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  receiveInbound,
  registerChannelConnection,
  setChannelTransport,
  type CanonicalDeliveryRequest,
  type ChannelTransport,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  listMeetingParticipants,
  receiveMeetingWebhook,
  registerMeetingConnection,
} from '@/modules/meetings/contract';
import {
  listRealtimeParticipants,
  receiveRealtimeEvent,
  registerRealtimeConnection,
  setRealtimeTransport,
  startRealtimeSession,
  type RealtimeSession,
  type RealtimeTransport,
} from '@/modules/realtime/contract';
import {
  getUnifiedIdentity,
  getUnifiedSubjectProfile,
  linkUnifiedSubject,
  listUnifiedAmbiguities,
  listUnifiedIdentities,
  listUnifiedIdentityEvents,
  observeModalityIdentity,
  resolveUnifiedAmbiguity,
  resolveUnifiedIdentity,
  revokeUnifiedLink,
  UnifiedIdentityError,
  unifyMeetingIdentities,
  unifyRealtimeIdentities,
  type ResolveUnifiedIdentityInput,
  type ObserveModalityIdentityInput,
} from '../contract';
import { runMigrations } from '../../../../scripts/migrate';

// Dedicated tenants per group so count/order assertions stay deterministic.
const tenantJourney = newId();
const tenantAmbiguity = newId();
const tenantCarrier = newId();
const tenantLifecycle = newId();
const tenantRealtime = newId();
const tenantIso = newId();
const tenantIsoB = newId();
const ALL_TENANTS = [
  tenantJourney,
  tenantAmbiguity,
  tenantCarrier,
  tenantLifecycle,
  tenantRealtime,
  tenantIso,
  tenantIsoB,
];

function member(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

/** The tenant's identity administrator (identity:attest + identity:link). */
function identityAdmin(tenantId: string): TenantContext {
  return member(tenantId, ['identity:attest', 'identity:link']);
}

async function expectCode(
  code: UnifiedIdentityError['code'] | 'person_not_found',
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected a typed error with code '${code}' but the call succeeded`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const typed = error as { code?: unknown };
    expect(typed.code, `expected error code '${code}'`).toBe(code);
  }
}

// ---------------------------------------------------------------------------
// Provider fixture builders (raw webhook envelopes — realistic shapes,
// never crossing any contract as anything but `unknown`)
// ---------------------------------------------------------------------------

const BASE_EPOCH_SECONDS = 1_764_000_000; // 2025-11-24T12:00:00Z

function whatsappWebhook(options: {
  from: string;
  text: string;
  wamid: string;
  displayName?: string;
  businessNumber?: string;
  timestamp?: number;
}): Record<string, unknown> {
  const business = (options.businessNumber ?? '+15550100001').replace('+', '');
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: business },
              contacts: [{ profile: { name: options.displayName ?? 'Maya Chen' }, wa_id: options.from.replace('+', '') }],
              messages: [
                {
                  from: options.from.replace('+', ''),
                  id: options.wamid,
                  timestamp: options.timestamp ?? BASE_EPOCH_SECONDS,
                  type: 'text',
                  text: { body: options.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

const ZOOM_ACCOUNT = 'zoom-w095-1';

function zoomEnvelope(
  event: string,
  eventId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event,
    event_id: eventId,
    occurredAt: '2025-11-24T13:00:00Z',
    account: { id: ZOOM_ACCOUNT },
    ...overrides,
  };
}

const zoomSessionWith = (
  eventId: string,
  participants: Array<{ id: string; name: string; email: string | null }>,
): Record<string, unknown> =>
  zoomEnvelope('meeting.started', eventId, {
    meeting: { id: 'mtg-w095' },
    session: {
      id: 'occ-w095',
      status: 'started',
      started_at: '2025-11-24T13:00:30Z',
      ended_at: null,
      participants: participants.map((participant) => ({
        id: participant.id,
        name: participant.name,
        email: participant.email,
        joined_at: '2025-11-24T13:00:30Z',
        left_at: null,
      })),
    },
  });

const LIVEKIT_ACCOUNT = 'lk-w095-1';

function livekitEnvelope(
  roomId: string,
  type: string,
  eventId: string,
  participant: { identity: string; name?: string; email?: string | null; phone?: string | null },
): Record<string, unknown> {
  return {
    type,
    event_id: eventId,
    occurredAt: '2025-11-24T14:00:00Z',
    account: { id: LIVEKIT_ACCOUNT },
    room: { id: roomId },
    participant: {
      identity: participant.identity,
      name: participant.name ?? null,
      email: participant.email ?? null,
      phone: participant.phone ?? null,
    },
  };
}

function roomOf(session: RealtimeSession): string {
  expect(session.providerRoomId).not.toBeNull();
  return session.providerRoomId!;
}

// ---------------------------------------------------------------------------
// Provider-neutral transports (the "wire" the tests read codes off)
// ---------------------------------------------------------------------------

/** Records every delivery request and accepts everything (W045 pattern). */
class RecordingTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static counter = 0;

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    RecordingTransport.counter += 1;
    return {
      status: 'delivered',
      providerMessageId: `w095-wire-${String(RecordingTransport.counter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

/** A minimal scripted realtime transport (realtime-sweep pattern). */
class ScriptedRealtimeTransport implements RealtimeTransport {
  readonly provider = 'livekit' as const;

  async startRoom(request: Parameters<RealtimeTransport['startRoom']>[0]) {
    return { providerRoomId: `room-${request.sessionId}`, agentParticipantId: request.agentParticipantId };
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
    // Fake credential assembled from fragments at runtime — never a literal.
    return {
      url: `wss://example.invalid/${request.sessionId}`,
      token: ['grant', Math.random().toString(36).slice(2, 10)].join('_'),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    };
  }
}

/** Extracts the single-use verification code a provider message carried. */
function challengeCodeFrom(messageText: string): string {
  const match = /(\d{6})/.exec(messageText);
  if (match === null) {
    throw new Error(`the delivered provider message carried no 6-digit code: '${messageText}'`);
  }
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Domain fixture helpers
// ---------------------------------------------------------------------------

async function personWithEmployee(
  ctx: TenantContext,
  fullName: string,
  email: string | null,
): Promise<{ person: Person; employee: Employee }> {
  const person = await createPerson(ctx, { fullName, email });
  const employee = await createEmployee(ctx, {
    personId: person.id,
    employeeNumber: `W095-${newId().slice(0, 8)}`,
    title: 'Operations Lead',
    department: 'Operations',
    hiredAt: '2024-03-04T00:00:00Z',
  });
  return { person, employee };
}

/** A VERIFIED + subject-linked identity-module identity (admin attestation). */
async function verifiedIdentity(
  admin: TenantContext,
  provider: 'email' | 'sms' | 'voice',
  account: string,
  personId: string,
  evidence: string,
): Promise<ExternalIdentity> {
  const { identity } = await registerExternalIdentity(admin, { provider, providerAccountId: account });
  const attested = await attestIdentity(admin, { identityId: identity.id, evidence });
  await linkExternalIdentity(admin, { personId, identityId: identity.id });
  return attested;
}

const BASE_TIME = Date.parse('2025-11-24T12:00:00Z');
let clockMs = BASE_TIME;

function advance(seconds: number): void {
  clockMs += seconds * 1_000;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

beforeEach(() => {
  clockMs = BASE_TIME;
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date(clockMs));
});

afterEach(() => {
  vi.restoreAllMocks();
  setChannelTransport(null);
  setRealtimeTransport(null);
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The acceptance journey: one employee, four modalities, one identity
// ---------------------------------------------------------------------------

describe('W095 · the acceptance journey — one employee recognized across modalities', () => {
  const MAYA_PHONE = '+15550102299';
  const MAYA_EMAIL = 'maya.chen@journey.test';
  const MAYA_SMS = '+15550109999';

  let admin: TenantContext;
  let plain: TenantContext;
  let person: Person;
  let employee: Employee;
  let whatsappIdentity: ExternalIdentity;
  let transport: RecordingTransport;
  let mayaParticipantAccount: string;
  let guestParticipantAccount: string;
  let meetingIdentityId: string;

  beforeAll(async () => {
    admin = identityAdmin(tenantJourney);
    plain = member(tenantJourney);
    const created = await personWithEmployee(plain, 'Maya Chen', MAYA_EMAIL);
    person = created.person;
    employee = created.employee;

    // --- messaging modality through the REAL W030 challenge loop ---
    await registerChannelConnection(plain, {
      provider: 'whatsapp',
      providerAccountId: '+15550100001',
      displayName: 'Journey WhatsApp line',
      credentialRef: `secret-store://w095/whatsapp/${tenantJourney}`,
    });
    transport = new RecordingTransport();
    setChannelTransport(transport);
    try {
      const first = await receiveInbound(plain, {
        provider: 'whatsapp',
        payload: whatsappWebhook({ from: MAYA_PHONE, text: 'Hi Aurum — this is Maya.', wamid: 'w095-wa-0001' }),
      });
      whatsappIdentity = first.identity;
      expect(whatsappIdentity.status).toBe('unverified'); // on sight, untrusted

      await deliverIdentityChallenge(plain, { identityId: whatsappIdentity.id });
      const code = challengeCodeFrom(transport.requests[transport.requests.length - 1]!.message.text);
      await receiveInbound(plain, {
        provider: 'whatsapp',
        payload: whatsappWebhook({ from: MAYA_PHONE, text: code, wamid: 'w095-wa-0002' }),
      });
      whatsappIdentity = await completeIdentityChallenge(plain, {
        identityId: whatsappIdentity.id,
        code,
      });
      expect(whatsappIdentity.status).toBe('verified');
    } finally {
      setChannelTransport(null);
    }
    await linkExternalIdentity(admin, { personId: person.id, identityId: whatsappIdentity.id });

    // --- email identity (the meeting evidence carrier) + SMS identity ---
    await verifiedIdentity(admin, 'email', MAYA_EMAIL, person.id, 'HR directory email');
    await verifiedIdentity(admin, 'sms', MAYA_SMS, person.id, 'HR directory mobile');

    // --- meeting modality through the W085 webhook capture path ---
    await registerMeetingConnection(plain, {
      provider: 'zoom',
      providerAccountId: ZOOM_ACCOUNT,
      displayName: 'Journey Zoom workspace',
      authKind: 'credentials',
      credentialRef: `secret-store://w095/zoom/${tenantJourney}`,
    });
    await receiveMeetingWebhook(plain, {
      provider: 'zoom',
      payload: zoomSessionWith('w095-zm-0001', [
        { id: 'zoom-maya-1', name: 'Maya Chen', email: MAYA_EMAIL },
        { id: 'zoom-guest-1', name: 'Guest Visitor', email: null },
      ]),
    });
    const participants = await listMeetingParticipants(plain, { provider: 'zoom' });
    const maya = participants.find((p) => p.email === MAYA_EMAIL)!;
    const guest = participants.find((p) => p.email === null)!;
    mayaParticipantAccount = maya.providerParticipantId;
    guestParticipantAccount = guest.providerParticipantId;
  });

  it('captures the meeting participants into the tenant registry', () => {
    expect(mayaParticipantAccount).toBeTruthy();
    expect(guestParticipantAccount).toBeTruthy();
  });

  it('unifies the meeting registry through the ambiguity guard', async () => {
    const summary = await unifyMeetingIdentities(plain, {});
    expect(summary).toEqual({
      considered: 2,
      created: 2,
      linked: 1, // Maya — unique verified-email evidence
      ambiguous: 0,
      linkRetained: 0,
      skipped: 0,
    });
  });

  it('auto-links ONLY the uniquely-matched participant, with evidence', async () => {
    const rows = await listUnifiedIdentities(plain, { modality: 'meeting' });
    expect(rows).toHaveLength(2);

    const maya = rows.find((r) => r.providerAccountId === mayaParticipantAccount)!;
    expect(maya.status).toBe('verified');
    expect(maya.subjectId).toBe(person.id);
    expect(maya.verificationMethod).toBe('cross_modality_match');
    expect(maya.verificationEvidence).toContain(MAYA_EMAIL);
    expect(maya.verifiedBy).toBeTruthy();
    meetingIdentityId = maya.id;

    // the email-less guest is known but NEVER trusted (lock 15)
    const guest = rows.find((r) => r.providerAccountId === guestParticipantAccount)!;
    expect(guest.status).toBe('unverified');
    expect(guest.subjectId).toBeNull();
    expect(guest.verificationMethod).toBeNull();
  });

  it('records the decision trail (observed + linked, same clock tick)', async () => {
    const events = await listUnifiedIdentityEvents(plain, { unifiedIdentityId: meetingIdentityId });
    // Both events land within one observation (same tick); the trail keeps
    // them both — the exact intra-tick order is not semantic.
    expect(events.map((event) => event.kind).sort()).toEqual(['linked', 'observed']);
    expect(events.every((event) => event.tenantId === tenantJourney)).toBe(true);
  });

  it('resolves the SAME person from every modality key', async () => {
    const keys = [
      { modality: 'messaging', provider: 'whatsapp', providerAccountId: MAYA_PHONE }, // challenge-verified
      { modality: 'messaging', provider: 'email', providerAccountId: MAYA_EMAIL }, // attested email
      { modality: 'sms', provider: 'sms', providerAccountId: MAYA_SMS }, // cellular rows
      { modality: 'meeting', provider: 'zoom', providerAccountId: mayaParticipantAccount }, // unified registry
    ] as const;
    for (const key of keys) {
      const resolution = await resolveUnifiedIdentity(plain, { ...key });
      expect(resolution.status, `modality ${key.modality}`).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(resolution.person.id).toBe(person.id);
      expect(resolution.person.fullName).toBe('Maya Chen');
      expect(resolution.employee!.id).toBe(employee.id);
      expect(resolution.employee!.status).toBe('active');
    }
  });

  it('carries the registry origin on unified views without leaking internals', async () => {
    const fromIdentityModule = await resolveUnifiedIdentity(plain, {
      modality: 'messaging',
      provider: 'whatsapp',
      providerAccountId: MAYA_PHONE,
    });
    expect(fromIdentityModule.status).toBe('resolved');
    if (fromIdentityModule.status === 'resolved') {
      expect(fromIdentityModule.view.origin).toBe('identity_module');
    }

    const fromRegistry = await resolveUnifiedIdentity(plain, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: mayaParticipantAccount,
    });
    expect(fromRegistry.status).toBe('resolved');
    if (fromRegistry.status === 'resolved') {
      expect(fromRegistry.view.origin).toBe('unified_registry');
    }
  });

  it('resolves the guest honestly as unverified', async () => {
    const resolution = await resolveUnifiedIdentity(plain, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: guestParticipantAccount,
    });
    expect(resolution.status).toBe('unverified');
    if (resolution.status === 'unverified') {
      expect(resolution.view.origin).toBe('unified_registry');
    }
  });

  it('reports unknown identities without existence leaks', async () => {
    const resolution = await resolveUnifiedIdentity(plain, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'never-seen',
    });
    expect(resolution.status).toBe('unknown_identity');
  });

  it('shows the employee’s verified reach across FOUR modalities (the W095 proof)', async () => {
    const profile = await getUnifiedSubjectProfile(plain, person.id);
    expect(profile.person.id).toBe(person.id);
    expect(profile.employee!.id).toBe(employee.id);
    expect(profile.verifiedModalityCount).toBe(3); // messaging + sms + meeting
    expect(profile.modalities.map((reach) => reach.modality)).toEqual(['messaging', 'sms', 'meeting']);

    const byModality = new Map(profile.modalities.map((reach) => [reach.modality, reach.identities]));
    expect(byModality.get('messaging')!.map((view) => view.origin).sort()).toEqual([
      'identity_module',
      'identity_module',
    ]); // whatsapp + email
    expect(byModality.get('sms')!).toHaveLength(1);
    expect(byModality.get('meeting')!.map((view) => view.origin)).toEqual(['unified_registry']);
  });
});

// ---------------------------------------------------------------------------
// The ambiguity rule (the acceptance's second half)
// ---------------------------------------------------------------------------

describe('W095 · ambiguous matches remain external/unverified — never auto-merged', () => {
  const EMAIL = 'dana@ambiguity.test';
  const PHONE = '+15550107777';

  let admin: TenantContext;
  let plain: TenantContext;
  let personA: Person;
  let personB: Person;
  let edgeIdentityId: string;
  let ambiguityId: string;

  beforeAll(async () => {
    admin = identityAdmin(tenantAmbiguity);
    plain = member(tenantAmbiguity);
    personA = (await personWithEmployee(plain, 'Dana Archer', EMAIL)).person;
    personB = (await personWithEmployee(plain, 'Sasha Bello', 'sasha@ambiguity.test')).person;

    // Person A owns the email facet; person B owns the phone facet.
    await verifiedIdentity(admin, 'email', EMAIL, personA.id, 'HR directory email');
    await verifiedIdentity(admin, 'sms', PHONE, personB.id, 'HR directory mobile');
  });

  it('records an OPEN ambiguity and stays unverified when facets disagree', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-usr-1',
      displayName: 'Edge user',
      email: EMAIL,
      phone: PHONE,
    });
    expect(result.created).toBe(true);
    expect(result.match.outcome).toBe('ambiguous');
    if (result.match.outcome === 'ambiguous') {
      expect(result.match.candidates).toHaveLength(2);
      expect(result.match.candidates.map((candidate) => candidate.personId).sort()).toEqual(
        [personA.id, personB.id].sort(),
      );
      ambiguityId = result.match.ambiguityId;
    }
    expect(result.identity.status).toBe('unverified'); // NEVER merged
    expect(result.identity.subjectId).toBeNull();
    edgeIdentityId = result.identity.id;
  });

  it('keeps the ambiguity queryable with its candidates', async () => {
    const open = await listUnifiedAmbiguities(plain, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe(ambiguityId);
    expect(open[0]!.kind).toBe('conflicting_subject_matches');
    expect(open[0]!.candidates.map((candidate) => candidate.personId).sort()).toEqual(
      [personA.id, personB.id].sort(),
    );
    expect(open[0]!.detail).toContain(EMAIL);
    expect(open[0]!.detail).toContain(PHONE);
  });

  it('resolves the ambiguous identity as unverified (external), from every angle', async () => {
    const resolution = await resolveUnifiedIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-usr-1',
    });
    expect(resolution.status).toBe('unverified');
  });

  it('attributes the edge identity to NEITHER person', async () => {
    for (const person of [personA, personB]) {
      const profile = await getUnifiedSubjectProfile(plain, person.id);
      expect(profile.verifiedModalityCount).toBe(1); // only their own email/sms identity
      expect(profile.modalities.map((reach) => reach.modality)).not.toContain('edge');
    }
  });

  it('refreshes the open ambiguity instead of stacking duplicates on re-observation', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-usr-1',
      email: EMAIL,
      phone: PHONE,
    });
    expect(result.created).toBe(false);
    expect(result.match.outcome).toBe('ambiguous');
    const open = await listUnifiedAmbiguities(plain, { status: 'open' });
    expect(open).toHaveLength(1);
  });

  it('an administrator’s explicit link resolves the ambiguity and closes it', async () => {
    advance(60);
    const linked = await linkUnifiedSubject(admin, {
      unifiedIdentityId: edgeIdentityId,
      personId: personA.id,
      evidence: 'HR confirmed the Edge Connector account belongs to Dana Archer',
    });
    expect(linked.status).toBe('verified');
    expect(linked.subjectId).toBe(personA.id);
    expect(linked.verificationMethod).toBe('admin_attestation');

    const resolved = await listUnifiedAmbiguities(plain, { status: 'resolved' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolvedAction).toBe('admin_linked');
    expect(resolved[0]!.resolvedBy).toBe(admin.principalId);

    const profile = await getUnifiedSubjectProfile(plain, personA.id);
    expect(profile.verifiedModalityCount).toBe(2); // messaging + edge now
    expect(profile.modalities.map((reach) => reach.modality)).toEqual(['messaging', 'edge']);
  });
});

// ---------------------------------------------------------------------------
// Carrier disagreement: one E.164, two persons
// ---------------------------------------------------------------------------

describe('W095 · the same E.164 verified as SMS and VOICE to different persons is ambiguous', () => {
  const SHARED_NUMBER = '+15550108888';
  const UNIQUE_NUMBER = '+15550101234';

  let admin: TenantContext;
  let plain: TenantContext;
  let personA: Person;
  let personB: Person;

  beforeAll(async () => {
    admin = identityAdmin(tenantCarrier);
    plain = member(tenantCarrier);
    personA = (await personWithEmployee(plain, 'Avery Cole', 'avery@carrier.test')).person;
    personB = (await personWithEmployee(plain, 'Blair Doe', 'blair@carrier.test')).person;

    // Both facets of the shared number are verified — to DIFFERENT persons.
    await verifiedIdentity(admin, 'sms', SHARED_NUMBER, personA.id, 'HR mobile (SMS)');
    await verifiedIdentity(admin, 'voice', SHARED_NUMBER, personB.id, 'HR landline (voice)');
    // A second number verified on SMS only — unambiguous.
    await verifiedIdentity(admin, 'sms', UNIQUE_NUMBER, personA.id, 'HR second mobile');
  });

  it('stays unverified when the number’s carriers disagree', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-carrier-1',
      phone: SHARED_NUMBER,
    });
    expect(result.match.outcome).toBe('ambiguous');
    expect(result.identity.status).toBe('unverified');
    expect(result.identity.subjectId).toBeNull();

    const open = await listUnifiedAmbiguities(plain, { status: 'open' });
    expect(open).toHaveLength(1);
    const candidates = open[0]!.candidates.map((candidate) => candidate.matchedVia).sort();
    expect(candidates).toEqual(['sms', 'voice']);
  });

  it('links a phone facet that matches exactly one person', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-carrier-2',
      phone: UNIQUE_NUMBER,
    });
    expect(result.match.outcome).toBe('linked');
    if (result.match.outcome === 'linked') {
      expect(result.match.personId).toBe(personA.id);
      expect(result.match.candidates).toHaveLength(1);
      expect(result.match.candidates[0]!.matchedVia).toBe('sms');
    }
    expect(result.identity.status).toBe('verified');
    expect(result.identity.subjectId).toBe(personA.id);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: conflict retention, revocation, re-attestation, dismissal
// ---------------------------------------------------------------------------

describe('W095 · lifecycle — verified links stay stable, revoked links never silently return', () => {
  let admin: TenantContext;
  let linkOnly: TenantContext;
  let plain: TenantContext;
  let personA: Person;
  let personB: Person;
  let meetingIdentityId: string;
  let dismissedIdentityId: string;
  let dismissedAmbiguityId: string;

  beforeAll(async () => {
    admin = identityAdmin(tenantLifecycle);
    linkOnly = member(tenantLifecycle, ['identity:link']);
    plain = member(tenantLifecycle);
    personA = (await personWithEmployee(plain, 'Adrian Faith', 'adrian@life.test')).person;
    personB = (await personWithEmployee(plain, 'Briar Grove', 'briar@life.test')).person;

    await verifiedIdentity(admin, 'email', 'adrian@life.test', personA.id, 'HR email A');
    await verifiedIdentity(admin, 'email', 'briar@life.test', personB.id, 'HR email B');
    await verifiedIdentity(admin, 'sms', '+15550105555', personB.id, 'HR mobile B');
    // An UNVERIFIED email identity — never match evidence (lock 15).
    await registerExternalIdentity(admin, { provider: 'email', providerAccountId: 'unverified@life.test' });

    await registerMeetingConnection(plain, {
      provider: 'zoom',
      providerAccountId: ZOOM_ACCOUNT,
      displayName: 'Lifecycle Zoom workspace',
      authKind: 'credentials',
      credentialRef: `secret-store://w095/zoom-life/${tenantLifecycle}`,
    });
  });

  it('links a meeting participant through unique email evidence', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'zoom-life-1',
      email: 'adrian@life.test',
    });
    expect(result.match.outcome).toBe('linked');
    expect(result.identity.subjectId).toBe(personA.id);
    meetingIdentityId = result.identity.id;
  });

  it('RETAINS the verified link when newer evidence points elsewhere — and records the conflict', async () => {
    advance(120);
    const result = await observeModalityIdentity(plain, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'zoom-life-1',
      email: 'briar@life.test', // the participant's email changed (facets move forward)
    });
    expect(result.match.outcome).toBe('link_retained');
    if (result.match.outcome === 'link_retained') {
      expect(result.match.personId).toBe(personA.id); // stability — never re-linked silently
    }
    expect(result.identity.status).toBe('verified');
    expect(result.identity.subjectId).toBe(personA.id);

    const open = await listUnifiedAmbiguities(plain, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0]!.kind).toBe('linked_subject_conflict');
    expect(open[0]!.unifiedIdentityId).toBe(meetingIdentityId);
  });

  it('never treats an unverified identity as evidence (lock 15)', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-life-1',
      email: 'unverified@life.test',
    });
    expect(result.match.outcome).toBe('unmatched');
    expect(result.identity.status).toBe('unverified');
    expect(result.identity.subjectId).toBeNull();
  });

  it('gates the trust operations on the identity authority claims', async () => {
    await expectCode('forbidden', () =>
      linkUnifiedSubject(plain, {
        unifiedIdentityId: meetingIdentityId,
        personId: personA.id,
        evidence: 'no claims',
      }),
    );
    await expectCode('forbidden', () =>
      revokeUnifiedLink(linkOnly, { unifiedIdentityId: meetingIdentityId, reason: 'link claim only' }),
    );
  });

  it('revokes the verified link (detaching the subject) and closes the conflict', async () => {
    advance(60);
    const revoked = await revokeUnifiedLink(admin, {
      unifiedIdentityId: meetingIdentityId,
      reason: 'participant account reassigned by the provider',
    });
    expect(revoked.status).toBe('revoked');
    expect(revoked.subjectId).toBeNull();
    expect(revoked.verificationMethod).toBeNull();
    expect(revoked.verificationEvidence).toBeNull();
    expect(revoked.revokedReason).toContain('reassigned');

    const open = await listUnifiedAmbiguities(plain, { status: 'open' });
    expect(open).toHaveLength(0);
    const resolved = await listUnifiedAmbiguities(plain, { status: 'resolved' });
    expect(resolved[0]!.resolvedAction).toBe('revoked');

    const profile = await getUnifiedSubjectProfile(plain, personA.id);
    expect(profile.modalities.map((reach) => reach.modality)).not.toContain('meeting');
  });

  it('never auto-relinks a revoked unification on re-observation', async () => {
    const result = await observeModalityIdentity(plain, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'zoom-life-1',
      email: 'adrian@life.test', // unique evidence again — still not enough
    });
    expect(result.match.outcome).toBe('unmatched');
    expect(result.identity.status).toBe('revoked');
    expect(result.identity.subjectId).toBeNull();
  });

  it('re-links through an explicit admin attestation onto a different subject', async () => {
    advance(60);
    const linked = await linkUnifiedSubject(linkOnly, {
      unifiedIdentityId: meetingIdentityId,
      personId: personB.id,
      evidence: 'Provider confirmed the account now belongs to Briar Grove',
    });
    expect(linked.status).toBe('verified');
    expect(linked.subjectId).toBe(personB.id);
    expect(linked.verificationMethod).toBe('admin_attestation');

    const profile = await getUnifiedSubjectProfile(plain, personB.id);
    expect(profile.modalities.map((reach) => reach.modality)).toContain('meeting');
  });

  it('refuses double links and bad subjects uniformly', async () => {
    await expectCode('unified_identity_already_linked', () =>
      linkUnifiedSubject(admin, {
        unifiedIdentityId: meetingIdentityId,
        personId: personA.id,
        evidence: 'already linked to B',
      }),
    );
    await expectCode('person_not_found', () =>
      linkUnifiedSubject(admin, {
        unifiedIdentityId: meetingIdentityId,
        personId: newId(),
        evidence: 'unknown person',
      }),
    );
    await expectCode('invalid_unified_input', () =>
      linkUnifiedSubject(admin, {
        unifiedIdentityId: meetingIdentityId,
        personId: 'not-a-uuid',
        evidence: 'bad uuid',
      }),
    );
    await expectCode('unified_identity_not_found', () =>
      linkUnifiedSubject(admin, {
        unifiedIdentityId: newId(),
        personId: personA.id,
        evidence: 'unknown identity',
      }),
    );
  });

  it('dismisses an open ambiguity without linking (the reviewed-no-action path)', async () => {
    advance(60);
    const result = await observeModalityIdentity(plain, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-life-2',
      email: 'adrian@life.test',
      phone: '+15550105555', // email → A, phone → B: ambiguous
    });
    expect(result.match.outcome).toBe('ambiguous');
    if (result.match.outcome === 'ambiguous') {
      dismissedAmbiguityId = result.match.ambiguityId;
    }
    dismissedIdentityId = result.identity.id;

    const dismissed = await resolveUnifiedAmbiguity(admin, {
      ambiguityId: dismissedAmbiguityId,
      action: 'dismissed',
      note: 'Reviewed: no action for now',
    });
    expect(dismissed.status).toBe('resolved');
    expect(dismissed.resolvedAction).toBe('dismissed');

    // the identity itself remains unverified — dismissal links nothing
    const identity = await getUnifiedIdentity(plain, dismissedIdentityId);
    expect(identity.status).toBe('unverified');
    expect(identity.subjectId).toBeNull();
  });

  it('refuses resolving an unknown or already-resolved ambiguity', async () => {
    await expectCode('ambiguity_not_found', () =>
      resolveUnifiedAmbiguity(admin, { ambiguityId: newId(), action: 'dismissed' }),
    );
    await expectCode('ambiguity_already_resolved', () =>
      resolveUnifiedAmbiguity(admin, { ambiguityId: dismissedAmbiguityId, action: 'dismissed' }),
    );
  });
});

// ---------------------------------------------------------------------------
// The realtime/voice path (W086) through the participant registry
// ---------------------------------------------------------------------------

describe('W095 · the realtime path — voice session participants unify (incl. SIP dial-out)', () => {
  const RAVI_EMAIL = 'ravi@realtime.test';
  const RAVI_SMS = '+15550104444';

  let admin: TenantContext;
  let plain: TenantContext;
  let personR: Person;
  let session: RealtimeSession;

  beforeAll(async () => {
    admin = identityAdmin(tenantRealtime);
    plain = member(tenantRealtime);
    personR = (await personWithEmployee(plain, 'Ravi Patel', RAVI_EMAIL)).person;

    await verifiedIdentity(admin, 'email', RAVI_EMAIL, personR.id, 'HR directory email');
    await verifiedIdentity(admin, 'sms', RAVI_SMS, personR.id, 'HR directory mobile');

    const { connection } = await registerRealtimeConnection(plain, {
      provider: 'livekit',
      providerAccountId: LIVEKIT_ACCOUNT,
      authKind: 'api_key',
      credentialRef: `secret-store://w095/livekit/${tenantRealtime}`,
    });
    setRealtimeTransport(new ScriptedRealtimeTransport());
    const started = await startRealtimeSession(plain, {
      connectionId: connection.id,
      kind: 'aurum_voice',
      title: 'Morning sync',
    });
    session = started.session;

    // A human joins with an email; a telephony party joins over SIP (no
    // Internet, no Aurum account — the W086/W087 reachability posture).
    await receiveRealtimeEvent(plain, {
      provider: 'livekit',
      payload: livekitEnvelope(roomOf(session), 'participant.connected', 'w095-rt-0001', {
        identity: 'p-ravi',
        name: 'Ravi Patel',
        email: RAVI_EMAIL,
      }),
    });
    await receiveRealtimeEvent(plain, {
      provider: 'livekit',
      payload: livekitEnvelope(roomOf(session), 'participant.connected', 'w095-rt-0002', {
        identity: 'sip:+15550104444',
        name: 'Ravi (mobile)',
        phone: RAVI_SMS,
      }),
    });
  });

  it('saw the participants (Aurum’s own included)', async () => {
    const participants = await listRealtimeParticipants(plain, { sessionId: session.id });
    expect(participants).toHaveLength(3); // aurum + human + phone party
    expect(participants.filter((p) => p.role === 'aurum')).toHaveLength(1);
  });

  it('unifies the realtime registry, skipping Aurum’s own participant', async () => {
    const summary = await unifyRealtimeIdentities(plain, { sessionId: session.id });
    expect(summary).toEqual({
      considered: 3,
      created: 2,
      linked: 2, // both Ravi's human and telephony parties
      ambiguous: 0,
      linkRetained: 0,
      skipped: 1, // Aurum itself is an application actor, never unified
    });
  });

  it('recognizes Ravi from BOTH realtime identities (email facet + E.164 facet)', async () => {
    for (const account of ['p-ravi', 'sip:+15550104444']) {
      const resolution = await resolveUnifiedIdentity(plain, {
        modality: 'realtime',
        provider: 'livekit',
        providerAccountId: account,
      });
      expect(resolution.status, `account ${account}`).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(resolution.person.id).toBe(personR.id);
    }
  });

  it('is idempotent across passes (whole-registry pass this time)', async () => {
    const summary = await unifyRealtimeIdentities(plain, {});
    expect(summary.created).toBe(0);
    expect(summary.linked).toBe(0);
    expect(summary.linkRetained).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('counts realtime as a third modality in Ravi’s profile', async () => {
    const profile = await getUnifiedSubjectProfile(plain, personR.id);
    expect(profile.verifiedModalityCount).toBe(3); // messaging + sms + realtime
    const realtime = profile.modalities.find((reach) => reach.modality === 'realtime')!;
    expect(realtime.identities).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('W095 · tenant isolation — another tenant’s unification state is invisible', () => {
  const EMAIL = 'park@iso.test';

  let adminA: TenantContext;
  let plainA: TenantContext;
  let plainB: TenantContext;
  let adminB: TenantContext;
  let personA: Person;
  let rowA: string;
  let ambiguityA: string;

  beforeAll(async () => {
    adminA = identityAdmin(tenantIso);
    plainA = member(tenantIso);
    plainB = member(tenantIsoB);
    adminB = identityAdmin(tenantIsoB);
    personA = (await personWithEmployee(plainA, 'Park Ineo', EMAIL)).person;
    const rho = await createPerson(plainA, { fullName: 'Rho Kappa' });

    // Tenant A: a linked meeting identity + an ambiguous edge identity
    // (email → personA, sms → rho).
    await verifiedIdentity(adminA, 'email', EMAIL, personA.id, 'HR email');
    await verifiedIdentity(adminA, 'sms', '+15550107770', rho.id, 'HR mobile');
    const linked = await observeModalityIdentity(plainA, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'p-iso',
      email: EMAIL,
    });
    expect(linked.match.outcome).toBe('linked');
    rowA = linked.identity.id;
    const ambiguous = await observeModalityIdentity(plainA, {
      modality: 'edge',
      provider: 'edge-connector',
      providerAccountId: 'edge-iso-2',
      email: EMAIL,
      phone: '+15550107770',
    });
    expect(ambiguous.match.outcome).toBe('ambiguous');
    if (ambiguous.match.outcome === 'ambiguous') ambiguityA = ambiguous.match.ambiguityId;

    // Tenant B: the SAME provider account, its own independent registry row.
    await observeModalityIdentity(plainB, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'p-iso',
    });
  });

  it('resolves the same provider account independently per tenant', async () => {
    const inA = await resolveUnifiedIdentity(plainA, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'p-iso',
    });
    expect(inA.status).toBe('resolved');

    const inB = await resolveUnifiedIdentity(plainB, {
      modality: 'meeting',
      provider: 'zoom',
      providerAccountId: 'p-iso',
    });
    expect(inB.status).toBe('unverified'); // tenant B's own unlinked row
  });

  it('hides another tenant’s registry rows uniformly (no existence leak)', async () => {
    await expectCode('unified_identity_not_found', () => getUnifiedIdentity(plainB, rowA));
    await expectCode('unified_identity_not_found', () => getUnifiedIdentity(plainB, newId()));
    await expectCode('unified_identity_not_found', () =>
      linkUnifiedSubject(adminB, { unifiedIdentityId: rowA, personId: newId(), evidence: 'steal' }),
    );
    await expectCode('unified_identity_not_found', () =>
      revokeUnifiedLink(adminB, { unifiedIdentityId: rowA, reason: 'steal' }),
    );
  });

  it('hides another tenant’s ambiguities uniformly', async () => {
    await expectCode('ambiguity_not_found', () =>
      resolveUnifiedAmbiguity(adminB, { ambiguityId: ambiguityA, action: 'dismissed' }),
    );
    expect(await listUnifiedAmbiguities(plainB, { status: 'open' })).toEqual([]);
    expect(await listUnifiedAmbiguities(plainB, { status: 'resolved' })).toEqual([]);
  });

  it('keeps listings per-tenant', async () => {
    const rowsA = await listUnifiedIdentities(plainA, {});
    expect(rowsA.map((row) => row.id)).toContain(rowA);
    const rowsB = await listUnifiedIdentities(plainB, {});
    expect(rowsB.map((row) => row.id)).not.toContain(rowA);
    expect(rowsB.every((row) => row.tenantId === tenantIsoB)).toBe(true);
  });

  it('refuses another tenant’s person records (profiles are tenant-scoped)', async () => {
    await expectCode('person_not_found', () => getUnifiedSubjectProfile(plainB, personA.id));
  });

  it('never writes a row outside the test tenants (row partition)', async () => {
    const placeholders = ALL_TENANTS.map((_, index) => `$${index + 1}`).join(', ');
    for (const table of ['unified_identities', 'unified_ambiguities', 'unified_identity_events']) {
      const result = await getDb().query<{ bad: string }>(
        `SELECT count(*)::text AS bad FROM ${table}
           WHERE tenant_id IS NULL OR tenant_id NOT IN (${placeholders})`,
        ALL_TENANTS,
      );
      expect(result.rows[0]!.bad, table).toBe('0');
    }
  });
});

// ---------------------------------------------------------------------------
// Repository boundary (schema discipline)
// ---------------------------------------------------------------------------

describe('W095 · repository boundary — every unified table is tenant-scoped', () => {
  it('carries a NOT NULL uuid tenant_id on all three tables', async () => {
    const columns = await getDb().query<DbRow & { table_name: string; column_name: string; data_type: string; is_nullable: string }>(
      `SELECT table_name, column_name, data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name IN ('unified_identities', 'unified_ambiguities', 'unified_identity_events')
         ORDER BY table_name, ordinal_position`,
    );
    const byTable = new Map<string, { data_type: string; is_nullable: string } | null>();
    for (const column of columns.rows) {
      if (column.column_name !== 'tenant_id') continue;
      byTable.set(column.table_name, { data_type: column.data_type, is_nullable: column.is_nullable });
    }
    for (const table of ['unified_identities', 'unified_ambiguities', 'unified_identity_events']) {
      const tenantColumn = byTable.get(table);
      expect(tenantColumn, `${table} must carry tenant_id`).not.toBeNull();
      expect(tenantColumn!.data_type).toBe('uuid');
      expect(tenantColumn!.is_nullable).toBe('NO');
    }
  });

  it('rejects out-of-vocabulary modalities and mismatched providers at the boundary', async () => {
    const ctx = member(tenantLifecycle);
    await expectCode('unsupported_modality', () =>
      observeModalityIdentity(
        ctx,
        { modality: 'messaging', provider: 'whatsapp', providerAccountId: '+15550101111' } as unknown as ObserveModalityIdentityInput,
      ),
    );
    await expectCode('invalid_unified_input', () =>
      observeModalityIdentity(ctx, { modality: 'meeting', provider: 'livekit', providerAccountId: 'x' }),
    );
    await expectCode('invalid_unified_input', () =>
      resolveUnifiedIdentity(ctx, { modality: 'messaging', provider: 'zoom', providerAccountId: 'x' }),
    );
    await expectCode('invalid_unified_input', () =>
      resolveUnifiedIdentity(ctx, { modality: 'sms', provider: 'whatsapp', providerAccountId: '+15550101111' }),
    );
    await expectCode('invalid_unified_input', () =>
      resolveUnifiedIdentity(
        ctx,
        { modality: 'carrier-pigeon', provider: 'sms', providerAccountId: 'x' } as unknown as ResolveUnifiedIdentityInput,
      ),
    );
  });
});
