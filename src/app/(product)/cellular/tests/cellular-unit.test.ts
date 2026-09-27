// Unit tests for the cellular surface's pure logic (W104 — J18) — no DB,
// no DOM: the label vocabulary over the cellular contract (reach
// statuses, attempt statuses, failure codes, policy sources, voice
// fallback modes, providers — tone AND label, never color alone), the
// money/formatting helpers, and THE HONESTY NOTES the pages quote
// verbatim (the environment limit reported exactly as the module reports
// it — the words ARE the product).

import { describe, expect, it } from 'vitest';
import {
  CELLULAR_TRANSPORT_NOTE,
  REACH_FEED_NOTE,
  attemptStatusLabel,
  attemptStatusTone,
  dateTimeLabel,
  failureCodeLabel,
  minorUnitsLabel,
  policySourceLabel,
  providerLabel,
  reachStatusLabel,
  reachStatusTone,
  voiceFallbackLabel,
} from '../lib/labels';
import {
  CELLULAR_REACH_STATUSES,
  CELLULAR_ATTEMPT_STATUSES,
  CELLULAR_VOICE_FALLBACK_MODES,
  CELLULAR_POLICY_SOURCES,
} from '@/modules/cellular/contract';

// ---------------------------------------------------------------------------
// Total functions over the contract vocabularies
// ---------------------------------------------------------------------------

describe('the cellular label vocabulary', () => {
  it('labels every reach status with a tone AND a label (never color alone)', () => {
    for (const status of CELLULAR_REACH_STATUSES) {
      expect(reachStatusLabel(status).length).toBeGreaterThan(0);
      expect(['positive', 'info', 'neutral', 'warning', 'error']).toContain(reachStatusTone(status));
    }
    expect(reachStatusLabel('delivered')).toBe('Delivered');
    expect(reachStatusTone('delivered')).toBe('positive');
    expect(reachStatusLabel('awaiting_approval')).toBe('Awaiting approval');
    expect(reachStatusLabel('voice_fallback')).toBe('Voice fallback in flight');
    expect(reachStatusTone('failed')).toBe('error');
  });

  it('labels every attempt status with a tone AND a label', () => {
    for (const status of CELLULAR_ATTEMPT_STATUSES) {
      expect(attemptStatusLabel(status).length).toBeGreaterThan(0);
      expect(['positive', 'info', 'neutral', 'warning', 'error']).toContain(attemptStatusTone(status));
    }
    expect(attemptStatusLabel('failed')).toBe('Failed (no leg placed)');
    expect(attemptStatusLabel('no_answer')).toBe('Not answered');
  });

  it('labels every provider, fallback mode and policy source', () => {
    expect(providerLabel('twilio')).toBe('Twilio');
    expect(providerLabel('telnyx')).toBe('Telnyx');
    expect(providerLabel('future')).toBe('future');
    for (const mode of CELLULAR_VOICE_FALLBACK_MODES) {
      expect(voiceFallbackLabel(mode).length).toBeGreaterThan(0);
    }
    expect(voiceFallbackLabel('forbidden')).toContain('forbidden');
    for (const source of CELLULAR_POLICY_SOURCES) {
      expect(policySourceLabel(source).length).toBeGreaterThan(0);
    }
  });

  it('the failure codes read in user words — provider_unavailable is THE environment limit', () => {
    expect(failureCodeLabel(null)).toBeNull();
    expect(failureCodeLabel('provider_unavailable')).toBe('provider unavailable (retryable)');
    expect(failureCodeLabel('voice_no_answer')).toBe('voice call not answered');
    expect(failureCodeLabel('cost_cap_exceeded')).toBe('cost cap reached');
    expect(failureCodeLabel('a_future_code')).toBe('a future code');
  });

  it('minor units format as readable money', () => {
    expect(minorUnitsLabel(0, 'USD')).toBe('free');
    expect(minorUnitsLabel(5, 'USD')).toBe('0.05 USD');
    expect(minorUnitsLabel(150, 'USD')).toBe('1.50 USD');
    expect(minorUnitsLabel(1000, 'EUR')).toBe('10.00 EUR');
  });

  it('formats timestamps honestly (null → the dash, junk → the raw value)', () => {
    expect(dateTimeLabel(null)).toBe('—');
    expect(dateTimeLabel('not-a-date')).toBe('not-a-date');
    expect(dateTimeLabel('2026-10-06T09:00:23Z')).toMatch(/Sep|Oct/);
  });
});

// ---------------------------------------------------------------------------
// The honesty notes (the pages quote them verbatim)
// ---------------------------------------------------------------------------

describe('the cellular honesty notes', () => {
  it('the transport note reports the environment limit exactly as the module records it', () => {
    expect(CELLULAR_TRANSPORT_NOTE).toContain('No telecom transport is wired by default');
    expect(CELLULAR_TRANSPORT_NOTE).toContain('provider_unavailable');
    expect(CELLULAR_TRANSPORT_NOTE).toContain('retryable');
    expect(CELLULAR_TRANSPORT_NOTE).toContain('never fakes a delivery');
  });

  it('the reach-feed note explains the durable intents, gates and retry semantics', () => {
    expect(REACH_FEED_NOTE).toContain('durable request');
    expect(REACH_FEED_NOTE).toContain('authority gate');
    expect(REACH_FEED_NOTE).toContain('policy snapshot');
    expect(REACH_FEED_NOTE).toContain('Blocked requests never re-leave');
  });
});
