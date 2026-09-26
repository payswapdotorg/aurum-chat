// Unit tests for the migration module's PURE surfaces (W094): the
// deterministic dual-run comparison (compare.ts — including its reuse of
// the W084 reconciliation semantics), the transform's schema-hint check,
// the validation/canonicalization guards, and the deterministic
// incumbent/native doubles (fixture-incumbent.ts).

import { describe, expect, it } from 'vitest';
import {
  buildDivergenceReason,
  buildIncumbentMissingReason,
  compareEntity,
  detectSchemaHintIssues,
  jsonDeepEqual,
} from '../compare';
import {
  canonicalizeIncumbentRecord,
  canonicalizeNativeStates,
  canonicalizeSnapshotResult,
  isImportRoundKind,
  isMigrationStatus,
  validateCreateMigrationInput,
  validateResolveExternalIdQuery,
} from '../validation';
import { MigrationError } from '../errors';
import { FixtureIncumbent, FixtureNativeStore } from '../fixture-incumbent';

// ---------------------------------------------------------------------------
// compareEntity — the dual-run question, deterministically
// ---------------------------------------------------------------------------

describe('compareEntity (the pure dual-run comparison)', () => {
  it('treats a native-only field as a structural divergence (surfaced, not ignored)', () => {
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: { stage: 'active', seats: 12, nested: { tier: 'gold' } },
      nativeState: { stage: 'active', seats: 12, nested: { tier: 'gold' }, extra: 'x' },
    });
    expect(verdict.kind).toBe('divergence');
    expect(verdict.nativeOnlyFields.map((field) => field.field)).toEqual(['extra']);
  });

  it('agrees when the states deep-equal', () => {
    const state = { stage: 'active', seats: 12, nested: { tier: 'gold' } };
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: state,
      nativeState: { ...state },
    });
    expect(verdict.kind).toBe('agreement');
    expect(verdict.reason).toBeNull();
    expect(verdict.mismatches).toEqual([]);
  });

  it('enumerates value divergences with the W084 mismatch shape (path/expected/actual)', () => {
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: { stage: 'onboarding', seats: 12, nested: { tier: 'gold' } },
      nativeState: { stage: 'active', seats: 12, nested: { tier: 'silver' } },
    });
    expect(verdict.kind).toBe('divergence');
    expect(verdict.mismatches).toEqual([
      { path: 'stage', expected: 'onboarding', actual: 'active' },
      { path: 'nested.tier', expected: 'gold', actual: 'silver' },
    ]);
    // expected = incumbent-imported, actual = native — the direction the
    // reason text carries.
    expect(verdict.reason).toContain("field 'stage' diverges (incumbent-imported 'onboarding' vs native 'active')");
    expect(verdict.reason).toContain("field 'nested.tier' diverges");
  });

  it('surfaces one-sided fields structurally (incumbent-only and native-only)', () => {
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: { stage: 'active', legacyCode: 'L-9' },
      nativeState: { stage: 'active', region: 'eu' },
    });
    expect(verdict.kind).toBe('divergence');
    expect(verdict.mismatches).toEqual([]);
    expect(verdict.incumbentOnlyFields).toEqual([{ field: 'legacyCode', value: 'L-9' }]);
    expect(verdict.nativeOnlyFields).toEqual([{ field: 'region', value: 'eu' }]);
    expect(verdict.reason).toContain("field 'legacyCode' only exists in the incumbent-imported state");
    expect(verdict.reason).toContain("field 'region' only exists in the native Aurum state");
  });

  it('reports native-missing when Aurum holds no native state for an imported entity', () => {
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: { stage: 'active' },
      nativeState: null,
    });
    expect(verdict.kind).toBe('native-missing');
    expect(verdict.reason).toContain('no native state');
  });

  it('reports incumbent-deleted when the incumbent tombstoned but native still holds', () => {
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: null,
      nativeState: { stage: 'active' },
    });
    expect(verdict.kind).toBe('incumbent-deleted');
    expect(verdict.reason).toContain('deleted in the incumbent');
  });

  it('agrees when both sides say gone (tombstone + no native state)', () => {
    const verdict = compareEntity({
      aurumEntityId: 'ent-1',
      incumbentState: null,
      nativeState: null,
    });
    expect(verdict.kind).toBe('agreement');
  });

  it('builds deterministic reasons (same inputs, same sentence)', () => {
    const mismatches = [{ path: 'stage', expected: 'a', actual: 'b' }];
    const first = buildDivergenceReason('ent-1', mismatches, [], []);
    const second = buildDivergenceReason('ent-1', mismatches, [], []);
    expect(first).toBe(second);
    expect(buildIncumbentMissingReason('ent-9')).toBe(
      "entity 'ent-9' holds a native Aurum state the incumbent never imported (a native-only entity)",
    );
  });
});

