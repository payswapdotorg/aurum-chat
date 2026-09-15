// Unit tests for the conversations module's pure logic (no database):
// vocabulary guards, TenantContext shape, and the full validation/
// normalization surface of conversation, message, list and execution-link
// inputs. The storage-level guarantees (immutability, tenant scoping,
// provider-message idempotency, identity resolution through the W002
// contracts) are covered by conversations-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { ConversationsError } from '../errors';
import {
  assertConversationsTenantContext,
  CONVERSATION_ACTOR_KINDS,
  DEFAULT_LIST_LIMIT,
  EXECUTION_LINK_ROLES,
  isConversationActorKind,
  isExecutionLinkRole,
  isMessageDirection,
  isUuid,
  MAX_LIST_LIMIT,
  MAX_PAYLOAD_BYTES,
  MAX_PROVIDER_MESSAGE_ID_LENGTH,
  MAX_TITLE_LENGTH,
  MESSAGE_DIRECTIONS,
  validateCreateConversationInput,
  validateListConversationsQuery,
  validateListExecutionLinksQuery,
  validateListMessagesQuery,
  validateRecordExecutionLinkInput,
  validateRecordMessageInput,
} from '../validation';
import type { RecordMessageInput } from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';

/** A minimal, fully valid inbound message input. */
function validMessage(): RecordMessageInput {
  return {
    direction: 'inbound',
    actor: { kind: 'person', personId: UUID_A },
    channel: 'whatsapp',
    payload: { text: 'the supplier meeting moved to Friday' },
    sentAt: '2026-09-14T09:15:00Z',
  };
}

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ConversationsError);
    expect((error as ConversationsError).code).toBe(code);
  }
}

