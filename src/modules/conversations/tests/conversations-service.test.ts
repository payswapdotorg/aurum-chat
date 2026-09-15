// Integration tests for the conversations module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W029
// acceptance: "Persist conversations/messages with actor/source/provenance
// and links to cognitive executions without making conversations
// authoritative truth."
//
//  * persistence + provenance — threads and immutable turns round-trip with
//    actor attribution, channel key, provider message id, sender clock vs
//    service clock;
//  * actor resolution through the W002 contracts — a `person` attribution
//    requires an existing person record (people contract) or a verified,
//    subject-linked channel identity (identity contract; ADR-0003, lock 15:
//    unverified/revoked/unlinked accounts stay `external` and can never
//    become pseudo-employees). Foreign/missing references are uniformly
//    `invalid_provenance` — no cross-tenant existence leak;
//  * identity across channels (W045 spirit) — the same person speaks via
//    two providers and the directory; the transcript shows which identity
//    carried each turn, and retrieval works by person and by identity;
//  * provider-message idempotency — a redelivered (channel, provider id)
//    replays the original turn instead of duplicating the transcript;
//  * retrieval — message filters (conversation, channel, direction, actor,
//    identity, window, order, limit), conversation filters (title text with
//    LIKE-metacharacter escaping, person participation) and derived
//    messageCount/lastMessageAt with most-recently-active ordering;
//  * execution links — opaque, append-only, idempotent references to
//    cognitive executions (W013) with roles `triggered`/`produced`;
//  * not authoritative truth — the service surface exports create/read/
//    list/link operations ONLY (no update/delete/promote), and PostgreSQL
//    itself rejects UPDATE/DELETE/TRUNCATE on all three tables (triggers);
//  * tenant isolation (ADR-0001) — cross-tenant conversations, messages and
//    links are uniformly not-found.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as conversationsContract from '../contract';
import * as conversationsService from '../service';
import {
  attestIdentity,
  attachVerifiedSubject,
  getExternalIdentity,
  registerExternalIdentity,
  revokeVerification,
  type ExternalIdentity,
} from '@/modules/identity/contract';
import { createPerson } from '@/modules/people/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { ConversationsError } from '../errors';
import type { RecordMessageInput } from '../types';
import { runMigrations } from '../../../../scripts/migrate';

const {
  createConversation,
  getConversation,
  getMessage,
  listConversations,
  listExecutionLinks,
  listMessages,
  recordExecutionLink,
  recordMessage,
} = conversationsContract;

// dedicated tenants per group so count/order assertions stay deterministic
const tenantA = newId();
const tenantB = newId();
const tenantList = newId();
const tenantOrder = newId();
const tenantDedupeA = newId();
const tenantDedupeB = newId();
const tenantDedukeScopeA = newId(); // provider-key tenant scoping (with tenantB)
const tenantImmutable = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function admin(tenantId: string): TenantContext {
  // interim authority claims for the identity module's attest/link workflow
  return { tenantId, principalId: newId(), authority: ['identity:attest', 'identity:link'] };
}

let accountCounter = 0;

/** Registers a fresh (unverified) channel identity in the tenant. */
async function registerIdentity(
  ctx: TenantContext,
  provider: 'whatsapp' | 'telegram' | 'slack' | 'email' = 'whatsapp',
): Promise<ExternalIdentity> {
  accountCounter += 1;
  const { identity } = await registerExternalIdentity(ctx, {
    provider,
    providerAccountId: `${provider}-acct-${accountCounter}`,
    displayName: `${provider} account ${accountCounter}`,
  });
  return identity;
}

/** Verified + subject-linked channel identity (ADR-0003 happy path). */
async function verifiedLinkedIdentity(
  adminCtx: TenantContext,
  personId: string,
  provider: 'whatsapp' | 'telegram' | 'slack' | 'email' = 'whatsapp',
): Promise<ExternalIdentity> {
  const identity = await registerIdentity(adminCtx, provider);
  await attestIdentity(adminCtx, {
    identityId: identity.id,
    evidence: 'checked in person at the office',
  });
  await attachVerifiedSubject(adminCtx, { identityId: identity.id, subjectId: personId });
  return getExternalIdentity(adminCtx, identity.id);
}

