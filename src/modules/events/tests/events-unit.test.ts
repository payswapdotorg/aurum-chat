// Unit tests for the events module's pure logic (no database): vocabulary
// guards, TenantContext shape, and the full validation/normalization
// surface of append inputs and list queries. The storage-level guarantees
// (immutability, ordering, idempotency, tenant scoping, correlation
// integrity) are covered by events-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { EventsError } from '../errors';
import {
  DEFAULT_LIST_LIMIT,
  ENVELOPE_VERSION,
  EVENT_ACTOR_KINDS,
  EVENT_SOURCE_KINDS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  assertEventTenantContext,
  isEventActorKind,
  isEventSourceKind,
  isUuid,
  validateAppendEventInput,
  validateListEventsQuery,
} from '../validation';
import type { AppendEventInput, ListEventsQuery } from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';

/** A minimal, fully valid append input. */
function validInput(): AppendEventInput {
  return {
    type: 'invoice.registered',
    payload: { invoice: 'INV-17', total: { value: 4200, currency: 'EUR' } },
    occurredAt: '2026-09-14T09:15:00Z',
    actor: { kind: 'person', id: UUID_A },
    source: { kind: 'source', label: 'billing' },
  };
}

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(EventsError);
    expect((error as EventsError).code).toBe(code);
  }
}

