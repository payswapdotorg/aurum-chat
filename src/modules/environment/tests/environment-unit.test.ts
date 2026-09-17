// Unit tests for the environment module's PURE logic — validation,
// vocabularies, severity ranking, escalation-policy resolution and the
// staleness schedule (no database, no clock). The service-level behavior
// (tenancy, storage, cross-module wiring) is covered by
// environment-service.test.ts.

import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@/infra/tenant';
import { newId } from '@/infra/ids';
// The freshness module's pure classifier — imported only to pin the boundary
// convention the staleness schedule shares (strict >; no reimplementation).
import { classifyFreshness } from '@/modules/freshness/contract';
import type { WatchEscalationPolicy, WatchEscalationPolicyInput } from '../types';
import {
  isStaleEpisodeEscalated,
  resolveEscalationPolicy,
  severityMeetsFloor,
  severityRank,
  severitiesAtOrAbove,
  signalEscalationSummary,
  staleEscalationSummary,
  stalenessDue,
  stalenessSchedule,
} from '../escalation';
import { EnvironmentError } from '../errors';
import {
  assertEnvironmentTenantContext,
  ESCALATION_TRIGGERS,
  escapeLike,
  isEscalationTrigger,
  isUuid,
  isWatchEntryKind,
  isWatchEntryStatus,
  isWatchEntityKind,
  isWatchPartyKind,
  isWatchSeverity,
  isWatchlistStatus,
  validateAddWatchEntryInput,
  validateCreateWatchlistInput,
  validateEscalateStaleWatchesQuery,
  validateEvaluateWatchFreshnessQuery,
  validateListWatchEscalationsQuery,
  validateListWatchEntriesQuery,
  validateRecordSignalInput,
  validateSetWatchFreshnessPolicyInput,
  validateSetWatchEntryStatusInput,
  validateSetWatchlistStatusInput,
  validateUpdateWatchEntryInput,
  validateUpdateWatchlistInput,
  WATCH_ENTRY_KINDS,
  WATCH_ENTITY_KINDS,
  WATCH_ENTRY_STATUSES,
  WATCH_PARTY_KINDS,
  WATCH_SEVERITIES,
  WATCH_SUBJECT_KIND,
  WATCHLIST_STATUSES,
} from '../validation';

const UUID = () => newId();

function member(): TenantContext {
  return { tenantId: newId(), principalId: newId(), authority: [] };
}

/** A minimal valid escalation policy (the tests mutate one field at a time). */
function policyInput(): WatchEscalationPolicyInput {
  return {
    signalSeverityFloor: 'medium',
    staleGraceSeconds: 3600,
    staleSeverity: 'high',
    notifyParties: [{ kind: 'person', label: 'coo' }],
    proposeMission: true,
  };
}

function expectCode(code: string, fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof EnvironmentError) {
      expect(error.code).toBe(code);
      return;
    }
    throw new Error(`expected EnvironmentError('${code}'), got: ${String(error)}`, {
      cause: error,
    });
  }
  throw new Error(`expected EnvironmentError('${code}'), but nothing was thrown`);
}

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

