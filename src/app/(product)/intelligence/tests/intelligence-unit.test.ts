// Unit tests for the intelligence workflow's pure logic (W061) — no DB,
// no DOM: the severity mapping (urgency legibility), the finding
// ordering, the family derivations (discovery candidates, trace
// findings, contradictions — each with why-this-matters and
// what-Aurum-needs-next), the briefing digest/card/answer composition,
// and the chat card link-label normalization the delivery relies on.

import { describe, expect, it } from 'vitest';
import {
  analysisFinding,
  contradictionFinding,
  discoveryFinding,
  findingChatCardKind,
  findingSeverity,
  percentLine,
  severityRank,
  sortFindings,
  urgencyLabel,
  urgencyTone,
} from '../lib/findings';
import type { ProactiveFinding } from '../lib/findings';
import {
  briefingAnswer,
  briefingProviderMessageId,
  findingCard,
  findingCitations,
  findingsDigest,
  renderBriefingText,
} from '../lib/briefing-chat';
import { normalizeChatCard } from '../../chat/lib/chat-types';

// ---------------------------------------------------------------------------
// Severity legibility
// ---------------------------------------------------------------------------

describe('severity legibility', () => {
  it('maps every urgency band to a tone + human label (never color alone)', () => {
    expect(urgencyTone('critical')).toBe('error');
    expect(urgencyTone('high')).toBe('warning');
    expect(urgencyTone('medium')).toBe('info');
    expect(urgencyTone('low')).toBe('neutral');
    expect(urgencyTone(null)).toBe('neutral');
    expect(urgencyLabel('critical')).toBe('Critical urgency');
    expect(urgencyLabel('high')).toBe('High urgency');
    expect(urgencyLabel(null)).toBe('Unbanded');
    expect(findingSeverity('high')).toEqual({
      urgency: 'high',
      tone: 'warning',
      label: 'High urgency',
    });
  });

  it('ranks critical first and unbanded last', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('low'));
    expect(severityRank('low')).toBeLessThan(severityRank(null));
  });

  it('sortFindings orders by severity band, then newest first within a band', () => {
    const finding = (id: string, urgency: string | null, at: string): ProactiveFinding =>
      ({
        id,
        kind: 'risk',
        source: 'analysis',
        title: id,
        whyThisMatters: 'why',
        whatNext: 'next',
        severity: findingSeverity(urgency as 'high' | null),
        impact: null,
        informationValue: null,
        missionId: null,
        detectedAt: at,
        href: '/intelligence',
        evidenceObservationIds: [],
        affectedGoalIds: [],
      }) as ProactiveFinding;
    const ordered = sortFindings([
      finding('low-old', 'low', '2026-01-01T00:00:00.000Z'),
      finding('high-new', 'high', '2026-03-01T00:00:00.000Z'),
      finding('high-old', 'high', '2026-02-01T00:00:00.000Z'),
      finding('critical', 'critical', '2026-01-15T00:00:00.000Z'),
      finding('unbanded', null, '2026-06-01T00:00:00.000Z'),
    ]);
    expect(ordered.map((f) => f.id)).toEqual([
      'critical',
      'high-new',
      'high-old',
      'low-old',
      'unbanded',
    ]);
  });

  it('percentLine renders scores or stays null', () => {
    expect(percentLine(0.62, 'Decision impact')).toBe('Decision impact 62%');
    expect(percentLine(null, 'x')).toBeNull();
    expect(percentLine(Number.NaN, 'x')).toBeNull();
  });

  it('maps finding kinds onto the chat card vocabulary', () => {
    expect(findingChatCardKind('unknown')).toBe('unknown');
    expect(findingChatCardKind('opportunity')).toBe('opportunity');
    expect(findingChatCardKind('risk')).toBe('risk');
    expect(findingChatCardKind('capability-gap')).toBe('risk');
    expect(findingChatCardKind('contradiction')).toBe('risk');
  });
});

// ---------------------------------------------------------------------------
// Family derivations — why + next always visible
// ---------------------------------------------------------------------------

