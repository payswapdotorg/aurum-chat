// Unit tests for the unified-identity module (W095) — pure logic, no
// database: the modality vocabulary/classification, the facet/provider
// validation rules, and the AMBIGUITY GUARD's decision logic (the W095
// acceptance rule: unique evidence links, ambiguous evidence never
// merges).
//
// The cross-module journeys (messaging challenge loop, meeting/realtime
// passes, profiles across modalities) live in unified-identity-service.test.ts.

import { describe, expect, it } from 'vitest';
import { UnifiedIdentityError } from '../errors';
import { decideMatch, describeCandidates, distinctPersons, relateEvidenceToSubject } from '../matching';
import {
  assertModalityProvider,
  assertUnifiedTenantContext,
  isRegistryModality,
  isUnifiedModality,
  isUnifiedStatus,
  modalityOfChannelProvider,
  normalizeDisplayName,
  normalizeEmailFacet,
  normalizeLimit,
  normalizePhoneFacet,
  normalizeProviderAccountId,
  REGISTRY_MODALITIES,
  requireText,
  requireUnifiedAuthority,
  requireUuid,
  UNIFIED_MODALITIES,
} from '../validation';
import type { MatchCandidate } from '../types';

const EMAIL_MAX = 320;

function candidate(personId: string, via: 'email' | 'sms' | 'voice', account: string): MatchCandidate {
  return { personId, matchedVia: via, provider: via, providerAccountId: account };
}

// ---------------------------------------------------------------------------
// Modality classification
// ---------------------------------------------------------------------------