function inboundMessage(
  actor: RecordMessageInput['actor'],
  overrides: Partial<RecordMessageInput> = {},
): RecordMessageInput {
  return {
    direction: 'inbound',
    actor,
    channel: 'whatsapp',
    payload: { text: 'the supplier meeting moved to Friday' },
    sentAt: '2026-09-14T09:15:00Z',
    ...overrides,
  };
}

async function expectCode(
  code: ConversationsError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ConversationsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationsError);
    expect((error as ConversationsError).code).toBe(code);
  }
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('conversation persistence', () => {
  it('creates, reads and lists threads with derived counts', async () => {
    const ctx = member(tenantA);
    const created = await createConversation(ctx, { title: '  Supplier escalation  ' });
    expect(created).toMatchObject({
      tenantId: tenantA,
      title: 'Supplier escalation',
      messageCount: 0,
      lastMessageAt: null,
    });
    expect(created.createdBy).toBe(ctx.principalId);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

    const read = await getConversation(ctx, created.id);
    expect(read).toEqual(created); // stable round-trip

    const untitled = await createConversation(ctx, {});
    expect(untitled.title).toBeNull();

    const listed = await listConversations(ctx, {});
    const ids = listed.map((conversation) => conversation.id);
    expect(ids).toContain(created.id);
    expect(ids).toContain(untitled.id);
  });

  it('reports missing, malformed and cross-tenant threads as conversation_not_found', async () => {
    const ctx = member(tenantA);
    const foreign = await createConversation(member(tenantB), { title: 'theirs' });
    await expectCode('conversation_not_found', () => getConversation(ctx, newId()));
    await expectCode('conversation_not_found', () => getConversation(ctx, 'not-a-uuid'));
    await expectCode('conversation_not_found', () => getConversation(ctx, foreign.id));
  });
});

describe('message persistence with actor/source provenance', () => {
  it('auto-creates the thread on the first turn and round-trips every attribute', async () => {
    const ctx = member(tenantA);
    const actorPerson = await createPerson(ctx, { fullName: 'Alice Ackermann' });
    const recorded = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', personId: actorPerson.id, label: 'Alice' }, {
        conversationTitle: 'Supplier escalation',
        providerMessageId: 'wamid.0001',
        channel: 'whatsapp',
      }),
    );

    expect(recorded.tenantId).toBe(tenantA);
    expect(recorded.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recorded.direction).toBe('inbound');
    expect(recorded.actor).toEqual({
      kind: 'person',
      id: actorPerson.id,
      label: 'Alice',
      identityId: null,
    });
    expect(recorded.channel).toBe('whatsapp');
    expect(recorded.payload).toEqual({ text: 'the supplier meeting moved to Friday' });
    expect(recorded.sentAt).toBe('2026-09-14T09:15:00.000Z'); // timestamptz round-trip carries ms precision
    expect(recorded.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // service clock
    expect(recorded.providerMessageId).toBe('wamid.0001');

    const conversation = await getConversation(ctx, recorded.conversationId);
    expect(conversation.title).toBe('Supplier escalation');
    expect(conversation.messageCount).toBe(1);
    expect(conversation.lastMessageAt).toBe('2026-09-14T09:15:00.000Z');
    expect(conversation.createdBy).toBe(ctx.principalId);

    const read = await getMessage(ctx, recorded.id);
    expect(read).toEqual(recorded);
  });

  it('appends into an explicit conversation and rejects foreign ones', async () => {
    const ctx = member(tenantA);
    const conversation = await createConversation(ctx, { title: 'Thread' });
    const recorded = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'unregistered customer' }, {
        conversationId: conversation.id,
        channel: 'email',
      }),
    );
    expect(recorded.conversationId).toBe(conversation.id);
    expect((await getConversation(ctx, conversation.id)).messageCount).toBe(1);

    const foreign = await createConversation(member(tenantB), { title: 'theirs' });
    await expectCode('conversation_not_found', () =>
      recordMessage(
        ctx,
        inboundMessage({ kind: 'external', label: 'x' }, { conversationId: foreign.id }),
      ),
    );
    await expectCode('conversation_not_found', () =>
      recordMessage(
        ctx,
        inboundMessage({ kind: 'external', label: 'x' }, { conversationId: newId() }),
      ),
    );
  });

  it('reports missing, malformed and cross-tenant messages as message_not_found', async () => {
    const ctx = member(tenantA);
    const theirs = await recordMessage(member(tenantB), inboundMessage({ kind: 'external', label: 'b' }));
    await expectCode('message_not_found', () => getMessage(ctx, newId()));
    await expectCode('message_not_found', () => getMessage(ctx, 'junk'));
    await expectCode('message_not_found', () => getMessage(ctx, theirs.id));
  });
});

