// Unit tests for the integration-intelligence module's PURE logic (no
// database, no clock, no network): the capability-class registry, the
// directory-record classification, the deterministic why-it-matters
// generator and the ranking/scope-impact derivation — plus the input
// validation guards.
//
// The integration path (admin grant → discovery → recommendations → bulk
// approval → connection → verification, tenant isolation, the no-scan
// invariant) lives in integration-intelligence-service.test.ts.

import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_CLASSES,
  CAPABILITY_CLASS_KEYS,
  DATA_CATEGORIES,
  DATA_CATEGORY_KEYS,
  OUTCOME_DIMENSION_ORDER,
  capabilityClassOf,
  dataCategoryOf,
} from '../vocabulary';
import {
  DISCOVERY_RECORD_KIND,
  classifyDirectoryRecord,
  deriveCapabilitySurface,
  systemKeyOf,
} from '../discovery';
import {
  explainWhyItMatters,
  joinAnd,
  keywordMatchesToken,
  keywordsForSystem,
  textMatchesKeywords,
  tokenize,
} from '../explain';
import {
  SCORE_WEIGHTS,
  buildRecommendationDraft,
  scopeImpactOf,
  scoreRecommendation,
} from '../recommend';
import { IntegrationError } from '../errors';
import {
  validateGrantDiscoverySourceInput,
  validateRunDiscoveryInput,
  validateSubmitBatchInput,
} from '../validation';
import type { ExplanationOrgContext } from '../types';

const EMPTY_CONTEXT: ExplanationOrgContext = { goals: [], unknowns: [], gaps: [] };

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