describe('vocabularies (ARCHITECTURE.md §4: immutable historical occurrences)', () => {
  it('declares the canonical sets without duplicates', () => {
    expect([...EVENT_ACTOR_KINDS]).toEqual(['person', 'agent', 'system', 'external', 'source']);
    expect([...EVENT_SOURCE_KINDS]).toEqual(['source', 'channel', 'system', 'api', 'external']);
    for (const set of [EVENT_ACTOR_KINDS, EVENT_SOURCE_KINDS]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('guards recognize members and reject everything else', () => {
    for (const kind of EVENT_ACTOR_KINDS) expect(isEventActorKind(kind)).toBe(true);
    for (const kind of EVENT_SOURCE_KINDS) expect(isEventSourceKind(kind)).toBe(true);
    for (const bad of ['', 'Person', 'event', 'thing', 42, null, undefined]) {
      expect(isEventActorKind(bad)).toBe(false);
      expect(isEventSourceKind(bad)).toBe(false);
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

  it('pins the current envelope version', () => {
    expect(ENVELOPE_VERSION).toBe(1);
  });
});

describe('TenantContext shape (explicit context, no ambient state)', () => {
  it('accepts a well-formed context', () => {
    expect(() =>
      assertEventTenantContext({ tenantId: newId(), principalId: newId(), authority: [] }),
    ).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () =>
      assertEventTenantContext({ tenantId: '', principalId: newId(), authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertEventTenantContext({ tenantId: newId(), principalId: '  ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertEventTenantContext({ tenantId: newId(), principalId: newId(), authority: 'admin' as unknown as string[] }),
    );
  });
});

describe('validateAppendEventInput', () => {
  it('applies the documented defaults for version and flow identities', () => {
    const validated = validateAppendEventInput(validInput());
    expect(validated.typeVersion).toBe(1);
    expect(validated.correlationId).toBeNull();
    expect(validated.causationId).toBeNull();
    expect(validated.idempotencyKey).toBeNull();
  });

  it('normalizes trimmed labels and lowercased uuid identities', () => {
    const validated = validateAppendEventInput({
      ...validInput(),
      actor: { kind: 'external', label: '  Public Registry  ' },
      source: { kind: 'channel', label: '  whatsapp  ' },
      correlationId: UUID_UPPER,
      causationId: UUID_B.toUpperCase(),
      idempotencyKey: '  webhook-1042  ',
    });
    expect(validated.actor.label).toBe('Public Registry');
    expect(validated.source.label).toBe('whatsapp');
    expect(validated.correlationId).toBe(UUID_A); // lowercased
    expect(validated.causationId).toBe(UUID_B);
    expect(validated.idempotencyKey).toBe('webhook-1042');
  });

  it('rejects smuggled identity/tenancy/commit-time/ordering/envelope fields (system-minted only)', () => {
    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'sequence', 'envelopeVersion']) {
      const input = { ...validInput(), [smuggled]: newId() } as unknown as AppendEventInput;
      expectCode('invalid_event_input', () => validateAppendEventInput(input));
    }
  });

  it('rejects a non-object or null input', () => {
    expectCode('invalid_event_input', () =>
      validateAppendEventInput(null as unknown as AppendEventInput),
    );
    expectCode('invalid_event_input', () =>
      validateAppendEventInput('event' as unknown as AppendEventInput),
    );
  });

  describe('type (canonical classification)', () => {
    it('accepts canonical classifications and trims', () => {
      expect(validateAppendEventInput({ ...validInput(), type: ' invoice.registered ' }).type).toBe('invoice.registered');
      expect(validateAppendEventInput({ ...validInput(), type: 'a:b-c_d.e' }).type).toBe('a:b-c_d.e');
    });

    it('rejects empty, oversized or malformed types', () => {
      for (const type of ['', '   ', 'has space', '.leading', 'ünïcode', 'x'.repeat(130), 42]) {
        expectCode('invalid_event_input', () =>
          validateAppendEventInput({ ...validInput(), type: type as unknown as string }),
        );
      }
    });
  });

  describe('typeVersion (payload contract version)', () => {
    it('defaults to 1 and accepts explicit integers >= 1', () => {
      expect(validateAppendEventInput(validInput()).typeVersion).toBe(1);
      expect(validateAppendEventInput({ ...validInput(), typeVersion: 2 }).typeVersion).toBe(2);
      expect(validateAppendEventInput({ ...validInput(), typeVersion: 17 }).typeVersion).toBe(17);
    });

    it('rejects non-integers and integers below 1', () => {
      for (const typeVersion of [0, -1, 1.5, '2', Number.NaN]) {
        expectCode('invalid_event_input', () =>
          validateAppendEventInput({ ...validInput(), typeVersion: typeVersion as unknown as number }),
        );
      }
    });

    it('treats an explicit null typeVersion as absent (default 1)', () => {
      expect(
        validateAppendEventInput({ ...validInput(), typeVersion: null as unknown as number }).typeVersion,
      ).toBe(1);
    });
  });

  describe('payload (immutable occurrence content)', () => {
    it('accepts any plain JSON value', () => {
      for (const payload of [
        'text',
        42,
        true,
        { nested: { deep: [1, 2, { x: null }] } },
        [{ array: true }],
      ]) {
        expect(validateAppendEventInput({ ...validInput(), payload }).payload).toEqual(payload);
      }
    });

    it('rejects non-JSON content', () => {
      for (const payload of [
        null,
        undefined,
        () => 1,
        Symbol('no'),
        10n,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        new Date('2026-01-01T00:00:00Z'),
        new Map(),
        { nested: { fn: () => 1 } },
      ]) {
        expectCode('invalid_event_input', () =>
          validateAppendEventInput({ ...validInput(), payload }),
        );
      }
    });

    it('rejects payloads that are too large', () => {
      const big = 'x'.repeat(1_048_577);
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), payload: { big } }),
      );
    });
  });

  describe('occurredAt (strict ISO 8601 with offset)', () => {
    it('accepts Z, offsets and fractional seconds', () => {
      for (const occurredAt of [
        '2026-09-14T09:15:00Z',
        '2026-09-14T09:15:00.123Z',
        '2026-09-14T11:15:00+02:00',
        '2026-09-14T05:15:00-04:00',
      ]) {
        expect(validateAppendEventInput({ ...validInput(), occurredAt }).occurredAt).toBe(occurredAt);
      }
    });

    it('rejects ambiguous or malformed timestamps', () => {
      for (const occurredAt of [
        '',
        '2026-09-14',
        '2026-09-14 09:15:00Z',
        '2026-09-14T09:15:00', // no offset
        'not-a-date',
        1726300500000,
      ]) {
        expectCode('invalid_event_input', () =>
          validateAppendEventInput({ ...validInput(), occurredAt: occurredAt as unknown as string }),
        );
      }
    });
  });

  describe('actor (who caused the occurrence)', () => {
    it('accepts every canonical kind with an id or a label', () => {
      for (const kind of EVENT_ACTOR_KINDS) {
        expect(validateAppendEventInput({ ...validInput(), actor: { kind, label: 'someone' } }).actor).toEqual({
          kind,
          id: null,
          label: 'someone',
        });
      }
    });

    it('rejects unknown kinds, missing provenance and unknown fields', () => {
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), actor: { kind: 'mystery' as unknown as 'system' } }),
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), actor: { kind: 'system' } }), // no id, no label
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({
          ...validInput(),
          actor: { kind: 'system', label: 'x', extra: 1 } as unknown as AppendEventInput['actor'],
        }),
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), actor: 'accountant' as unknown as AppendEventInput['actor'] }),
      );
    });
  });

  describe('source (the surface the event entered through)', () => {
    it('accepts every canonical kind with an id or a label', () => {
      for (const kind of EVENT_SOURCE_KINDS) {
        expect(validateAppendEventInput({ ...validInput(), source: { kind, id: 'connector-1' } }).source).toEqual({
          kind,
          id: 'connector-1',
          label: null,
        });
      }
    });

    it('rejects unknown kinds, missing provenance and unknown fields', () => {
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), source: { kind: 'mystery' as unknown as 'api' } }),
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), source: { kind: 'api' } }), // no id, no label
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({
          ...validInput(),
          source: { kind: 'api', label: 'x', extra: 1 } as unknown as AppendEventInput['source'],
        }),
      );
    });
  });

  describe('correlationId / causationId (flow identities)', () => {
    it('accepts well-formed uuids and treats explicit nulls as absent', () => {
      const validated = validateAppendEventInput({
        ...validInput(),
        correlationId: UUID_B,
        causationId: UUID_A,
      });
      expect(validated.correlationId).toBe(UUID_B);
      expect(validated.causationId).toBe(UUID_A);
      expect(
        validateAppendEventInput({ ...validInput(), correlationId: null, causationId: null }).correlationId,
      ).toBeNull();
    });

    it('rejects malformed uuids', () => {
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), correlationId: 'not-a-uuid' }),
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), causationId: 'not-a-uuid' }),
      );
      expectCode('invalid_event_input', () =>
        validateAppendEventInput({ ...validInput(), correlationId: 42 as unknown as string }),
      );
    });
  });

  describe('idempotencyKey (dedupe key)', () => {
    it('accepts realistic keys and treats explicit null as absent', () => {
      for (const idempotencyKey of [
        'webhook-1042',
        'billing:INV-17',
        'provider@event-42',
        'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH),
      ]) {
        expect(
          validateAppendEventInput({ ...validInput(), idempotencyKey }).idempotencyKey,
        ).toBe(idempotencyKey);
      }
      expect(validateAppendEventInput({ ...validInput(), idempotencyKey: null }).idempotencyKey).toBeNull();
    });

    it('rejects malformed or oversized keys', () => {
      for (const idempotencyKey of [
        '',
        'has space',
        '!!!',
        '-leading-dash',
        'x'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
        42,
      ]) {
        expectCode('invalid_event_input', () =>
          validateAppendEventInput({ ...validInput(), idempotencyKey: idempotencyKey as unknown as string }),
        );
      }
    });
  });
});