describe('actor resolution through the W002 contracts (ADR-0003, lock 15)', () => {
  it('attributes a person via a verified, linked channel identity', async () => {
    const adminCtx = admin(tenantA);
    const ctx = member(tenantA);
    const person = await createPerson(ctx, { fullName: 'Bruno Bauer' });
    const identity = await verifiedLinkedIdentity(adminCtx, person.id, 'whatsapp');

    const recorded = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', externalIdentityId: identity.id }),
    );
    expect(recorded.actor).toEqual({
      kind: 'person',
      id: person.id, // the identity's verified subject
      label: identity.displayName, // display-name fallback captured at record time
      identityId: identity.id,
    });
  });

  it('attributes a person via a directory personId', async () => {
    const ctx = member(tenantA);
    const person = await createPerson(ctx, { fullName: 'Clara Century' });
    const recorded = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', personId: person.id }),
    );
    expect(recorded.actor).toEqual({
      kind: 'person',
      id: person.id,
      label: null,
      identityId: null,
    });
  });

  it('rejects person attribution through unverified, unlinked or revoked identities', async () => {
    const adminCtx = admin(tenantA);
    const ctx = member(tenantA);
    const person = await createPerson(ctx, { fullName: 'Dora Delta' });

    // unverified (registered on sight, ownership never proven)
    const unverified = await registerIdentity(adminCtx, 'whatsapp');
    await expectCode('identity_not_resolved', () =>
      recordMessage(ctx, inboundMessage({ kind: 'person', externalIdentityId: unverified.id })),
    );

    // verified but not subject-linked
    const unlinked = await registerIdentity(adminCtx, 'telegram');
    await attestIdentity(adminCtx, { identityId: unlinked.id, evidence: 'phone check' });
    await expectCode('identity_not_resolved', () =>
      recordMessage(ctx, inboundMessage({ kind: 'person', externalIdentityId: unlinked.id })),
    );

    // verified + linked, then revoked (revocation also detaches)
    const revoked = await verifiedLinkedIdentity(adminCtx, person.id, 'slack');
    await revokeVerification(adminCtx, { identityId: revoked.id, reason: 'account holder left' });
    await expectCode('identity_not_resolved', () =>
      recordMessage(ctx, inboundMessage({ kind: 'person', externalIdentityId: revoked.id })),
    );
  });

  it('keeps unverified accounts external — they never become persons', async () => {
    const adminCtx = admin(tenantA);
    const ctx = member(tenantA);
    const unverified = await registerIdentity(adminCtx, 'whatsapp');

    const recorded = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', externalIdentityId: unverified.id }),
    );
    expect(recorded.actor).toEqual({
      kind: 'external', // stays external regardless of verification status
      id: null,
      label: unverified.displayName,
      identityId: unverified.id,
    });
    // external actors can never ride the outbound side (§9)
    await expectCode('invalid_actor', () =>
      recordMessage(
        ctx,
        inboundMessage({ kind: 'external', externalIdentityId: unverified.id }, { direction: 'outbound' }),
      ),
    );
  });

  it('records agent and system actors with their provenance', async () => {
    const ctx = member(tenantA);
    const agentTurn = await recordMessage(ctx, {
      direction: 'outbound',
      actor: { kind: 'agent', id: newId(), label: 'intake-agent' },
      channel: 'web',
      payload: { text: 'I filed your request and started investigating.' },
      sentAt: '2026-09-14T09:20:00Z',
    });
    expect(agentTurn.actor).toEqual({
      kind: 'agent',
      id: agentTurn.actor.id,
      label: 'intake-agent',
      identityId: null,
    });

    const systemTurn = await recordMessage(ctx, {
      direction: 'outbound',
      actor: { kind: 'system', label: 'aurum-cognition' },
      channel: 'web',
      payload: { text: 'analysis complete' },
      sentAt: '2026-09-14T09:25:00Z',
    });
    expect(systemTurn.actor).toEqual({
      kind: 'system',
      id: null,
      label: 'aurum-cognition',
      identityId: null,
    });
  });

  it('maps foreign/missing person and identity references to uniform invalid_provenance', async () => {
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);
    const foreignPerson = await createPerson(ctxB, { fullName: 'Elsewhere Employee' });
    const foreignIdentity = await verifiedLinkedIdentity(admin(tenantB), foreignPerson.id, 'whatsapp');

    await expectCode('invalid_provenance', () =>
      recordMessage(ctxA, inboundMessage({ kind: 'person', personId: foreignPerson.id })),
    );
    await expectCode('invalid_provenance', () =>
      recordMessage(ctxA, inboundMessage({ kind: 'person', personId: newId() })),
    );
    await expectCode('invalid_provenance', () =>
      recordMessage(ctxA, inboundMessage({ kind: 'person', externalIdentityId: foreignIdentity.id })),
    );
    await expectCode('invalid_provenance', () =>
      recordMessage(ctxA, inboundMessage({ kind: 'external', externalIdentityId: foreignIdentity.id })),
    );
    await expectCode('invalid_provenance', () =>
      recordMessage(ctxA, inboundMessage({ kind: 'external', externalIdentityId: newId() })),
    );
  });

  it('carries one person across multiple providers (W045 spirit)', async () => {
    const adminCtx = admin(tenantA);
    const ctx = member(tenantA);
    const person = await createPerson(ctx, { fullName: 'Elena Erasure' });
    const whatsapp = await verifiedLinkedIdentity(adminCtx, person.id, 'whatsapp');
    const telegram = await verifiedLinkedIdentity(adminCtx, person.id, 'telegram');

    const viaWhatsapp = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', externalIdentityId: whatsapp.id }, {
        channel: 'whatsapp',
        sentAt: '2026-09-14T10:00:00Z',
      }),
    );
    const viaTelegram = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', externalIdentityId: telegram.id }, {
        channel: 'telegram',
        sentAt: '2026-09-14T11:00:00Z',
      }),
    );
    const viaDirectory = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', personId: person.id }, {
        channel: 'web',
        sentAt: '2026-09-14T12:00:00Z',
      }),
    );

    // every turn attributes the same person…
    for (const turn of [viaWhatsapp, viaTelegram, viaDirectory]) {
      expect(turn.actor.kind).toBe('person');
      expect(turn.actor.id).toBe(person.id);
    }
    // …while the transcript shows which identity carried which turn
    expect(viaWhatsapp.actor.identityId).toBe(whatsapp.id);
    expect(viaTelegram.actor.identityId).toBe(telegram.id);
    expect(viaDirectory.actor.identityId).toBeNull();

    // retrieval by person and by identity both work
    expect(await listMessages(ctx, { actorKind: 'person', actorId: person.id })).toHaveLength(3);
    expect(await listMessages(ctx, { actorIdentityId: whatsapp.id })).toEqual([viaWhatsapp]);
    expect(await listMessages(ctx, { actorIdentityId: telegram.id })).toEqual([viaTelegram]);
    expect(
      (await listMessages(ctx, { channel: 'telegram', actorIdentityId: telegram.id }))[0],
    ).toEqual(viaTelegram);
  });
});

