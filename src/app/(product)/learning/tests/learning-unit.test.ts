// Unit tests for the learning surface's pure logic (W062) — no DB, no
// DOM: the contribution/reward label vocabulary (tone + label pairs,
// never color alone), the COMPENSATION SEPARATION sweep (the acceptance's
// final clause, pinned over every copy constant the surface renders),
// the formatting helpers, the answer-input validation, and the API
// error-code mapping.

import { describe, expect, it } from 'vitest';
import {
  COMPENSATION_FORBIDDEN_TERMS,
  REWARD_KIND_LABELS,
  REWARD_SEPARATION_NOTE,
  askPolicyNote,
  contributionStatusExplanation,
  contributionStatusLabel,
  contributionStatusTone,
  dateLabel,
  missionImpactLabel,
  missionProgressPercent,
  missionUrgencyTone,
  moneyLabel,
  percentLabel,
  rewardKindLabel,
  rewardStatusLabel,
  rewardStatusTone,
  settlementDecisionLabel,
  usesForbiddenTerm,
  validationOutcomeLabel,
  validationOutcomeTone,
} from '../lib/labels';
import {
  ANSWER_CONFIDENCE_OPTIONS,
  ANSWER_STRENGTHS,
  AnswerInputError,
  LearningStateError,
  MAX_ANSWER_NOTE_LENGTH,
  MAX_ANSWER_SUMMARY_LENGTH,
  isAnswerStrength,
  validateAnswerInput,
} from '../lib/answer';
import { learningApiError, parseAnswerBody } from '../lib/api';
import {
  COMPENSATION_EXCLUDED_KINDS,
  REWARD_KINDS,
  REWARD_STATUSES,
  SETTLEMENT_DECISIONS,
} from '@/modules/rewards/contract';
import {
  CONTRIBUTION_STATUSES,
  MISSION_IMPACT_KINDS,
  VALIDATION_OUTCOMES,
} from '@/modules/contributions/contract';
import { MISSION_URGENCIES } from '@/modules/missions/contract';

// ---------------------------------------------------------------------------
// The compensation/performance separation (the acceptance's final clause)
// ---------------------------------------------------------------------------

describe('the compensation separation sweep', () => {
  it('keeps the reward-kind labels inside the closed non-compensation vocabulary', () => {
    for (const kind of REWARD_KINDS) {
      expect(REWARD_KIND_LABELS[kind]).toBeDefined();
      expect(usesForbiddenTerm(REWARD_KIND_LABELS[kind])).toBeNull();
    }
    // The label set covers exactly the closed vocabulary.
    expect(Object.keys(REWARD_KIND_LABELS).sort()).toEqual([...REWARD_KINDS].sort());
  });

  it('renders no compensation/performance term in any status label the surface can produce', () => {
    const allCopy: string[] = [
      REWARD_SEPARATION_NOTE,
      ...CONTRIBUTION_STATUSES.map((status) => contributionStatusLabel(status)),
      ...CONTRIBUTION_STATUSES.map((status) => contributionStatusExplanation(status)),
      ...VALIDATION_OUTCOMES.map((outcome) => validationOutcomeLabel(outcome)),
      ...MISSION_IMPACT_KINDS.map((kind) => missionImpactLabel(kind)),
      ...REWARD_STATUSES.map((status) => rewardStatusLabel(status)),
      ...SETTLEMENT_DECISIONS.map((decision) => settlementDecisionLabel(decision)),
      ...MISSION_URGENCIES.map((urgency) => missionUrgencyTone(urgency) && `${urgency}`),
      askPolicyNote('allowed'),
      askPolicyNote('approval_required'),
      askPolicyNote('forbidden'),
    ];
    for (const text of allCopy) {
      expect(usesForbiddenTerm(text)).toBeNull();
    }
  });

  it('keeps the reward kind vocabulary disjoint from the excluded compensation shapes', () => {
    for (const kind of REWARD_KINDS) {
      expect(COMPENSATION_EXCLUDED_KINDS).not.toContain(kind);
    }
  });

  it('detects forbidden terms (the guard works both ways)', () => {
    expect(usesForbiddenTerm('a salary decision')).toBe('salary');
    expect(usesForbiddenTerm('annual performance rating')).toBe('performance');
    expect(usesForbiddenTerm('pure recognition')).toBeNull();
  });

  it('pins the forbidden-term list the sweep enforces', () => {
    expect(COMPENSATION_FORBIDDEN_TERMS).toContain('compensation');
    expect(COMPENSATION_FORBIDDEN_TERMS).toContain('bonus');
    expect(COMPENSATION_FORBIDDEN_TERMS).toContain('appraisal');
  });
});