// ---------------------------------------------------------------------------
// detectSchemaHintIssues — the transform's kit schema-hint check
// ---------------------------------------------------------------------------

const LEDGER_HINTS = [
  {
    entity: 'ledger-account',
    fields: [
      { name: 'accountCode', type: 'string', required: true },
      { name: 'name', type: 'string', required: true },
      { name: 'active', type: 'boolean', required: true },
      { name: 'openedOn', type: 'date', required: false },
    ],
  },
];

describe('detectSchemaHintIssues (the W092 schema-hint check)', () => {
  it('passes a conforming payload with no issues', () => {
    const issues = detectSchemaHintIssues(
      { accountCode: '1000', name: 'Cash', active: true, openedOn: '2026-01-05' },
      'ledger-account',
      LEDGER_HINTS,
    );
    expect(issues).toEqual([]);
  });

  it('surfaces a missing required field (never drops the record)', () => {
    const issues = detectSchemaHintIssues({ name: 'Cash', active: true }, 'ledger-account', LEDGER_HINTS);
    expect(issues.map((issue) => issue.code)).toEqual(['schema-hint-required-field-missing']);
    expect(issues[0]!.field).toBe('accountCode');
  });

  it('surfaces a null required field', () => {
    const issues = detectSchemaHintIssues(
      { accountCode: null, name: 'Cash', active: true },
      'ledger-account',
      LEDGER_HINTS,
    );
    expect(issues.map((issue) => issue.code)).toEqual(['schema-hint-required-field-null']);
  });

  it('surfaces type mismatches (string vs number, boolean vs string, bad date)', () => {
    const issues = detectSchemaHintIssues(
      { accountCode: 1000, name: 'Cash', active: 'yes', openedOn: 'not-a-date' },
      'ledger-account',
      LEDGER_HINTS,
    );
    expect(issues.map((issue) => issue.code).sort()).toEqual([
      'schema-hint-type-mismatch',
      'schema-hint-type-mismatch',
      'schema-hint-type-mismatch',
    ]);
  });

  it('surfaces an unrecognized hint type instead of guessing', () => {
    const issues = detectSchemaHintIssues(
      { code: 'X', blob: {} },
      'odd-entity',
      [{ entity: 'odd-entity', fields: [{ name: 'blob', type: 'weird-type', required: true }] }],
    );
    expect(issues.map((issue) => issue.code)).toEqual(['schema-hint-type-unrecognized']);
  });

  it('checks nothing when the entity is unhinted or the record has no entity type', () => {
    expect(detectSchemaHintIssues({ anything: 1 }, 'unheard-of', LEDGER_HINTS)).toEqual([]);
    expect(detectSchemaHintIssues({ anything: 1 }, null, LEDGER_HINTS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Validation + canonicalization guards
// ---------------------------------------------------------------------------

describe('validation guards', () => {
  it('guards the vocabularies', () => {
    expect(isMigrationStatus('dual-running')).toBe(true);
    expect(isMigrationStatus('dualrun')).toBe(false);
    expect(isImportRoundKind('delta')).toBe(true);
    expect(isImportRoundKind('weekly')).toBe(false);
  });

  it('rejects unknown keys on inputs (the house pattern)', () => {
    expect(() =>
      validateCreateMigrationInput({
        incumbentSystemId: '0b7f7f7e-0000-4000-8000-000000000001',
        incumbentConnectionId: '0b7f7f7e-0000-4000-8000-000000000002',
        incumbentReadCapabilityKey: 'read.customer-records',
        sneaky: 'no',
      }),
    ).toThrowError(MigrationError);
  });

  it('validates the kit binding shape', () => {
    const valid = validateCreateMigrationInput({
      incumbentSystemId: '0b7f7f7e-0000-4000-8000-000000000001',
      incumbentConnectionId: '0b7f7f7e-0000-4000-8000-000000000002',
      incumbentReadCapabilityKey: 'read.customer-records',
      kitBinding: {
        installationId: '0b7f7f7e-0000-4000-8000-000000000003',
        integrationKey: 'ledger-erp-sor',
      },
    });
    expect(valid.kitIntegrationKey).toBe('ledger-erp-sor');
    expect(() =>
      validateCreateMigrationInput({
        incumbentSystemId: '0b7f7f7e-0000-4000-8000-000000000001',
        incumbentConnectionId: '0b7f7f7e-0000-4000-8000-000000000002',
        incumbentReadCapabilityKey: 'read.customer-records',
        kitBinding: { installationId: 'not-a-uuid', integrationKey: 'x' },
      }),
    ).toThrowError(MigrationError);
  });

  it('validates the external-id resolution query', () => {
    const valid = validateResolveExternalIdQuery({
      sourceSystemKey: 'src_1:ext-9',
      externalId: 'C-100',
    });
    expect(valid.externalId).toBe('C-100');
    expect(() => validateResolveExternalIdQuery({ sourceSystemKey: '', externalId: 'x' })).toThrowError(
      MigrationError,
    );
  });
});

describe('canonicalizeIncumbentRecord (provider objects never cross)', () => {
  it('accepts a canonical live record and normalizes the tombstone flag', () => {
    const record = canonicalizeIncumbentRecord(
      { externalId: 'C-100', matchKey: 'cust-100', entityType: 'customer', payload: { a: 1 }, deletedAt: null },
      1,
    );
    expect(record).toEqual({
      externalId: 'C-100',
      matchKey: 'cust-100',
      entityType: 'customer',
      payload: { a: 1 },
      tombstone: false,
    });
    const tombstone = canonicalizeIncumbentRecord(
      { externalId: 'C-100', matchKey: null, entityType: null, payload: null, deletedAt: '2026-09-01T00:00:00Z' },
      2,
    );
    expect(tombstone.tombstone).toBe(true);
    expect(tombstone.payload).toBeNull();
  });

  it('rejects a provider object payload loudly (non-plain or non-serializable)', () => {
    // A provider-native object AS the payload (a Date instance — not a
    // plain JSON object).
    expect(() =>
      canonicalizeIncumbentRecord(
        { externalId: 'C-100', payload: new Date(), deletedAt: null },
        1,
      ),
    ).toThrowError(MigrationError);
    // A circular value inside the payload (JSON.stringify throws).
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      canonicalizeIncumbentRecord(
        { externalId: 'C-100', payload: circular, deletedAt: null },
        1,
      ),
    ).toThrowError(MigrationError);
    // A BigInt value (JSON.stringify throws).
    expect(() =>
      canonicalizeIncumbentRecord(
        { externalId: 'C-100', payload: { n: 10n }, deletedAt: null },
        1,
      ),
    ).toThrowError(MigrationError);
  });

  it('rejects a tombstone with a payload, a live record without one, and a bad deletedAt', () => {
    expect(() =>
      canonicalizeIncumbentRecord(
        { externalId: 'C-1', payload: { a: 1 }, deletedAt: '2026-09-01T00:00:00Z' },
        1,
      ),
    ).toThrowError(MigrationError);
    expect(() => canonicalizeIncumbentRecord({ externalId: 'C-1', payload: null, deletedAt: null }, 1)).toThrowError(
      MigrationError,
    );
    expect(() =>
      canonicalizeIncumbentRecord(
        { externalId: 'C-1', payload: { a: 1 }, deletedAt: 'yesterday' },
        1,
      ),
    ).toThrowError(MigrationError);
  });

  it('rejects unknown record keys and non-object records', () => {
    expect(() =>
      canonicalizeIncumbentRecord(
        { externalId: 'C-1', payload: {}, deletedAt: null, extra: 1 },
        1,
      ),
    ).toThrowError(MigrationError);
    expect(() => canonicalizeIncumbentRecord('nope', 1)).toThrowError(MigrationError);
  });
});

describe('canonicalizeSnapshotResult + canonicalizeNativeStates', () => {
  it('canonicalizes a snapshot with its records', () => {
    const result = canonicalizeSnapshotResult(
      { snapshotRef: 'fixsnap-3', records: [{ externalId: 'C-1', payload: {}, deletedAt: null }] },
      'reader',
    );
    expect(result.snapshotRef).toBe('fixsnap-3');
    expect(result.records).toHaveLength(1);
  });

  it('rejects an oversized snapshot with the honest cap error', () => {
    const records = Array.from({ length: 5001 }, (_, index) => ({
      externalId: `C-${index}`,
      payload: {},
      deletedAt: null,
    }));
    expect(() => canonicalizeSnapshotResult({ snapshotRef: 'r', records }, 'reader')).toThrowError(
      MigrationError,
    );
    try {
      canonicalizeSnapshotResult({ snapshotRef: 'r', records }, 'reader');
    } catch (error) {
      expect((error as MigrationError).code).toBe('snapshot_too_large');
    }
  });

  it('rejects duplicate native entity states (a malformed answer)', () => {
    expect(() =>
      canonicalizeNativeStates(
        {
          states: [
            { aurumEntityId: 'ent-1', state: {} },
            { aurumEntityId: 'ent-1', state: {} },
          ],
        },
        'native reader',
      ),
    ).toThrowError(MigrationError);
  });
});

// ---------------------------------------------------------------------------
// The deterministic incumbent double
// ---------------------------------------------------------------------------

describe('FixtureIncumbent (versioned snapshots, churn, tombstones)', () => {
  function baseIncumbent(): FixtureIncumbent {
    return new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'cust-1', entityType: 'customer', payload: { stage: 'active', seats: 10 } },
      { externalId: 'C-2', matchKey: 'cust-2', entityType: 'customer', payload: { stage: 'onboarding' } },
      { externalId: 'C-3', matchKey: 'cust-3', entityType: 'customer', payload: { stage: 'active', seats: 3 } },
    ]);
  }

  it('a full read returns everything under the current version reference', async () => {
    const incumbent = baseIncumbent();
    const result = await incumbent.readSnapshot({
      connectionId: 'conn-1',
      credentialRef: 'embedded-connection:emb-1',
      systemKey: 'src_1:crm',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: null,
      idempotencyKey: 'migration:r1',
    });
    expect(result.snapshotRef).toBe('fixsnap-0');
    expect(result.records.map((record) => record.externalId)).toEqual(['C-1', 'C-2', 'C-3']);
    // The credentialRef passed through opaquely (recorded, never interpreted).
    expect(incumbent.requests[0]!.credentialRef).toBe('embedded-connection:emb-1');
  });

  it('churn commits a new version and a delta read returns exactly the changes', async () => {
    const incumbent = baseIncumbent();
    incumbent.churn({
      upserts: [
        { externalId: 'C-2', matchKey: 'cust-2', entityType: 'customer', payload: { stage: 'active' } },
        { externalId: 'C-4', matchKey: 'cust-4', entityType: 'customer', payload: { stage: 'onboarding' } },
      ],
      deletions: ['C-3'],
      deletedAt: '2026-09-24T12:00:00Z',
    });
    const delta = await incumbent.readSnapshot({
      connectionId: 'conn-1',
      credentialRef: 'ref',
      systemKey: 'src_1:crm',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: 'fixsnap-0',
      idempotencyKey: 'migration:r2',
    });
    expect(delta.snapshotRef).toBe('fixsnap-1');
    const byId = new Map(delta.records.map((record) => [record.externalId, record]));
    expect(byId.get('C-2')!.payload).toEqual({ stage: 'active' });
    expect(byId.get('C-4')!.payload).toEqual({ stage: 'onboarding' });
    // The tombstone carries its deletion timestamp and no payload (the
    // canonical IncumbentRecord shape the reader answers with).
    expect(byId.get('C-3')!.deletedAt).toBe('2026-09-24T12:00:00Z');
    expect(byId.get('C-3')!.payload).toBeNull();
    expect(byId.has('C-1')).toBe(false);
  });

  it('a delta with no churn is empty and the reference stands still', async () => {
    const incumbent = baseIncumbent();
    const first = await incumbent.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'k',
      sinceSnapshotRef: null,
      idempotencyKey: 'i',
    });
    const second = await incumbent.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'k',
      sinceSnapshotRef: first.snapshotRef,
      idempotencyKey: 'i2',
    });
    expect(second.records).toEqual([]);
    expect(second.snapshotRef).toBe(first.snapshotRef);
  });

  it('rejects an unknown snapshot reference loudly (never guesses)', async () => {
    const incumbent = baseIncumbent();
    await expect(
      incumbent.readSnapshot({
        connectionId: 'c',
        credentialRef: 'r',
        systemKey: 's',
        readCapabilityKey: 'k',
        sinceSnapshotRef: 'fixsnap-99',
        idempotencyKey: 'i',
      }),
    ).rejects.toThrowError(MigrationError);
  });
});