describe('provider-message idempotency (redelivery dedupe)', () => {
  it('replays the original turn for a repeated (channel, provider id)', async () => {
    const ctx = member(tenantDedupeA);
    const first = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        providerMessageId: 'wamid.redeliver',
        sentAt: '2026-09-14T09:15:00Z',
      }),
    );
    const replay = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        providerMessageId: 'wamid.redeliver',
        sentAt: '2026-09-14T09:15:00Z',
        payload: { text: 'redelivered content is ignored — first write wins' },
      }),
    );
    expect(replay).toEqual(first);
    expect(await listMessages(ctx, {})).toHaveLength(1); // no duplicate turn
    expect(await listConversations(ctx, {})).toHaveLength(1); // no orphan thread
  });

  it('scopes the dedupe key per channel and keeps keyless turns distinct', async () => {
    const ctx = member(tenantDedupeB);
    const viaWhatsApp = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        providerMessageId: 'shared-id-1',
        channel: 'whatsapp',
      }),
    );
    const viaTelegram = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        providerMessageId: 'shared-id-1',
        channel: 'telegram',
      }),
    );
    expect(viaTelegram.id).not.toBe(viaWhatsApp.id);

    const keylessA = await recordMessage(ctx, inboundMessage({ kind: 'external', label: 'customer' }));
    const keylessB = await recordMessage(ctx, inboundMessage({ kind: 'external', label: 'customer' }));
    expect(keylessA.id).not.toBe(keylessB.id);
    expect(await listMessages(ctx, {})).toHaveLength(4);
  });

  it('keeps provider dedupe keys tenant-scoped', async () => {
    const ctxA = member(tenantDedukeScopeA);
    const ctxB = member(tenantB);
    await recordMessage(
      ctxA,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        providerMessageId: 'tenant-scoped-key',
        channel: 'whatsapp',
      }),
    );
    const theirs = await recordMessage(
      ctxB,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        providerMessageId: 'tenant-scoped-key',
        channel: 'whatsapp',
      }),
    );
    expect(theirs.tenantId).toBe(tenantB); // same key, different tenant: both recorded
    const ours = await listMessages(ctxA, {});
    expect(ours).toHaveLength(1);
    expect(ours[0]!.providerMessageId).toBe('tenant-scoped-key');
    expect(ours[0]!.tenantId).toBe(tenantDedukeScopeA);
  });
});