const candidate = {
  id: 'candidate-1',
  runId: 'run-1',
  tenantId: 't1',
  gapKey: 'goal/1/metric',
  source: 'derived',
  gapKind: 'driver',
  affectedGoals: [{ goalId: 'goal-1', label: 'Freshness' }],
  missingKnowledge: 'What is driving the freshness shortfall?',
  consequence: 'Without the driver, the freshness goal cannot be steered.',
  decisionImpact: 0.55,
  urgency: 'high',
  currentConfidence: 0.3,
  requiredConfidence: 0.9,
  informationValue: 0.7,
  evidenceClaimIds: [],
  evidenceBeliefIds: [],
  acquisitionPaths: [],
  disposition: 'promoted',
  epistemicsUnknownId: 'unknown-1',
  missionId: 'mission-1',
  coveredByMissionId: null,
  recordedAt: '2026-10-05T09:00:00.000Z',
} as unknown as Parameters<typeof discoveryFinding>[0];

describe('family derivations', () => {
  it('a promoted discovery candidate carries why, next, severity and links', () => {
    const finding = discoveryFinding(candidate, candidate.recordedAt);
    expect(finding.kind).toBe('unknown');
    expect(finding.href).toBe('/intelligence/unknowns/unknown-1');
    expect(finding.whyThisMatters).toContain('freshness goal cannot be steered');
    expect(finding.whatNext).toContain('Close the confidence gap 30% → 90%');
    expect(finding.severity.label).toBe('High urgency');
    expect(finding.impact).toBe(0.55);
    expect(finding.missionId).toBe('mission-1');
    expect(finding.affectedGoalIds).toEqual(['goal-1']);
  });

  it('a candidate without a mission names the mission as the next step', () => {
    const finding = discoveryFinding(
      { ...candidate, missionId: null, epistemicsUnknownId: null },
      candidate.recordedAt,
    );
    expect(finding.missionId).toBeNull();
    expect(finding.whatNext).toContain('next step is a mission');
    expect(finding.href).toBe('/intelligence');
  });

  it('a trace finding links to the affected goal chain and carries its evidence', () => {
    const finding = analysisFinding({
      kind: 'risk',
      statement: 'Churn threatens the goal.',
      executionId: 'exec-1',
      detectedAt: '2026-10-06T10:00:00.000Z',
      evidenceObservationIds: ['obs-1', 'obs-2'],
      affectedGoalIds: ['goal-9'],
    });
    expect(finding.kind).toBe('risk');
    expect(finding.href).toBe('/intelligence/goals/goal-9');
    expect(finding.whyThisMatters).toContain('Churn threatens the goal');
    expect(finding.whatNext.length).toBeGreaterThan(0);
    expect(finding.evidenceObservationIds).toEqual(['obs-1', 'obs-2']);
  });

  it('an opportunity finding is constructive in what it needs next', () => {
    const finding = analysisFinding({
      kind: 'opportunity',
      statement: 'A courier lane would recover freshness points.',
      executionId: 'exec-2',
      detectedAt: '2026-10-06T10:00:00.000Z',
      evidenceObservationIds: [],
      affectedGoalIds: [],
    });
    expect(finding.kind).toBe('opportunity');
    expect(finding.whatNext).toContain('recommendation');
    expect(finding.href).toBe('/intelligence');
  });

  it('a contradiction is banded high and explains the retained conflict', () => {
    const finding = contradictionFinding({
      id: 'contra-1',
      tenantId: 't1',
      evidenceA: { kind: 'observation', id: 'obs-1' },
      evidenceB: { kind: 'claim', id: 'claim-1' },
      note: 'The export contradicts the report.',
      status: 'open',
      detectedAt: '2026-10-07T08:00:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
      resolutionNote: null,
    });
    expect(finding.kind).toBe('contradiction');
    expect(finding.severity.urgency).toBe('high');
    expect(finding.whyThisMatters).toContain('both are retained');
    expect(finding.whatNext).toContain('resolve the contradiction');
  });
});

// ---------------------------------------------------------------------------
// The briefing composition (digest, cards, answer, text)
// ---------------------------------------------------------------------------

