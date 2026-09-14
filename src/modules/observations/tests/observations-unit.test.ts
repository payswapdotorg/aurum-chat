// Unit tests for the observations module's pure logic (no database):
// vocabulary guards, TenantContext shape, and the full
// validation/normalization surface of record inputs and list queries.
// The storage-level guarantees (immutability, tenant scoping, lineage
// integrity) are covered by observations-service.test.ts.

import { describe, expect, it } from 'vitest';
import { newId } from '@/infra/ids';
import { ObservationsError } from '../errors';
import {
  assertObservationTenantContext,
  DEFAULT_LIST_LIMIT,
  DERIVING_LINEAGE_METHODS,
  isLineageMethod,
  isObservationSourceKind,
  isObservationVisibility,
  isUuid,
  LINEAGE_METHODS,
  MAX_LIST_LIMIT,
  MAX_LINEAGE_PARENTS,
  MAX_USAGE_TAGS,
  OBSERVATION_SOURCE_KINDS,
  OBSERVATION_VISIBILITIES,
  validateListObservationsQuery,
  validateRecordObservationInput,
} from '../validation';
import type { RecordObservationInput } from '../types';

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3a9f4b-2d5c-4e9b-8a4f-8b3c7d6e5f9a';
const UUID_UPPER = '0B2F8E2A-1C4B-4D8A-9F3E-7A2B6C5D4E8F';

/** A minimal, fully valid record input. */
function validInput(): RecordObservationInput {
  return {
    kind: 'channel.message',
    payload: { text: 'the printer on floor 3 is broken', floor: 3 },
    observedAt: '2026-09-14T09:15:00Z',
    source: { kind: 'person', id: UUID_A },
    channel: 'whatsapp',
    confidence: { value: 0.9, method: 'source_trust' },
  };
}

function expectCode(code: string, fn: () => void): void {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(ObservationsError);
    expect((error as ObservationsError).code).toBe(code);
  }
}

