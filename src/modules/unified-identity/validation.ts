// Input/query validation and the modality vocabulary of the
// unified-identity module (W095).
//
// Provider vocabularies are owned by their modules and are consumed
// THROUGH their contracts (lock 16 / MODULE-DEPENDENCY-MAP provider
// boundaries): messaging/sms/voice providers by the identity module
// (W002, ADR-0015 neutral keys), meeting providers by the meetings module
// (W085), realtime providers by the realtime module (W086). Edge provider
// keys are free-form neutral keys until W088's vocabulary lands — the
// safe-shape check below is the interim discipline (lowercase kebab, like
// every provider key in this repository).
//
// The provider CHECK lives here (service layer) rather than in SQL on
// purpose: the three vocabularies evolve with their owning modules, and a
// hard-coded SQL CHECK would silently fork from them. The registry's
// modality CHECK in migrations/001-unified-identity.sql mirrors
// UNIFIED_MODALITIES — keep both in sync.

import { isChannelProvider, type ChannelProvider } from '@/modules/identity/contract';
import { isMeetingProvider } from '@/modules/meetings/contract';
import { isRealtimeProvider } from '@/modules/realtime/contract';
import { UnifiedIdentityError } from './errors';
import type { RegistryModality, UnifiedModality, UnifiedStatus } from './types';

/** The communication modalities W095 unifies, in canonical order. */
export const UNIFIED_MODALITIES = [
  'messaging',
  'sms',
  'voice',
  'meeting',
  'realtime',
  'edge',
] as const;

/** Modalities whose identities this module's registry owns. */
export const REGISTRY_MODALITIES = ['meeting', 'realtime', 'edge'] as const;

export const UNIFIED_STATUSES = ['unverified', 'verified', 'revoked'] as const;

export const UNIFIED_VERIFICATION_METHODS = ['cross_modality_match', 'admin_attestation'] as const;

export const UNIFIED_AMBIGUITY_KINDS = [
  'conflicting_subject_matches',
  'linked_subject_conflict',
] as const;

export const UNIFIED_AMBIGUITY_STATUSES = ['open', 'resolved'] as const;

export const UNIFIED_AMBIGUITY_ACTIONS = ['admin_linked', 'revoked', 'dismissed'] as const;

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const MIN_LIST_LIMIT = 1;

export const MAX_PROVIDER_LENGTH = 64;
export const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 255;
export const MAX_DISPLAY_NAME_LENGTH = 200;
export const MAX_EMAIL_LENGTH = 320;
export const MAX_EVIDENCE_LENGTH = 2000;
export const MAX_DETAIL_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 2000;
export const MAX_REASON_LENGTH = 2000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EDGE_PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isUnifiedModality(value: unknown): value is UnifiedModality {
  return typeof value === 'string' && (UNIFIED_MODALITIES as readonly string[]).includes(value);
}

export function isRegistryModality(value: unknown): value is RegistryModality {
  return typeof value === 'string' && (REGISTRY_MODALITIES as readonly string[]).includes(value);
}

export function isUnifiedStatus(value: unknown): value is UnifiedStatus {
  return typeof value === 'string' && (UNIFIED_STATUSES as readonly string[]).includes(value);
}

export function isUnifiedVerificationMethod(
  value: unknown,
): value is (typeof UNIFIED_VERIFICATION_METHODS)[number] {
  return (
    typeof value === 'string' &&
    (UNIFIED_VERIFICATION_METHODS as readonly string[]).includes(value)
  );
}

/**
 * Maps an identity-module channel provider onto its communication modality
 * (W095's view of the identity module's vocabulary):
 * 'sms' → sms, 'voice' → voice, every other channel provider → messaging.
 */
export function modalityOfChannelProvider(provider: ChannelProvider): UnifiedModality {
  if (provider === 'sms') return 'sms';
  if (provider === 'voice') return 'voice';
  return 'messaging';
}

