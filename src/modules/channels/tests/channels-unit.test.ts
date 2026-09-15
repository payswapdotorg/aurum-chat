// Unit tests for the channels module's pure logic (no database): input
// validation/normalization, the canonical-content guards, and EVERY
// provider adapter's parse/normalize/format behavior.
//
// W030 acceptance covered here:
//  * canonical adapters exist for all twelve providers (WhatsApp,
//    Telegram, Signal, Slack, X, Instagram, Facebook/Messenger, LinkedIn,
//    email, SMS/voice and web — the identity module's closed provider
//    vocabulary);
//  * provider payloads normalize into canonical communication events
//    (account ids, thread anchors, message ids, sender clocks, canonical
//    content) and malformed/recognized-but-non-message envelopes fail with
//    the canonical error codes;
//  * provider isolation: adapter files are reachable only inside the
//    module (tests import them directly — the contract never exposes them)
//    and the registry is closed over the provider vocabulary.

import { CHANNEL_PROVIDERS } from '@/modules/identity/contract';
import { describe, expect, it } from 'vitest';
import { ChannelsError } from '../errors';
import { allChannelAdapters, getChannelAdapter } from '../adapters';
import { facebookAdapter } from '../adapters/facebook';
import { instagramAdapter } from '../adapters/instagram';
import { linkedinAdapter } from '../adapters/linkedin';
import { emailAdapter, normalizeEmailThreadSubject } from '../adapters/email';
import { signalAdapter } from '../adapters/signal';
import { slackAdapter } from '../adapters/slack';
import { smsAdapter } from '../adapters/sms';
import { telegramAdapter } from '../adapters/telegram';
import type { ChannelAdapter } from '../adapters/types';
import { voiceAdapter } from '../adapters/voice';
import { whatsappAdapter } from '../adapters/whatsapp';
import { webAdapter } from '../adapters/web';
import { xAdapter } from '../adapters/x';
import {
  assertChannelsTenantContext,
  isCanonicalContent,
  isUuid,
  validateCanonicalContent,
  validateCanonicalInboundMessage,
  validateCanonicalParty,
  validateCompleteChallengeInput,
  validateDeliverChallengeInput,
  validateListChannelConnectionsQuery,
  validateReceiveInboundInput,
  validateRegisterChannelConnectionInput,
  validateSendOutboundInput,
  validateSetChannelConnectionStatusInput,
} from '../validation';