describe('vocabularies (ARCHITECTURE.md §9: actor + channel provenance)', () => {
  it('declares the canonical sets without duplicates', () => {
    expect([...CONVERSATION_ACTOR_KINDS]).toEqual(['person', 'agent', 'system', 'external']);
    expect([...MESSAGE_DIRECTIONS]).toEqual(['inbound', 'outbound']);
    expect([...EXECUTION_LINK_ROLES]).toEqual(['triggered', 'produced']);
    for (const set of [CONVERSATION_ACTOR_KINDS, MESSAGE_DIRECTIONS, EXECUTION_LINK_ROLES]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('guards recognize members and reject everything else', () => {
    for (const kind of CONVERSATION_ACTOR_KINDS) expect(isConversationActorKind(kind)).toBe(true);
    for (const direction of MESSAGE_DIRECTIONS) expect(isMessageDirection(direction)).toBe(true);
    for (const role of EXECUTION_LINK_ROLES) expect(isExecutionLinkRole(role)).toBe(true);
    for (const bad of ['', 'Person', 'thread', 'in', 'out', 42, null, undefined]) {
      expect(isConversationActorKind(bad)).toBe(false);
      expect(isMessageDirection(bad)).toBe(false);
      expect(isExecutionLinkRole(bad)).toBe(false);
    }
  });

  it('isUuid accepts any uuid shape and rejects the rest', () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid(UUID_UPPER)).toBe(true);
    expect(isUuid(newId())).toBe(true);
    for (const bad of ['', 'not-a-uuid', `${UUID_A}-extra`, 42, null, undefined]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('TenantContext shape (explicit context, no ambient state)', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertConversationsTenantContext({ tenantId: newId(), principalId: newId(), authority: [] }),
    ).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () =>
      assertConversationsTenantContext({ tenantId: '', principalId: newId(), authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertConversationsTenantContext({ tenantId: newId(), principalId: '  ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertConversationsTenantContext({
        tenantId: newId(),
        principalId: newId(),
        authority: 'identity:attest' as unknown as string[],
      }),
    );
  });
});

describe('createConversation validation', () => {
  it('normalizes a titled conversation and defaults to untitled', () => {
    expect(validateCreateConversationInput({ title: '  Supplier escalation  ' })).toEqual({
      title: 'Supplier escalation',
    });
    expect(validateCreateConversationInput({})).toEqual({ title: null });
    expect(validateCreateConversationInput({ title: null })).toEqual({ title: null });
    expect(validateCreateConversationInput({ title: '   ' })).toEqual({ title: null });
  });

  it('rejects non-objects, unknown fields and over-long titles', () => {
    expectCode('invalid_conversation_input', () =>
      validateCreateConversationInput(null as never),
    );
    expectCode('invalid_conversation_input', () =>
      validateCreateConversationInput({ title: 'x', extra: 1 } as never),
    );
    expectCode('invalid_conversation_input', () =>
      validateCreateConversationInput({ title: 'a'.repeat(MAX_TITLE_LENGTH + 1) }),
    );
    expectCode('invalid_conversation_input', () =>
      validateCreateConversationInput({ title: 'a', createdBy: newId() } as never),
    );
  });
});

describe('recordMessage validation (actor/source/provenance)', () => {
  it('normalizes a fully valid message, trimming provider ids', () => {
    const valid = validateRecordMessageInput({
      ...validMessage(),
      conversationId: UUID_UPPER,
      providerMessageId: '  wamid.HBgNNjIyNzA1OTk5NxYZABAMCAA=  ',
    });
    expect(valid.conversationId).toBe(UUID_A); // normalized to lowercase
    expect(valid.providerMessageId).toBe('wamid.HBgNNjIyNzA1OTk5NxYZABAMCAA=');
    expect(valid.direction).toBe('inbound');
    expect(valid.channel).toBe('whatsapp');
    expect(valid.sentAt).toBe('2026-09-14T09:15:00Z');
    expect(valid.conversationTitle).toBeNull();
  });

  it('rejects unknown fields and smuggled system-minted fields', () => {
    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'messageCount']) {
      expectCode('invalid_conversation_input', () =>
        validateRecordMessageInput({ ...validMessage(), [smuggled]: newId() } as never),
      );
    }
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), nonsense: true } as never),
    );
    expectCode('invalid_conversation_input', () => validateRecordMessageInput(null as never));
  });

  it('rejects conversationTitle when appending to an explicit conversation', () => {
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({
        ...validMessage(),
        conversationId: UUID_A,
        conversationTitle: 'cannot retitle via a message',
      }),
    );
    // …while the auto-create path accepts it.
    expect(() =>
      validateRecordMessageInput({ ...validMessage(), conversationTitle: 'First thread' }),
    ).not.toThrow();
  });

  it('requires a canonical direction and channel key', () => {
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), direction: 'sideways' as never }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), channel: 'carrier-pigeon' as never }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), channel: 'WhatsApp' as never }),
    );
  });

  it('requires strict ISO 8601 sent timestamps with explicit offset', () => {
    for (const bad of [
      '2026-09-14 09:15:00',
      '2026-09-14T09:15:00',
      'not a date',
      '',
      '2026-13-40T99:99:99Z',
    ]) {
      expectCode('invalid_conversation_input', () =>
        validateRecordMessageInput({ ...validMessage(), sentAt: bad }),
      );
    }
    expect(() =>
      validateRecordMessageInput({ ...validMessage(), sentAt: '2026-09-14T09:15:00+02:00' }),
    ).not.toThrow();
  });

  it('requires a non-null, plain-JSON payload within the size cap', () => {
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), payload: null }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), payload: undefined }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), payload: new Date() }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), payload: { x: Number.NaN } }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), payload: 'a'.repeat(MAX_PAYLOAD_BYTES + 1) }),
    );
    expect(() =>
      validateRecordMessageInput({ ...validMessage(), payload: { nested: { list: [1, 2, null] } } }),
    ).not.toThrow();
  });

  it('validates provider message id shape', () => {
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), providerMessageId: '   ' }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({
        ...validMessage(),
        providerMessageId: `x${'a'.repeat(MAX_PROVIDER_MESSAGE_ID_LENGTH)}`,
      }),
    );
    expectCode('invalid_conversation_input', () =>
      validateRecordMessageInput({ ...validMessage(), providerMessageId: 'bad\nid' }),
    );
    expect(() =>
      validateRecordMessageInput({ ...validMessage(), providerMessageId: 'wamid.12345==AZ' }),
    ).not.toThrow();
  });

  it('enforces the direction/actor coherence of ARCHITECTURE.md §9', () => {
    // An external party cannot send on the tenant's outbound side.
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        direction: 'outbound',
        actor: { kind: 'external', label: 'someone@elsewhere.example' },
      }),
    );
    // Aurum's own subsystems are never inbound senders.
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        direction: 'inbound',
        actor: { kind: 'system', label: 'channel-adapter' },
      }),
    );
    // The coherent combinations pass validation (the DB CHECK mirrors this).
    expect(() =>
      validateRecordMessageInput({
        ...validMessage(),
        direction: 'outbound',
        actor: { kind: 'system', label: 'aurum-cognition' },
      }),
    ).not.toThrow();
  });
});

