// Unit tests for the migration-continuity module's PURE surfaces (no
// database, no network — lock 10): the lifecycle state machine and its
// DERIVED authority rule, the canonical-JSON checksums the manifests
// rest on, the incumbent-record parse guards, and the W095 semantics
// reuse probe (the identity-mapping states are the unified-identity
// verification semantics, with the W094 `unverified-external` name for
// the never-auto-merged side).

import { describe, expect, it } from 'vitest';
import { UNIFIED_STATUSES } from '@/modules/unified-identity/contract';
import {
  IDENTITY_MAPPING_STATES,
  MIGRATION_CONFLICT_TAXONOMIES,
  parseConversationRecord,
  parsePersonRecord,
} from '../validation';
import {
  MIGRATION_STATES,
  MIGRATION_TRANSITIONS,
  INITIAL_MIGRATION_STATE,
  authorityForKind,
  availableMigrationTransitions,
  canTransitionMigration,
  isDualRunActive,
  isMigrationState,
  rollbackTargetOf,
} from '../lifecycle';
import { canonicalMigrationJson, checksumOf, isChecksum } from '../digest';

describe('W094 lifecycle — the pure state machine', () => {
  it('holds the five machine-readable lifecycle states', () => {
    expect(MIGRATION_STATES).toEqual([
      'staged',
      'imported',
      'dual-running',
      'retiring-incumbent',
      'retired',
    ]);
    expect(INITIAL_MIGRATION_STATE).toBe('staged');
    for (const state of MIGRATION_STATES) expect(isMigrationState(state)).toBe(true);
    expect(isMigrationState('importing')).toBe(false);
  });

  it('every forward transition is REVERSIBLE (rollback rides the same graph)', () => {
    const forward = MIGRATION_TRANSITIONS.filter((edge) => edge.kind === 'forward');
    const rollback = MIGRATION_TRANSITIONS.filter((edge) => edge.kind === 'rollback');
    expect(forward.length).toBe(4);
    expect(rollback.length).toBe(4);
    for (const edge of forward) {
      expect(canTransitionMigration(edge.from, edge.to)).toBe(true);
      // The reverse edge exists — the transition is reversible.
      expect(canTransitionMigration(edge.to, edge.from)).toBe(true);
    }
    // Illegal jumps do not exist.
    expect(canTransitionMigration('staged', 'dual-running')).toBe(false);
    expect(canTransitionMigration('staged', 'retired')).toBe(false);
    expect(canTransitionMigration('imported', 'retiring-incumbent')).toBe(false);
  });

  it('the rollback target of every state restores the previous authority surface', () => {
    expect(rollbackTargetOf('staged')).toBeNull();
    expect(rollbackTargetOf('imported')).toBe('staged');
    expect(rollbackTargetOf('dual-running')).toBe('imported');
    expect(rollbackTargetOf('retiring-incumbent')).toBe('dual-running');
    expect(rollbackTargetOf('retired')).toBe('retiring-incumbent');
  });

  it('dual-run activity is legal exactly in the two parallel-run states', () => {
    expect(isDualRunActive('staged')).toBe(false);
    expect(isDualRunActive('imported')).toBe(false);
    expect(isDualRunActive('dual-running')).toBe(true);
    expect(isDualRunActive('retiring-incumbent')).toBe(true);
    expect(isDualRunActive('retired')).toBe(false);
  });

  it('exposes the legal targets per state (the operation mapping)', () => {
    const fromStaged = availableMigrationTransitions('staged').map((edge) => edge.operation);
    expect(fromStaged).toEqual(['runImport']);
    const fromRetired = availableMigrationTransitions('retired').map((edge) => edge.operation);
    expect(fromRetired).toEqual(['rollbackMigration']);
  });
});

describe('W094 derived authority — the no-duplicate-authority invariant', () => {
  it('the INCUMBENT is the authority of record until a retirement window completes', () => {
    for (const state of ['staged', 'imported', 'dual-running', 'retiring-incumbent'] as const) {
      expect(authorityForKind({ state, latestWindowStatus: null })).toBe('incumbent');
      expect(authorityForKind({ state, latestWindowStatus: 'open' })).toBe('incumbent');
      expect(authorityForKind({ state, latestWindowStatus: 'rolled-back' })).toBe('incumbent');
    }
  });

  it('authority transfers to Aurum EXACTLY at the completed retirement window', () => {
    expect(authorityForKind({ state: 'retiring-incumbent', latestWindowStatus: 'retired' })).toBe(
      'aurum',
    );
    expect(authorityForKind({ state: 'retired', latestWindowStatus: 'retired' })).toBe('aurum');
    // The whole migration retired: Aurum holds every kind.
    expect(authorityForKind({ state: 'retired', latestWindowStatus: null })).toBe('aurum');
  });

  it('a rolled-back window restores incumbent authority (rollback re-opens)', () => {
    // retired -> rolled back re-open: the LATEST window rules.
    expect(authorityForKind({ state: 'retiring-incumbent', latestWindowStatus: 'rolled-back' })).toBe(
      'incumbent',
    );
  });
});