/** Asserts the provider key belongs to the modality's owning vocabulary. */
export function assertModalityProvider(modality: UnifiedModality, provider: unknown): string {
  const key = typeof provider === 'string' ? provider.trim() : '';
  if (key === '') {
    throw new UnifiedIdentityError('invalid_unified_input', 'provider must be a non-empty string');
  }
  if (key.length > MAX_PROVIDER_LENGTH) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `provider must be at most ${MAX_PROVIDER_LENGTH} characters`,
    );
  }
  switch (modality) {
    case 'messaging':
      if (!isChannelProvider(key) || key === 'sms' || key === 'voice') {
        throw new UnifiedIdentityError(
          'invalid_unified_input',
          `provider '${key}' is not a messaging channel provider (identity vocabulary minus sms/voice)`,
        );
      }
      return key;
    case 'sms':
    case 'voice':
      if (key !== modality) {
        throw new UnifiedIdentityError(
          'invalid_unified_input',
          `modality '${modality}' accepts only the identity provider '${modality}'`,
        );
      }
      return key;
    case 'meeting':
      if (!isMeetingProvider(key)) {
        throw new UnifiedIdentityError(
          'invalid_unified_input',
          `provider '${key}' is not a meeting provider (meetings module vocabulary)`,
        );
      }
      return key;
    case 'realtime':
      if (!isRealtimeProvider(key)) {
        throw new UnifiedIdentityError(
          'invalid_unified_input',
          `provider '${key}' is not a realtime provider (realtime module vocabulary)`,
        );
      }
      return key;
    case 'edge':
      if (!EDGE_PROVIDER_PATTERN.test(key)) {
        throw new UnifiedIdentityError(
          'invalid_unified_input',
          "edge provider keys are neutral lowercase kebab keys ('a'..'z', '0'..'9', '-')",
        );
      }
      return key;
  }
}

/** Normalizes a provider account id (trim; non-empty; bounded). */
export function normalizeProviderAccountId(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      'providerAccountId must be a non-empty string',
    );
  }
  if (trimmed.length > MAX_PROVIDER_ACCOUNT_ID_LENGTH) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `providerAccountId must be at most ${MAX_PROVIDER_ACCOUNT_ID_LENGTH} characters`,
    );
  }
  return trimmed;
}

/**
 * Normalizes an email contact facet: as delivered, trimmed (the identity
 * module stores emails exactly as delivered, so the matcher probes both
 * this form and the lowercased one — the meetings bridge discipline).
 */
export function normalizeEmailFacet(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return null;
  if (trimmed.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
    throw new UnifiedIdentityError('invalid_unified_input', `email facet '${trimmed}' is not an email address`);
  }
  return trimmed;
}

/** Normalizes a phone contact facet: E.164 or null. */
export function normalizePhoneFacet(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return null;
  if (!E164_PATTERN.test(trimmed)) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `phone facet '${trimmed}' is not an E.164 number`,
    );
  }
  return trimmed;
}

/** Normalizes an optional display name (trim → null). */
export function normalizeDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return null;
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `displayName must be at most ${MAX_DISPLAY_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}

/** Required non-empty bounded text (evidence, reason, detail). */
export function requireText(value: unknown, field: string, maxLength: number): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') {
    throw new UnifiedIdentityError('invalid_unified_input', `${field} must be a non-empty string`);
  }
  if (trimmed.length > maxLength) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `${field} must be at most ${maxLength} characters`,
    );
  }
  return trimmed;
}

/** Optional bounded text (notes; trim → null). */
export function optionalText(value: unknown, field: string, maxLength: number): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return null;
  if (trimmed.length > maxLength) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `${field} must be at most ${maxLength} characters`,
    );
  }
  return trimmed;
}

/** Validates a uuid input (subject ids, registry ids, session/ambiguity ids). */
export function requireUuid(value: unknown, field: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(trimmed)) {
    throw new UnifiedIdentityError('invalid_unified_input', `${field} must be a uuid`);
  }
  return trimmed;
}

/** List-limit normalization (1..MAX_LIST_LIMIT, default DEFAULT_LIST_LIMIT). */
export function normalizeLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new UnifiedIdentityError('invalid_unified_query', 'limit must be an integer');
  }
  if (value < MIN_LIST_LIMIT || value > MAX_LIST_LIMIT) {
    throw new UnifiedIdentityError(
      'invalid_unified_query',
      `limit must be between ${MIN_LIST_LIMIT} and ${MAX_LIST_LIMIT}`,
    );
  }
  return value;
}

/** Validates a TenantContext shape (throws `invalid_context`). */
export function assertUnifiedTenantContext(ctx: {
  tenantId: string;
  principalId: string;
  authority: string[];
}): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new UnifiedIdentityError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new UnifiedIdentityError(
      'invalid_context',
      'TenantContext.principalId must be a non-empty string',
    );
  }
  if (!Array.isArray(ctx.authority)) {
    throw new UnifiedIdentityError(
      'invalid_context',
      'TenantContext.authority must be an array of claims',
    );
  }
}

/** Requires an exact authority claim (throws `forbidden`). */
export function requireUnifiedAuthority(ctx: { authority: string[] }, claim: string): void {
  if (!ctx.authority.includes(claim)) {
    throw new UnifiedIdentityError(
      'forbidden',
      `this operation requires the '${claim}' authority claim`,
    );
  }
}