describe('validateListEventsQuery', () => {
  it('defaults the order and limit and accepts the full filter surface', () => {
    const validated = validateListEventsQuery({
      type: 'invoice.registered',
      typeVersion: 2,
      actorKind: 'person',
      actorId: UUID_A,
      sourceKind: 'source',
      sourceId: 'connector-1',
      correlationId: UUID_B,
      causationId: UUID_A,
      idempotencyKey: 'webhook-1042',
      occurredFrom: '2026-09-01T00:00:00Z',
      occurredTo: '2026-09-30T23:59:59Z',
      sequenceFrom: 1,
      sequenceTo: 500,
    });
    expect(validated.order).toBe('asc');
    expect(validated.limit).toBe(DEFAULT_LIST_LIMIT);
    expect(validated.occurredFrom).toBeInstanceOf(Date);
    expect(validated.occurredTo).toBeInstanceOf(Date);
    expect(validated.sequenceFrom).toBe(1);
    expect(validated.sequenceTo).toBe(500);
    expect(validated.correlationId).toBe(UUID_B);
    expect(validated.idempotencyKey).toBe('webhook-1042');
  });

  it('accepts both replay directions', () => {
    expect(validateListEventsQuery({ order: 'asc' }).order).toBe('asc');
    expect(validateListEventsQuery({ order: 'desc' }).order).toBe('desc');
  });

  it('rejects unknown fields with invalid_event_query', () => {
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ nope: 1 } as unknown as ListEventsQuery),
    );
  });

  it('rejects ids without their kinds', () => {
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ typeVersion: 2 } as unknown as ListEventsQuery), // version without type
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ actorId: UUID_A } as unknown as ListEventsQuery), // actor id without kind
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ sourceId: 'connector-1' } as unknown as ListEventsQuery), // source id without kind
    );
  });

  it('rejects malformed filter values', () => {
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ correlationId: 'not-a-uuid' } as unknown as ListEventsQuery),
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ causationId: 42 as unknown as string } as unknown as ListEventsQuery)
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ idempotencyKey: 'has space' } as unknown as ListEventsQuery)
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ occurredFrom: '2026-09-01', occurredTo: '2026-09-30' })
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ actorKind: 'mystery' as unknown as 'person' })
    );
  });

  it('rejects inverted windows', () => {
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ occurredFrom: '2026-10-01T00:00:00Z', occurredTo: '2026-09-01T00:00:00Z' }),
    );
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ sequenceFrom: 5, sequenceTo: 2 }),
    );
  });

  it('bounds the sequence cursor and the limit', () => {
    expect(validateListEventsQuery({ limit: MAX_LIST_LIMIT }).limit).toBe(MAX_LIST_LIMIT);
    expect(validateListEventsQuery({ sequenceFrom: 1 }).sequenceFrom).toBe(1);
    for (const limit of [0, -1, MAX_LIST_LIMIT + 1, 1.5, '10']) {
      expectCode('invalid_event_query', () =>
        validateListEventsQuery({ limit: limit as unknown as number }),
      );
    }
    for (const sequenceFrom of [0, -1, 1.5, '3']) {
      expectCode('invalid_event_query', () =>
        validateListEventsQuery({ sequenceFrom: sequenceFrom as unknown as number }),
      );
    }
    for (const sequenceTo of [0, -1, 1.5, '3']) {
      expectCode('invalid_event_query', () =>
        validateListEventsQuery({ sequenceTo: sequenceTo as unknown as number }),
      );
    }
  });

  it('rejects unknown replay directions', () => {
    expectCode('invalid_event_query', () =>
      validateListEventsQuery({ order: 'sideways' as unknown as 'asc' }),
    );
  });
});
