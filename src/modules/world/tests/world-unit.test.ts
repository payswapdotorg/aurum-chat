// Unit tests for the world module's pure logic: the built-in vocabularies
// (kinds.ts) and the input validators (validation.ts). No database — the
// service/integration behavior is covered by world-service.test.ts.

import { describe, expect, it } from 'vitest';
import { WorldError } from '../errors';
import {
  BUILTIN_ENTITY_KINDS,
  BUILTIN_RELATIONSHIP_TYPES,
  ENTITY_KIND_CATEGORIES,
  builtinEntityKindCategory,
  isBuiltinEntityKind,
  isBuiltinRelationshipType,
} from '../kinds';
import {
  assertWorldTenantContext,
  escapeLike,
  isEntityKindCategory,
  isUuid,
  validateCreateEntityInput,
  validateCreateRelationshipInput,
  validateListEntitiesQuery,
  validateListRelationshipsQuery,
  validateRegisterEntityKindInput,
  validateRegisterRelationshipTypeInput,
  validateUpdateEntityInput,
} from '../validation';
import type { TenantContext } from '@/infra/tenant';

const KIND_OR_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

describe('built-in entity vocabulary (ARCHITECTURE.md §4)', () => {
  it('mirrors the frozen core entity list exactly, plus the tenant company', () => {
    // The 31 entities of ARCHITECTURE.md §4 (snake_cased)…
    const architectureCore = [
      'person', 'employee', 'team', 'manager', 'customer', 'supplier', 'subcontractor',
      'competitor', 'regulator', 'government_body', 'product', 'service', 'asset', 'location',
      'project', 'process', 'contract', 'market', 'industry', 'technology', 'agent', 'agent_team',
      'extension', 'capability', 'goal', 'risk', 'opportunity', 'learning_mission',
      'knowledge_contribution', 'reward', 'external_identity',
    ];
    // …plus `company` — the work item's own "company" area needs an entity
    // for the tenant company itself (employed_by/operates_in edges).
    const expected = new Set([...architectureCore, 'company']);
    const actual = new Set(BUILTIN_ENTITY_KINDS.map((entry) => entry.kind));
    expect(actual).toEqual(expected);
  });

  it('has no duplicate kinds, and every kind is a valid lowercase snake name', () => {
    const kinds = BUILTIN_ENTITY_KINDS.map((entry) => entry.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const entry of BUILTIN_ENTITY_KINDS) {
      expect(entry.kind).toMatch(KIND_OR_TYPE_PATTERN);
      expect(entry.description.trim()).not.toBe('');
    }
  });

  it('covers all five areas of the work item via categories', () => {
    const byCategory = new Map<string, number>();
    for (const entry of BUILTIN_ENTITY_KINDS) {
      byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
    }
    // company, people, processes, capabilities and environment — the work
    // item's five areas — each carry at least one built-in kind.
    expect(byCategory.get('company')!).toBeGreaterThan(0);
    expect(byCategory.get('people')!).toBeGreaterThan(0);
    expect(byCategory.get('process')!).toBeGreaterThan(0);
    expect(byCategory.get('capability')!).toBeGreaterThan(0);
    expect(byCategory.get('environment')!).toBeGreaterThan(0);
    // the sixth category exists for module-owned direction objects
    expect(byCategory.get('direction')!).toBeGreaterThan(0);
  });

  it('classifies every kind with a known category and exposes lookups', () => {
    for (const entry of BUILTIN_ENTITY_KINDS) {
      expect(ENTITY_KIND_CATEGORIES).toContain(entry.category);
      expect(builtinEntityKindCategory(entry.kind)).toBe(entry.category);
    }
    expect(isBuiltinEntityKind('person')).toBe(true);
    expect(isBuiltinEntityKind('not_a_kind')).toBe(false);
    expect(builtinEntityKindCategory('not_a_kind')).toBeUndefined();
  });
});