describe('actor validation (ADR-0003 attribution paths)', () => {
  it('accepts person via personId, via externalIdentityId, agent, system and external', () => {
    expect(
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'person', personId: UUID_A } })
        .actor,
    ).toEqual({ kind: 'person', personId: UUID_A, externalIdentityId: null, agentId: null, label: null });

    expect(
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'person', externalIdentityId: UUID_B, label: 'Alice (WhatsApp)' },
      }).actor,
    ).toEqual({ kind: 'person', personId: null, externalIdentityId: UUID_B, agentId: null, label: 'Alice (WhatsApp)' });

    expect(
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'agent', id: UUID_B },
      }).actor,
    ).toEqual({ kind: 'agent', personId: null, externalIdentityId: null, agentId: UUID_B, label: null });

    expect(
      validateRecordMessageInput({
        ...validMessage(),
        direction: 'outbound',
        actor: { kind: 'system', label: 'aurum-cognition' },
      }).actor,
    ).toMatchObject({ kind: 'system', label: 'aurum-cognition' });

    expect(
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'external', externalIdentityId: UUID_B },
      }).actor,
    ).toMatchObject({ kind: 'external', externalIdentityId: UUID_B, label: null });
  });

  it('normalizes uuids to lowercase and rejects malformed ids', () => {
    const valid = validateRecordMessageInput({
      ...validMessage(),
      actor: { kind: 'person', personId: UUID_UPPER },
    });
    expect(valid.actor.personId).toBe(UUID_A);
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'person', personId: 'nope' } }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'person', externalIdentityId: 42 as never },
      }),
    );
  });

  it('person requires exactly one attribution path', () => {
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'person', personId: UUID_A, externalIdentityId: UUID_B },
      }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'person' } }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'person', id: UUID_B } }),
    );
  });

  it('agent requires a traceable id or label and rejects person fields', () => {
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'agent' } }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'agent', personId: UUID_A },
      }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'agent', externalIdentityId: UUID_B },
      }),
    );
  });

  it('system is identified by its label alone', () => {
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'system' } }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'system', id: UUID_A } }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'system', externalIdentityId: UUID_B },
      }),
    );
  });

  it('external never carries person/agent references and must be traceable', () => {
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'external', personId: UUID_A },
      }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'external', id: UUID_A } }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: { kind: 'external' } }),
    );
    expect(() =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'external', label: 'unregistered customer' },
      }),
    ).not.toThrow();
  });

  it('rejects unknown actor fields and non-object actors', () => {
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({ ...validMessage(), actor: 'person' as never }),
    );
    expectCode('invalid_actor', () =>
      validateRecordMessageInput({
        ...validMessage(),
        actor: { kind: 'person', personId: UUID_A, subjectId: UUID_B } as never,
      }),
    );
  });
});

describe('listMessages query validation', () => {
  it('applies defaults and normalizes the sent window', () => {
    const valid = validateListMessagesQuery({});
    expect(valid).toMatchObject({
      conversationId: null,
      channel: null,
      direction: null,
      actorKind: null,
      actorId: null,
      actorIdentityId: null,
      order: 'asc',
      limit: DEFAULT_LIST_LIMIT,
    });
    expect(valid.sentFrom).toBeNull();
    expect(valid.sentTo).toBeNull();

    const windowed = validateListMessagesQuery({
      conversationId: UUID_UPPER,
      channel: 'slack',
      direction: 'outbound',
      actorKind: 'person',
      actorId: UUID_A,
      actorIdentityId: UUID_B,
      sentFrom: '2026-09-01T00:00:00Z',
      sentTo: '2026-09-30T23:59:59Z',
      order: 'desc',
      limit: 10,
    });
    expect(windowed.conversationId).toBe(UUID_A);
    expect(windowed.sentFrom).toBeInstanceOf(Date);
    expect(windowed.sentTo).toBeInstanceOf(Date);
    expect(windowed.order).toBe('desc');
  });

  it('rejects unknown fields, bad vocabularies and bad uuids', () => {
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ text: 'nope' } as never),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ channel: 'irc' as never }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ direction: 'through' as never }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ actorKind: 'robot' as never }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ conversationId: 'xyz' } as never),
    );
    expectCode('invalid_conversation_query', () => validateListMessagesQuery(null as never));
  });

  it('actorId requires actorKind; windows must be ordered; order and limit are bounded', () => {
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ actorId: UUID_A }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({
        sentFrom: '2026-09-30T00:00:00Z',
        sentTo: '2026-09-01T00:00:00Z',
      }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ sentFrom: '2026-09-01' } as never),
    );
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ order: 'random' as never }),
    );
    expectCode('invalid_conversation_query', () => validateListMessagesQuery({ limit: 0 }));
    expectCode('invalid_conversation_query', () =>
      validateListMessagesQuery({ limit: MAX_LIST_LIMIT + 1 }),
    );
    expectCode('invalid_conversation_query', () => validateListMessagesQuery({ limit: 1.5 }));
  });
});