describe('capability-class registry', () => {
  it('has unique keys and non-empty plain-language content', () => {
    const keys = new Set<string>();
    for (const entry of CAPABILITY_CLASSES) {
      expect(keys.has(entry.key)).toBe(false);
      keys.add(entry.key);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.connectionLead.length).toBeGreaterThan(0);
      expect(entry.keywords.length).toBeGreaterThan(0);
      expect(entry.readCapabilities.length).toBeGreaterThan(0);
      expect(entry.writeCapabilities.length).toBeGreaterThan(0);
      expect(entry.dataCategories.length).toBeGreaterThan(0);
      for (const outcome of entry.outcomes) {
        expect(OUTCOME_DIMENSION_ORDER).toContain(outcome.dimension);
        expect(outcome.text.length).toBeGreaterThan(10);
      }
    }
    expect(CAPABILITY_CLASS_KEYS.length).toEqual(CAPABILITY_CLASSES.length);
  });

  it('references only registered data categories', () => {
    for (const entry of CAPABILITY_CLASSES) {
      for (const category of entry.dataCategories) {
        expect(dataCategoryOf(category)).not.toBeNull();
      }
    }
    for (const category of DATA_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
      expect(category.keywords.length).toBeGreaterThan(0);
    }
    expect(DATA_CATEGORY_KEYS.length).toEqual(DATA_CATEGORIES.length);
  });

  it('never names a provider or vendor (lock 16 — plain language only)', () => {
    const providerWords = [
      'salesforce', 'hubspot', 'zendesk', 'jira', 'linear', 'confluence',
      'notion', 'github', 'google', 'stripe', 'quickbooks', 'zapier',
      'slack', 'microsoft', 'okta', 'oauth', 'api', 'rest', 'webhook',
    ];
    const haystack = JSON.stringify(CAPABILITY_CLASSES).toLowerCase();
    for (const word of providerWords) {
      expect(haystack).not.toContain(word);
    }
  });

  it('looks up classes and categories by key', () => {
    expect(capabilityClassOf('customer-records')?.label).toBe('Customer records');
    expect(capabilityClassOf('nope')).toBeNull();
    expect(dataCategoryOf('support-tickets')?.label).toBe('Support tickets');
    expect(dataCategoryOf('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Directory-record classification
// ---------------------------------------------------------------------------

describe('classifyDirectoryRecord', () => {
  const manifest = (overrides: Record<string, unknown> = {}) => ({
    externalId: 'app-001',
    displayName: 'Acme CRM',
    capabilityClasses: ['customer-records'],
    ...overrides,
  });

  it('classifies a canonical directory record', () => {
    const result = classifyDirectoryRecord({
      kind: DISCOVERY_RECORD_KIND,
      payload: manifest(),
    });
    expect(result).toEqual({
      externalId: 'app-001',
      displayName: 'Acme CRM',
      description: null,
      capabilityClasses: ['customer-records'],
      dataCategories: ['customer-contacts'],
      health: 'unknown',
    });
  });

  it('ignores records that are not directory system records', () => {
    expect(
      classifyDirectoryRecord({ kind: 'crm.opportunity.updated', payload: { x: 1 } }),
    ).toBeNull();
    expect(classifyDirectoryRecord({ kind: 'directory.member.listed', payload: {} })).toBeNull();
  });

  it('unions class-derived and manifest-declared data categories, sorted', () => {
    const result = classifyDirectoryRecord({
      kind: DISCOVERY_RECORD_KIND,
      payload: manifest({
        capabilityClasses: ['customer-records', 'support-desk'],
        dataCategories: ['payments'],
      }),
    });
    expect(result!.dataCategories).toEqual([
      'customer-contacts',
      'payments',
      'support-tickets',
    ]);
  });

  it('deduplicates repeated capability classes preserving order', () => {
    const result = classifyDirectoryRecord({
      kind: DISCOVERY_RECORD_KIND,
      payload: manifest({
        capabilityClasses: ['support-desk', 'customer-records', 'support-desk'],
      }),
    });
    expect(result!.capabilityClasses).toEqual(['support-desk', 'customer-records']);
  });

  it('rejects malformed payloads loudly (buggy-adapter discipline)', () => {
    const expectInvalid = (payload: unknown): void => {
      expect(() =>
        classifyDirectoryRecord({ kind: DISCOVERY_RECORD_KIND, payload }),
      ).toThrow(IntegrationError);
    };
    expectInvalid(null);
    expectInvalid('text');
    expectInvalid([]); // payload must be an object
    expectInvalid(manifest({ externalId: '' }));
    expectInvalid(manifest({ displayName: ' '.repeat(300) }));
    expectInvalid({ ...manifest(), extra: 'field' }); // unknown keys rejected
    expectInvalid(manifest({ capabilityClasses: [] })); // ≥ 1 required
    expectInvalid(manifest({ capabilityClasses: ['not-a-class'] }));
    expectInvalid(manifest({ capabilityClasses: 'customer-records' }));
    expectInvalid(manifest({ dataCategories: ['not-a-category'] }));
    expectInvalid(manifest({ health: 'broken' }));
  });

  it('accepts an explicit health statement and an optional description', () => {
    const result = classifyDirectoryRecord({
      kind: DISCOVERY_RECORD_KIND,
      payload: manifest({ description: 'The main CRM', health: 'degraded' }),
    });
    expect(result!.description).toBe('The main CRM');
    expect(result!.health).toBe('degraded');
  });
});

describe('deriveCapabilitySurface + systemKeyOf', () => {
  it('derives read + write-gated capabilities per class', () => {
    const surface = deriveCapabilitySurface(['customer-records', 'sales-pipeline']);
    expect(surface.map((capability) => capability.key)).toEqual([
      'read.customer-records',
      'write.customer-records',
      'read.sales-pipeline',
      'write.sales-pipeline',
    ]);
    const read = surface[0]!;
    expect(read.mode).toBe('read');
    expect(read.capabilityClass).toBe('customer-records');
    expect(read.dataCategories).toEqual(['customer-contacts']);
    const write = surface[1]!;
    expect(write.mode).toBe('write');
  });

  it('builds the canonical tenant-unique system key', () => {
    expect(systemKeyOf('src-1', 'app-9')).toBe('src-1:app-9');
  });
});

// ---------------------------------------------------------------------------
// Why-it-matters (deterministic, outcome-oriented, plain language)
// ---------------------------------------------------------------------------

describe('keyword matching primitives', () => {
  it('tokenizes on non-alphanumerics and lowercases', () => {
    expect(tokenize('Reduce customer-churn, Q4!')).toEqual([
      'reduce',
      'customer',
      'churn',
      'q4',
    ]);
  });

  it('matches equal tokens and ≥4-char plural prefixes only', () => {
    expect(keywordMatchesToken('customer', 'customer')).toBe(true);
    expect(keywordMatchesToken('customer', 'customers')).toBe(true); // plural
    expect(keywordMatchesToken('customer', 'customerbase')).toBe(true);
    expect(keywordMatchesToken('crm', 'crmpf')).toBe(false); // short keys never prefix
    expect(keywordMatchesToken('crm', 'crm')).toBe(true);
    expect(keywordMatchesToken('deal', 'ideal')).toBe(false); // prefix, not substring
  });

  it('matches a text when any keyword hits any token', () => {
    expect(textMatchesKeywords('Which customers are at risk of leaving?', ['customer'])).toBe(true);
    expect(textMatchesKeywords('Book more meetings', ['customer'])).toBe(false);
  });

  it('joins with and deterministically', () => {
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('collects the union of class + category keywords', () => {
    const keywords = keywordsForSystem(['customer-records'], ['customer-contacts', 'payments']);
    expect(keywords).toContain('customer');
    expect(keywords).toContain('churn');
    expect(keywords).toContain('payment');
  });
});

describe('explainWhyItMatters', () => {
  const system = {
    displayName: 'Acme CRM',
    capabilityClasses: ['customer-records', 'sales-pipeline'],
    dataCategories: ['customer-contacts', 'deals'],
  };

  it('falls back to capability-class basis with a plain-language summary', () => {
    const explanation = explainWhyItMatters(system, EMPTY_CONTEXT);
    expect(explanation.basis).toBe('capability-class');
    expect(explanation.groundedIn).toEqual({ goals: [], unknowns: [], gaps: [] });
    expect(explanation.summary).toBe(
      'Connecting Acme CRM would let Aurum see every customer and their history in one place and know which deals are at risk before they slip.',
    );
    // No dangling punctuation from quoted fragments involved here.
    expect(explanation.summary.endsWith('.')).toBe(true);
  });

  it('grounds in goals, unknowns and gaps when they match', () => {
    const context: ExplanationOrgContext = {
      goals: [{ id: 'g1', title: 'Reduce customer churn.', text: 'Keep the customers we have' }],
      unknowns: [
        { id: 'u1', question: 'Which customers are at risk of leaving?', text: 'Without it we react too late' },
      ],
      gaps: [{ capabilityId: 'c1', capabilityName: 'Customer success management' }],
    };
    const explanation = explainWhyItMatters(system, context);
    expect(explanation.basis).toBe('org-context');
    expect(explanation.summary).toBe(
      'Connecting Acme CRM would let Aurum see every customer and their history in one place and know which deals are at risk before they slip. ' +
        'This would help with your goal "Reduce customer churn". ' +
        'It could also help answer the open question "Which customers are at risk of leaving?". ' +
        'And it could help close the capability gap "Customer success management".',
    );
    expect(explanation.groundedIn.goals).toEqual([{ id: 'g1', title: 'Reduce customer churn.' }]);
    expect(explanation.groundedIn.unknowns).toEqual([
      { id: 'u1', question: 'Which customers are at risk of leaving?' },
    ]);
    expect(explanation.groundedIn.gaps).toEqual([
      { capabilityId: 'c1', capabilityName: 'Customer success management' },
    ]);
  });

  it('does not ground on unrelated org records', () => {
    const context: ExplanationOrgContext = {
      goals: [{ id: 'g1', title: 'Hire five engineers', text: 'Grow the platform team' }],
      unknowns: [{ id: 'u1', question: 'What is the office lease renewal date?', text: 'Finance needs it' }],
      gaps: [{ capabilityId: 'c1', capabilityName: 'Legal contract review' }],
    };
    const explanation = explainWhyItMatters(system, context);
    expect(explanation.basis).toBe('capability-class');
    expect(explanation.groundedIn.goals).toEqual([]);
  });

  it('caps cited grounding at three records per kind, in input order', () => {
    const context: ExplanationOrgContext = {
      goals: [
        { id: 'g1', title: 'Customer success', text: '' },
        { id: 'g2', title: 'Customer retention', text: '' },
        { id: 'g3', title: 'Customer support quality', text: '' },
        { id: 'g4', title: 'Customer expansion', text: '' },
      ],
      unknowns: [],
      gaps: [],
    };
    const explanation = explainWhyItMatters(system, context);
    expect(explanation.groundedIn.goals.map((goal) => goal.id)).toEqual(['g1', 'g2', 'g3']);
    // The summary cites only the first.
    expect(explanation.summary).toContain('"Customer success".');
    expect(explanation.summary).not.toContain('Customer expansion');
  });

  it('orders outcomes canonically by §10 dimension and dedupes', () => {
    const explanation = explainWhyItMatters(system, EMPTY_CONTEXT);
    const dimensions = explanation.outcomes.map((outcome) => outcome.dimension);
    // Canonical §10 order, stable regardless of class order.
    const rank = (dimension: string): number => OUTCOME_DIMENSION_ORDER.indexOf(dimension as never);
    expect([...dimensions].sort((a, b) => rank(a) - rank(b))).toEqual(dimensions);
    const identities = new Set(explanation.outcomes.map((outcome) => `${outcome.dimension}:${outcome.text}`));
    expect(identities.size).toBe(explanation.outcomes.length);
    // Outcome-oriented language across the five §10 dimensions.
    expect(new Set(dimensions)).toEqual(new Set(['quality', 'speed', 'cost', 'privacy', 'policy']));
  });

  it('is a pure function: identical inputs give identical outputs', () => {
    const context: ExplanationOrgContext = {
      goals: [{ id: 'g1', title: 'Grow revenue', text: '' }],
      unknowns: [],
      gaps: [],
    };
    expect(explainWhyItMatters(system, context)).toEqual(explainWhyItMatters(system, context));
  });
});

// ---------------------------------------------------------------------------
// Ranking + scope impact
// ---------------------------------------------------------------------------

describe('scoreRecommendation', () => {
  const system = {
    capabilityClasses: ['customer-records', 'sales-pipeline'],
    dataCategories: ['customer-contacts', 'deals'],
  };

  it('applies the documented deterministic formula', () => {
    const context: ExplanationOrgContext = {
      goals: [{ id: 'g1', title: 'Reduce customer churn', text: '' }],
      unknowns: [{ id: 'u1', question: 'Which deals will slip this quarter?', text: '' }],
      gaps: [{ capabilityId: 'c1', capabilityName: 'Sales forecasting' }],
    };
    // 1 goal + 1 unknown + 1 gap + 2 classes + 2 categories.
    expect(scoreRecommendation(system, context)).toBe(
      SCORE_WEIGHTS.groundedGoal * 1 +
        SCORE_WEIGHTS.groundedUnknown * 1 +
        SCORE_WEIGHTS.groundedGap * 1 +
        SCORE_WEIGHTS.capabilityClass * 2 +
        SCORE_WEIGHTS.dataCategory * 2,
    );
  });

  it('scores breadth alone without org context', () => {
    expect(scoreRecommendation(system, EMPTY_CONTEXT)).toBe(
      SCORE_WEIGHTS.capabilityClass * 2 + SCORE_WEIGHTS.dataCategory * 2,
    );
  });

  it('weigs goals above unknowns and gaps', () => {
    const goalOnly = scoreRecommendation(
      system,
      { goals: [{ id: 'g', title: 'Customer focus', text: '' }], unknowns: [], gaps: [] },
    );
    const unknownOnly = scoreRecommendation(
      system,
      { goals: [], unknowns: [{ id: 'u', question: 'Customer focus?', text: '' }], gaps: [] },
    );
    expect(goalOnly).toBeGreaterThan(unknownOnly);
  });
});

describe('scopeImpactOf', () => {
  it('is safe by default: read-only, with explicit read vs write-gated split', () => {
    const scope = scopeImpactOf({
      capabilityClasses: ['customer-records', 'support-desk'],
      dataCategories: ['customer-contacts', 'support-tickets'],
    });
    expect(scope.connectionMode).toBe('read-only');
    expect(scope.wouldRead.map((capability) => capability.key)).toEqual([
      'read.customer-records',
      'read.support-desk',
    ]);
    expect(scope.staysWriteGated.map((capability) => capability.key)).toEqual([
      'write.customer-records',
      'write.support-desk',
    ]);
    expect(scope.dataCategories).toEqual(['customer-contacts', 'support-tickets']);
    // Every read capability names its data categories (the scope statement).
    for (const capability of scope.wouldRead) {
      expect(capability.dataCategories.length).toBeGreaterThan(0);
    }
  });
});

describe('buildRecommendationDraft', () => {
  it('bundles the frozen explanation, scope and score', () => {
    const draft = buildRecommendationDraft(
      { displayName: 'Help Center', capabilityClasses: ['support-desk'], dataCategories: ['support-tickets'] },
      EMPTY_CONTEXT,
    );
    expect(draft.whyItMatters.basis).toBe('capability-class');
    expect(draft.scopeImpact.connectionMode).toBe('read-only');
    expect(draft.score).toBe(SCORE_WEIGHTS.capabilityClass * 1 + SCORE_WEIGHTS.dataCategory * 1);
  });
});

// ---------------------------------------------------------------------------
// Input validation guards (strict-unknown-key discipline)
// ---------------------------------------------------------------------------

describe('validation guards', () => {
  it('validates grant input strictly', () => {
    expect(() => validateGrantDiscoverySourceInput({ sourceId: 'not-a-uuid' })).toThrow(
      IntegrationError,
    );
    expect(() =>
      validateGrantDiscoverySourceInput({
        sourceId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
        extra: 1,
      } as unknown as Parameters<typeof validateGrantDiscoverySourceInput>[0]),
    ).toThrow(IntegrationError);
    expect(
      validateGrantDiscoverySourceInput({
        sourceId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
        note: 'workspace admin api',
      }),
    ).toEqual({
      sourceId: '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
      note: 'workspace admin api',
    });
  });

  it('validates the discovery input (maxRecords bounds, optional source)', () => {
    expect(validateRunDiscoveryInput({})).toEqual({ sourceId: null, maxRecords: 100 });
    expect(validateRunDiscoveryInput({ sourceId: null, maxRecords: 200 })).toEqual({
      sourceId: null,
      maxRecords: 200,
    });
    expect(() => validateRunDiscoveryInput({ maxRecords: 0 })).toThrow(IntegrationError);
    expect(() => validateRunDiscoveryInput({ maxRecords: 201 })).toThrow(IntegrationError);
    expect(() => validateRunDiscoveryInput({ sourceId: 'nope' })).toThrow(IntegrationError);
  });

  it('validates batch submission (1..100 unique uuids)', () => {
    const id = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';
    expect(() => validateSubmitBatchInput({ recommendationIds: [] })).toThrow(IntegrationError);
    expect(() => validateSubmitBatchInput({ recommendationIds: [id, id] })).toThrow(IntegrationError);
    expect(() =>
      validateSubmitBatchInput({ recommendationIds: new Array(101).fill(id) }),
    ).toThrow(IntegrationError);
    expect(validateSubmitBatchInput({ recommendationIds: [id] })).toEqual({
      recommendationIds: [id],
      justification: null,
    });
  });
});
