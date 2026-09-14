// Neutral channel-provider vocabulary (ARCHITECTURE.md §9, ADR-0015).
//
// A provider is referenced in domain contracts only by this neutral key.
// Provider SDKs, message objects and account semantics stay inside the
// channels module's adapters (W030); the identity module never learns more
// about a provider than its name and the canonical account identifier the
// adapter supplies. Adding a provider therefore extends this list (a contract
// change); swapping a provider implementation never requires a migration.
//
// NOTE: the CHECK constraint in migrations/001-identities.sql mirrors this
// list — keep both in sync.

import { IdentityError } from './errors';

/** Canonical supported channel providers (ARCHITECTURE.md §9 / W030). */
export const CHANNEL_PROVIDERS = [
  'whatsapp',
  'telegram',
  'signal',
  'slack',
  'x',
  'instagram',
  'facebook',
  'linkedin',
  'email',
  'sms',
  'voice',
  'web',
] as const;

export type ChannelProvider = (typeof CHANNEL_PROVIDERS)[number];

export function isChannelProvider(value: unknown): value is ChannelProvider {
  return typeof value === 'string' && (CHANNEL_PROVIDERS as readonly string[]).includes(value);
}

/** Runtime guard for contract inputs; throws `invalid_identity_input`. */
export function assertChannelProvider(value: unknown): ChannelProvider {
  if (!isChannelProvider(value)) {
    throw new IdentityError(
      'invalid_identity_input',
      `unsupported channel provider '${String(value)}' (supported: ${CHANNEL_PROVIDERS.join(', ')})`,
    );
  }
  return value;
}