describe('FixtureNativeStore (the native-state double)', () => {
  it('mirrors the incumbent through a map with seeded divergences', async () => {
    const incumbent = new FixtureIncumbent([
      { externalId: 'C-1', matchKey: 'cust-1', entityType: null, payload: { stage: 'active', seats: 10 } },
      { externalId: 'C-2', matchKey: 'cust-2', entityType: null, payload: { stage: 'onboarding' } },
    ]);
    const native = new FixtureNativeStore();
    native.mirror(
      incumbent,
      [
        { externalId: 'C-1', aurumEntityId: 'ent-1' },
        { externalId: 'C-2', aurumEntityId: 'ent-2' },
      ],
      [{ externalId: 'C-2', override: { stage: 'active' }, remove: [] }],
    );
    const result = await native.readNativeStates({ entityIds: null });
    expect(result.states).toEqual([
      { aurumEntityId: 'ent-1', state: { stage: 'active', seats: 10 } },
      { aurumEntityId: 'ent-2', state: { stage: 'active' } },
    ]);
    // A filtered read answers exactly the asked entities.
    const filtered = await native.readNativeStates({ entityIds: ['ent-2'] });
    expect(filtered.states).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The W084 reconciliation reuse (one comparison semantics, no fork)
// ---------------------------------------------------------------------------

describe('the W084 reconciliation reuse', () => {
  it('jsonDeepEqual arrives through the deep-actions contract unchanged', () => {
    expect(jsonDeepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
  });
});