describe('built-in relationship vocabulary', () => {
  it('has no duplicate types and valid snake names', () => {
    const types = BUILTIN_RELATIONSHIP_TYPES.map((entry) => entry.type);
    expect(new Set(types).size).toBe(types.length);
    for (const entry of BUILTIN_RELATIONSHIP_TYPES) {
      expect(entry.type).toMatch(KIND_OR_TYPE_PATTERN);
      expect(entry.description.trim()).not.toBe('');
    }
  });

  it('covers the work-item areas with people, process, capability, environment and company semantics', () => {
    const types = new Set(BUILTIN_RELATIONSHIP_TYPES.map((entry) => entry.type));
    // people
    for (const t of ['member_of', 'reports_to', 'employed_by']) expect(types.has(t)).toBe(true);
    // processes / capabilities
    for (const t of ['works_on', 'participates_in', 'requires', 'provides', 'depends_on']) {
      expect(types.has(t)).toBe(true);
    }
    // environment
    for (const t of ['supplies', 'competes_with', 'operates_in', 'regulates', 'serves', 'contracts_with']) {
      expect(types.has(t)).toBe(true);
    }
    // company structure
    for (const t of ['owns', 'located_at', 'part_of', 'uses']) expect(types.has(t)).toBe(true);
    expect(isBuiltinRelationshipType('member_of')).toBe(true);
    expect(isBuiltinRelationshipType('not_a_type')).toBe(false);
  });
});

describe('tenant context validation', () => {
  const good: TenantContext = { tenantId: 't-1', principalId: 'p-1', authority: [] };

  it('accepts a well-formed context', () => {
    expect(() => assertWorldTenantContext(good)).not.toThrow();
  });

  it('rejects malformed contexts with invalid_context', () => {
    for (const bad of [
      { tenantId: '', principalId: 'p', authority: [] },
      { tenantId: 't', principalId: '', authority: [] },
      { tenantId: 't', principalId: 'p', authority: 'none' },
      { principalId: 'p', authority: [] },
      { tenantId: 't', authority: [] },
    ]) {
      expect(() => assertWorldTenantContext(bad as unknown as TenantContext)).toThrowError(WorldError);
    }
  });
});

describe('validateCreateEntityInput', () => {
  const base = { kind: 'person', name: 'Ada Lovelace' };

  it('normalizes a minimal input with defaulted description/attributes/externalRef', () => {
    expect(validateCreateEntityInput(base)).toEqual({
      kind: 'person',
      name: 'Ada Lovelace',
      description: null,
      attributes: {},
      externalRef: null,
    });
  });

  it('accepts and normalizes the full shape', () => {
    const validated = validateCreateEntityInput({
      kind: 'person',
      name: '  Grace Hopper  ',
      description: ' Captain ',
      attributes: { seniority: 'staff', skills: ['naval', 'compilers'] },
      externalRef: { module: 'people', id: ' id-1 ' },
    });
    expect(validated.name).toBe('Grace Hopper');
    expect(validated.description).toBe('Captain');
    expect(validated.attributes).toEqual({ seniority: 'staff', skills: ['naval', 'compilers'] });
    expect(validated.externalRef).toEqual({ module: 'people', id: 'id-1' });
  });

  it('rejects smuggled system fields (identity, tenancy and time are minted by the system)', () => {
    for (const smuggled of ['id', 'tenantId', 'createdAt', 'updatedAt', 'category']) {
      const error = capture(() =>
        validateCreateEntityInput({ ...base, [smuggled]: 'x' } as never),
      );
      expect(error?.code).toBe('invalid_entity_input');
    }
  });

  it('rejects bad names, kinds and attributes', () => {
    expect(capture(() => validateCreateEntityInput({ ...base, name: '   ' }))?.code).toBe(
      'invalid_entity_input',
    );
    expect(capture(() => validateCreateEntityInput({ ...base, name: 'x'.repeat(201) }))?.code).toBe(
      'invalid_entity_input',
    );
    expect(capture(() => validateCreateEntityInput({ ...base, name: 'bad\nname' }))?.code).toBe(
      'invalid_entity_input',
    );
    expect(capture(() => validateCreateEntityInput({ ...base, kind: 'Not-Snake' }))?.code).toBe(
      'invalid_entity_input',
    );
    expect(capture(() => validateCreateEntityInput({ ...base, attributes: 'flat' }))?.code).toBe(
      'invalid_entity_input',
    );
    expect(capture(() => validateCreateEntityInput({ ...base, attributes: new Date() }))?.code).toBe(
      'invalid_entity_input',
    );
    const tooBig = { blob: 'x'.repeat(262_145) };
    expect(capture(() => validateCreateEntityInput({ ...base, attributes: tooBig }))?.code).toBe(
      'invalid_entity_input',
    );
  });

  it('rejects malformed external references', () => {
    expect(
      capture(() => validateCreateEntityInput({ ...base, externalRef: { module: 'People' } } as never))?.code,
    ).toBe('invalid_entity_input');
    expect(
      capture(() => validateCreateEntityInput({ ...base, externalRef: { module: 'people', id: '' } }) )?.code,
    ).toBe('invalid_entity_input');
    expect(
      capture(() => validateCreateEntityInput({ ...base, externalRef: { module: 'people', id: 'x', extra: 1 } as never })),
    ).toMatchObject({ code: 'invalid_entity_input' });
  });
});

