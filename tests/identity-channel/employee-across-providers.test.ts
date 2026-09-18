// W045 — Identity/Channel Verification (end-to-end, part 1: the journey).
//
// "End-to-end test that the same employee can communicate across multiple
//  providers while permissions remain consistent."
//
// This file walks the complete cross-module journey for ONE employee —
// Maya Chen, Operations Lead at Acme — across FOUR channel providers
// (WhatsApp, Telegram, Slack, email), strictly through public contracts:
//
//   first contact (raw provider webhooks → external turns, lock 15)
//   → per-provider verification (code delivered over the employee's own
//     channel, replied over the same channel, completes the W002 workflow)
//   → claim-gated linking (a plain member is refused on every provider;
//     the identity admin links all four accounts to the one person)
//   → communication as the employee (every provider attributes the SAME
//     person; resolution returns the SAME person+employee from every
//     provider key; Aurum replies over each provider)
//   → transcript shape (per-person and per-identity retrieval across
//     channels; one thread per provider, one human across them)
//   → subject-state consistency (an employment change is visible
//     identically through every provider).
//
// Permission-consistency dimensions that mutate policy or trust state
// (authority-matrix uniformity, per-identity revocation, cross-tenant
// isolation) are covered by permission-consistency.test.ts in this
// directory, on an identical journey fixture.
//
// Database: embedded PostgreSQL (PGlite, `:memory:`) through the db port —
// this file's module graph gets a private database, migrated in beforeAll.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import {
  receiveInbound,
  sendOutbound,
  setChannelTransport,
} from '@/modules/channels/contract';
import { listConversations, listMessages } from '@/modules/conversations/contract';
import { IdentityError } from '@/modules/identity/contract';
import {
  resolveIdentity,
  setEmployeeStatus,
  type IdentityResolution,
} from '@/modules/people/contract';
import {
  onboardEmployeeAcrossProviders,
  prepareDatabase,
  RecordingTransport,
  teardownDatabase,
  type OnboardingFixture,
} from './helpers';

const tenantId = newId();

let fixture: OnboardingFixture;
let transport: RecordingTransport;

beforeAll(async () => {
  await prepareDatabase();
  fixture = await onboardEmployeeAcrossProviders({
    tenantId,
    fullName: 'Maya Chen',
    email: 'maya.chen@acme.example',
    title: 'Operations Lead',
    department: 'Operations',
  });
});

beforeEach(() => {
  transport = new RecordingTransport();
  setChannelTransport(transport);
});

afterAll(async () => {
  await teardownDatabase();
});

/** The provider keys of the journey, in persona order. */
const KEYS = ['whatsapp', 'telegram', 'slack', 'email'] as const;

describe('W045 · first contact over each provider (pre-verification)', () => {
  it('registers each provider account on sight, unverified and unlinked', () => {
    expect(fixture.providers).toHaveLength(4);
    for (const journey of fixture.providers) {
      expect(journey.firstTurn.identityCreated).toBe(true);
      expect(journey.firstTurn.identity.provider).toBe(journey.persona.provider);
      expect(journey.firstTurn.identity.providerAccountId).toBe(journey.persona.account);
      expect(journey.firstTurn.identity.status).toBe('unverified');
      expect(journey.firstTurn.identity.subjectId).toBeNull();
    }
    // four distinct provider identities for the one human
    const identityIds = new Set(fixture.providers.map((p) => p.firstTurn.identity.id));
    expect(identityIds.size).toBe(4);
  });

  it('attributes the pre-verification turns to an external actor — no pseudo-employees (lock 15)', () => {
    for (const journey of fixture.providers) {
      const actor = journey.firstTurn.message.actor;
      expect(actor.kind).toBe('external');
      expect(actor.id).toBeNull();
      // …while the transcript still records WHICH account carried the turn
      expect(actor.identityId).toBe(journey.firstTurn.identity.id);
      expect(journey.firstTurn.message.channel).toBe(journey.persona.provider);
    }
  });

  it('opens one provider thread per provider (four conversations, one tenant)', () => {
    const conversationIds = new Set(fixture.providers.map((p) => p.firstTurn.message.conversationId));
    expect(conversationIds.size).toBe(4);
    for (const id of conversationIds) expect(id).toBeTruthy();
  });
});

