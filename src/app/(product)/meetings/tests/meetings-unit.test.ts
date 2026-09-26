// Unit tests for the meetings surface's pure logic (W104 — J17) — no DB,
// no DOM: the label vocabulary over the meetings contract (provider names,
// connection/session status pairs — tone AND label, never color alone),
// the artifact kinds, the access-code mapping, the formatting helpers,
// and the two standing notes the page quotes verbatim (the honesty
// words ARE the product).

import { describe, expect, it } from 'vitest';
import {
  CAPTURE_TRANSPORT_NOTE,
  MEETING_INTELLIGENCE_NOTE,
  accessCodeLabel,
  accessCodeTone,
  artifactKindLabel,
  authKindLabel,
  connectionStatusLabel,
  connectionStatusTone,
  dateLabel,
  dateTimeLabel,
  ingestionModeLabel,
  providerLabel,
  sessionStatusLabel,
  sessionStatusTone,
} from '../lib/labels';
import {
  MEETING_SESSION_STATUSES,
  MEETING_ARTIFACT_KINDS,
  MEETING_AUTH_KINDS,
  MEETING_ACCESS_CODES,
  MEETING_INGESTION_MODES,
  MEETING_PROVIDERS,
} from '@/modules/meetings/contract';

// ---------------------------------------------------------------------------
// Total functions over the contract vocabularies
// ---------------------------------------------------------------------------

describe('the meetings label vocabulary', () => {
  it('labels every provider key', () => {
    expect(providerLabel('zoom')).toBe('Zoom');
    expect(providerLabel('microsoft-teams')).toBe('Microsoft Teams');
    expect(providerLabel('google-meet')).toBe('Google Meet');
    expect(providerLabel('recall')).toContain('meeting bot');
    for (const provider of MEETING_PROVIDERS) {
      expect(providerLabel(provider).length).toBeGreaterThan(0);
    }
    expect(providerLabel('future-provider')).toBe('future-provider');
  });

  it('labels every connection status with a tone AND a label (never color alone)', () => {
    expect(connectionStatusLabel('active')).toBe('Capturing');
    expect(connectionStatusTone('active')).toBe('positive');
    expect(connectionStatusLabel('disabled')).toBe('Disabled');
    expect(connectionStatusTone('disabled')).toBe('neutral');
  });

  it('labels every session status with a tone AND a label', () => {
    for (const status of MEETING_SESSION_STATUSES) {
      expect(sessionStatusLabel(status).length).toBeGreaterThan(0);
      expect(['positive', 'info', 'neutral', 'warning', 'error']).toContain(sessionStatusTone(status));
    }
    expect(sessionStatusLabel('started')).toBe('Happening now');
    expect(sessionStatusLabel('ended')).toBe('Ended');
  });

  it('labels every auth kind and ingestion mode', () => {
    for (const kind of MEETING_AUTH_KINDS) {
      expect(authKindLabel(kind).length).toBeGreaterThan(0);
    }
    expect(ingestionModeLabel('webhook')).toBe('Provider webhooks');
    expect(ingestionModeLabel('polling')).toBe('Scheduled polling');
    for (const mode of MEETING_INGESTION_MODES) {
      expect(ingestionModeLabel(mode).length).toBeGreaterThan(0);
    }
  });

  it('labels every artifact kind', () => {
    for (const kind of MEETING_ARTIFACT_KINDS) {
      expect(artifactKindLabel(kind).length).toBeGreaterThan(0);
    }
    expect(artifactKindLabel('recording')).toBe('Recording');
    expect(artifactKindLabel('chat')).toBe('In-meeting chat');
  });

  it('labels every access code, with the recoverable ones toned warning', () => {
    for (const code of MEETING_ACCESS_CODES) {
      expect(accessCodeLabel(code).length).toBeGreaterThan(0);
      expect(['positive', 'info', 'neutral', 'warning', 'error']).toContain(accessCodeTone(code));
    }
    expect(accessCodeLabel('recording_unavailable')).toBe('recording unavailable');
    expect(accessCodeTone('recording_unavailable')).toBe('warning');
    expect(accessCodeTone('authorization_expired')).toBe('warning');
    expect(accessCodeTone('access_denied')).toBe('error');
  });

  it('formats dates honestly (null → the dash, junk → the raw value)', () => {
    expect(dateLabel(null)).toBe('—');
    expect(dateLabel('not-a-date')).toBe('not-a-date');
    expect(dateLabel('2026-10-06T09:00:00Z')).toMatch(/Oct/);
    expect(dateTimeLabel(null)).toBe('—');
    expect(dateTimeLabel('2026-10-06T09:00:23Z')).toMatch(/Sep|Oct/);
  });
});

// ---------------------------------------------------------------------------
// The standing notes (the page quotes them verbatim)
// ---------------------------------------------------------------------------

describe('the meetings honesty notes', () => {
  it('the capture-transport note reports the provider_unavailable limit as the module does', () => {
    expect(CAPTURE_TRANSPORT_NOTE).toContain('provider_unavailable');
    expect(CAPTURE_TRANSPORT_NOTE).toContain('retryable');
    expect(CAPTURE_TRANSPORT_NOTE).toContain('webhook capture is unaffected');
    expect(CAPTURE_TRANSPORT_NOTE).toContain('fakes a capture');
  });

  it('the surface note explains capture, evidence and read-only posture', () => {
    expect(MEETING_INTELLIGENCE_NOTE).toContain('captured, not guessed');
    expect(MEETING_INTELLIGENCE_NOTE).toContain('immutable evidence model');
    expect(MEETING_INTELLIGENCE_NOTE).toContain('never edits capture state');
  });
});