function expectCode(code: ChannelsError['code'], fn: () => unknown): void {
  try {
    fn();
    throw new Error(`expected ChannelsError('${code}') but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(ChannelsError);
    expect((error as ChannelsError).code).toBe(code);
  }
}

const GOOD_CONTEXT = { tenantId: '11111111-1111-4111-8111-111111111111', principalId: '22222222-2222-4222-8222-222222222222', authority: [] };

// ---------------------------------------------------------------------------
// Tenant context + shape guards
// ---------------------------------------------------------------------------

describe('channels validation — context and guards', () => {
  it('accepts a well-formed TenantContext and rejects malformed ones', () => {
    expect(() => assertChannelsTenantContext(GOOD_CONTEXT)).not.toThrow();
    expectCode('invalid_context', () =>
      assertChannelsTenantContext({ ...GOOD_CONTEXT, tenantId: '  ' }),
    );
    expectCode('invalid_context', () =>
      assertChannelsTenantContext({ ...GOOD_CONTEXT, principalId: '' }),
    );
    expectCode('invalid_context', () =>
      assertChannelsTenantContext({ ...GOOD_CONTEXT, authority: 'admin' as unknown as string[] }),
    );
  });

  it('isUuid accepts uuids only', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Connection inputs
// ---------------------------------------------------------------------------

describe('channels validation — connections', () => {
  it('validates register inputs strictly (unknown keys, provider, shapes)', () => {
    const valid = validateRegisterChannelConnectionInput({
      provider: 'whatsapp',
      providerAccountId: '15551234567',
      displayName: '  Ops WhatsApp  ',
      credentialRef: 'secret-store://whatsapp/ops',
    });
    expect(valid).toEqual({
      provider: 'whatsapp',
      providerAccountId: '15551234567',
      displayName: 'Ops WhatsApp',
      credentialRef: 'secret-store://whatsapp/ops',
    });

    expectCode('invalid_channel_input', () =>
      validateRegisterChannelConnectionInput({ provider: 'carrier-pigeon', providerAccountId: 'x', credentialRef: 'r' } as never),
    );
    expectCode('invalid_channel_input', () =>
      validateRegisterChannelConnectionInput({ provider: 'slack', providerAccountId: '', credentialRef: 'r' }),
    );
    expectCode('invalid_channel_input', () =>
      validateRegisterChannelConnectionInput({ provider: 'slack', providerAccountId: 'U123', credentialRef: '', displayName: null }),
    );
    expectCode('invalid_channel_input', () =>
      validateRegisterChannelConnectionInput({ provider: 'slack', providerAccountId: 'U123', credentialRef: 'r', tenantId: '11111111-1111-4111-8111-111111111111' } as never),
    );
    expectCode('invalid_channel_input', () =>
      validateRegisterChannelConnectionInput({
        provider: 'slack',
        providerAccountId: 'U123',
        credentialRef: 'r',
        displayName: 'x'.repeat(201),
      }),
    );
  });

  it('validates list queries (filters, limits, unknown fields)', () => {
    expect(validateListChannelConnectionsQuery({})).toEqual({
      provider: null,
      status: null,
      limit: 50,
    });
    expect(
      validateListChannelConnectionsQuery({ provider: 'email', status: 'disabled', limit: 500 }),
    ).toEqual({ provider: 'email', status: 'disabled', limit: 500 });
    expectCode('invalid_channel_query', () => validateListChannelConnectionsQuery({ nope: 1 } as never));
    expectCode('invalid_channel_query', () => validateListChannelConnectionsQuery({ provider: 'x-com' } as never));
    expectCode('invalid_channel_query', () => validateListChannelConnectionsQuery({ status: 'paused' } as never));
    expectCode('invalid_channel_query', () => validateListChannelConnectionsQuery({ limit: 0 }));
    expectCode('invalid_channel_query', () => validateListChannelConnectionsQuery({ limit: 501 }));
  });

  it('validates status transitions', () => {
    expect(
      validateSetChannelConnectionStatusInput({
        connectionId: '11111111-1111-4111-8111-111111111111',
        status: 'disabled',
      }),
    ).toEqual({ connectionId: '11111111-1111-4111-8111-111111111111', status: 'disabled' });
    expectCode('invalid_channel_input', () =>
      validateSetChannelConnectionStatusInput({ connectionId: 'zzz', status: 'active' }),
    );
    expectCode('invalid_channel_input', () =>
      validateSetChannelConnectionStatusInput({
        connectionId: '11111111-1111-4111-8111-111111111111',
        status: 'paused',
      } as never),
    );
  });
});

// ---------------------------------------------------------------------------
// Canonical content
// ---------------------------------------------------------------------------

describe('channels validation — canonical content', () => {
  it('accepts text, attachments and both — never neither', () => {
    expect(validateCanonicalContent({ text: 'hello', attachments: [] })).toEqual({
      text: 'hello',
      attachments: [],
    });
    const media = validateCanonicalContent({
      text: null,
      attachments: [{ kind: 'image', reference: 'https://cdn.example/x.png' }],
    });
    expect(media.attachments[0]).toMatchObject({
      kind: 'image',
      reference: 'https://cdn.example/x.png',
      mimeType: null,
      caption: null,
      transcript: null,
    });
    expectCode('invalid_channel_input', () => validateCanonicalContent({}));
    expectCode('invalid_channel_input', () => validateCanonicalContent({ text: '   ', attachments: [] }));
  });

  it('enforces attachment and text bounds', () => {
    expectCode('invalid_channel_input', () => validateCanonicalContent({ text: 'x'.repeat(16_385) }));
    expectCode('invalid_channel_input', () =>
      validateCanonicalContent({
        text: null,
        attachments: Array.from({ length: 21 }, (_, i) => ({ kind: 'image', reference: `r${i}` })),
      }),
    );
    expectCode('invalid_channel_input', () =>
      validateCanonicalContent({ text: 'a', attachments: [{ kind: 'sticker', reference: 'r' }] }),
    );
    expectCode('invalid_channel_input', () =>
      validateCanonicalContent({ text: 'a', attachments: [{ kind: 'image', reference: 'x'.repeat(2_049) }] }),
    );
    expectCode('invalid_channel_input', () =>
      validateCanonicalContent({ text: 'a', attachments: [{ kind: 'image', reference: 'bad\u0007ref' }] }),
    );
  });

  it('rejects payloads whose serialized form exceeds the content budget', () => {
    expectCode('invalid_channel_input', () =>
      validateCanonicalContent({ text: 'x'.repeat(300_000) }),
    );
  });

  it('isCanonicalContent is a structural guard', () => {
    expect(isCanonicalContent({ text: 'ok' })).toBe(true);
    expect(isCanonicalContent({ text: null, attachments: [] })).toBe(false);
    expect(isCanonicalContent('nope')).toBe(false);
  });

  it('validates canonical parties', () => {
    expect(validateCanonicalParty({ providerAccountId: '+15551234567', displayName: ' Ops ' }, 'to')).toEqual({
      providerAccountId: '+15551234567',
      displayName: 'Ops',
    });
    expectCode('invalid_channel_input', () => validateCanonicalParty({ providerAccountId: '' }, 'to'));
    expectCode('invalid_channel_input', () => validateCanonicalParty({ providerAccountId: 'a', extra: 1 }, 'to') as never);
  });
});

// ---------------------------------------------------------------------------
// Inbound + outbound + challenge inputs
// ---------------------------------------------------------------------------

describe('channels validation — inbound, outbound and challenges', () => {
  it('validates inbound envelopes (provider, plain-JSON object, size)', () => {
    const valid = validateReceiveInboundInput({ provider: 'whatsapp', payload: { a: 1 } });
    expect(valid).toEqual({ provider: 'whatsapp', payload: { a: 1 } });
    expectCode('invalid_channel_input', () => validateReceiveInboundInput({ provider: 'nope', payload: {} } as never));
    expectCode('invalid_channel_input', () => validateReceiveInboundInput({ provider: 'web', payload: [] as unknown }));
    expectCode('invalid_channel_input', () => validateReceiveInboundInput({ provider: 'web', payload: 'text' as unknown }));
    expectCode('invalid_channel_input', () =>
      validateReceiveInboundInput({ provider: 'web', payload: { text: 'x'.repeat(1_100_000) } }),
    );
    expectCode('invalid_channel_input', () => validateReceiveInboundInput({ provider: 'web', payload: { a: 1 }, extra: true } as never));
  });

  it('re-validates adapter output (defense in depth)', () => {
    const good = validateCanonicalInboundMessage({
      provider: 'sms',
      providerAccountId: '+15551234567',
      displayName: null,
      providerMessageId: 'SM1',
      sentAt: null,
      providerThreadKey: 'sms:1',
      threadTitle: null,
      content: { text: 'hi', attachments: [] },
    });
    expect(good.providerAccountId).toBe('+15551234567');
    expectCode('invalid_provider_payload', () =>
      validateCanonicalInboundMessage({ provider: 'sms', providerAccountId: '+15551234567', content: { text: null, attachments: [] } } as never),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalInboundMessage({
        provider: 'carrier-pigeon',
        providerAccountId: 'x',
        content: { text: 'hi' },
      } as never),
    );
    expectCode('invalid_provider_payload', () =>
      validateCanonicalInboundMessage({
        provider: 'sms',
        providerAccountId: '+15551234567',
        sentAt: '14/09/2026',
        content: { text: 'hi' },
      } as never),
    );
  });

  it('validates outbound inputs', () => {
    const valid = validateSendOutboundInput({
      provider: 'email',
      to: { providerAccountId: 'Erin.Chu@Corp.com', displayName: 'Erin' },
      content: { text: 'quarterly numbers', attachments: [] },
      subject: ' Q4 ',
      conversationId: null,
    });
    expect(valid.subject).toBe('Q4');
    expect(valid.to.providerAccountId).toBe('Erin.Chu@Corp.com');
    expectCode('invalid_channel_input', () =>
      validateSendOutboundInput({ provider: 'email', to: { providerAccountId: 'e@x.com' }, content: {} } as never),
    );
    expectCode('invalid_channel_input', () =>
      validateSendOutboundInput({
        provider: 'email',
        to: { providerAccountId: 'e@x.com' },
        content: { text: 'hi' },
        connectionId: 'nope',
      } as never),
    );
  });

  it('validates challenge delivery and completion inputs', () => {
    const identityId = '11111111-1111-4111-8111-111111111111';
    expect(validateDeliverChallengeInput({ identityId })).toEqual({
      identityId,
      connectionId: null,
      ttlSeconds: null,
    });
    expect(validateDeliverChallengeInput({ identityId, ttlSeconds: 86400, connectionId: identityId })).toEqual({
      identityId,
      connectionId: identityId,
      ttlSeconds: 86400,
    });
    expectCode('invalid_channel_input', () => validateDeliverChallengeInput({ identityId: 'zz', ttlSeconds: null }));
    expectCode('invalid_channel_input', () => validateDeliverChallengeInput({ identityId, ttlSeconds: 29 }));
    expectCode('invalid_channel_input', () => validateDeliverChallengeInput({ identityId, ttlSeconds: 86_401 }));
    expectCode('invalid_channel_input', () => validateDeliverChallengeInput({ identityId, ttlSeconds: 90.5 }));

    expect(validateCompleteChallengeInput({ identityId, code: ' 123456 ' })).toEqual({
      identityId,
      code: '123456',
    });
    expectCode('invalid_channel_input', () => validateCompleteChallengeInput({ identityId, code: '  ' }));
  });
});

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

describe('channels adapter registry', () => {
  it('exposes exactly one adapter per canonical provider', () => {
    expect(allChannelAdapters()).toHaveLength(CHANNEL_PROVIDERS.length);
    for (const provider of CHANNEL_PROVIDERS) {
      expect(getChannelAdapter(provider).provider).toBe(provider);
    }
  });

  it('rejects unknown providers', () => {
    expectCode('invalid_channel_input', () => getChannelAdapter('carrier-pigeon'));
  });
});

// ---------------------------------------------------------------------------
// WhatsApp
// ---------------------------------------------------------------------------

describe('whatsapp adapter', () => {
  const adapter = whatsappAdapter;
  const payload = {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: '15550100000' },
              contacts: [{ profile: { name: 'Alice Wong' }, wa_id: '15551234567' }],
              messages: [
                {
                  from: '15551234567',
                  id: 'wamid.HBgLMTU1NTEyMzQ1Njc',
                  timestamp: '1760426100',
                  type: 'text',
                  text: { body: 'supplier meeting moved to Friday' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  it('normalizes a Cloud API text webhook into a canonical event', () => {
    const event = adapter.parseInbound(payload);
    expect(event).toMatchObject({
      provider: 'whatsapp',
      providerAccountId: '+15551234567',
      displayName: 'Alice Wong',
      providerMessageId: 'wamid.HBgLMTU1NTEyMzQ1Njc',
      sentAt: new Date(1_760_426_100_000).toISOString(),
      providerThreadKey: '+15550100000|+15551234567',
      threadTitle: null,
    });
    expect(event.content).toEqual({ text: 'supplier meeting moved to Friday', attachments: [] });
  });

  it('normalizes media and location messages', () => {
    const media = adapter.parseInbound({
      entry: [{ changes: [{ value: { metadata: { display_phone_number: '15550100000' }, messages: [{ from: '15551234567', id: 'wamid.2', timestamp: '1760426100', type: 'image', image: { id: 'media-9', mime_type: 'image/jpeg', caption: 'the invoice' } }] } }] }],
    });
    expect(media.content.attachments).toEqual([
      { kind: 'image', reference: 'media-9', mimeType: 'image/jpeg', caption: 'the invoice', transcript: null },
    ]);

    const location = adapter.parseInbound({
      entry: [{ changes: [{ value: { metadata: { display_phone_number: '15550100000' }, messages: [{ from: '15551234567', id: 'wamid.3', timestamp: '1760426100', type: 'location', location: { latitude: 47.3769, longitude: 8.5417 } }] } }] }],
    });
    expect(location.content.attachments[0]).toMatchObject({ kind: 'location', reference: 'geo:47.3769,8.5417' });
  });

  it('classifies status webhooks as unsupported events and malformed envelopes as invalid payloads', () => {
    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.1', status: 'delivered' }] } }] }] }),
    );
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ entry: [{ changes: [{ value: { messages: [{ timestamp: '1760426100', type: 'text', text: { body: 'x' } }] } }] }] }),
    );
    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ entry: [{ changes: [{ value: { messages: [{ from: '15551234567', id: 'wamid.9', timestamp: '1760426100', type: 'sticker', sticker: { id: 's1' } }] } }] }] }),
    );
  });

  it('normalizes account ids to E.164', () => {
    expect(adapter.normalizeAccountId(' 1555 123 4567 ')).toBe('+15551234567');
    expect(adapter.normalizeAccountId('+15551234567')).toBe('+15551234567');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('not-a-number'));
  });

  it('formats verification and message turns', () => {
    expect(adapter.formatOutbound({ purpose: 'verification', code: '123456', recipientName: null }).text).toContain('123456');
    expect(
      adapter.formatOutbound({
        purpose: 'message',
        content: { text: 'hello', attachments: [] },
        subject: null,
        recipientName: null,
      }),
    ).toEqual({ text: 'hello', subject: null, attachments: [] });
  });
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

describe('telegram adapter', () => {
  const adapter = telegramAdapter;
  const payload = {
    message: {
      message_id: 42,
      from: { id: 98765, first_name: 'Bob', last_name: 'Tan', username: 'bobtan' },
      chat: { id: -100123, type: 'private' },
      date: 1_760_426_100,
      text: 'the shipment landed',
    },
  };

  it('normalizes a Bot API update into a canonical event', () => {
    const event = adapter.parseInbound(payload);
    expect(event).toMatchObject({
      provider: 'telegram',
      providerAccountId: '98765',
      displayName: 'Bob Tan',
      providerMessageId: '-100123:42',
      sentAt: new Date(1_760_426_100_000).toISOString(),
      providerThreadKey: 'chat:-100123',
    });
    expect(event.content.text).toBe('the shipment landed');
  });

  it('picks the largest photo size and reads voice/document media', () => {
    const photo = adapter.parseInbound({
      message: {
        message_id: 43,
        from: { id: 98765 },
        chat: { id: -100123 },
        date: 1_760_426_100,
        caption: 'site photo',
        photo: [
          { file_id: 'small', width: 320 },
          { file_id: 'large', width: 1280 },
        ],
      },
    });
    expect(photo.content.text).toBe('site photo');
    expect(photo.content.attachments).toEqual([
      { kind: 'image', reference: 'large', mimeType: null, caption: null, transcript: null },
    ]);

    const voice = adapter.parseInbound({
      message: {
        message_id: 44,
        from: { id: 98765 },
        chat: { id: -100123 },
        date: 1_760_426_100,
        voice: { file_id: 'v1', mime_type: 'audio/ogg', duration: 12 },
      },
    });
    expect(voice.content.attachments[0]).toMatchObject({ kind: 'audio', reference: 'v1', mimeType: 'audio/ogg' });
  });

  it('rejects non-message updates and malformed envelopes', () => {
    expectCode('unsupported_provider_event', () => adapter.parseInbound({ edited_message: { message_id: 1 } }));
    expectCode('unsupported_provider_event', () => adapter.parseInbound({ callback_query: { id: 'q1' } }));
    expectCode('invalid_provider_payload', () => adapter.parseInbound({ message: { message_id: 42, chat: { id: 1 }, date: 1, text: 'x' } }));
  });

  it('normalizes numeric account ids', () => {
    expect(adapter.normalizeAccountId(' 98765 ')).toBe('98765');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('@bobtan'));
  });
});

// ---------------------------------------------------------------------------
// Signal
// ---------------------------------------------------------------------------

describe('signal adapter', () => {
  const adapter = signalAdapter;

  it('normalizes a signal-cli envelope into a canonical event', () => {
    const event = adapter.parseInbound({
      envelope: {
        sourceNumber: '+15551234567',
        sourceName: 'Carol Diaz',
        timestamp: 1_760_426_100_123,
        message: 'the permits cleared',
        attachments: [{ contentType: 'application/pdf', id: 'attachment-1' }],
      },
    });
    expect(event).toMatchObject({
      provider: 'signal',
      providerAccountId: '+15551234567',
      displayName: 'Carol Diaz',
      providerMessageId: 'signal:+15551234567:1760426100123',
      sentAt: new Date(1_760_426_100_123).toISOString(),
      providerThreadKey: '+15551234567',
    });
    expect(event.content.attachments[0]).toMatchObject({ kind: 'document', mimeType: 'application/pdf' });
  });

  it('rejects envelopes without content', () => {
    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ envelope: { sourceNumber: '+15551234567', timestamp: 1 } }),
    );
    expectCode('invalid_provider_payload', () => adapter.parseInbound({ envelope: { timestamp: 1, message: 'x' } }));
  });

  it('normalizes account ids to E.164', () => {
    expect(adapter.normalizeAccountId('15551234567')).toBe('+15551234567');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('not-a-number'));
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

describe('slack adapter', () => {
  const adapter = slackAdapter;
  const payload = {
    type: 'event_callback',
    team_id: 'T1234TEAM',
    event: {
      type: 'message',
      user: 'U123ABC',
      text: 'deploy finished',
      ts: '1760426100.001500',
      channel: 'C456DEF',
      files: [{ url_private: 'https://files.example/build.log.png', mimetype: 'image/png', name: 'build.png' }],
    },
  };

  it('normalizes an Events API message into a canonical event', () => {
    const event = adapter.parseInbound(payload);
    expect(event).toMatchObject({
      provider: 'slack',
      providerAccountId: 'U123ABC',
      providerMessageId: 'C456DEF.1760426100.001500',
      sentAt: new Date(1_760_426_100_001).toISOString(),
      providerThreadKey: 'C456DEF',
    });
    expect(event.content.attachments[0]).toMatchObject({
      kind: 'image',
      reference: 'https://files.example/build.log.png',
      caption: 'build.png',
    });
  });

  it('classifies handshakes, non-message events and edits as unsupported; wrong envelopes as invalid', () => {
    expectCode('unsupported_provider_event', () => adapter.parseInbound({ type: 'url_verification', challenge: 'abc' }));
    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ type: 'event_callback', event: { type: 'app_mention', user: 'U1', ts: '1.2', channel: 'C1' } }),
    );
    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ type: 'event_callback', event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '1.2' } }),
    );
    expectCode('invalid_provider_payload', () => adapter.parseInbound({ type: 'event', event: { type: 'message' } }));
  });

  it('drops files whose urls were withheld but keeps the turn', () => {
    const event = adapter.parseInbound({
      type: 'event_callback',
      event: { type: 'message', user: 'U123ABC', text: 'see file', ts: '1760426100.0001', channel: 'C456DEF', files: [{ name: 'no-access.bin' }] },
    });
    expect(event.content.attachments).toEqual([]);
    expect(event.content.text).toBe('see file');
  });

  it('normalizes uppercase-alphanumeric account ids', () => {
    expect(adapter.normalizeAccountId('U123ABC')).toBe('U123ABC');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('user-1'));
  });
});

// ---------------------------------------------------------------------------
// X
// ---------------------------------------------------------------------------

describe('x adapter', () => {
  const adapter = xAdapter;
  const payload = {
    direct_message_events: [
      {
        id: '1500000000000000000',
        created_timestamp: '1760426100123',
        text: 'the competitor slashed prices',
        sender_id: '224466',
        recipient_id: '112233',
        attachment: { media: { type: 'photo', media_url_https: 'https://pbs.example/9.png' } },
      },
    ],
    users: { '224466': { name: 'Dana Reed', screen_name: 'danareed' } },
  };

  it('normalizes a DM webhook into a canonical event with a pairwise thread key', () => {
    const event = adapter.parseInbound(payload);
    expect(event).toMatchObject({
      provider: 'x',
      providerAccountId: '224466',
      displayName: 'Dana Reed',
      providerMessageId: '1500000000000000000',
      sentAt: new Date(1_760_426_100_123).toISOString(),
      providerThreadKey: '112233|224466',
    });
    expect(event.content.attachments[0]).toMatchObject({ kind: 'image', reference: 'https://pbs.example/9.png' });
  });

  it('rejects non-DM envelopes and malformed ids', () => {
    expectCode('unsupported_provider_event', () => adapter.parseInbound({ tweet_create_events: [{ id: '1' }] }));
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ direct_message_events: [{ id: '1', created_timestamp: '1', sender_id: 'abc!', recipient_id: '2', text: 'x' }] }),
    );
  });

  it('normalizes numeric account ids', () => {
    expect(adapter.normalizeAccountId('224466')).toBe('224466');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('danareed'));
  });
});

// ---------------------------------------------------------------------------
// Instagram + Facebook (Messenger platform shape)
// ---------------------------------------------------------------------------

describe('instagram adapter', () => {
  const adapter = instagramAdapter;

  it('normalizes an Instagram Messaging webhook into a canonical event', () => {
    const event = adapter.parseInbound({
      entry: [
        {
          messaging: [
            {
              sender: { id: '771100' },
              recipient: { id: '178900' },
              timestamp: 1_760_426_100_123,
              message: { mid: 'm_9x', text: 'the reel is live' },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({
      provider: 'instagram',
      providerAccountId: '771100',
      providerMessageId: 'm_9x',
      sentAt: new Date(1_760_426_100_123).toISOString(),
      providerThreadKey: '178900|771100',
    });
  });

  it('classifies postbacks as unsupported events', () => {
    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ entry: [{ messaging: [{ sender: { id: '1' }, recipient: { id: '2' }, timestamp: 1, postback: { payload: 'GET_STARTED' } }] }] }),
    );
  });

  it('normalizes numeric account ids', () => {
    expect(adapter.normalizeAccountId('771100')).toBe('771100');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('ig-handle'));
  });
});

describe('facebook adapter', () => {
  const adapter = facebookAdapter;

  it('normalizes a Messenger webhook into a canonical event (media + location)', () => {
    const event = adapter.parseInbound({
      entry: [
        {
          messaging: [
            {
              sender: { id: '5150' },
              recipient: { id: '9999' },
              timestamp: 1_760_426_100_123,
              message: {
                mid: 'mid.1700000',
                text: 'on site',
                attachments: [
                  { type: 'image', payload: { url: 'https://cdn.example/site.png' } },
                  { type: 'location', payload: { coordinates: { lat: 47.3769, long: 8.5417 } } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(event).toMatchObject({
      provider: 'facebook',
      providerAccountId: '5150',
      providerMessageId: 'mid.1700000',
      providerThreadKey: '5150|9999',
    });
    expect(event.content.attachments).toEqual([
      { kind: 'image', reference: 'https://cdn.example/site.png', mimeType: null, caption: null, transcript: null },
      { kind: 'location', reference: 'geo:47.3769,8.5417', mimeType: null, caption: null, transcript: null },
    ]);
  });

  it('normalizes numeric account ids', () => {
    expect(adapter.normalizeAccountId('5150')).toBe('5150');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('fb-page'));
  });
});

// ---------------------------------------------------------------------------
// LinkedIn
// ---------------------------------------------------------------------------

describe('linkedin adapter', () => {
  const adapter = linkedinAdapter;

  it('normalizes a bridge event into a canonical event', () => {
    const event = adapter.parseInbound({
      conversationId: 'urn:li:messagingThread:abc123',
      senderId: 'member-42',
      sentAt: '2026-10-14T09:00:00Z',
      text: 'the contract draft is attached',
      attachments: [{ kind: 'document', url: 'https://docs.example/draft.pdf', mimeType: 'application/pdf' }],
      messageId: 'urn:li:message:77',
    });
    expect(event).toMatchObject({
      provider: 'linkedin',
      providerAccountId: 'member-42',
      providerMessageId: 'urn:li:message:77',
      sentAt: '2026-10-14T09:00:00.000Z',
      providerThreadKey: 'urn:li:messagingThread:abc123',
    });
    expect(event.content.attachments[0]).toMatchObject({ kind: 'document', mimeType: 'application/pdf' });
  });

  it('synthesizes a message id when the bridge omits one and accepts epoch-millis dates', () => {
    const event = adapter.parseInbound({
      conversationId: 'thread-2',
      senderId: 'member-42',
      sentAt: 1_760_426_100_123,
      text: 'ping',
    });
    expect(event.providerMessageId).toContain('thread-2');
    expect(event.sentAt).toBe(new Date(1_760_426_100_123).toISOString());
  });

  it('rejects contentless events and bad ids', () => {
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ conversationId: 'c1', senderId: 'member-42', sentAt: '2026-10-14T09:00:00Z' }),
    );
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ conversationId: 'c1', senderId: 'has space', text: 'x' }),
    );
  });

  it('normalizes alphanumeric account ids', () => {
    expect(adapter.normalizeAccountId('member-42')).toBe('member-42');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('has space'));
  });
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

describe('email adapter', () => {
  const adapter = emailAdapter;

  it('normalizes an inbound email into a canonical event (lowercase account, subject thread)', () => {
    const event = adapter.parseInbound({
      from: 'Erin Chu <Erin.Chu@Corp.com>',
      to: 'ops@tenant.example',
      subject: 'Re: Q4 planning',
      text: 'the numbers are in',
      messageId: '<abc-123@corp.com>',
      date: 'Mon, 14 Sep 2026 09:15:00 +0000',
      attachments: [{ url: 'https://docs.example/q4.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'q4.xlsx' }],
    });
    expect(event).toMatchObject({
      provider: 'email',
      providerAccountId: 'erin.chu@corp.com',
      displayName: 'Erin Chu',
      providerMessageId: '<abc-123@corp.com>',
      sentAt: '2026-09-14T09:15:00.000Z',
      providerThreadKey: 'subject:q4 planning',
      threadTitle: 'Re: Q4 planning',
    });
    expect(event.content.attachments[0]).toMatchObject({ kind: 'document', caption: 'q4.xlsx' });
  });

  it('threads replies by normalized subject and leaves subjectless mail unthreaded', () => {
    expect(normalizeEmailThreadSubject('RE: re: Fwd: Q4   PLANNING')).toBe('q4 planning');
    const noSubject = adapter.parseInbound({
      from: 'ops@tenant.example',
      to: 'someone@example.com',
      text: 'quick note',
    });
    expect(noSubject.providerThreadKey).toBeNull();
    expect(noSubject.sentAt).toBeNull();
  });

  it('rejects invalid addresses and contentless mail', () => {
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ from: 'not-an-address', to: 'x@y.com', text: 'hi' }),
    );
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ from: 'a@b.com', to: 'c@d.com', date: '2026-09-14T09:15:00Z' }),
    );
  });

  it('normalizes account ids (name + angle brackets stripped, lowercased)', () => {
    expect(adapter.normalizeAccountId('Erin Chu <Erin.Chu@Corp.com>')).toBe('erin.chu@corp.com');
    expect(adapter.normalizeAccountId('Plain@Example.COM')).toBe('plain@example.com');
  });

  it('formats outbound mail with subject defaults', () => {
    const verification = adapter.formatOutbound({ purpose: 'verification', code: '654321', recipientName: null });
    expect(verification.subject).toBe('Your Aurum verification code');
    expect(verification.text).toContain('654321');

    const message = adapter.formatOutbound({
      purpose: 'message',
      content: { text: 'the quarterly numbers are attached', attachments: [] },
      subject: null,
      recipientName: null,
    });
    expect(message.subject).toBe('the quarterly numbers are attached');
  });
});

// ---------------------------------------------------------------------------
// SMS
// ---------------------------------------------------------------------------

describe('sms adapter', () => {
  const adapter = smsAdapter;

  it('normalizes a carrier webhook into a canonical event (no sender clock, pairwise thread)', () => {
    const event = adapter.parseInbound({
      From: '+15551234567',
      To: '+15550100000',
      Body: 'gate code 4711',
      MessageSid: 'SM1234567890abcdef',
    });
    expect(event).toMatchObject({
      provider: 'sms',
      providerAccountId: '+15551234567',
      providerMessageId: 'SM1234567890abcdef',
      sentAt: null,
      providerThreadKey: '+15550100000|+15551234567',
    });
    expect(event.content.text).toBe('gate code 4711');
  });

  it('reads MMS media urls', () => {
    const event = adapter.parseInbound({
      From: '+15551234567',
      To: '+15550100000',
      Body: 'photo',
      MessageSid: 'SM2',
      MediaUrls: ['https://mms.example/1.jpg'],
    });
    expect(event.content.attachments).toEqual([
      { kind: 'document', reference: 'https://mms.example/1.jpg', mimeType: null, caption: null, transcript: null },
    ]);
  });

  it('rejects malformed envelopes', () => {
    expectCode('invalid_provider_payload', () => adapter.parseInbound({ From: 'not-a-number', To: '+15550100000', Body: 'x', MessageSid: 'SM1' }));
    expectCode('invalid_provider_payload', () => adapter.parseInbound([] as unknown));
  });

  it('normalizes account ids to E.164 and keeps verification texts short', () => {
    expect(adapter.normalizeAccountId('+1 (555) 123-4567')).toBe('+15551234567');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('123'));
    const verification = adapter.formatOutbound({ purpose: 'verification', code: '314159', recipientName: null });
    expect(verification.text.length).toBeLessThanOrEqual(160);
    expect(verification.text).toContain('314159');
  });
});

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

describe('voice adapter', () => {
  const adapter = voiceAdapter;

  it('normalizes a speech webhook into a canonical event (transcript + recording)', () => {
    const event = adapter.parseInbound({
      CallSid: 'CA1234567890',
      From: '+15551234567',
      To: '+15550100000',
      SpeechResult: 'please double-check the invoice totals',
      RecordingUrl: 'https://record.example/CA123.mp3',
      Timestamp: '2026-10-14T08:30:00Z',
    });
    expect(event).toMatchObject({
      provider: 'voice',
      providerAccountId: '+15551234567',
      providerMessageId: 'CA1234567890',
      sentAt: '2026-10-14T08:30:00.000Z',
      providerThreadKey: 'CA1234567890',
    });
    expect(event.content.text).toBe('please double-check the invoice totals');
    expect(event.content.attachments).toEqual([
      { kind: 'audio', reference: 'https://record.example/CA123.mp3', mimeType: null, caption: null, transcript: 'please double-check the invoice totals' },
    ]);
  });

  it('accepts recording-only turns and EventKey overrides; classifies status callbacks as unsupported', () => {
    const recordingOnly = adapter.parseInbound({
      CallSid: 'CA2',
      From: '+15551234567',
      To: '+15550100000',
      RecordingUrl: 'https://record.example/CA2.mp3',
    });
    expect(recordingOnly.content.text).toBeNull();
    expect(recordingOnly.sentAt).toBeNull();

    const keyed = adapter.parseInbound({
      CallSid: 'CA3',
      From: '+15551234567',
      To: '+15550100000',
      SpeechResult: 'second turn',
      EventKey: 'CA3:turn-2',
    });
    expect(keyed.providerMessageId).toBe('CA3:turn-2');

    expectCode('unsupported_provider_event', () =>
      adapter.parseInbound({ CallSid: 'CA4', From: '+15551234567', To: '+15550100000', CallStatus: 'completed' }),
    );
  });

  it('formats spoken verification codes with spaced digits', () => {
    const verification = adapter.formatOutbound({ purpose: 'verification', code: '246810', recipientName: null });
    expect(verification.text).toContain('2 4 6 8 1 0');
  });
});

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

describe('web adapter', () => {
  const adapter = webAdapter;

  it('normalizes a widget event into a canonical event (visitor account, session thread)', () => {
    const event = adapter.parseInbound({
      sessionId: 'sess-2026-10-14-1',
      visitorId: 'visitor-9',
      visitorName: 'Frank Ibe',
      messageId: 'web-0001',
      sentAt: '2026-10-14T10:00:00Z',
      text: 'where is the delivery tracker?',
    });
    expect(event).toMatchObject({
      provider: 'web',
      providerAccountId: 'visitor-9',
      displayName: 'Frank Ibe',
      providerMessageId: 'web-0001',
      sentAt: '2026-10-14T10:00:00.000Z',
      providerThreadKey: 'sess-2026-10-14-1',
    });

    const anonymous = adapter.parseInbound({
      sessionId: 'sess-2',
      messageId: 'web-0002',
      sentAt: '2026-10-14T10:01:00Z',
      text: 'hello?',
    });
    expect(anonymous.providerAccountId).toBe('sess-2');
    expect(anonymous.displayName).toBeNull();
  });

  it('rejects malformed events', () => {
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ sessionId: 's', messageId: 'm', sentAt: 'not-a-date', text: 'x' }),
    );
    expectCode('invalid_provider_payload', () =>
      adapter.parseInbound({ sessionId: 's', messageId: 'm', sentAt: '2026-10-14T10:00:00Z' }),
    );
  });

  it('normalizes bounded printable account ids', () => {
    expect(adapter.normalizeAccountId('visitor-9')).toBe('visitor-9');
    expectCode('invalid_channel_input', () => adapter.normalizeAccountId('bad\u0001id'));
  });
});

// ---------------------------------------------------------------------------
// Formatting sweep across every provider (verification codes reach the wire)
// ---------------------------------------------------------------------------

describe('all adapters format verification turns', () => {
  const adapters: Array<[string, ChannelAdapter]> = [
    ['whatsapp', whatsappAdapter],
    ['telegram', telegramAdapter],
    ['signal', signalAdapter],
    ['slack', slackAdapter],
    ['x', xAdapter],
    ['instagram', instagramAdapter],
    ['facebook', facebookAdapter],
    ['linkedin', linkedinAdapter],
    ['email', emailAdapter],
    ['sms', smsAdapter],
    ['voice', voiceAdapter],
    ['web', webAdapter],
  ];

  it('embeds the single-use code in every provider\'s verification text', () => {
    for (const [name, adapter] of adapters) {
      const formatted = adapter.formatOutbound({ purpose: 'verification', code: '135790', recipientName: 'Someone' });
      // voice reads the code with spaced digits for text-to-speech; every
      // other provider embeds it verbatim — both reach the wire.
      expect(
        formatted.text.includes('135790') || formatted.text.includes('1 3 5 7 9 0'),
        name,
      ).toBe(true);
      expect(formatted.attachments, name).toEqual([]);
    }
  });

  it('carries message content and media through every provider', () => {
    for (const [name, adapter] of adapters) {
      const formatted = adapter.formatOutbound({
        purpose: 'message',
        content: {
          text: 'the report',
          attachments: [{ kind: 'document', reference: 'ref-1', mimeType: 'application/pdf', caption: 'report.pdf', transcript: null }],
        },
        subject: 'subject' as string | null,
        recipientName: null,
      });
      expect(formatted.text, name).toBe('the report');
      expect(formatted.attachments, name).toHaveLength(1);
    }
  });
});
