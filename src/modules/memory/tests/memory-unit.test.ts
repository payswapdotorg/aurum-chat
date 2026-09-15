// Unit tests for the memory module's pure logic (no database): vocabulary
// guards, TenantContext shape, ILIKE escaping, and the full
// validation/normalization surface of knowledge/transactive record inputs
// and list queries. The storage-level guarantees (append-only immutability,
// tenant scoping, the evidence gate) are covered by memory-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { MemoryError } from '../errors';
import {
  assertMemoryTenantContext,
  DEFAULT_LIST_LIMIT,
  escapeLikePattern,
  isKnowledgeEntryKind,
  isTransactiveActorKind,
  isTransactiveRelation,
  isUuid,
  KNOWLEDGE_ENTRY_KINDS,
  MAX_ENTITIES,
  MAX_EVIDENCE_OBSERVATIONS,
  MAX_LIST_LIMIT,
  MAX_NOTES_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TEXT_QUERY_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_TOPICS,
  TRANSACTIVE_ACTOR_KINDS,
  TRANSACTIVE_RELATIONS,
  validateListKnowledgeEntriesQuery,
  validateListTransactiveEntriesQuery,
  validateRecordKnowledgeEntryInput,
  validateRecordTransactiveEntryInput,
} from '../validation';
import type {
  ListKnowledgeEntriesQuery,
  RecordKnowledgeEntryInput,
  RecordTransactiveEntryInput,
} from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UUID_C = '2d4b0a5c-3e6d-4f0c-9b5a-9c4d8e7f6a1b';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';

/** A minimal, fully valid knowledge record input. */
function knowledgeInput(): RecordKnowledgeEntryInput {
  return {
    kind: 'fact',
    title: 'Northwind renewal decision',
    summary: 'Northwind chose the competitor on price; renewal was lost in September.',
    topics: ['customers', 'churn'],
    evidenceObservationIds: [UUID_A],
  };
}

/** A minimal, fully valid transactive record input. */
function transactiveInput(): RecordTransactiveEntryInput {
  return {
    actor: { kind: 'person', id: UUID_B, label: 'alice' },
    relation: 'knows',
    subjectLabel: 'HVAC maintenance contracts',
    topics: ['hvac', 'facilities'],
    evidenceObservationIds: [UUID_A],
  };
}

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryError);
    expect((error as MemoryError).code).toBe(code);
  }
}

