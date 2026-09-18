// Unit tests for the briefings module's pure logic (no database): the
// vocabulary guards, the built-in policy floor and the kind → default →
// built-in resolution, the window computation (continuity + clamping),
// the honest bounding, the deterministic headline/body composition, the
// delivery-handoff key stability, and the input validation/normalization
// (including the delivery-recipient coherence rule).
//
// W032 acceptance covered here (pure halves):
//  * policy-controlled: the built-in floor, the precedence resolution,
//    and the default-row-only delivery configuration;
//  * proactive windows: continuous default coverage, never empty, never
//    beyond the maximum span;
//  * bounded derived text: headline/body/excerpt always within the
//    notifications contract's subject/body limits;
//  * honest truncation: the candidate count survives the item cap.

import { describe, expect, it } from 'vitest';
import {
  BRIEFING_NOTIFICATION_KIND,
  BRIEFING_SECTION_KINDS,
  BRIEFING_TRIGGER_KINDS,
  BRIEFINGS_AUTHORITY_ADMINISTER,
  BUILT_IN_DEFAULT_POLICY,
  MAX_BODY_LENGTH,
  MAX_BRIEFING_WINDOW_SECONDS,
  MAX_HEADLINE_LENGTH,
  SECTION_LABELS,
  briefingNotificationDedupeKey,
  briefingWindowFrom,
  boundCandidates,
  builtInDefaultPolicy,
  composeBriefingBody,
  composeBriefingHeadline,
  excerptText,
  isBriefingSectionKind,
  isBriefingTriggerKind,
  recipientLabel,
  resolveBriefingPolicySnapshot,
  resolveSectionPolicySnapshot,
} from '../policy';
import type { BriefingItem, BriefingPolicy } from '../types';
import {
  assertBriefingsTenantContext,
  canAdministerBriefingPolicies,
  isUuid,
  validateGenerateBriefingInput,
  validateGetBriefingQuery,
  validateListBriefingsQuery,
  validatePolicySubjectQuery,
  validateResolvePolicyQuery,
  validateSetBriefingPolicyInput,
} from '../validation';
import { BriefingsError } from '../errors';
import * as briefingsContract from '../contract';

function expectCode(code: BriefingsError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected BriefingsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(BriefingsError);
    expect((error as BriefingsError).code).toBe(code);
  }
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const GOOD_CONTEXT = {
  tenantId: TENANT,
  principalId: '22222222-2222-4222-8222-222222222222',
  authority: [] as string[],
};

// The notifications module's dedupe-key pattern (migrations/002, W031) —
// the handoff keys must be legal against it.
const NOTIFICATIONS_DEDUPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/;

function policyRow(overrides: Partial<BriefingPolicy> = {}): BriefingPolicy {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    tenantId: TENANT,
    sectionKind: null,
    enabled: true,
    maxItems: 20,
    windowSeconds: 86_400,
    deliveryRecipient: null,
    note: null,
    createdAt: '2026-09-14T08:00:00Z',
    updatedAt: '2026-09-14T08:00:00Z',
    ...overrides,
  };
}