describe('W095 · modality vocabulary and channel-provider classification', () => {
  it('unifies exactly the six declared communication modalities', () => {
    expect([...UNIFIED_MODALITIES]).toEqual(['messaging', 'sms', 'voice', 'meeting', 'realtime', 'edge']);
  });

  it('splits registry modalities from identity-backed modalities', () => {
    expect([...REGISTRY_MODALITIES]).toEqual(['meeting', 'realtime', 'edge']);
    expect(isRegistryModality('meeting')).toBe(true);
    expect(isRegistryModality('realtime')).toBe(true);
    expect(isRegistryModality('edge')).toBe(true);
    // identity-module territory — never a registry row
    expect(isRegistryModality('messaging')).toBe(false);
    expect(isRegistryModality('sms')).toBe(false);
    expect(isRegistryModality('voice')).toBe(false);
  });

  it('classifies identity channel providers onto modalities', () => {
    expect(modalityOfChannelProvider('sms')).toBe('sms');
    expect(modalityOfChannelProvider('voice')).toBe('voice');
    for (const provider of ['whatsapp', 'telegram', 'slack', 'email', 'signal'] as const) {
      expect(modalityOfChannelProvider(provider)).toBe('messaging');
    }
  });

  it('recognizes modality and status values defensively', () => {
    expect(isUnifiedModality('meeting')).toBe(true);
    expect(isUnifiedModality('carrier-pigeon')).toBe(false);
    expect(isUnifiedModality(null)).toBe(false);
    expect(isUnifiedStatus('verified')).toBe(true);
    expect(isUnifiedStatus('pending')).toBe(false); // no challenge-pending state here
    expect(isUnifiedStatus(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider validation per modality
// ---------------------------------------------------------------------------

describe('W095 · provider keys are validated against the owning module vocabulary', () => {
  it('accepts the identity vocabulary for messaging minus sms/voice', () => {
    expect(assertModalityProvider('messaging', 'whatsapp')).toBe('whatsapp');
    expect(assertModalityProvider('messaging', ' email ')).toBe('email');
    expect(() => assertModalityProvider('messaging', 'sms')).toThrow(UnifiedIdentityError);
    expect(() => assertModalityProvider('messaging', 'voice')).toThrow(UnifiedIdentityError);
    expect(() => assertModalityProvider('messaging', 'zoom')).toThrow(UnifiedIdentityError);
  });

  it('pins sms/voice modalities to their single identity provider', () => {
    expect(assertModalityProvider('sms', 'sms')).toBe('sms');
    expect(assertModalityProvider('voice', 'voice')).toBe('voice');
    expect(() => assertModalityProvider('sms', 'voice')).toThrow(UnifiedIdentityError);
    expect(() => assertModalityProvider('voice', 'whatsapp')).toThrow(UnifiedIdentityError);
  });

  it('accepts meeting/realtime provider keys from their owning modules', () => {
    expect(assertModalityProvider('meeting', 'zoom')).toBe('zoom');
    expect(assertModalityProvider('meeting', 'microsoft-teams')).toBe('microsoft-teams');
    expect(() => assertModalityProvider('meeting', 'livekit')).toThrow(UnifiedIdentityError);
    expect(assertModalityProvider('realtime', 'livekit')).toBe('livekit');
    expect(assertModalityProvider('realtime', 'openai-realtime')).toBe('openai-realtime');
    expect(() => assertModalityProvider('realtime', 'zoom')).toThrow(UnifiedIdentityError);
  });

  it('accepts free-form neutral keys for the edge modality only', () => {
    expect(assertModalityProvider('edge', 'edge-connector')).toBe('edge-connector');
    expect(assertModalityProvider('edge', 'acme-edge-gateway')).toBe('acme-edge-gateway');
    expect(() => assertModalityProvider('edge', 'EdgeConnector')).toThrow(UnifiedIdentityError);
    expect(() => assertModalityProvider('edge', 'edge connector')).toThrow(UnifiedIdentityError);
    expect(() => assertModalityProvider('edge', '')).toThrow(UnifiedIdentityError);
  });

  it('trims and bounds provider keys and account ids', () => {
    expect(() => assertModalityProvider('meeting', 'x'.repeat(65))).toThrow(UnifiedIdentityError);
    expect(normalizeProviderAccountId('  zoom-participant-1  ')).toBe('zoom-participant-1');
    expect(() => normalizeProviderAccountId('   ')).toThrow(UnifiedIdentityError);
    expect(() => normalizeProviderAccountId('x'.repeat(256))).toThrow(UnifiedIdentityError);
    expect(() => normalizeProviderAccountId(42)).toThrow(UnifiedIdentityError);
  });
});

// ---------------------------------------------------------------------------
// Facet normalization
// ---------------------------------------------------------------------------

describe('W095 · contact facets are normalized but never trusted blindly', () => {
  it('keeps email facets as delivered (trimmed) — the matcher probes case variants', () => {
    expect(normalizeEmailFacet('  Maya.Chen@Acme.Test ')).toBe('Maya.Chen@Acme.Test');
    expect(normalizeEmailFacet(null)).toBeNull();
    expect(normalizeEmailFacet(undefined)).toBeNull();
    expect(normalizeEmailFacet('')).toBeNull();
    expect(() => normalizeEmailFacet('not-an-email')).toThrow(UnifiedIdentityError);
    expect(() => normalizeEmailFacet('a@b')).toThrow(UnifiedIdentityError);
    expect(() => normalizeEmailFacet(`${'x'.repeat(EMAIL_MAX)}@example.test`)).toThrow(UnifiedIdentityError);
  });

  it('requires E.164 for phone facets', () => {
    expect(normalizePhoneFacet('+15550102299')).toBe('+15550102299');
    expect(normalizePhoneFacet(null)).toBeNull();
    expect(() => normalizePhoneFacet('555-010-2299')).toThrow(UnifiedIdentityError);
    expect(() => normalizePhoneFacet('+1555010')).toThrow(UnifiedIdentityError); // too short for E.164
    expect(() => normalizePhoneFacet('+15550102299123456')).toThrow(UnifiedIdentityError); // too long
    expect(() => normalizePhoneFacet('+01550102299')).toThrow(UnifiedIdentityError); // invalid country digit
  });

  it('trims display names to null (never evidence, only display)', () => {
    expect(normalizeDisplayName('  Ravi Patel  ')).toBe('Ravi Patel');
    expect(normalizeDisplayName('   ')).toBeNull();
    expect(() => normalizeDisplayName('x'.repeat(201))).toThrow(UnifiedIdentityError);
  });
});

// ---------------------------------------------------------------------------
// Context, authority, uuid/text/limit validation
// ---------------------------------------------------------------------------

describe('W095 · context and scalar validation', () => {
  const ctx = { tenantId: 't-1', principalId: 'p-1', authority: ['identity:link'] };

  it('validates the TenantContext shape', () => {
    expect(() => assertUnifiedTenantContext(ctx)).not.toThrow();
    expect(() => assertUnifiedTenantContext({ ...ctx, tenantId: '' })).toThrow(UnifiedIdentityError);
    expect(() => assertUnifiedTenantContext({ ...ctx, principalId: ' ' })).toThrow(UnifiedIdentityError);
    expect(() =>
      assertUnifiedTenantContext({ ...ctx, authority: 'identity:link' as unknown as string[] }),
    ).toThrow(UnifiedIdentityError);
  });

  it('requires exact authority claims', () => {
    expect(() => requireUnifiedAuthority(ctx, 'identity:link')).not.toThrow();
    expect(() => requireUnifiedAuthority(ctx, 'identity:attest')).toThrow(UnifiedIdentityError);
    expect(
      () => requireUnifiedAuthority({ ...ctx, authority: ['identity:attest'] }, 'identity:attest'),
    ).not.toThrow();
  });

  it('validates uuids, required text and list limits', () => {
    expect(requireUuid('  6f9619ff-8b86-d011-b42d-00cf4fc964ff  ', 'personId')).toBe(
      '6f9619ff-8b86-d011-b42d-00cf4fc964ff',
    );
    expect(() => requireUuid('not-a-uuid', 'personId')).toThrow(UnifiedIdentityError);
    expect(requireText('  HR attested  ', 'evidence', 2000)).toBe('HR attested');
    expect(() => requireText('  ', 'evidence', 2000)).toThrow(UnifiedIdentityError);
    expect(normalizeLimit(undefined)).toBe(50);
    expect(normalizeLimit(500)).toBe(500);
    expect(() => normalizeLimit(0)).toThrow(UnifiedIdentityError);
    expect(() => normalizeLimit(501)).toThrow(UnifiedIdentityError);
    expect(() => normalizeLimit(10.5)).toThrow(UnifiedIdentityError);
  });
});

// ---------------------------------------------------------------------------
// The ambiguity guard (pure decision logic)
// ---------------------------------------------------------------------------

describe('W095 · the ambiguity guard decides matches', () => {
  it('returns none for an empty candidate set', () => {
    expect(decideMatch([])).toEqual({ kind: 'none' });
  });

  it('links a UNIQUE candidate — even when several identities agree on the person', () => {
    const candidates = [
      candidate('person-a', 'email', 'maya@acme.test'),
      candidate('person-a', 'sms', '+15550102299'),
    ];
    expect(decideMatch(candidates)).toEqual({ kind: 'unique', personId: 'person-a', candidates });
  });

  it('stays ambiguous when evidence points at two different persons', () => {
    const candidates = [
      candidate('person-a', 'email', 'shared@acme.test'),
      candidate('person-b', 'sms', '+15550107777'),
    ];
    expect(decideMatch(candidates)).toEqual({ kind: 'ambiguous', candidates });
  });

  it('stays ambiguous for the same E.164 verified on sms AND voice to different persons', () => {
    const candidates = [
      candidate('person-a', 'sms', '+15550108888'),
      candidate('person-b', 'voice', '+15550108888'),
    ];
    expect(decideMatch(candidates)).toEqual({ kind: 'ambiguous', candidates });
  });

  it('collapses duplicate persons in first-appearance order', () => {
    expect(
      distinctPersons([
        candidate('person-b', 'sms', '+15550108888'),
        candidate('person-a', 'email', 'x@y.test'),
        candidate('person-b', 'voice', '+15550108888'),
      ]),
    ).toEqual(['person-b', 'person-a']);
  });

  it('relates evidence to an existing verified link without ever re-linking', () => {
    expect(relateEvidenceToSubject('person-a', [])).toEqual({ relation: 'no_evidence' });
    expect(relateEvidenceToSubject('person-a', [candidate('person-a', 'email', 'x@y.test')])).toEqual({
      relation: 'consistent',
      candidates: [candidate('person-a', 'email', 'x@y.test')],
    });
    // single different person → conflict
    expect(relateEvidenceToSubject('person-a', [candidate('person-b', 'email', 'x@y.test')]).relation).toBe(
      'conflict',
    );
    // multiple persons including the linked one → still a conflict
    expect(
      relateEvidenceToSubject('person-a', [
        candidate('person-a', 'email', 'x@y.test'),
        candidate('person-b', 'sms', '+15550107777'),
      ]).relation,
    ).toBe('conflict');
  });

  it('renders the human-readable evidence trail', () => {
    expect(
      describeCandidates([candidate('person-a', 'email', 'maya@acme.test')]),
    ).toBe("email identity 'maya@acme.test' → person person-a");
    expect(
      describeCandidates([
        candidate('person-a', 'sms', '+15550108888'),
        candidate('person-b', 'voice', '+15550108888'),
      ]),
    ).toBe(
      "sms identity '+15550108888' → person person-a; voice identity '+15550108888' → person person-b",
    );
  });
});