describe('vocabularies (ARCHITECTURE.md §4/§7)', () => {
  it('declares the canonical sets without duplicates', () => {
    expect([...KNOWLEDGE_ENTRY_KINDS]).toEqual([
      'fact',
      'procedure',
      'decision',
      'preference',
      'insight',
      'context',
    ]);
    expect([...TRANSACTIVE_ACTOR_KINDS]).toEqual(['person', 'agent', 'team']);
    // ARCHITECTURE.md §7, verbatim: "who knows, owns, decides, has
    // experience with, influences, or can perform a capability."
    expect([...TRANSACTIVE_RELATIONS]).toEqual([
      'knows',
      'owns',
      'decides',
      'has_experience_with',
      'influences',
      'can_perform',
    ]);
    for (const set of [KNOWLEDGE_ENTRY_KINDS, TRANSACTIVE_ACTOR_KINDS, TRANSACTIVE_RELATIONS]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('guards recognize members and reject everything else', () => {
    for (const kind of KNOWLEDGE_ENTRY_KINDS) expect(isKnowledgeEntryKind(kind)).toBe(true);
    for (const kind of TRANSACTIVE_ACTOR_KINDS) expect(isTransactiveActorKind(kind)).toBe(true);
    for (const relation of TRANSACTIVE_RELATIONS) expect(isTransactiveRelation(relation)).toBe(true);
    for (const bad of ['', 'Fact', 'belief', 'unknown', 42, null, undefined]) {
      expect(isKnowledgeEntryKind(bad)).toBe(false);
      expect(isTransactiveActorKind(bad)).toBe(false);
      expect(isTransactiveRelation(bad)).toBe(false);
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

describe('escapeLikePattern (literal text retrieval)', () => {
  it('escapes the ILIKE metacharacters and leaves everything else intact', () => {
    expect(escapeLikePattern('plain')).toBe('plain');
    expect(escapeLikePattern('50%_off')).toBe('50\\%\\_off');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
    expect(escapeLikePattern('a*b?c')).toBe('a*b?c');
  });
});

describe('TenantContext shape (explicit context, no ambient state)', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertMemoryTenantContext({ tenantId: newId(), principalId: newId(), authority: [] }),
    ).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () =>
      assertMemoryTenantContext({ tenantId: '', principalId: newId(), authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertMemoryTenantContext({ tenantId: newId(), principalId: '  ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertMemoryTenantContext({
        tenantId: newId(),
        principalId: newId(),
        authority: 'admin' as unknown as string[],
      }),
    );
  });
});

describe('validateRecordKnowledgeEntryInput', () => {
  it('applies the documented defaults for entities and notes', () => {
    const validated = validateRecordKnowledgeEntryInput(knowledgeInput());
    expect(validated.entities).toEqual([]);
    expect(validated.notes).toBeNull();
  });

  it('normalizes trimmed strings, topic/evidence case, dedupe and canonical ordering', () => {
    const validated = validateRecordKnowledgeEntryInput({
      ...knowledgeInput(),
      title: '  padded title  ',
      summary: '  padded summary  ',
      notes: '  keep me  ',
      topics: ['churn', 'churn', 'customers', ' arr '],
      entities: [
        { kind: 'customer', label: 'zeta corp' },
        { kind: 'agent', id: UUID_C },
        { kind: 'customer', label: 'alpha inc' },
        { kind: 'customer', label: 'alpha inc' },
      ],
      evidenceObservationIds: [UUID_UPPER, UUID_A, UUID_UPPER],
    });
    expect(validated.title).toBe('padded title');
    expect(validated.summary).toBe('padded summary');
    expect(validated.notes).toBe('keep me');
    // topics: trimmed, lowercased by slug rule, deduplicated, sorted
    expect(validated.topics).toEqual(['arr', 'churn', 'customers']);
    // entities: uuid case-normalized, exact duplicates removed, canonically sorted
    expect(validated.entities).toEqual([
      { kind: 'agent', id: UUID_C, label: null },
      { kind: 'customer', id: null, label: 'alpha inc' },
      { kind: 'customer', id: null, label: 'zeta corp' },
    ]);
    // evidence: case-normalized, deduplicated, sorted
    expect(validated.evidenceObservationIds).toEqual([UUID_A]);
  });

  it('rejects smuggled identity, tenancy and commit-time fields', () => {
    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'authoritative']) {
      expectCode('invalid_knowledge_input', () =>
        validateRecordKnowledgeEntryInput({ ...knowledgeInput(), [smuggled]: newId() } as never),
      );
    }
  });

  it('rejects malformed knowledge inputs', () => {
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), kind: 'belief' } as never),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), title: '   ' }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), title: 'x'.repeat(MAX_TITLE_LENGTH + 1) }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), summary: 'x'.repeat(MAX_SUMMARY_LENGTH + 1) }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), notes: 'x'.repeat(MAX_NOTES_LENGTH + 1) }),
    );
    // topics: at least one retrieval key, slugs only, bounded
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), topics: [] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), topics: 'customers' } as never),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), topics: ['Customers'] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({
        ...knowledgeInput(),
        topics: Array.from({ length: MAX_TOPICS + 1 }, (_, i) => `t${i}`),
      }),
    );
    // entities: bounded, traceable, well-formed
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({
        ...knowledgeInput(),
        entities: Array.from({ length: MAX_ENTITIES + 1 }, () => ({ kind: 'customer', label: 'x' })),
      }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), entities: [{ kind: 'customer' }] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), entities: [{ kind: 'Customer', label: 'x' }] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), entities: [{ kind: 'customer', id: 'nope' }] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), entities: [{ kind: 'customer', id: null, label: null }] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), entities: [{ kind: 'customer', label: 'x', extra: 1 }] as never }),
    );
    // evidence: required, uuids only, bounded
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), evidenceObservationIds: [] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), evidenceObservationIds: 'not-an-array' } as never),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({ ...knowledgeInput(), evidenceObservationIds: ['nope'] }),
    );
    expectCode('invalid_knowledge_input', () =>
      validateRecordKnowledgeEntryInput({
        ...knowledgeInput(),
        evidenceObservationIds: Array.from(
          { length: MAX_EVIDENCE_OBSERVATIONS + 1 },
          () => newId(),
        ),
      }),
    );
  });
});