describe('message retrieval', () => {
  it('filters by conversation, channel, direction, actor, identity, window, order and limit', async () => {
    const adminCtx = admin(tenantList);
    const ctx = member(tenantList);
    const person = await createPerson(ctx, { fullName: 'Felix Finder' });
    const other = await createPerson(ctx, { fullName: 'Greta Guest' });
    const identity = await verifiedLinkedIdentity(adminCtx, person.id, 'whatsapp');

    const thread = await createConversation(ctx, { title: 'Filters' });
    const otherThread = await createConversation(ctx, { title: 'Other' });

    const m1 = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', externalIdentityId: identity.id }, {
        conversationId: thread.id,
        channel: 'whatsapp',
        sentAt: '2026-09-14T08:00:00Z',
      }),
    );
    const m2 = await recordMessage(ctx, {
      direction: 'outbound',
      actor: { kind: 'system', label: 'aurum-cognition' },
      channel: 'web',
      payload: { text: 'on it' },
      sentAt: '2026-09-14T09:00:00Z',
      conversationId: thread.id,
    });
    const m3 = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', personId: other.id }, {
        conversationId: otherThread.id,
        channel: 'email',
        sentAt: '2026-09-14T10:00:00Z',
      }),
    );
    const m4 = await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', externalIdentityId: identity.id }, {
        conversationId: thread.id,
        channel: 'whatsapp',
        sentAt: '2026-09-15T08:00:00Z',
      }),
    );

    // transcript of one thread, chronological
    expect(await listMessages(ctx, { conversationId: thread.id })).toEqual([m1, m2, m4]);
    // newest first
    expect(await listMessages(ctx, { conversationId: thread.id, order: 'desc' })).toEqual([m4, m2, m1]);
    // by channel
    expect(await listMessages(ctx, { channel: 'whatsapp' })).toEqual([m1, m4]);
    expect(await listMessages(ctx, { channel: 'email' })).toEqual([m3]);
    // by direction
    expect(await listMessages(ctx, { direction: 'outbound' })).toEqual([m2]);
    // by actor
    expect(await listMessages(ctx, { actorKind: 'person', actorId: person.id })).toEqual([m1, m4]);
    expect(await listMessages(ctx, { actorKind: 'person', actorId: other.id })).toEqual([m3]);
    expect(await listMessages(ctx, { actorKind: 'system' })).toEqual([m2]);
    // by identity
    expect(await listMessages(ctx, { actorIdentityId: identity.id })).toEqual([m1, m4]);
    // by sent window
    expect(
      await listMessages(ctx, {
        sentFrom: '2026-09-14T08:30:00Z',
        sentTo: '2026-09-14T23:59:59Z',
      }),
    ).toEqual([m2, m3]);
    // limit
    expect(await listMessages(ctx, { limit: 2 })).toEqual([m1, m2]);
    // combined filters
    expect(
      await listMessages(ctx, {
        conversationId: thread.id,
        channel: 'whatsapp',
        direction: 'inbound',
        actorKind: 'person',
        actorId: person.id,
      }),
    ).toEqual([m1, m4]);
  });

  it('never leaks another tenant’s messages', async () => {
    const ctx = member(tenantList);
    const outsider = member(newId());
    expect(await listMessages(outsider, {})).toEqual([]);
    const all = await listMessages(ctx, {});
    expect(all.map((message) => message.tenantId).every((tenantId) => tenantId === tenantList)).toBe(
      true,
    );
    expect(all.length).toBeGreaterThan(0);
  });
});