describe('W045 · per-provider verification (the challenge loop, W002 via W030)', () => {
  it('delivers a single-use code over the employee’s OWN channel, from the tenant’s endpoint', () => {
    for (const journey of fixture.providers) {
      const request = fixture.transport.requests.find(
        (candidate) =>
          candidate.purpose === 'verification' &&
          candidate.provider === journey.persona.provider &&
          candidate.to.providerAccountId === journey.persona.account,
      );
      expect(request).toBeDefined();
      expect(request!.tenantId).toBe(tenantId);
      expect(request!.from.providerAccountId).toBe(journey.persona.connectionAccount);
      expect(journey.challenge.code).toMatch(/^\d{6}$/);
      // the delivered provider message carried the code on the wire…
      expect(request!.message.text).toContain(journey.challenge.code);
    }
    // one verification delivery per provider, in persona order
    expect(
      fixture.transport.requests.filter((request) => request.purpose === 'verification'),
    ).toHaveLength(4);
  });

  it('NEVER persists the delivered code — the transcript turn carries a redaction marker only', () => {
    for (const journey of fixture.providers) {
      const turn = journey.challenge.delivery.message;
      expect(turn.direction).toBe('outbound');
      expect(turn.channel).toBe(journey.persona.provider);
      expect(turn.payload).toMatchObject({ kind: 'verification_code' });
      expect(JSON.stringify(turn.payload)).not.toContain(journey.challenge.code);
    }
  });

  it('records the account holder’s code reply in the SAME provider thread, still external', () => {
    for (const journey of fixture.providers) {
      const reply = journey.challenge.replyTurn;
      expect(reply.message.conversationId).toBe(journey.firstTurn.message.conversationId);
      // the reply happened while the identity was still pending → external
      expect(reply.message.actor.kind).toBe('external');
      expect(reply.message.actor.identityId).toBe(journey.firstTurn.identity.id);
      expect(reply.message.payload).toMatchObject({
        kind: 'message',
        content: { text: journey.challenge.code },
      });
      expect(reply.identity.id).toBe(journey.firstTurn.identity.id);
      expect(reply.identityCreated).toBe(false); // the on-sight registration survived
    }
  });

  it('completes verification from the channel-replied code on every provider', () => {
    for (const journey of fixture.providers) {
      expect(journey.verified.id).toBe(journey.firstTurn.identity.id);
      expect(journey.verified.status).toBe('verified');
      expect(journey.verified.verificationMethod).toBe('challenge_response');
    }
  });
});

describe('W045 · linking the verified accounts to the employee (claim-gated, uniform)', () => {
  it('refuses a plain member on EVERY provider (the identity:link claim is required)', () => {
    for (const journey of fixture.providers) {
      expect(journey.memberLinkError).toBeInstanceOf(IdentityError);
      expect((journey.memberLinkError as IdentityError).code).toBe('forbidden');
    }
  });

  it('links every verified identity to the one person through the people contract', () => {
    for (const journey of fixture.providers) {
      expect(journey.link.person.id).toBe(fixture.person.id);
      expect(journey.link.identity.id).toBe(journey.firstTurn.identity.id);
      expect(journey.link.identity.status).toBe('verified');
      expect(journey.link.identity.subjectId).toBe(fixture.person.id);
      expect(journey.link.identity.subjectKind).toBe('person');
    }
  });
});