describe('validateRecordTransactiveEntryInput', () => {
  it('applies the documented defaults and preserves the §7 relation', () => {
    const validated = validateRecordTransactiveEntryInput(transactiveInput());
    expect(validated.entities).toEqual([]);
    expect(validated.notes).toBeNull();
    expect(validated.relation).toBe('knows');
    expect(validated.actor).toEqual({ kind: 'person', id: UUID_B, label: 'alice' });
  });

  it('accepts a label-only actor (unregistered team/agent)', () => {
    const validated = validateRecordTransactiveEntryInput({
      ...transactiveInput(),
      actor: { kind: 'team', label: 'night-shift maintenance' },
    });
    expect(validated.actor).toEqual({ kind: 'team', id: null, label: 'night-shift maintenance' });
  });

  it('rejects malformed transactive inputs', () => {
    // actor: object, known kind, traceable, unknown keys rejected
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({ ...transactiveInput(), actor: 'alice' } as never),
    );
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({
        ...transactiveInput(),
        actor: { kind: 'system', label: 'x' },
      } as never),
    );
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({ ...transactiveInput(), actor: { kind: 'person' } }),
    );
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({
        ...transactiveInput(),
        actor: { kind: 'person', id: 'not-a-uuid' },
      }),
    );
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({
        ...transactiveInput(),
        actor: { kind: 'person', id: UUID_B, label: 'alice', nickname: 'al' },
      } as never),
    );
    // relation: the §7 vocabulary only
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({ ...transactiveInput(), relation: 'likes' } as never),
    );
    // subject: required, bounded
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({ ...transactiveInput(), subjectLabel: '' }),
    );
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({
        ...transactiveInput(),
        subjectLabel: 'x'.repeat(MAX_TITLE_LENGTH + 1),
      }),
    );
    // topics + evidence follow the knowledge-side rules
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({ ...transactiveInput(), topics: [] }),
    );
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({ ...transactiveInput(), evidenceObservationIds: [] }),
    );
    // identity smuggling
    expectCode('invalid_transactive_input', () =>
      validateRecordTransactiveEntryInput({
        ...transactiveInput(),
        id: newId(),
      } as never),
    );
  });
});

describe('validateListKnowledgeEntriesQuery', () => {
  it('defaults the limit and leaves every filter off', () => {
    const validated = validateListKnowledgeEntriesQuery({});
    expect(validated).toEqual({
      kind: null,
      topics: null,
      entityKind: null,
      entityId: null,
      evidenceObservationId: null,
      text: null,
      recordedFrom: null,
      recordedTo: null,
      limit: DEFAULT_LIST_LIMIT,
    });
  });

  it('normalizes topic queries (dedupe + sort) and validates uuids', () => {
    const validated = validateListKnowledgeEntriesQuery({
      topics: ['churn', 'churn', 'arr'],
      evidenceObservationId: UUID_UPPER,
      entityKind: 'customer',
      entityId: UUID_B,
    });
    expect(validated.topics).toEqual(['arr', 'churn']);
    expect(validated.evidenceObservationId).toBe(UUID_A); // case-normalized to UUID_UPPER's lowercase form
    expect(validated.entityKind).toBe('customer');
    expect(validated.entityId).toBe(UUID_B);
  });

  it('rejects malformed knowledge queries', () => {
    const query = {} as ListKnowledgeEntriesQuery;
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ ...query, nope: 1 } as never),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ kind: 'belief' } as never),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ topics: [] }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ topics: 'churn' } as never),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ entityId: UUID_A }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ text: 'x'.repeat(MAX_TEXT_QUERY_LENGTH + 1) }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ recordedFrom: '2026-09-14' }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({
        recordedFrom: '2026-09-15T00:00:00Z',
        recordedTo: '2026-09-14T00:00:00Z',
      }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ limit: 0 }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ limit: MAX_LIST_LIMIT + 1 }),
    );
    expectCode('invalid_knowledge_query', () =>
      validateListKnowledgeEntriesQuery({ limit: 1.5 }),
    );
  });
});

describe('validateListTransactiveEntriesQuery', () => {
  it('defaults the limit and leaves every filter off', () => {
    const validated = validateListTransactiveEntriesQuery({});
    expect(validated).toEqual({
      topics: null,
      relation: null,
      actorKind: null,
      actorId: null,
      evidenceObservationId: null,
      text: null,
      recordedFrom: null,
      recordedTo: null,
      limit: DEFAULT_LIST_LIMIT,
    });
  });

  it('accepts the who-knows-what retrieval shape (topics + relation + actor)', () => {
    const validated = validateListTransactiveEntriesQuery({
      topics: ['hvac'],
      relation: 'can_perform',
      actorKind: 'person',
      actorId: UUID_B,
    });
    expect(validated.topics).toEqual(['hvac']);
    expect(validated.relation).toBe('can_perform');
    expect(validated.actorKind).toBe('person');
    expect(validated.actorId).toBe(UUID_B);
  });

  it('rejects malformed transactive queries', () => {
    expectCode('invalid_transactive_query', () =>
      validateListTransactiveEntriesQuery({ nope: 1 } as never),
    );
    expectCode('invalid_transactive_query', () =>
      validateListTransactiveEntriesQuery({ relation: 'likes' } as never),
    );
    expectCode('invalid_transactive_query', () =>
      validateListTransactiveEntriesQuery({ actorKind: 'system' } as never),
    );
    expectCode('invalid_transactive_query', () =>
      validateListTransactiveEntriesQuery({ actorId: UUID_B }),
    );
    expectCode('invalid_transactive_query', () =>
      validateListTransactiveEntriesQuery({ topics: [] }),
    );
    expectCode('invalid_transactive_query', () =>
      validateListTransactiveEntriesQuery({ limit: MAX_LIST_LIMIT + 1 }),
    );
  });
});