describe('vocabularies (frozen, mirrored by storage CHECKs)', () => {
  it('pins the watch vocabularies', () => {
    expect(WATCHLIST_STATUSES).toEqual(['active', 'archived']);
    expect(WATCH_ENTRY_KINDS).toEqual(['entity', 'topic', 'geography']);
    expect(WATCH_ENTITY_KINDS).toEqual([
      'competitor',
      'regulator',
      'government_body',
      'supplier',
      'law',
      'technology',
      'market',
      'industry',
    ]);
    expect(WATCH_ENTRY_STATUSES).toEqual(['active', 'paused', 'archived']);
    expect(WATCH_SEVERITIES).toEqual(['low', 'medium', 'high', 'critical']);
    expect(ESCALATION_TRIGGERS).toEqual(['signal', 'stale']);
    expect(WATCH_PARTY_KINDS).toEqual(['person', 'team', 'agent', 'system', 'external']);
    // The freshness subject kind W006's namespace reserved for W014.
    expect(WATCH_SUBJECT_KIND).toBe('environment.watch');
  });

  it('guards accept exactly the vocabulary', () => {
    for (const status of WATCHLIST_STATUSES) expect(isWatchlistStatus(status)).toBe(true);
    expect(isWatchlistStatus('paused')).toBe(false);
    for (const kind of WATCH_ENTRY_KINDS) expect(isWatchEntryKind(kind)).toBe(true);
    expect(isWatchEntryKind('event')).toBe(false);
    for (const kind of WATCH_ENTITY_KINDS) expect(isWatchEntityKind(kind)).toBe(true);
    expect(isWatchEntityKind('customer')).toBe(false);
    for (const status of WATCH_ENTRY_STATUSES) expect(isWatchEntryStatus(status)).toBe(true);
    expect(isWatchEntryStatus('deleted')).toBe(false);
    for (const severity of WATCH_SEVERITIES) expect(isWatchSeverity(severity)).toBe(true);
    expect(isWatchSeverity('urgent')).toBe(false);
    for (const trigger of ESCALATION_TRIGGERS) expect(isEscalationTrigger(trigger)).toBe(true);
    expect(isEscalationTrigger('timeout')).toBe(false);
    for (const kind of WATCH_PARTY_KINDS) expect(isWatchPartyKind(kind)).toBe(true);
    expect(isWatchPartyKind('provider')).toBe(false);
  });

  it('isUuid recognizes uuid shape only', () => {
    expect(isUuid(UUID())).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });

  it('escapeLike escapes LIKE metacharacters', () => {
    expect(escapeLike('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });
});

describe('assertEnvironmentTenantContext', () => {
  it('accepts a well-formed context and rejects malformed ones', () => {
    expect(() => assertEnvironmentTenantContext(member())).not.toThrow();
    expectCode('invalid_context', () =>
      assertEnvironmentTenantContext({ tenantId: '', principalId: 'p', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertEnvironmentTenantContext({ tenantId: 't', principalId: ' ', authority: [] }),
    );
    expectCode('invalid_context', () =>
      assertEnvironmentTenantContext({ tenantId: 't', principalId: 'p', authority: 'admin' as never }),
    );
  });
});

// ---------------------------------------------------------------------------
// Escalation policy validation
// ---------------------------------------------------------------------------

describe('validateCreateWatchlistInput (escalation policy shape)', () => {
  it('accepts a full valid policy and normalizes nothing silently', () => {
    const valid = validateCreateWatchlistInput({
      name: 'EU Regulatory Watch',
      description: '  Everything regulatory that touches us.  ',
      escalationPolicy: policyInput(),
    });
    expect(valid.name).toBe('EU Regulatory Watch');
    expect(valid.description).toBe('Everything regulatory that touches us.');
    expect(valid.escalationPolicy.signalSeverityFloor).toBe('medium');
    expect(valid.escalationPolicy.staleGraceSeconds).toBe(3600);
    expect(valid.escalationPolicy.staleSeverity).toBe('high');
    expect(valid.escalationPolicy.proposeMission).toBe(true);
    expect(valid.escalationPolicy.notifyParties).toEqual([
      { kind: 'person', id: null, label: 'coo' },
    ]);
  });

  it('accepts a disarmed staleness arm (both fields null/omitted)', () => {
    const valid = validateCreateWatchlistInput({
      name: 'Soft watch',
      escalationPolicy: {
        signalSeverityFloor: 'low',
        staleGraceSeconds: null,
        staleSeverity: null,
        notifyParties: [{ kind: 'team', id: UUID() }],
        proposeMission: false,
      },
    });
    expect(valid.escalationPolicy.staleGraceSeconds).toBeNull();
    expect(valid.escalationPolicy.staleSeverity).toBeNull();
  });

  it('rejects unknown keys on the input and on the policy', () => {
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: policyInput(),
        id: UUID(),
      } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), extra: 1 },
      } as never),
    );
  });

  it('rejects a missing or malformed policy', () => {
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({ name: 'x' } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({ name: 'x', escalationPolicy: null } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), signalSeverityFloor: 'urgent' },
      } as never),
    );
  });

  it('rejects incoherent staleness arms (grace xor severity)', () => {
    // armed grace without a severity
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), staleSeverity: null },
      }),
    );
    // severity without a grace (inert configuration)
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), staleGraceSeconds: null },
      }),
    );
    // malformed severity
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), staleSeverity: 'meh' },
      } as never),
    );
  });

  it('rejects malformed grace seconds', () => {
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), staleGraceSeconds: 0 },
      }),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), staleGraceSeconds: 2_592_001 },
      }),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), staleGraceSeconds: 1.5 },
      }),
    );
  });

  it('rejects malformed notify parties', () => {
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), notifyParties: [] },
      }),
    );
    // a party with neither id nor label is untraceable
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), notifyParties: [{ kind: 'person' }] },
      }),
    );
    // bad kind / bad uuid / overlong label
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: {
          ...policyInput(),
          notifyParties: [{ kind: 'provider', label: 'x' }],
        },
      } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: {
          ...policyInput(),
          notifyParties: [{ kind: 'person', id: 'nope' }],
        },
      }),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: {
          ...policyInput(),
          notifyParties: [{ kind: 'person', label: 'x'.repeat(201) }],
        },
      }),
    );
    // > 8 parties
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: {
          ...policyInput(),
          notifyParties: Array.from({ length: 9 }, () => ({ kind: 'person', label: 'p' })),
        },
      }),
    );
  });

  it('rejects a malformed proposeMission / name / description', () => {
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        escalationPolicy: { ...policyInput(), proposeMission: 'yes' },
      } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({ name: '', escalationPolicy: policyInput() }),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({ name: 'x'.repeat(201), escalationPolicy: policyInput() }),
    );
    expectCode('invalid_watchlist_input', () =>
      validateCreateWatchlistInput({
        name: 'x',
        description: 'y'.repeat(2001),
        escalationPolicy: policyInput(),
      }),
    );
  });
});