describe('validateUpdateEntityInput', () => {
  const entityId = '00000000-0000-4000-8000-000000000001';

  it('keeps description three-state: omitted / cleared / replaced', () => {
    expect(validateUpdateEntityInput({ entityId, name: 'New' }).setDescription).toBe(false);
    const cleared = validateUpdateEntityInput({ entityId, description: null });
    expect(cleared.setDescription).toBe(true);
    expect(cleared.description).toBeNull();
    const replaced = validateUpdateEntityInput({ entityId, description: 'New text' });
    expect(replaced.setDescription).toBe(true);
    expect(replaced.description).toBe('New text');
  });

  it('requires at least one change and a uuid entityId', () => {
    expect(capture(() => validateUpdateEntityInput({ entityId }))?.code).toBe('invalid_entity_input');
    expect(capture(() => validateUpdateEntityInput({ entityId: 'nope', name: 'X' }))?.code).toBe(
      'invalid_entity_input',
    );
  });
});

describe('validateCreateRelationshipInput', () => {
  const from = '00000000-0000-4000-8000-000000000002';
  const to = '00000000-0000-4000-8000-000000000003';

  it('accepts a valid edge and defaults attributes', () => {
    expect(validateCreateRelationshipInput({ type: 'member_of', fromEntityId: from, toEntityId: to })).toEqual({
      type: 'member_of',
      fromEntityId: from,
      toEntityId: to,
      attributes: {},
    });
  });

  it('rejects self-loops, bad uuids, bad types and non-object attributes', () => {
    expect(
      capture(() => validateCreateRelationshipInput({ type: 'member_of', fromEntityId: from, toEntityId: from }))
        ?.code,
    ).toBe('invalid_relationship_input');
    expect(
      capture(() => validateCreateRelationshipInput({ type: 'member_of', fromEntityId: 'x', toEntityId: to }))?.code,
    ).toBe('invalid_relationship_input');
    expect(
      capture(() => validateCreateRelationshipInput({ type: 'MemberOf', fromEntityId: from, toEntityId: to }))?.code,
    ).toBe('invalid_relationship_input');
    expect(
      capture(() =>
        validateCreateRelationshipInput({ type: 'member_of', fromEntityId: from, toEntityId: to, attributes: [] }),
      )?.code,
    ).toBe('invalid_relationship_input');
  });
});

