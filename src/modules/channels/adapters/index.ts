// The canonical adapter registry (MODULE-INTERNAL).
//
// Exactly one adapter per canonical provider (the identity module's
// CHANNEL_PROVIDERS vocabulary, W002/ADR-0015). Adapters are private to the
// channels module: the contract speaks only canonical types, so swapping a
// provider implementation (or adding one) never touches a domain contract.

import type { ChannelProvider } from '@/modules/identity/contract';
import { ChannelsError } from '../errors';
import { facebookAdapter } from './facebook';
import { instagramAdapter } from './instagram';
import { linkedinAdapter } from './linkedin';
import { signalAdapter } from './signal';
import { slackAdapter } from './slack';
import { smsAdapter } from './sms';
import { telegramAdapter } from './telegram';
import type { ChannelAdapter } from './types';
import { voiceAdapter } from './voice';
import { whatsappAdapter } from './whatsapp';
import { xAdapter } from './x';
import { emailAdapter } from './email';
import { webAdapter } from './web';

const ADAPTERS: Record<ChannelProvider, ChannelAdapter> = {
  whatsapp: whatsappAdapter,
  telegram: telegramAdapter,
  signal: signalAdapter,
  slack: slackAdapter,
  x: xAdapter,
  instagram: instagramAdapter,
  facebook: facebookAdapter,
  linkedin: linkedinAdapter,
  email: emailAdapter,
  sms: smsAdapter,
  voice: voiceAdapter,
  web: webAdapter,
};

/** The adapter of a canonical provider (never null — the vocabulary is closed). */
export function getChannelAdapter(provider: string): ChannelAdapter {
  const adapter = (ADAPTERS as Record<string, ChannelAdapter | undefined>)[provider];
  if (adapter === undefined) {
    throw new ChannelsError(
      'invalid_channel_input',
      `unsupported channel provider '${provider}'`,
    );
  }
  return adapter;
}

/** Every canonical provider has an adapter (exhaustiveness guard). */
export function allChannelAdapters(): ChannelAdapter[] {
  return Object.values(ADAPTERS);
}