// ---------------------------------------------------------------------------
// The acknowledgement ladder (tone + label, never color alone)
// ---------------------------------------------------------------------------

describe('the contribution acknowledgement ladder', () => {
  it('maps every status to a distinct tone + human label', () => {
    expect(contributionStatusTone('pending')).toBe('neutral');
    expect(contributionStatusTone('validated')).toBe('positive');
    expect(contributionStatusTone('contradicted')).toBe('warning');
    expect(contributionStatusTone('rejected')).toBe('error');
    expect(contributionStatusTone('measured')).toBe('info');
    const labels = CONTRIBUTION_STATUSES.map((status) => contributionStatusLabel(status));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  it('explains every ladder step (what it means for the contributor)', () => {
    for (const status of CONTRIBUTION_STATUSES) {
      const explanation = contributionStatusExplanation(status);
      expect(explanation.length).toBeGreaterThan(20);
    }
  });

  it('maps validation outcomes to tone + copy', () => {
    expect(validationOutcomeTone('validated')).toBe('positive');
    expect(validationOutcomeTone('contradicted')).toBe('warning');
    expect(validationOutcomeTone('rejected')).toBe('error');
    expect(validationOutcomeLabel('validated')).toContain('validated');
  });

  it('labels every frozen mission impact', () => {
    expect(missionImpactLabel('advanced')).toContain('advanced');
    expect(missionImpactLabel('resolved')).toContain('resolved');
    expect(missionImpactLabel('no_effect')).toContain('no measurable');
  });
});

// ---------------------------------------------------------------------------
// Reward status/history labels
// ---------------------------------------------------------------------------

describe('reward status labels', () => {
  it('maps every reward status to a tone + label', () => {
    expect(rewardStatusTone('proposed')).toBe('warning');
    expect(rewardStatusTone('granted')).toBe('positive');
    expect(rewardStatusTone('declined')).toBe('neutral');
    expect(rewardStatusTone('refused')).toBe('error');
    for (const status of REWARD_STATUSES) {
      expect(rewardStatusLabel(status).length).toBeGreaterThan(3);
    }
  });

  it('labels settlement decisions and reward kinds', () => {
    expect(settlementDecisionLabel('granted')).toContain('grant');
    expect(settlementDecisionLabel('declined')).toContain('decline');
    expect(rewardKindLabel('recognition')).toBe('Recognition');
    expect(rewardKindLabel('donation')).toBe('Donation');
  });

  it('labels ask-policy outcomes honestly', () => {
    expect(askPolicyNote('allowed')).toContain('permits');
    expect(askPolicyNote('approval_required')).toContain('approval');
    expect(askPolicyNote('forbidden')).toContain('did not permit');
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('renders money as minor units + ISO currency', () => {
    expect(moneyLabel(1250, 'USD')).toBe('12.50 USD');
    expect(moneyLabel(0, 'EUR')).toBe('0.00 EUR');
  });

  it('renders percents and bounded mission progress', () => {
    expect(percentLabel(0.62)).toBe('62%');
    expect(percentLabel(1)).toBe('100%');
    expect(missionProgressPercent(0.25, 0.5)).toBe(50);
    expect(missionProgressPercent(0.9, 0.5)).toBe(100); // capped at target
    expect(missionProgressPercent(0, 0.4)).toBe(0);
  });

  it('passes invalid dates through untouched (no lies)', () => {
    expect(dateLabel('not-a-date')).toBe('not-a-date');
    expect(dateLabel('2026-10-01T09:00:00.000Z')).toMatch(/2026/);
  });
});

// ---------------------------------------------------------------------------
// Answer-input validation
// ---------------------------------------------------------------------------

describe('answer-input validation', () => {
  it('accepts a well-formed answer and defaults the confidence', () => {
    const validated = validateAnswerInput({ summary: '  The courier changed brokers.  ' });
    expect(validated.summary).toBe('The courier changed brokers.');
    expect(validated.note).toBeNull();
    expect(validated.confidence).toBe('medium');
  });

  it('keeps the optional note bounded and trimmed', () => {
    const validated = validateAnswerInput({
      summary: 'knows the root cause',
      note: '  from the WMS export  ',
      confidence: 'high',
    });
    expect(validated.note).toBe('from the WMS export');
    expect(validated.confidence).toBe('high');
    const long = 'x'.repeat(MAX_ANSWER_NOTE_LENGTH + 1);
    expect(() => validateAnswerInput({ summary: 's', note: long })).toThrow(AnswerInputError);
  });

  it('rejects empty, non-string and over-long summaries', () => {
    expect(() => validateAnswerInput({ summary: '   ' })).toThrow(AnswerInputError);
    expect(() => validateAnswerInput({ summary: 42 })).toThrow(AnswerInputError);
    expect(() =>
      validateAnswerInput({ summary: 'x'.repeat(MAX_ANSWER_SUMMARY_LENGTH + 1) }),
    ).toThrow(AnswerInputError);
  });

  it('rejects unknown confidence strengths', () => {
    expect(() => validateAnswerInput({ summary: 's', confidence: 'certain' })).toThrow(
      AnswerInputError,
    );
    expect(() => validateAnswerInput({ summary: 's', confidence: null })).toThrow(
      AnswerInputError,
    );
  });

  it('keeps the strength vocabulary and the form options in sync', () => {
    expect(ANSWER_STRENGTHS).toEqual(['high', 'medium', 'low']);
    for (const option of ANSWER_CONFIDENCE_OPTIONS) {
      expect(isAnswerStrength(option.value)).toBe(true);
      expect(option.label.length).toBeGreaterThan(5);
    }
  });
});

// ---------------------------------------------------------------------------
// API-body parsing and error mapping
// ---------------------------------------------------------------------------

describe('API parsing and error mapping', () => {
  it('parses an answer body as a JSON object with loose fields', () => {
    const parsed = parseAnswerBody({ summary: 's', note: 'n', confidence: 'low' });
    expect(parsed).toEqual({ ok: true, summary: 's', note: 'n', confidence: 'low' });
    const defaulted = parseAnswerBody({ summary: 's' });
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.confidence).toBe('medium');
      expect(defaulted.note).toBeNull();
    }
  });

  it('refuses non-object bodies', () => {
    expect(parseAnswerBody(null).ok).toBe(false);
    expect(parseAnswerBody('text').ok).toBe(false);
    expect(parseAnswerBody([1, 2]).ok).toBe(false);
  });

  it('maps the surface error classes to 400 and 409', () => {
    const input = learningApiError(new AnswerInputError('bad input'));
    expect(input.status).toBe(400);
    expect(input.body.error).toBe('invalid_answer_input');
    const state = learningApiError(new LearningStateError('already answered'));
    expect(state.status).toBe(409);
    expect(state.body.error).toBe('request_state');
  });

  it('maps code-carrying domain errors by family', () => {
    const notFound = learningApiError(
      Object.assign(new Error('no such plan'), { code: 'plan_not_found' }),
    );
    expect(notFound.status).toBe(404);
    const conflict = learningApiError(
      Object.assign(new Error('terminal'), { code: 'outcome_conflict' }),
    );
    expect(conflict.status).toBe(409);
    const forbidden = learningApiError(Object.assign(new Error('no'), { code: 'forbidden' }));
    expect(forbidden.status).toBe(403);
    const invalid = learningApiError(
      Object.assign(new Error('shape'), { code: 'invalid_plan_input' }),
    );
    expect(invalid.status).toBe(400);
    const unknown = learningApiError(new Error('plain failure'));
    expect(unknown.status).toBe(500);
  });
});