describe('W045 · the same employee communicates over every provider', () => {
  it('attributes every post-link turn to the SAME person, whichever provider carries it', async () => {
    for (const [index, journey] of fixture.providers.entries()) {
      const turn = await receiveInbound(fixture.member, {
        provider: journey.persona.provider,
        payload: journey.persona.inbound(
          index === 0
            ? 'Verified now! What renewal deadlines are coming up this quarter?'
            : 'Following up from my other account — anything new on the renewals?',
          index * 100 + 10,
        ),
      });

      expect(turn.identityCreated).toBe(false); // same account as first contact
      expect(turn.identity.id).toBe(journey.firstTurn.identity.id);
      expect(turn.identity.status).toBe('verified');
      expect(turn.identity.subjectId).toBe(fixture.person.id);

      const actor = turn.message.actor;
      expect(actor.kind).toBe('person');
      expect(actor.id).toBe(fixture.person.id); // THE employee — on every provider
      // …while the transcript still shows which identity carried the turn
      expect(actor.identityId).toBe(journey.firstTurn.identity.id);
      expect(turn.message.conversationId).toBe(journey.firstTurn.message.conversationId);
    }
  });

  it('resolves the employee identically from every provider key', async () => {
    const resolutions: IdentityResolution[] = [];
    for (const journey of fixture.providers) {
      resolutions.push(
        await resolveIdentity(fixture.member, {
          provider: journey.persona.provider,
          providerAccountId: journey.persona.account,
        }),
      );
    }
    for (const resolution of resolutions) {
      expect(resolution.status).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(resolution.person.id).toBe(fixture.person.id);
      expect(resolution.person.fullName).toBe('Maya Chen');
      expect(resolution.employee!.id).toBe(fixture.employee.id);
      expect(resolution.employee!.employeeNumber).toBe(fixture.employee.employeeNumber);
      expect(resolution.employee!.status).toBe('active');
    }
  });

  it('lets Aurum reply to the employee over each provider (delivery + transcript)', async () => {
    for (const journey of fixture.providers) {
      const outbound = await sendOutbound(fixture.member, {
        provider: journey.persona.provider,
        to: { providerAccountId: journey.persona.account, displayName: 'Maya Chen' },
        content: { text: 'Three renewals land in October — summaries are on the way.', attachments: [] },
        conversationId: journey.firstTurn.message.conversationId,
      });
      expect(outbound.receipt.status).toBe('delivered');
      expect(outbound.message.direction).toBe('outbound');
      expect(outbound.message.channel).toBe(journey.persona.provider);
      expect(outbound.message.conversationId).toBe(journey.firstTurn.message.conversationId);
      expect(outbound.message.actor.kind).toBe('system'); // the tenant's endpoint spoke
      // the wire request went to the employee's account on that provider
      const wire = transport.requests[transport.requests.length - 1]!;
      expect(wire.provider).toBe(journey.persona.provider);
      expect(wire.to.providerAccountId).toBe(journey.persona.account);
      expect(wire.purpose).toBe('message');
    }
    expect(transport.requests).toHaveLength(4);
  });
});

describe('W045 · the transcript shows one human across four channels', () => {
  it('retrieves the employee’s person-attributed turns across all providers', async () => {
    const turns = await listMessages(fixture.member, {
      actorKind: 'person',
      actorId: fixture.person.id,
    });
    expect(turns).toHaveLength(4); // exactly the four post-link turns
    const byProvider = new Map(turns.map((turn) => [turn.channel, turn]));
    for (const key of KEYS) expect(byProvider.has(key)).toBe(true);
    for (const turn of turns) {
      const journey = fixture.providers.find((p) => p.persona.provider === turn.channel)!;
      expect(turn.actor.id).toBe(fixture.person.id);
      expect(turn.actor.identityId).toBe(journey.firstTurn.identity.id);
    }
  });

  it('retrieves each identity’s full journey — external era and person era', async () => {
    for (const journey of fixture.providers) {
      const turns = await listMessages(fixture.member, {
        actorIdentityId: journey.firstTurn.identity.id,
      });
      // first contact + code reply (external era) + post-link turn (person era)
      expect(turns).toHaveLength(3);
      expect(turns.map((turn) => turn.actor.kind)).toEqual(['external', 'external', 'person']);
      expect(turns.map((turn) => turn.actor.identityId)).toEqual(
        Array.from({ length: 3 }, () => journey.firstTurn.identity.id),
      );
    }
  });

  it('lists one conversation per provider the employee participated in', async () => {
    const threads = await listConversations(fixture.member, {
      participantPersonId: fixture.person.id,
    });
    expect(threads).toHaveLength(4);
    const expected = new Set(fixture.providers.map((p) => p.firstTurn.message.conversationId));
    expect(new Set(threads.map((thread) => thread.id))).toEqual(expected);
  });
});

describe('W045 · employee state changes are visible identically through every provider', () => {
  it('reflects an employment change in every provider’s resolution', async () => {
    const updated = await setEmployeeStatus(fixture.member, {
      employeeId: fixture.employee.id,
      status: 'on_leave',
    });
    expect(updated.status).toBe('on_leave');

    for (const journey of fixture.providers) {
      const resolution = await resolveIdentity(fixture.member, {
        provider: journey.persona.provider,
        providerAccountId: journey.persona.account,
      });
      expect(resolution.status).toBe('resolved');
      if (resolution.status !== 'resolved') continue;
      expect(resolution.employee!.id).toBe(fixture.employee.id);
      expect(resolution.employee!.status).toBe('on_leave'); // same state, every channel
    }
  });
});