describe('conversation retrieval', () => {
  it('filters by title text with LIKE metacharacters escaped', async () => {
    const ctx = member(tenantList);
    await createConversation(ctx, { title: 'Q3_Review 100%' });
    await createConversation(ctx, { title: 'Q3 Review' });
    await createConversation(ctx, { title: 'Unrelated' });

    expect(await listConversations(ctx, { titleContains: 'review' })).toHaveLength(2); // case-insensitive
    expect(await listConversations(ctx, { titleContains: 'unrelated' })).toHaveLength(1);
    expect(await listConversations(ctx, { titleContains: 'Q3_Review 100%' })).toHaveLength(1); // _ and % literal
    expect(await listConversations(ctx, { titleContains: 'Q3XReview' })).toHaveLength(0); // _ must not wildcard
    expect(await listConversations(ctx, { titleContains: 'nothing matches' })).toHaveLength(0);
  });

  it('filters by person participation and derives counts/activity', async () => {
    const adminCtx = admin(tenantList);
    const ctx = member(tenantList);
    const participant = await createPerson(ctx, { fullName: 'Hana Helper' });
    const bystander = await createPerson(ctx, { fullName: 'Ivan Idle' });
    const participantIdentity = await verifiedLinkedIdentity(adminCtx, participant.id, 'whatsapp');

    const joined = await createConversation(ctx, { title: 'Joined' });
    await recordMessage(
      ctx,
      inboundMessage({ kind: 'person', externalIdentityId: participantIdentity.id }, {
        conversationId: joined.id,
        sentAt: '2026-09-14T10:00:00Z',
      }),
    );
    await recordMessage(ctx, {
      direction: 'outbound',
      actor: { kind: 'system', label: 'aurum-cognition' },
      channel: 'web',
      payload: { text: 'noted' },
      sentAt: '2026-09-14T10:05:00Z',
      conversationId: joined.id,
    });
    await createConversation(ctx, { title: 'Empty' });

    const threadsOfParticipant = await listConversations(ctx, {
      participantPersonId: participant.id,
    });
    expect(threadsOfParticipant.map((thread) => thread.title)).toEqual(['Joined']);
    expect(threadsOfParticipant[0]).toMatchObject({
      messageCount: 2,
      lastMessageAt: '2026-09-14T10:05:00.000Z',
    });

    expect(await listConversations(ctx, { participantPersonId: bystander.id })).toEqual([]);
  });

  it('orders threads by most recent activity', async () => {
    const ctx = member(tenantOrder);
    const t1 = await createConversation(ctx, { title: 'older activity' });
    const t2 = await createConversation(ctx, { title: 'newest activity' });
    const t3 = await createConversation(ctx, { title: 'middle activity' });
    await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        conversationId: t1.id,
        sentAt: '2026-09-10T08:00:00Z',
      }),
    );
    await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        conversationId: t3.id,
        sentAt: '2026-09-12T08:00:00Z',
      }),
    );
    await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        conversationId: t2.id,
        sentAt: '2026-09-14T08:00:00Z',
      }),
    );

    const titles = (await listConversations(ctx, {})).map((thread) => thread.title);
    expect(titles).toEqual(['newest activity', 'middle activity', 'older activity']);
  });

  it('lists an empty thread with zero counts', async () => {
    const ctx = member(tenantOrder);
    const empty = await createConversation(ctx, { title: 'Silent thread' });
    const listed = await listConversations(ctx, { titleContains: 'Silent' });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: empty.id,
      messageCount: 0,
      lastMessageAt: null,
    });
  });
});