describe('validateUpdateWatchlistInput', () => {
  it('requires at least one change', () => {
    expectCode('invalid_watchlist_input', () =>
      validateUpdateWatchlistInput({ watchlistId: UUID() }),
    );
  });

  it('rejects unknown keys and malformed ids', () => {
    expectCode('invalid_watchlist_input', () =>
      validateUpdateWatchlistInput({ watchlistId: UUID(), status: 'archived' } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateUpdateWatchlistInput({ watchlistId: 'nope', name: 'x' }),
    );
  });

  it('distinguishes absent from clearing (description) and carries full policies', () => {
    const keepDescription = validateUpdateWatchlistInput({ watchlistId: UUID(), name: 'n' });
    expect(keepDescription.setDescription).toBe(false);
    const clearDescription = validateUpdateWatchlistInput({
      watchlistId: UUID(),
      description: null,
    });
    expect(clearDescription.setDescription).toBe(true);
    expect(clearDescription.description).toBeNull();
    const replacePolicy = validateUpdateWatchlistInput({
      watchlistId: UUID(),
      escalationPolicy: policyInput(),
    });
    expect(replacePolicy.setEscalationPolicy).toBe(true);
  });
});

describe('validateSetWatchlistStatusInput / validateSetWatchEntryStatusInput', () => {
  it('validates status vocabulary and id shape', () => {
    expectCode('invalid_watchlist_input', () =>
      validateSetWatchlistStatusInput({ watchlistId: UUID(), status: 'paused' } as never),
    );
    expectCode('invalid_watchlist_input', () =>
      validateSetWatchlistStatusInput({ watchlistId: 'nope', status: 'archived' }),
    );
    expectCode('invalid_watch_entry_input', () =>
      validateSetWatchEntryStatusInput({ watchEntryId: UUID(), status: 'deleted' } as never),
    );
    expect(
      validateSetWatchEntryStatusInput({ watchEntryId: UUID(), status: 'paused' }).status,
    ).toBe('paused');
  });
});

// ---------------------------------------------------------------------------
// Watch entry validation
// ---------------------------------------------------------------------------

describe('validateAddWatchEntryInput', () => {
  it('accepts entity entries with their §12 entity kind and canonicalizes scopes', () => {
    const valid = validateAddWatchEntryInput({
      watchlistId: UUID(),
      kind: 'entity',
      entityKind: 'competitor',
      name: 'Acme Corp',
      geographies: ['EU', 'US', 'EU'],
      topics: ['pricing', 'ai-regulation'],
    });
    expect(valid.entityKind).toBe('competitor');
    // deduplicated + sorted canonical storage
    expect(valid.geographies).toEqual(['EU', 'US']);
    expect(valid.topics).toEqual(['ai-regulation', 'pricing']);
    expect(valid.escalationPolicy).toBeNull(); // inherits the watchlist default
  });

  it('accepts topic and geography entries without an entity kind', () => {
    const topic = validateAddWatchEntryInput({
      watchlistId: UUID(),
      kind: 'topic',
      name: 'AI regulation',
      geographies: ['EU'],
    });
    expect(topic.entityKind).toBeNull();
    const geography = validateAddWatchEntryInput({
      watchlistId: UUID(),
      kind: 'geography',
      name: 'European Union',
      topics: ['ai-regulation'],
    });
    expect(geography.entityKind).toBeNull();
    expect(geography.geographies).toEqual([]);
  });

  it('enforces identity coherence: entity requires entityKind, others forbid it', () => {
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({ watchlistId: UUID(), kind: 'entity', name: 'Acme' } as never),
    );
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'topic',
        entityKind: 'competitor',
        name: 'AI regulation',
      } as never),
    );
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'geography',
        name: 'EU',
        geographies: ['EU'],
      }),
    );
  });

  it('validates scope slugs and their count', () => {
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'topic',
        name: 't',
        geographies: ['not a slug!'],
      }),
    );
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'topic',
        name: 't',
        topics: Array.from({ length: 17 }, (_, i) => `topic-${i}`),
      }),
    );
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'topic',
        name: 't',
        geographies: 'EU' as never,
      }),
    );
  });

  it('validates the optional world binding and per-entry policy override', () => {
    const worldEntityId = UUID();
    const valid = validateAddWatchEntryInput({
      watchlistId: UUID(),
      kind: 'entity',
      entityKind: 'regulator',
      name: 'EBA',
      worldEntityId,
      escalationPolicy: policyInput(),
    });
    expect(valid.worldEntityId).toBe(worldEntityId);
    expect(valid.escalationPolicy?.signalSeverityFloor).toBe('medium');
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'entity',
        entityKind: 'regulator',
        name: 'EBA',
        worldEntityId: 'nope',
      }),
    );
    // a malformed override surfaces the ENTRY input code
    expectCode('invalid_watch_entry_input', () =>
      validateAddWatchEntryInput({
        watchlistId: UUID(),
        kind: 'topic',
        name: 't',
        escalationPolicy: { ...policyInput(), signalSeverityFloor: 'urgent' },
      } as never),
    );
  });
});