describe('W094 digest — canonical JSON + checksums (the manifest material)', () => {
  it('canonical JSON sorts keys recursively and stays stable', () => {
    expect(canonicalMigrationJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } })).toBe(
      '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}',
    );
    expect(canonicalMigrationJson(null)).toBe('null');
    expect(canonicalMigrationJson([1, { b: 2, a: 1 }])).toBe('[1,{"a":1,"b":2}]');
  });

  it('the checksum is a sha-256 hex digest over the canonical form', () => {
    const first = checksumOf({ records: [{ id: 'a', kind: 'x' }, { id: 'b', kind: 'y' }] });
    const second = checksumOf({ records: [{ kind: 'x', id: 'a' }, { kind: 'y', id: 'b' }] });
    expect(first).toBe(second); // object key order does not matter
    expect(checksumOf({ records: [{ id: 'a' }, { id: 'b' }] })).not.toBe(
      checksumOf({ records: [{ id: 'b' }, { id: 'a' }] }), // array order does
    );
    expect(isChecksum(first)).toBe(true);
    expect(isChecksum('not-a-checksum')).toBe(false);
    expect(checksumOf({ a: 1 })).not.toBe(checksumOf({ a: 2 }));
  });
});

describe('W094 record parsing — the ladder never guesses semantics', () => {
  it('a conversation record parses only with a CANONICAL channel and well-formed turns', () => {
    const valid = parseConversationRecord({
      incumbentId: 'C-1',
      channel: 'email',
      subject: 'Hello',
      turns: [
        {
          turnId: 'C-1#1',
          direction: 'inbound',
          actorLabel: 'Dana',
          sentAt: '2026-09-01T10:00:00Z',
          payload: { text: 'hi' },
        },
      ],
    });
    expect(valid).not.toBeNull();
    expect(valid!.channel).toBe('email');
    expect(valid!.turns).toHaveLength(1);

    // A channel outside the identity vocabulary never maps — raw evidence.
    expect(parseConversationRecord({
      incumbentId: 'C-2',
      channel: 'carrier-pigeon',
      turns: [{ turnId: 't', direction: 'inbound', sentAt: '2026-09-01T10:00:00Z', payload: {} }],
    })).toBeNull();
    // No turns / bad direction / bad clock: never mapped.
    expect(
      parseConversationRecord({ incumbentId: 'C-3', channel: 'email', turns: [] }),
    ).toBeNull();
    expect(
      parseConversationRecord({
        incumbentId: 'C-4',
        channel: 'email',
        turns: [{ turnId: 't', direction: 'sideways', sentAt: '2026-09-01T10:00:00Z', payload: {} }],
      }),
    ).toBeNull();
    expect(
      parseConversationRecord({
        incumbentId: 'C-5',
        channel: 'email',
        turns: [{ turnId: 't', direction: 'inbound', sentAt: 'not-a-date', payload: {} }],
      }),
    ).toBeNull();
  });

  it('a person record parses only with a full name', () => {
    const valid = parsePersonRecord({
      incumbentId: 'P-1',
      fullName: 'Dana Ruiz',
      email: 'dana@ruiz.example',
    });
    expect(valid).not.toBeNull();
    expect(valid!.fullName).toBe('Dana Ruiz');
    expect(parsePersonRecord({ incumbentId: 'P-2', fullName: '   ' })).toBeNull();
    expect(parsePersonRecord({ incumbentId: 'P-3', email: 'x@y.example' })).toBeNull();
  });
});

describe('W094 identifier preservation — the W095 semantics reuse', () => {
  it('the mapping states are the unified-identity verification semantics (W094 naming)', () => {
    // `verified` is the unified-identity state verbatim.
    expect(UNIFIED_STATUSES).toContain('verified');
    expect(IDENTITY_MAPPING_STATES).toContain('verified');
    // The unverified side keeps the W094 work order's explicit name —
    // `unverified-external` — the never-auto-merged state.
    expect(IDENTITY_MAPPING_STATES).toEqual(['verified', 'unverified-external']);
  });

  it('the conflict taxonomy is machine-readable and minimal', () => {
    expect(MIGRATION_CONFLICT_TAXONOMIES).toEqual([
      'concurrent-update',
      'delete-vs-update',
      'back-write-refused',
    ]);
  });
});