describe('list query validation', () => {
  it('validates entity queries', () => {
    expect(validateListEntitiesQuery({})).toMatchObject({ limit: 50 });
    expect(validateListEntitiesQuery({ kind: 'person', category: 'people', limit: 1 })).toEqual({
      kind: 'person',
      category: 'people',
      externalModule: null,
      externalId: null,
      search: null,
      limit: 1,
    });
    expect(capture(() => validateListEntitiesQuery({ nope: 1 } as never))?.code).toBe('invalid_world_query');
    expect(capture(() => validateListEntitiesQuery({ limit: 0 }))?.code).toBe('invalid_world_query');
    expect(capture(() => validateListEntitiesQuery({ limit: 501 }))?.code).toBe('invalid_world_query');
    expect(capture(() => validateListEntitiesQuery({ category: 'nope' as never }))?.code).toBe(
      'invalid_world_query',
    );
    expect(capture(() => validateListEntitiesQuery({ externalId: 'x' }))?.code).toBe('invalid_world_query');
    expect(capture(() => validateListEntitiesQuery({ externalModule: 'people' }))?.code).toBe(
      'invalid_world_query',
    );
  });

  it('validates relationship queries, including the adjacency exclusivity rule', () => {
    const from = '00000000-0000-4000-8000-000000000002';
    expect(validateListRelationshipsQuery({ fromEntityId: from })).toMatchObject({ fromEntityId: from });
    expect(
      capture(() => validateListRelationshipsQuery({ entityId: from, fromEntityId: from }))?.code,
    ).toBe('invalid_world_query');
    expect(
      capture(() => validateListRelationshipsQuery({ entityId: from, toEntityId: from }))?.code,
    ).toBe('invalid_world_query');
    expect(capture(() => validateListRelationshipsQuery({ limit: 999 }))?.code).toBe('invalid_world_query');
  });
});

describe('vocabulary registration validation', () => {
  it('rejects built-in entity kinds as reserved', () => {
    const error = capture(() =>
      validateRegisterEntityKindInput({ kind: 'person', category: 'people' }),
    );
    expect(error?.code).toBe('entity_kind_reserved');
  });

  it('rejects bad custom kind names and categories', () => {
    expect(
      capture(() => validateRegisterEntityKindInput({ kind: 'Profit Center', category: 'company' }))?.code,
    ).toBe('invalid_registration_input');
    expect(
      capture(() => validateRegisterEntityKindInput({ kind: 'profit_center', category: 'nope' as never }))?.code,
    ).toBe('invalid_registration_input');
  });

  it('accepts a well-formed custom kind', () => {
    expect(validateRegisterEntityKindInput({ kind: 'profit_center', category: 'company' })).toEqual({
      kind: 'profit_center',
      category: 'company',
      description: null,
    });
  });

  it('rejects built-in relationship types as reserved and validates names', () => {
    expect(
      capture(() => validateRegisterRelationshipTypeInput({ type: 'member_of' }))?.code,
    ).toBe('relationship_type_reserved');
    expect(
      capture(() => validateRegisterRelationshipTypeInput({ type: 'Not A Type' }))?.code,
    ).toBe('invalid_registration_input');
    expect(validateRegisterRelationshipTypeInput({ type: 'mentored_by' })).toEqual({
      type: 'mentored_by',
      description: null,
    });
  });
});

describe('helpers', () => {
  it('escapeLike escapes wildcards so search text is a literal substring', () => {
    expect(escapeLike('100%_done\\')).toBe('100\\%\\_done\\\\');
  });

  it('isUuid checks the canonical shape', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isUuid('nope')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('isEntityKindCategory checks the fixed category set', () => {
    expect(isEntityKindCategory('company')).toBe(true);
    expect(isEntityKindCategory('companies')).toBe(false);
    expect(isEntityKindCategory(7)).toBe(false);
  });
});

/** Captures a thrown WorldError (or returns undefined if nothing threw). */
function capture(fn: () => unknown): WorldError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (!(error instanceof WorldError)) throw error;
    return error;
  }
}