describe('links to cognitive executions (opaque references)', () => {
  it('records triggered and produced links on messages and conversations', async () => {
    const ctx = member(tenantA);
    const conversation = await createConversation(ctx, { title: 'Cognition flow' });
    const inbound = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, {
        conversationId: conversation.id,
        sentAt: '2026-09-14T09:00:00Z',
      }),
    );
    const outbound = await recordMessage(ctx, {
      direction: 'outbound',
      actor: { kind: 'system', label: 'aurum-cognition' },
      channel: 'web',
      payload: { text: 'investigating' },
      sentAt: '2026-09-14T09:01:00Z',
      conversationId: conversation.id,
    });

    const executionId = newId(); // opaque — cognition (W013) owns the record
    const triggered = await recordExecutionLink(ctx, {
      messageId: inbound.id,
      executionId,
      role: 'triggered',
    });
    const produced = await recordExecutionLink(ctx, {
      messageId: outbound.id,
      executionId,
      role: 'produced',
    });
    const conversationTriggered = await recordExecutionLink(ctx, {
      conversationId: conversation.id,
      executionId: newId(),
      role: 'triggered',
    });

    expect(triggered).toMatchObject({
      tenantId: tenantA,
      conversationId: conversation.id,
      messageId: inbound.id,
      executionId,
      role: 'triggered',
      recordedBy: ctx.principalId,
    });
    expect(produced.role).toBe('produced');
    expect(conversationTriggered.messageId).toBeNull();

    // retrieval by conversation includes message-level links of that thread
    expect(await listExecutionLinks(ctx, { conversationId: conversation.id })).toHaveLength(3);
    const byExecution = await listExecutionLinks(ctx, { executionId });
    expect(byExecution).toEqual([triggered, produced]);
    expect(await listExecutionLinks(ctx, { messageId: outbound.id })).toEqual([produced]);
    const byRole = await listExecutionLinks(ctx, { role: 'triggered' });
    expect(byRole.map((link) => link.id).sort()).toEqual(
      [triggered.id, conversationTriggered.id].sort(),
    );
  });

  it('is idempotent per (execution, role, target)', async () => {
    const ctx = member(tenantA);
    const conversation = await createConversation(ctx, { title: 'Idempotent links' });
    const message = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, { conversationId: conversation.id }),
    );

    const first = await recordExecutionLink(ctx, {
      messageId: message.id,
      executionId: newId(),
      role: 'produced',
    });
    const replay = await recordExecutionLink(ctx, {
      messageId: message.id,
      executionId: first.executionId,
      role: 'produced',
    });
    expect(replay).toEqual(first);

    const conversationLevel = await recordExecutionLink(ctx, {
      conversationId: conversation.id,
      executionId: newId(),
      role: 'triggered',
    });
    const conversationReplay = await recordExecutionLink(ctx, {
      conversationId: conversation.id,
      executionId: conversationLevel.executionId,
      role: 'triggered',
    });
    expect(conversationReplay).toEqual(conversationLevel);

    expect(await listExecutionLinks(ctx, { conversationId: conversation.id })).toHaveLength(2);
  });

  it('validates targets and keeps them tenant-scoped with no leak', async () => {
    const ctx = member(tenantA);
    const outsiderCtx = member(tenantB);
    const theirs = await recordMessage(outsiderCtx, inboundMessage({ kind: 'external', label: 'b' }));
    const theirConversation = await createConversation(outsiderCtx, { title: 'theirs' });

    await expectCode('conversation_not_found', () =>
      recordExecutionLink(ctx, { conversationId: newId(), executionId: newId(), role: 'triggered' }),
    );
    await expectCode('invalid_execution_link', () =>
      recordExecutionLink(ctx, { conversationId: newId(), executionId: newId(), role: 'produced' }),
    );
    await expectCode('message_not_found', () =>
      recordExecutionLink(ctx, { messageId: theirs.id, executionId: newId(), role: 'triggered' }),
    );
    await expectCode('conversation_not_found', () =>
      recordExecutionLink(ctx, {
        conversationId: theirConversation.id,
        executionId: newId(),
        role: 'triggered',
      }),
    );
    expect(await listExecutionLinks(ctx, { messageId: theirs.id })).toEqual([]);
    expect(await listExecutionLinks(ctx, { conversationId: theirConversation.id })).toEqual([]);
  });
});