function item(summary: string): BriefingItem {
  return {
    summary,
    refs: [{ module: 'events', kind: 'event', id: TENANT }],
    detail: {
      section: 'changes',
      type: 'test.event',
      typeVersion: 1,
      occurredAt: '2026-09-14T07:00:00Z',
      recordedAt: '2026-09-14T07:00:01Z',
      sequence: 1,
      actor: { kind: 'system', label: 'test' },
    },
  };
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

describe('section-kind vocabulary', () => {
  it('carries exactly the W032 section list, in canonical order', () => {
    expect([...BRIEFING_SECTION_KINDS]).toEqual([
      'changes',
      'goal-drift',
      'unknowns',
      'risks',
      'opportunities',
      'capability-gaps',
      'workforce-performance',
      'approvals',
    ]);
  });

  it('guards membership', () => {
    expect(isBriefingSectionKind('changes')).toBe(true);
    expect(isBriefingSectionKind('automation')).toBe(false); // W018's, not W032's
    expect(isBriefingSectionKind(42)).toBe(false);
    expect(isBriefingTriggerKind('scheduled')).toBe(true);
    expect(isBriefingTriggerKind('nightly')).toBe(false);
    expect([...BRIEFING_TRIGGER_KINDS]).toEqual(['on_demand', 'scheduled', 'system']);
  });

  it('labels every section kind', () => {
    for (const kind of BRIEFING_SECTION_KINDS) {
      expect(SECTION_LABELS[kind].length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The built-in floor + resolution
// ---------------------------------------------------------------------------

describe('the built-in default policy', () => {
  it('is the deterministic floor: all sections on, 20 items, 24h window, no push', () => {
    expect(BUILT_IN_DEFAULT_POLICY).toEqual({
      enabled: true,
      maxItems: 20,
      windowSeconds: 86_400,
      deliveryRecipient: null,
    });
  });

  it('hands out fresh copies (no shared mutable state)', () => {
    const first = builtInDefaultPolicy();
    const second = builtInDefaultPolicy();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.deliveryRecipient).toBeNull();
  });
});

describe('policy resolution (kind row → default row → built-in)', () => {
  it('briefing level: the default row wins when present, else the floor', () => {
    const floor = resolveBriefingPolicySnapshot(null);
    expect(floor).toMatchObject({
      source: 'built-in',
      policy: null,
      enabled: true,
      maxItems: 20,
      windowSeconds: 86_400,
      deliveryRecipient: null,
    });
    const row = policyRow({
      enabled: false,
      maxItems: 5,
      windowSeconds: 3_600,
      deliveryRecipient: {
        provider: 'slack',
        providerAccountId: 'U777OPER',
        displayName: 'Ops',
      },
    });
    const resolved = resolveBriefingPolicySnapshot(row);
    expect(resolved).toMatchObject({
      source: 'tenant-default',
      policy: row,
      enabled: false,
      maxItems: 5,
      windowSeconds: 3_600,
    });
    expect(resolved.deliveryRecipient).toEqual({
      provider: 'slack',
      providerAccountId: 'U777OPER',
      displayName: 'Ops',
    });
  });

  it('section level: the kind row beats the default row beats the floor', () => {
    const kindRow = policyRow({ sectionKind: 'unknowns', maxItems: 7, windowSeconds: 600 });
    const defaultRow = policyRow({ maxItems: 9, windowSeconds: 1_200, enabled: false });
    expect(resolveSectionPolicySnapshot('unknowns', kindRow, defaultRow)).toMatchObject({
      sectionKind: 'unknowns',
      source: 'kind',
      enabled: true,
      maxItems: 7,
      windowSeconds: 600,
      policy: kindRow,
    });
    expect(resolveSectionPolicySnapshot('unknowns', null, defaultRow)).toMatchObject({
      source: 'tenant-default',
      enabled: false,
      maxItems: 9,
      windowSeconds: 1_200,
      policy: defaultRow,
    });
    expect(resolveSectionPolicySnapshot('unknowns', null, null)).toMatchObject({
      source: 'built-in',
      policy: null,
      enabled: true,
      maxItems: 20,
      windowSeconds: 86_400,
    });
  });

  it('resolution is total: every section kind resolves without rows', () => {
    for (const kind of BRIEFING_SECTION_KINDS) {
      const resolved = resolveSectionPolicySnapshot(kind, null, null);
      expect(resolved.sectionKind).toBe(kind);
      expect(resolved.maxItems).toBeGreaterThan(0);
      expect(resolved.windowSeconds).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Window computation (proactive continuity)
// ---------------------------------------------------------------------------

describe('briefingWindowFrom (the default coverage window)', () => {
  const to = new Date('2026-09-14T12:00:00Z');

  it('first briefing: windowTo − cadence window', () => {
    const from = briefingWindowFrom(null, to, 86_400);
    expect(from.toISOString()).toBe('2026-09-13T12:00:00.000Z');
  });

  it('follows the previous briefing continuously (no gaps, no overlaps)', () => {
    const from = briefingWindowFrom('2026-09-14T09:30:00Z', to, 86_400);
    expect(from.toISOString()).toBe('2026-09-14T09:30:00.000Z');
  });

  it('clamps to the maximum span when the last briefing is ancient', () => {
    const ancient = new Date(to.getTime() - (MAX_BRIEFING_WINDOW_SECONDS + 3_600) * 1_000);
    const from = briefingWindowFrom(ancient.toISOString(), to, 86_400);
    expect(to.getTime() - from.getTime()).toBe(MAX_BRIEFING_WINDOW_SECONDS * 1_000);
  });

  it('falls back to the cadence window on garbage or future last-window values', () => {
    expect(briefingWindowFrom('not-a-date', to, 3_600).toISOString()).toBe(
      '2026-09-14T11:00:00.000Z',
    );
    expect(briefingWindowFrom('2026-09-14T13:00:00Z', to, 3_600).toISOString()).toBe(
      '2026-09-14T11:00:00.000Z',
    );
    // A degenerate cadence still yields a non-empty window.
    expect(briefingWindowFrom(null, to, 0).getTime()).toBeLessThan(to.getTime());
  });
});

// ---------------------------------------------------------------------------
// Bounding (honest truncation)
// ---------------------------------------------------------------------------

describe('boundCandidates (the item cap)', () => {
  it('caps the items and retains the candidate count', () => {
    const candidates = Array.from({ length: 30 }, (_, index) => item(`item ${index}`));
    const bounded = boundCandidates(candidates, 10);
    expect(bounded.items).toHaveLength(10);
    expect(bounded.candidateCount).toBe(30);
    expect(bounded.items[0]!.summary).toBe('item 0');
  });

  it('never returns an empty cap (degenerate input defends itself)', () => {
    const bounded = boundCandidates([item('only')], 0);
    expect(bounded.items).toHaveLength(1);
    expect(bounded.candidateCount).toBe(1);
  });

  it('is a pure prefix slice — no candidate is reordered or dropped silently', () => {
    const candidates = [item('a'), item('b'), item('c')];
    const bounded = boundCandidates(candidates, 2);
    expect(bounded.items.map((entry) => entry.summary)).toEqual(['a', 'b']);
    expect(bounded.candidateCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Composition (deterministic, bounded)
// ---------------------------------------------------------------------------

describe('composeBriefingHeadline', () => {
  it('counts enabled sections and total items', () => {
    const headline = composeBriefingHeadline([
      { sectionKind: 'changes', enabled: true, itemCount: 3, candidateCount: 3, items: [] },
      { sectionKind: 'unknowns', enabled: false, itemCount: 0, candidateCount: 0, items: [] },
    ]);
    expect(headline).toBe('Briefing — 1/2 sections, 3 items');
  });

  it('stays within the notifications subject limit on huge inputs', () => {
    const sections = Array.from({ length: 64 }, () => ({
      sectionKind: 'changes' as const,
      enabled: true,
      itemCount: 2_000,
      candidateCount: 2_000,
      items: [],
    }));
    const headline = composeBriefingHeadline(sections);
    expect(headline).toBe('Briefing — 64/64 sections, 128000 items');
    expect(headline.length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH);
  });
});

describe('composeBriefingBody', () => {
  const windowTo = '2026-09-14T12:00:00Z';

  it('renders status lines, disabled sections, excerpts and truncation notes', () => {
    const body = composeBriefingBody(
      [
        {
          sectionKind: 'changes',
          enabled: true,
          itemCount: 2,
          candidateCount: 5,
          items: [{ summary: 'first change' }, { summary: 'second change' }],
        },
        {
          sectionKind: 'unknowns',
          enabled: false,
          itemCount: 0,
          candidateCount: 0,
          items: [],
        },
      ],
      windowTo,
    );
    const lines = body.split('\n');
    expect(lines[0]).toBe(`As of ${windowTo}`);
    expect(lines).toContain('Changes: 2 item(s) (of 5 found)');
    expect(lines).toContain('  - first change');
    expect(lines).toContain('  - second change');
    expect(lines).toContain('Unknowns: section disabled by policy');
  });

  it('is bounded to the notifications body limit', () => {
    const sections = Array.from({ length: 32 }, (_, index) => ({
      sectionKind: BRIEFING_SECTION_KINDS[index % BRIEFING_SECTION_KINDS.length]!,
      enabled: true,
      itemCount: 50,
      candidateCount: 50,
      items: Array.from({ length: 50 }, () => ({
        summary: 'x'.repeat(500),
      })),
    }));
    const body = composeBriefingBody(sections, windowTo);
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_LENGTH);
  });
});

describe('excerptText', () => {
  it('returns the source when it fits', () => {
    expect(excerptText('short', 10)).toBe('short');
  });

  it('cuts and marks longer sources', () => {
    const excerpt = excerptText('a'.repeat(50), 10);
    expect(excerpt.length).toBe(10);
    expect(excerpt.endsWith('…')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery-handoff vocabulary
// ---------------------------------------------------------------------------

describe('the delivery handoff keys', () => {
  it('uses a stable, notifications-legal kind and dedupe key', () => {
    expect(BRIEFING_NOTIFICATION_KIND).toBe('briefing');
    const key = briefingNotificationDedupeKey('44444444-4444-4444-8444-444444444444');
    expect(key).toBe('briefing:44444444-4444-4444-8444-444444444444');
    expect(NOTIFICATIONS_DEDUPE_PATTERN.test(key)).toBe(true);
    expect(briefingNotificationDedupeKey('x')).toBe(briefingNotificationDedupeKey('x'));
  });
});

describe('recipientLabel', () => {
  it('prefers the display name, falls back to the account id', () => {
    expect(recipientLabel({ provider: 'slack', providerAccountId: 'U1', displayName: 'Ops' })).toBe('Ops');
    expect(recipientLabel({ provider: 'slack', providerAccountId: 'U1' })).toBe('U1');
  });
});

// ---------------------------------------------------------------------------
// Validation + authority
// ---------------------------------------------------------------------------

describe('tenant context and authority claims', () => {
  it('rejects malformed contexts', () => {
    expectCode('invalid_context', () => assertBriefingsTenantContext({ ...GOOD_CONTEXT, tenantId: ' ' }));
    expectCode('invalid_context', () =>
      assertBriefingsTenantContext({ ...GOOD_CONTEXT, principalId: '' }),
    );
    expectCode('invalid_context', () =>
      assertBriefingsTenantContext({ ...GOOD_CONTEXT, authority: 'nope' as unknown as string[] }),
    );
    expect(() => assertBriefingsTenantContext(GOOD_CONTEXT)).not.toThrow();
  });

  it('policy administration needs the administer claim', () => {
    expect(canAdministerBriefingPolicies([])).toBe(false);
    expect(canAdministerBriefingPolicies(['briefings:administer'])).toBe(true);
    expect(BRIEFINGS_AUTHORITY_ADMINISTER).toBe('briefings:administer');
  });
});

describe('validateSetBriefingPolicyInput', () => {
  it('normalizes defaults and accepts the full shape', () => {
    const valid = validateSetBriefingPolicyInput({
      sectionKind: 'unknowns',
      enabled: false,
      maxItems: 5,
      windowSeconds: 600,
      note: 'tight',
    });
    expect(valid).toEqual({
      sectionKind: 'unknowns',
      enabled: false,
      maxItems: 5,
      windowSeconds: 600,
      deliveryRecipient: null,
      note: 'tight',
    });
  });

  it('default-row writes accept the delivery recipient', () => {
    const valid = validateSetBriefingPolicyInput({
      sectionKind: null,
      deliveryRecipient: { provider: 'email', providerAccountId: 'coo@corp.example' },
    });
    expect(valid.deliveryRecipient).toEqual({
      provider: 'email',
      providerAccountId: 'coo@corp.example',
      displayName: null,
    });
  });

  it('rejects a delivery recipient on a section-kind row (coherence)', () => {
    expectCode('invalid_policy_input', () =>
      validateSetBriefingPolicyInput({
        sectionKind: 'changes',
        deliveryRecipient: { provider: 'email', providerAccountId: 'coo@corp.example' },
      }),
    );
  });

  it('rejects unknown keys, bad kinds and out-of-bounds values', () => {
    expectCode('invalid_policy_input', () => validateSetBriefingPolicyInput({ unknown: true }));
    expectCode('invalid_policy_input', () => validateSetBriefingPolicyInput({ sectionKind: 'automation' }));
    expectCode('invalid_policy_input', () => validateSetBriefingPolicyInput({ maxItems: 51 }));
    expectCode('invalid_policy_input', () => validateSetBriefingPolicyInput({ maxItems: 0 }));
    expectCode('invalid_policy_input', () => validateSetBriefingPolicyInput({ windowSeconds: 59 }));
    expectCode('invalid_policy_input', () =>
      validateSetBriefingPolicyInput({ windowSeconds: 2_592_001 }),
    );
    expectCode('invalid_policy_input', () => validateSetBriefingPolicyInput({ enabled: 'yes' }));
    expectCode('invalid_policy_input', () =>
      validateSetBriefingPolicyInput({
        sectionKind: null,
        deliveryRecipient: { provider: 'fax', providerAccountId: 'x' },
      }),
    );
    expectCode('invalid_policy_input', () =>
      validateSetBriefingPolicyInput({
        sectionKind: null,
        deliveryRecipient: { provider: 'slack' },
      }),
    );
  });
});

describe('validateGenerateBriefingInput', () => {
  it('defaults the trigger and accepts explicit windows + keys', () => {
    const valid = validateGenerateBriefingInput({});
    expect(valid.trigger).toEqual({ kind: 'on_demand', label: null });
    expect(valid.windowFrom).toBeNull();
    expect(valid.windowTo).toBeNull();
    expect(valid.idempotencyKey).toBeNull();

    const explicit = validateGenerateBriefingInput({
      trigger: { kind: 'scheduled', label: 'nightly' },
      windowFrom: '2026-09-13T00:00:00Z',
      windowTo: '2026-09-14T00:00:00Z',
      idempotencyKey: 'worker-nightly-2026-09-14',
    });
    expect(explicit.trigger).toEqual({ kind: 'scheduled', label: 'nightly' });
    expect(explicit.windowFrom).toBe('2026-09-13T00:00:00Z');
    expect(explicit.idempotencyKey).toBe('worker-nightly-2026-09-14');
  });

  it('rejects bad triggers, non-ISO times, inverted/oversized windows, bad keys', () => {
    expectCode('invalid_briefing_input', () => validateGenerateBriefingInput({ trigger: { kind: 'nightly' } }));
    expectCode('invalid_briefing_input', () => validateGenerateBriefingInput({ trigger: { kind: 'system', label: 'x'.repeat(201) } }));
    expectCode('invalid_briefing_input', () => validateGenerateBriefingInput({ windowTo: '2026-09-14' }));
    expectCode('invalid_briefing_input', () =>
      validateGenerateBriefingInput({
        windowFrom: '2026-09-14T00:00:00Z',
        windowTo: '2026-09-13T00:00:00Z',
      }),
    );
    expectCode('invalid_briefing_input', () =>
      validateGenerateBriefingInput({
        windowFrom: '2026-06-01T00:00:00Z',
        windowTo: '2026-09-14T00:00:00Z', // > 90 days
      }),
    );
    expectCode('invalid_briefing_input', () => validateGenerateBriefingInput({ idempotencyKey: 'not legal!' }));
    expectCode('invalid_briefing_input', () => validateGenerateBriefingInput({ sections: ['changes'] }));
  });
});

describe('read + policy query validation', () => {
  it('getBriefing: uuid required', () => {
    expectCode('invalid_briefing_query', () => validateGetBriefingQuery({ briefingId: 'nope' }));
    expectCode('invalid_briefing_query', () => validateGetBriefingQuery({ extra: 1 }));
    const valid = validateGetBriefingQuery({ briefingId: '44444444-4444-4444-8444-444444444444' });
    expect(valid.briefingId).toBe('44444444-4444-4444-8444-444444444444');
  });

  it('listBriefings: trigger kind, ISO window bounds, limit', () => {
    const valid = validateListBriefingsQuery({});
    expect(valid.limit).toBe(50);
    expect(validateListBriefingsQuery({ limit: 500 }).limit).toBe(500);
    expectCode('invalid_briefing_query', () => validateListBriefingsQuery({ triggerKind: 'cron' }));
    expectCode('invalid_briefing_query', () => validateListBriefingsQuery({ windowFrom: 'yesterday' }));
    expectCode('invalid_briefing_query', () => validateListBriefingsQuery({ limit: 501 }));
  });

  it('policy subject + resolve queries', () => {
    expect(validatePolicySubjectQuery({}).sectionKind).toBeNull();
    expect(validatePolicySubjectQuery({ sectionKind: null }).sectionKind).toBeNull();
    expect(validatePolicySubjectQuery({ sectionKind: 'changes' }).sectionKind).toBe('changes');
    expectCode('invalid_policy_query', () => validatePolicySubjectQuery({ sectionKind: 'automation' }));
    expect(validateResolvePolicyQuery({ sectionKind: 'risks' }).sectionKind).toBe('risks');
    expectCode('invalid_policy_query', () => validateResolvePolicyQuery({ sectionKind: 'nope' }));
  });
});

describe('isUuid', () => {
  it('guards the uuid shape', () => {
    expect(isUuid('44444444-4444-4444-8444-444444444444')).toBe(true);
    expect(isUuid('44444444444444448444444444444444')).toBe(false);
    expect(isUuid('nope')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Contract surface pin
// ---------------------------------------------------------------------------

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', () => {
    // There is deliberately no updateBriefing, no regenerateBriefing, no
    // deleteBriefing and no setBriefingSection: briefings and their
    // sections are immutable history (triggers) — the only post-write
    // move is the one-way delivery link the service itself fills.
    // (Type-only exports are erased at runtime and do not appear here.)
    expect(Object.keys(briefingsContract).sort()).toEqual(
      [
        'BRIEFING_NOTIFICATION_KIND',
        'BRIEFING_SECTION_KINDS',
        'BRIEFING_TRIGGER_KINDS',
        'BRIEFINGS_AUTHORITY_ADMINISTER',
        'BODY_SECTION_EXCERPTS',
        'BUILT_IN_DEFAULT_POLICY',
        'BriefingsError',
        'DEFAULT_LIST_LIMIT',
        'EXCERPT_ELLIPSIS',
        'MAX_BODY_LENGTH',
        'MAX_BRIEFING_WINDOW_SECONDS',
        'MAX_DETAIL_CONSEQUENCE',
        'MAX_DETAIL_IDS',
        'MAX_DETAIL_TEXT',
        'MAX_DISPLAY_NAME_LENGTH',
        'MAX_HEADLINE_LENGTH',
        'MAX_IDEMPOTENCY_KEY_LENGTH',
        'MAX_ITEM_REFS',
        'MAX_LIST_LIMIT',
        'MAX_MAX_ITEMS',
        'MAX_NOTE_LENGTH',
        'MAX_PROVIDER_ACCOUNT_ID_LENGTH',
        'MAX_SECTION_ITEMS_BYTES',
        'MAX_SUMMARY_LENGTH',
        'MAX_TRIGGER_LABEL_LENGTH',
        'MAX_WINDOW_SECONDS',
        'MIN_MAX_ITEMS',
        'MIN_WINDOW_SECONDS',
        'SECTION_LABELS',
        'SECTION_SCAN_LIMITS',
        'assertBriefingsTenantContext',
        'boundCandidates',
        'briefingNotificationDedupeKey',
        'briefingWindowFrom',
        'builtInDefaultPolicy',
        'canAdministerBriefingPolicies',
        'compileSection',
        'composeBriefingBody',
        'composeBriefingHeadline',
        'excerptText',
        'generateBriefing',
        'getBriefing',
        'getBriefingPolicy',
        'isBriefingPolicySource',
        'isBriefingSectionKind',
        'isBriefingTriggerKind',
        'isUuid',
        'listBriefingPolicies',
        'listBriefings',
        'recipientLabel',
        'resolveBriefingPolicy',
        'resolveBriefingPolicySnapshot',
        'resolveSectionPolicySnapshot',
        'setBriefingPolicy',
      ].sort(),
    );
  });
});