const findingA: ProactiveFinding = {
  id: 'unknown-1',
  kind: 'unknown',
  source: 'discovery',
  title: 'What is driving the freshness shortfall?',
  whyThisMatters: 'Without the driver, the goal cannot be steered.',
  whatNext: 'Close the confidence gap 30% → 90% — the mission is underway.',
  severity: findingSeverity('high'),
  impact: 0.55,
  informationValue: 0.7,
  missionId: 'mission-1',
  detectedAt: '2026-10-05T09:00:00.000Z',
  href: '/intelligence/unknowns/unknown-1',
  evidenceObservationIds: ['obs-1', 'obs-2'],
  affectedGoalIds: ['goal-1'],
};

const findingB: ProactiveFinding = {
  ...findingA,
  id: 'exec-1',
  kind: 'risk',
  source: 'analysis',
  title: 'Churn threatens the goal.',
  missionId: null,
  evidenceObservationIds: ['obs-2', 'obs-3'],
  affectedGoalIds: ['goal-1'],
  href: '/intelligence/goals/goal-1',
};

describe('the briefing digest', () => {
  it('is stable for the same finding identities and changes with the set', () => {
    const one = findingsDigest([findingA, findingB]);
    expect(findingsDigest([findingA, findingB])).toBe(one);
    // Order does not matter (the same findings state).
    expect(findingsDigest([findingB, findingA])).toBe(one);
    // A different set is a different digest.
    expect(findingsDigest([findingA])).not.toBe(one);
    expect(findingsDigest([])).not.toBe(one);
    expect(findingsDigest([])).toBe(findingsDigest([]));
  });

  it('the provider message id is prefixed and bounded', () => {
    const id = briefingProviderMessageId(findingsDigest([findingA]));
    expect(id.startsWith('intel-briefing-')).toBe(true);
    expect(id.length).toBeLessThanOrEqual(255);
  });
});

describe('the briefing answer', () => {
  it('renders cards with severity meta, workflow links and why/next context', () => {
    const card = findingCard(findingA);
    expect(card.kind).toBe('unknown');
    expect(card.tone).toBe('warning');
    expect(card.href).toBe('/intelligence/unknowns/unknown-1');
    expect(card.linkLabel).toBe('Open the intelligence workflow');
    expect(card.meta).toContain('High urgency');
    expect(card.meta).toContain('Decision impact 55%');
    expect(card.context).not.toBeNull();
    const kinds = card.context?.sections.map((section) => section.kind);
    expect(kinds).toContain('why');
    expect(kinds).toContain('detail');
    expect(card.decision).toBeNull();
  });

  it('the card survives the chat payload guard (linkLabel included)', () => {
    const stored = JSON.parse(JSON.stringify(findingCard(findingA))) as unknown;
    const normalized = normalizeChatCard(stored);
    expect(normalized).not.toBeNull();
    expect(normalized?.linkLabel).toBe('Open the intelligence workflow');
    expect(normalized?.href).toBe('/intelligence/unknowns/unknown-1');
    // A legacy card without linkLabel still normalizes (back-compat).
    const legacy = normalizeChatCard({ ...findingCard(findingB), linkLabel: undefined });
    expect(legacy?.linkLabel).toBeNull();
  });

  it('citations are bounded and deduplicated across findings', () => {
    const citations = findingCitations([findingA, findingB]);
    expect(citations.map((c) => c.id)).toEqual(['obs-1', 'obs-2', 'obs-3']);
    expect(citations.every((c) => c.href === '/evidence')).toBe(true);
  });

  it('the answer is an attention briefing with honest degradation note', () => {
    const answer = briefingAnswer([findingA, findingB], ['contradictions']);
    expect(answer.intent).toBe('attention');
    expect(answer.mode).toBe('deterministic');
    expect(answer.cards).toHaveLength(2);
    expect(answer.note).toContain('contradictions');
    expect(answer.executionId).toBeNull();
    const clean = briefingAnswer([findingA], []);
    expect(clean.note).toBeNull();
  });

  it('the text reads like Aurum messaging first, worst first', () => {
    const text = renderBriefingText([findingA, findingB]);
    expect(text).toContain('I found 2 things on my own');
    expect(text).toContain('High urgency — What is driving the freshness shortfall?');
    expect(renderBriefingText([])).toContain('nothing needs your attention');
  });

  it('an empty briefing state still composes honestly', () => {
    const answer = briefingAnswer([], []);
    expect(answer.headline).toContain('Nothing needs your attention');
    expect(answer.cards).toEqual([]);
  });
});