describe('validateUpdateWatchEntryInput', () => {
  it('rejects kind/entityKind — the watched subject is immutable identity', () => {
    expectCode('invalid_watch_entry_input', () =>
      validateUpdateWatchEntryInput({
        watchEntryId: UUID(),
        kind: 'topic',
        name: 'x',
      } as never),
    );
    expectCode('invalid_watch_entry_input', () =>
      validateUpdateWatchEntryInput({
        watchEntryId: UUID(),
        entityKind: 'competitor',
        name: 'x',
      } as never),
    );
  });

  it('requires at least one change and distinguishes clear from keep', () => {
    expectCode('invalid_watch_entry_input', () =>
      validateUpdateWatchEntryInput({ watchEntryId: UUID() }),
    );
    const clears = validateUpdateWatchEntryInput({
      watchEntryId: UUID(),
      worldEntityId: null,
      escalationPolicy: null,
    });
    expect(clears.setWorldEntityId).toBe(true);
    expect(clears.worldEntityId).toBeNull();
    expect(clears.setEscalationPolicy).toBe(true);
    expect(clears.escalationPolicy).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Signal + query validation
// ---------------------------------------------------------------------------

describe('validateRecordSignalInput', () => {
  it('accepts a minimal signal and validates severity/note/uuids', () => {
    const observationId = UUID();
    const valid = validateRecordSignalInput({
      watchEntryId: UUID(),
      observationId,
      severity: 'high',
    });
    expect(valid.observationId).toBe(observationId);
    expect(valid.note).toBeNull();
    expect(valid.originExecutionId).toBeNull();
    expectCode('invalid_signal_input', () =>
      validateRecordSignalInput({
        watchEntryId: UUID(),
        observationId,
        severity: 'urgent',
      } as never),
    );
    expectCode('invalid_signal_input', () =>
      validateRecordSignalInput({ watchEntryId: 'nope', observationId, severity: 'low' }),
    );
    expectCode('invalid_signal_input', () =>
      validateRecordSignalInput({
        watchEntryId: UUID(),
        observationId,
        severity: 'low',
        note: 'x'.repeat(2001),
      }),
    );
    expectCode('invalid_signal_input', () =>
      validateRecordSignalInput({
        watchEntryId: UUID(),
        observationId,
        severity: 'low',
        originExecutionId: 'nope',
      }),
    );
  });
});

describe('watch freshness policy + evaluation query validation', () => {
  it('validates seconds and the aging-below-stale rule', () => {
    const valid = validateSetWatchFreshnessPolicyInput({
      watchEntryId: UUID(),
      staleAfterSeconds: 600,
      agingAfterSeconds: 300,
    });
    expect(valid.staleAfterSeconds).toBe(600);
    expect(valid.agingAfterSeconds).toBe(300);
    expectCode('invalid_policy_input', () =>
      validateSetWatchFreshnessPolicyInput({ staleAfterSeconds: 0 }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetWatchFreshnessPolicyInput({
        staleAfterSeconds: 100,
        agingAfterSeconds: 100,
      }),
    );
    // the kind default (no entry id) is addressable
    expect(validateSetWatchFreshnessPolicyInput({ staleAfterSeconds: 60 }).watchEntryId).toBeNull();
  });

  it('validates the asOf instant of freshness evaluation', () => {
    const valid = validateEvaluateWatchFreshnessQuery({
      watchEntryId: UUID(),
      asOf: '2026-09-14T12:30:00Z',
    });
    expect(valid.asOf?.toISOString()).toBe('2026-09-14T12:30:00.000Z');
    expectCode('invalid_watch_query', () =>
      validateEvaluateWatchFreshnessQuery({
        watchEntryId: UUID(),
        asOf: '2026-09-14 12:30:00', // not strict ISO with offset
      }),
    );
  });
});

describe('list/pump query validation', () => {
  it('validates limits, vocabularies and scope filters', () => {
    expectCode('invalid_watch_query', () =>
      validateListWatchEntriesQuery({ limit: 0 } as never),
    );
    expectCode('invalid_watch_query', () =>
      validateListWatchEntriesQuery({ limit: 501 } as never),
    );
    expectCode('invalid_watch_query', () =>
      validateListWatchEntriesQuery({ geography: 'not a slug!' } as never),
    );
    expectCode('invalid_watch_query', () =>
      validateListWatchEntriesQuery({ status: 'deleted' } as never),
    );
    expect(validateListWatchEntriesQuery({ limit: 500 }).limit).toBe(500);

    expectCode('invalid_watch_query', () =>
      validateListWatchEscalationsQuery({ minSeverity: 'urgent' } as never),
    );
    expectCode('invalid_watch_query', () =>
      validateListWatchEscalationsQuery({ trigger: 'timeout' } as never),
    );

    expectCode('invalid_watch_query', () =>
      validateEscalateStaleWatchesQuery({ limit: 501 } as never),
    );
    expect(validateEscalateStaleWatchesQuery({}).limit).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Escalation logic (pure)
// ---------------------------------------------------------------------------

describe('severityRank / severityMeetsFloor / severitiesAtOrAbove', () => {
  it('orders low < medium < high < critical', () => {
    expect(severityRank('low')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });

  it('the signal floor is inclusive', () => {
    expect(severityMeetsFloor('low', 'low')).toBe(true);
    expect(severityMeetsFloor('medium', 'low')).toBe(true);
    expect(severityMeetsFloor('low', 'medium')).toBe(false);
    expect(severityMeetsFloor('critical', 'medium')).toBe(true);
  });

  it('severitiesAtOrAbove lists the ordered suffix', () => {
    expect(severitiesAtOrAbove('medium')).toEqual(['medium', 'high', 'critical']);
    expect(severitiesAtOrAbove('critical')).toEqual(['critical']);
  });
});

describe('resolveEscalationPolicy', () => {
  const entryPolicy: WatchEscalationPolicy = {
    signalSeverityFloor: 'critical',
    staleGraceSeconds: 3600,
    staleSeverity: 'high',
    notifyParties: [{ kind: 'person', id: null, label: 'coo' }],
    proposeMission: true,
  };
  const listPolicy: WatchEscalationPolicy = {
    signalSeverityFloor: 'medium',
    staleGraceSeconds: 3600,
    staleSeverity: 'high',
    notifyParties: [{ kind: 'person', id: null, label: 'coo' }],
    proposeMission: true,
  };

  it('the entry override wins and reports its source', () => {
    const resolved = resolveEscalationPolicy(entryPolicy, listPolicy)!;
    expect(resolved.source).toBe('entry');
    expect(resolved.policy.signalSeverityFloor).toBe('critical');
  });

  it('falls back to the watchlist default', () => {
    const resolved = resolveEscalationPolicy(null, listPolicy)!;
    expect(resolved.source).toBe('watchlist');
    expect(resolved.policy.signalSeverityFloor).toBe('medium');
  });

  it('is total: no policy anywhere resolves to null', () => {
    expect(resolveEscalationPolicy(null, null)).toBeNull();
  });
});

describe('stalenessSchedule / stalenessDue (boundary conventions)', () => {
  const OBSERVED = '2026-09-14T10:00:00Z';

  it('anchors the stale boundary at latestObservedAt + staleAfter', () => {
    const schedule = stalenessSchedule(OBSERVED, 600, 3600);
    expect(schedule.staleSince.toISOString()).toBe('2026-09-14T10:10:00.000Z');
    expect(schedule.escalateAt.toISOString()).toBe('2026-09-14T11:10:00.000Z');
  });

  it('due-ness is strict: AT the due instant the escalation is not yet due', () => {
    const schedule = stalenessSchedule(OBSERVED, 600, 3600);
    expect(stalenessDue('2026-09-14T11:09:59.999Z', schedule.escalateAt)).toBe(false);
    expect(stalenessDue('2026-09-14T11:10:00.000Z', schedule.escalateAt)).toBe(false);
    expect(stalenessDue('2026-09-14T11:10:00.001Z', schedule.escalateAt)).toBe(true);
  });

  it('is consistent with the freshness classifier boundary (strict >)', () => {
    // at exactly staleAfterSeconds of age the classifier says NOT stale;
    // one tick later it is stale — the schedule's staleSince is the same
    // boundary and the grace is measured from it.
    expect(classifyFreshness({ staleAfterSeconds: 600 }, 600)).toBe('current');
    expect(classifyFreshness({ staleAfterSeconds: 600 }, 600.001)).toBe('stale');
  });
});

describe('isStaleEpisodeEscalated (one escalation per staleness episode)', () => {
  const STALE_SINCE = '2026-09-14T10:10:00Z';

  it('no recorded escalation → not escalated', () => {
    expect(isStaleEpisodeEscalated(null, STALE_SINCE)).toBe(false);
  });

  it('an escalation recorded at/after the stale boundary belongs to this episode', () => {
    expect(isStaleEpisodeEscalated('2026-09-14T10:10:00.000Z', STALE_SINCE)).toBe(true);
    expect(isStaleEpisodeEscalated('2026-09-14T10:11:00.000Z', STALE_SINCE)).toBe(true);
  });

  it('an escalation recorded before the boundary belongs to an earlier episode', () => {
    // (it predates the newest evidence that anchored this episode)
    expect(isStaleEpisodeEscalated('2026-09-14T10:09:59.999Z', STALE_SINCE)).toBe(false);
  });
});

describe('escalation summaries (deterministic, reconstructable)', () => {
  it('stale summaries name the evidence, threshold and grace', () => {
    expect(staleEscalationSummary('2026-09-14T10:00:00Z', 600, 3600)).toBe(
      'watch evidence stale since 2026-09-14T10:00:00Z (stale after 600s, grace 3600s) with no fresher signal',
    );
  });

  it('signal summaries prefer the recorder note and generate otherwise', () => {
    expect(signalEscalationSummary('high', 'Competitor cut prices 20%', 'obs-1')).toBe(
      'Competitor cut prices 20%',
    );
    expect(signalEscalationSummary('high', null, 'obs-1')).toBe(
      "signal at severity 'high' (observation obs-1) met the escalation floor",
    );
  });
});