describe('vocabularies (ARCHITECTURE.md §4: evidence provenance)', () => {
  it('declares the canonical sets without duplicates', () => {
    expect([...OBSERVATION_SOURCE_KINDS]).toEqual(['source', 'person', 'agent', 'system', 'external']);
    expect([...LINEAGE_METHODS]).toEqual(['direct', 'connector', 'extraction', 'transformation', 'inference']);
    expect([...OBSERVATION_VISIBILITIES]).toEqual(['tenant', 'workspace', 'principal']);
    expect([...DERIVING_LINEAGE_METHODS]).toEqual(['extraction', 'transformation', 'inference']);
    for (const set of [OBSERVATION_SOURCE_KINDS, LINEAGE_METHODS, OBSERVATION_VISIBILITIES]) {
      expect(new Set(set).size).toBe(set.length);
    }
  });

  it('guards recognize members and reject everything else', () => {
    for (const kind of OBSERVATION_SOURCE_KINDS) expect(isObservationSourceKind(kind)).toBe(true);
    for (const method of LINEAGE_METHODS) expect(isLineageMethod(method)).toBe(true);
    for (const visibility of OBSERVATION_VISIBILITIES) expect(isObservationVisibility(visibility)).toBe(true);
    for (const bad of ['', 'Source', 'observation', 'thing', 42, null, undefined]) {
      expect(isObservationSourceKind(bad)).toBe(false);
      expect(isLineageMethod(bad)).toBe(false);
      expect(isObservationVisibility(bad)).toBe(false);
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
      assertObservationTenantContext({ tenantId: newId(), principalId: newId(), authority: [] }),
    ).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    expectCode('invalid_context', () =>
      assertObservationTenantContext({ tenantId: '', principalId: newId(), authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertObservationTenantContext({ tenantId: newId(), principalId: '  ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertObservationTenantContext({ tenantId: newId(), principalId: newId(), authority: 'admin' as unknown as string[] }),
    );
  });
});

describe('validateRecordObservationInput', () => {
  it('applies the documented defaults for lineage and permissions', () => {
    const validated = validateRecordObservationInput(validInput());
    expect(validated.lineage).toEqual({ method: 'direct', parents: [], extractor: null });
    expect(validated.permissions).toEqual({
      visibility: 'tenant',
      workspaceId: null,
      principalId: null,
      usage: [],
    });
    expect(validated.confidence.basis).toBeNull();
  });

  it('normalizes trimmed strings, parent case and usage tags', () => {
    const validated = validateRecordObservationInput({
      kind: 'document.note',
      payload: ['line one'],
      observedAt: '2026-09-14T09:15:00+02:00',
      source: { kind: 'external', label: '  Public Registry  ' },
      channel: 'web.form',
      lineage: { method: 'extraction', parents: [UUID_UPPER] },
      permissions: { usage: ['no-export', 'no-llm', 'no-export'] },
      confidence: { value: 0.42, method: 'source_trust', basis: '  registry snapshot  ' },
    });
    expect(validated.source.label).toBe('Public Registry');
    expect(validated.lineage.parents).toEqual([UUID_A]); // lowercased
    expect(validated.permissions.usage).toEqual(['no-export', 'no-llm']); // deduped + sorted
    expect(validated.confidence.basis).toBe('registry snapshot');
  });

  it('rejects smuggled identity/tenancy/commit-time fields (system-minted only)', () => {
    for (const smuggled of ['id', 'tenantId', 'recordedAt', 'authoritative', 'verified']) {
      const input = { ...validInput(), [smuggled]: newId() } as unknown as RecordObservationInput;
      expectCode('invalid_observation_input', () => validateRecordObservationInput(input));
    }
  });

  it('rejects a non-object or null input', () => {
    expectCode('invalid_observation_input', () =>
      validateRecordObservationInput(null as unknown as RecordObservationInput),
    );
    expectCode('invalid_observation_input', () =>
      validateRecordObservationInput('observation' as unknown as RecordObservationInput),
    );
  });

  describe('kind', () => {
    it('accepts canonical classifications and trims', () => {
      expect(validateRecordObservationInput({ ...validInput(), kind: ' metric.sample ' }).kind).toBe('metric.sample');
      expect(validateRecordObservationInput({ ...validInput(), kind: 'a:b-c_d.e' }).kind).toBe('a:b-c_d.e');
    });

    it('rejects empty, oversized or malformed kinds', () => {
      for (const kind of ['', '   ', 'has space', '.leading', 'ünïcode', 'x'.repeat(130), 42]) {
        expectCode('invalid_observation_input', () =>
          validateRecordObservationInput({ ...validInput(), kind: kind as unknown as string }),
        );
      }
    });
  });

  describe('payload (immutable observed content)', () => {
    it('accepts any plain JSON value', () => {
      for (const payload of [
        'text',
        42,
        true,
        { nested: { deep: [1, 2, { x: null }] } },
        [{ array: true }],
      ]) {
        expect(validateRecordObservationInput({ ...validInput(), payload }).payload).toEqual(payload);
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
        expectCode('invalid_observation_input', () =>
          validateRecordObservationInput({ ...validInput(), payload }),
        );
      }
    });

    it('rejects payloads that are too large', () => {
      const big = 'x'.repeat(1_048_577);
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), payload: { big } }),
      );
    });
  });

  describe('observedAt (strict ISO 8601 with offset)', () => {
    it('accepts Z, offsets and fractional seconds', () => {
      for (const observedAt of [
        '2026-09-14T09:15:00Z',
        '2026-09-14T09:15:00.123Z',
        '2026-09-14T11:15:00+02:00',
        '2026-09-14T05:15:00-04:00',
      ]) {
        expect(validateRecordObservationInput({ ...validInput(), observedAt }).observedAt).toBe(observedAt);
      }
    });

    it('rejects ambiguous or malformed timestamps', () => {
      for (const observedAt of [
        '',
        '2026-09-14',
        '2026-09-14 09:15:00Z',
        '2026-09-14T09:15:00', // no offset
        'not-a-date',
        1726300500000,
      ]) {
        expectCode('invalid_observation_input', () =>
          validateRecordObservationInput({ ...validInput(), observedAt: observedAt as unknown as string }),
        );
      }
    });
  });

  describe('source (provenance must be traceable)', () => {
    it('accepts a kind with an id or a label', () => {
      expect(validateRecordObservationInput({ ...validInput(), source: { kind: 'external', label: 'news feed' } }).source).toEqual({
        kind: 'external',
        id: null,
        label: 'news feed',
      });
    });

    it('rejects unknown kinds, missing provenance and unknown fields', () => {
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), source: { kind: 'mystery' as unknown as 'system' } }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), source: { kind: 'external' } }), // no id, no label
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          source: { kind: 'system', label: 'x', extra: 1 } as unknown as RecordObservationInput['source'],
        }),
      );
    });
  });

  describe('channel (provider-neutral slug, lock 16)', () => {
    it('accepts neutral channel keys', () => {
      for (const channel of ['whatsapp', 'api', 'ingestion', 'web.form', 'voice_sms']) {
        expect(validateRecordObservationInput({ ...validInput(), channel }).channel).toBe(channel);
      }
    });

    it('rejects non-slug channel keys', () => {
      for (const channel of ['', 'WhatsApp', 'whatsapp!', 'has space', 'x'.repeat(66)]) {
        expectCode('invalid_observation_input', () =>
          validateRecordObservationInput({ ...validInput(), channel }),
        );
      }
    });
  });

  describe('lineage (extraction provenance)', () => {
    it('accepts deriving methods with valid parents and extractor metadata', () => {
      const validated = validateRecordObservationInput({
        ...validInput(),
        lineage: {
          method: 'inference',
          parents: [UUID_A, UUID_B],
          extractor: { provider: 'llm-a', model: 'reasoning-model-1', notes: 'structured extraction' },
        },
      });
      expect(validated.lineage.method).toBe('inference');
      expect(validated.lineage.parents).toEqual([UUID_A, UUID_B]);
      expect(validated.lineage.extractor).toEqual({
        provider: 'llm-a',
        model: 'reasoning-model-1',
        notes: 'structured extraction',
      });
    });

    it('rejects deriving methods without parents', () => {
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({ ...validInput(), lineage: { method: 'extraction', parents: [] } }),
      );
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({ ...validInput(), lineage: { method: 'inference' } }),
      );
    });

    it('rejects root methods carrying parents', () => {
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({ ...validInput(), lineage: { method: 'direct', parents: [UUID_A] } }),
      );
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'connector', parents: [UUID_A] },
        }),
      );
    });

    it('rejects malformed, duplicate, self-shaped and too many parents', () => {
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'extraction', parents: ['nope'] },
        }),
      );
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'extraction', parents: [UUID_A, UUID_A] },
        }),
      );
      expectCode('invalid_lineage', () =>
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'extraction', parents: Array.from({ length: MAX_LINEAGE_PARENTS + 1 }, () => newId()) },
        }),
      );
    });

    it('rejects malformed extractor metadata', () => {
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'inference', parents: [UUID_A], extractor: { provider: 'LLM A', model: 'm' } },
        }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'inference', parents: [UUID_A], extractor: { provider: 'llm-a' } as never },
        }),
      );
    });
  });

  describe('permissions (recorded access constraints)', () => {
    it('accepts each visibility with its required scope', () => {
      const workspaceId = newId();
      const principalId = newId();
      expect(
        validateRecordObservationInput({
          ...validInput(),
          permissions: { visibility: 'workspace', workspaceId },
        }).permissions,
      ).toEqual({ visibility: 'workspace', workspaceId, principalId: null, usage: [] });
      expect(
        validateRecordObservationInput({
          ...validInput(),
          permissions: { visibility: 'principal', principalId },
        }).permissions,
      ).toEqual({ visibility: 'principal', workspaceId: null, principalId, usage: [] });
    });

    it('treats explicit nulls for optional scopes as absent', () => {
      expect(
        validateRecordObservationInput({
          ...validInput(),
          permissions: { visibility: 'tenant', workspaceId: null, principalId: null },
        }).permissions,
      ).toEqual({ visibility: 'tenant', workspaceId: null, principalId: null, usage: [] });
      expect(
        validateRecordObservationInput({
          ...validInput(),
          lineage: { method: 'direct', extractor: null },
        }).lineage,
      ).toEqual({ method: 'direct', parents: [], extractor: null });
    });

    it('rejects missing scopes, mismatched scopes and bad uuids', () => {
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), permissions: { visibility: 'workspace' } }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), permissions: { visibility: 'principal' } }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          permissions: { visibility: 'tenant', workspaceId: newId() },
        }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          permissions: { visibility: 'principal', principalId: 'not-a-uuid' },
        }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          permissions: { visibility: 'principal', principalId: newId(), workspaceId: newId() },
        }),
      );
    });

    it('rejects malformed usage tags and oversized tag lists', () => {
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), permissions: { usage: ['No-LLM'] } }),
      );
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({
          ...validInput(),
          permissions: { usage: Array.from({ length: MAX_USAGE_TAGS + 1 }, (_, i) => `tag-${i}`) },
        }),
      );
    });
  });

  describe('confidence (explicit, calibrated, never truth)', () => {
    it('accepts the inclusive [0, 1] bounds', () => {
      expect(validateRecordObservationInput({ ...validInput(), confidence: { value: 0, method: 'none' } }).confidence.value).toBe(0);
      expect(validateRecordObservationInput({ ...validInput(), confidence: { value: 1, method: 'certain_capture' } }).confidence.value).toBe(1);
    });

    it('is required and rejects out-of-range or malformed values', () => {
      const { confidence: _omit, ...withoutConfidence } = validInput();
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput(withoutConfidence as unknown as RecordObservationInput),
      );
      for (const value of [-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY, '0.5', null]) {
        expectCode('invalid_observation_input', () =>
          validateRecordObservationInput({
            ...validInput(),
            confidence: { value: value as unknown as number, method: 'x_method' },
          }),
        );
      }
      expectCode('invalid_observation_input', () =>
        validateRecordObservationInput({ ...validInput(), confidence: { value: 0.5, method: 'Sarah said so' } }),
      );
    });
  });
});