describe('not authoritative truth (ADR-0014: chat is a channel only)', () => {
  it('exposes only create/read/list/link operations — no mutation, no promotion', () => {
    // The service surface is the contract's operational content; snapshot it
    // so no update/delete/promote/derive operation can be added silently.
    expect(Object.keys(conversationsService).sort()).toEqual([
      'createConversation',
      'getConversation',
      'getMessage',
      'listConversations',
      'listExecutionLinks',
      'listMessages',
      'recordExecutionLink',
      'recordMessage',
    ]);
    for (const name of Object.keys(conversationsService)) {
      expect(/update|delete|promote|correct|verify|edit|close|archive|redact|supersede/i.test(name)).toBe(
        false,
      );
    }
    // and the public contract re-exports exactly the same operations (plus
    // errors, guards and limits — no additional behavioral surface)
    expect(Object.keys(conversationsContract).sort()).toEqual([
      'CONVERSATION_ACTOR_KINDS',
      'ConversationsError',
      'DEFAULT_LIST_LIMIT',
      'EXECUTION_LINK_ROLES',
      'MAX_LABEL_LENGTH',
      'MAX_LIST_LIMIT',
      'MAX_PAYLOAD_BYTES',
      'MAX_PROVIDER_MESSAGE_ID_LENGTH',
      'MAX_TITLE_LENGTH',
      'MESSAGE_DIRECTIONS',
      'createConversation',
      'getConversation',
      'getMessage',
      'isConversationActorKind',
      'isExecutionLinkRole',
      'isMessageDirection',
      'listConversations',
      'listExecutionLinks',
      'listMessages',
      'recordExecutionLink',
      'recordMessage',
    ]);
  });

  it('rejects direct UPDATE/DELETE/TRUNCATE at the storage layer (triggers)', async () => {
    const ctx = member(tenantImmutable);
    const conversation = await createConversation(ctx, { title: 'Immutable' });
    const message = await recordMessage(
      ctx,
      inboundMessage({ kind: 'external', label: 'customer' }, { conversationId: conversation.id }),
    );
    await recordExecutionLink(ctx, {
      messageId: message.id,
      executionId: newId(),
      role: 'produced',
    });

    const db = getDb();
    const attempts: Array<() => Promise<unknown>> = [
      () => db.query(`UPDATE conversations SET title = 'rewritten' WHERE tenant_id = $1`, [tenantImmutable]),
      () => db.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenantImmutable]),
      () => db.query(`TRUNCATE conversations`),
      () =>
        db.query(`UPDATE conversation_messages SET payload = '{"text":"rewritten"}' WHERE tenant_id = $1`, [
          tenantImmutable,
        ]),
      () => db.query(`DELETE FROM conversation_messages WHERE tenant_id = $1`, [tenantImmutable]),
      () => db.query(`TRUNCATE conversation_messages`),
      () =>
        db.query(`UPDATE conversation_execution_links SET role = 'triggered' WHERE tenant_id = $1`, [
          tenantImmutable,
        ]),
      () => db.query(`DELETE FROM conversation_execution_links WHERE tenant_id = $1`, [tenantImmutable]),
      () => db.query(`TRUNCATE conversation_execution_links`),
    ];
    // TRUNCATE on the parent tables is refused by FK integrity (children
    // reference them) and on the leaf table by the immutability trigger —
    // either way the transcript cannot be emptied from outside the module.
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toThrow(/immutable|cannot truncate/i);
    }

    // the transcript survived every attempt untouched
    expect(await getMessage(ctx, message.id)).toEqual(message);
  });
});

describe('tenant isolation sweep (ADR-0001)', () => {
  it('keeps every operation tenant-scoped', async () => {
    const adminCtxA = admin(tenantA);
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    const personA = await createPerson(ctxA, { fullName: 'Isolated Person' });
    const identityA = await verifiedLinkedIdentity(adminCtxA, personA.id, 'whatsapp');
    const message = await recordMessage(
      ctxA,
      inboundMessage({ kind: 'person', externalIdentityId: identityA.id }, {
        conversationTitle: 'Isolated thread',
        providerMessageId: 'iso-key-1',
      }),
    );

    // reads
    await expectCode('conversation_not_found', () => getConversation(ctxB, message.conversationId));
    await expectCode('message_not_found', () => getMessage(ctxB, message.id));
    // writes into foreign threads
    await expectCode('conversation_not_found', () =>
      recordMessage(
        ctxB,
        inboundMessage({ kind: 'external', label: 'x' }, { conversationId: message.conversationId }),
      ),
    );
    // lists see nothing foreign (tenantB has its OWN data from earlier
    // describes — what must never appear is tenantA's content)
    const theirs = await listMessages(ctxB, {});
    expect(theirs.map((foreign) => foreign.tenantId).every((tenantId) => tenantId === tenantB)).toBe(
      true,
    );
    expect(theirs.find((foreign) => foreign.id === message.id)).toBeUndefined();
    expect(await listConversations(ctxB, { titleContains: 'Isolated' })).toHaveLength(0);
    expect(await listExecutionLinks(ctxB, { conversationId: message.conversationId })).toEqual([]);
    // the owner still sees everything
    expect(await listMessages(ctxA, { conversationId: message.conversationId })).toEqual([message]);
  });
});