describe('listConversations query validation', () => {
  it('applies defaults and trims the title filter', () => {
    const valid = validateListConversationsQuery({});
    expect(valid).toEqual({
      titleContains: null,
      participantPersonId: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    expect(
      validateListConversationsQuery({ titleContains: '  Supplier  ' }).titleContains,
    ).toBe('Supplier');
  });

  it('rejects unknown fields, empty titles, bad uuids and bad limits', () => {
    expectCode('invalid_conversation_query', () =>
      validateListConversationsQuery({ orderBy: 'nonsense' } as never),
    );
    expectCode('invalid_conversation_query', () =>
      validateListConversationsQuery({ titleContains: '   ' }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListConversationsQuery({ participantPersonId: 'not-a-uuid' } as never),
    );
    expectCode('invalid_conversation_query', () =>
      validateListConversationsQuery({ titleContains: 'a'.repeat(MAX_TITLE_LENGTH + 1) }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListConversationsQuery({ limit: -1 }),
    );
  });
});

describe('execution-link validation', () => {
  it('accepts message-level and conversation-level links with a uuid execution id', () => {
    expect(
      validateRecordExecutionLinkInput({ messageId: UUID_A, executionId: UUID_B, role: 'produced' }),
    ).toEqual({ conversationId: null, messageId: UUID_A, executionId: UUID_B, role: 'produced' });
    expect(
      validateRecordExecutionLinkInput({
        conversationId: UUID_UPPER,
        executionId: UUID_B,
        role: 'triggered',
      }),
    ).toEqual({ conversationId: UUID_A, messageId: null, executionId: UUID_B, role: 'triggered' });
  });

  it('requires exactly one target', () => {
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput({ executionId: UUID_B, role: 'triggered' }),
    );
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput({
        conversationId: UUID_A,
        messageId: UUID_B,
        executionId: newId(),
        role: 'triggered',
      }),
    );
  });

  it("role 'produced' requires a message target", () => {
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput({
        conversationId: UUID_A,
        executionId: UUID_B,
        role: 'produced',
      }),
    );
  });

  it('rejects unknown fields, bad roles and malformed uuids', () => {
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput({ messageId: UUID_A, executionId: 'nope', role: 'produced' }),
    );
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput({
        messageId: UUID_A,
        executionId: UUID_B,
        role: 'mentioned',
      } as never),
    );
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput({
        messageId: UUID_A,
        executionId: UUID_B,
        role: 'produced',
        recordedBy: newId(),
      } as never),
    );
    expectCode('invalid_execution_link', () =>
      validateRecordExecutionLinkInput(null as never),
    );
  });
});

describe('listExecutionLinks query validation', () => {
  it('applies defaults and accepts every filter', () => {
    expect(validateListExecutionLinksQuery({})).toEqual({
      conversationId: null,
      messageId: null,
      executionId: null,
      role: null,
      limit: DEFAULT_LIST_LIMIT,
    });
    expect(
      validateListExecutionLinksQuery({
        conversationId: UUID_A,
        messageId: UUID_B,
        executionId: newId(),
        role: 'triggered',
        limit: 5,
      }),
    ).toMatchObject({ role: 'triggered', limit: 5 });
  });

  it('rejects unknown fields, bad roles, bad uuids and bad limits', () => {
    expectCode('invalid_conversation_query', () =>
      validateListExecutionLinksQuery({ message: UUID_A } as never),
    );
    expectCode('invalid_conversation_query', () =>
      validateListExecutionLinksQuery({ role: 'caused' as never }),
    );
    expectCode('invalid_conversation_query', () =>
      validateListExecutionLinksQuery({ executionId: 'xyz' } as never),
    );
    expectCode('invalid_conversation_query', () =>
      validateListExecutionLinksQuery({ limit: MAX_LIST_LIMIT + 1 }),
    );
  });
});