describe('validateListObservationsQuery', () => {
  it('defaults the limit and accepts the full filter surface', () => {
    const validated = validateListObservationsQuery({
      kind: 'channel.message',
      channel: 'whatsapp',
      sourceKind: 'person',
      sourceId: UUID_A,
      observedFrom: '2026-09-01T00:00:00Z',
      observedTo: '2026-09-30T23:59:59Z',
    });
    expect(validated.limit).toBe(DEFAULT_LIST_LIMIT);
    expect(validated.observedFrom).toBeInstanceOf(Date);
    expect(validated.observedTo).toBeInstanceOf(Date);
    expect(validated.channel).toBe('whatsapp');
  });

  it('rejects unknown fields and bad filters with invalid_observation_query', () => {
    expectCode('invalid_observation_query', () =>
      validateListObservationsQuery({ nope: 1 } as unknown as Parameters<typeof validateListObservationsQuery>[0]),
    );
    expectCode('invalid_observation_query', () =>
      validateListObservationsQuery({ sourceId: UUID_A }), // id without kind
    );
    expectCode('invalid_observation_query', () =>
      validateListObservationsQuery({ observedFrom: '2026-09-01', observedTo: '2026-09-30' }),
    );
    expectCode('invalid_observation_query', () =>
      validateListObservationsQuery({ observedFrom: '2026-10-01T00:00:00Z', observedTo: '2026-09-01T00:00:00Z' }),
    );
  });

  it('bounds the limit', () => {
    expect(validateListObservationsQuery({ limit: MAX_LIST_LIMIT }).limit).toBe(MAX_LIST_LIMIT);
    for (const limit of [0, -1, MAX_LIST_LIMIT + 1, 1.5, '10']) {
      expectCode('invalid_observation_query', () =>
        validateListObservationsQuery({ limit: limit as unknown as number }),
      );
    }
  });
});
