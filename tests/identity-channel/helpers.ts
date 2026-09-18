// Shared end-to-end fixtures for W045 — Identity/Channel Verification
// (tests/identity-channel/**; the cross-module fixture directory the
// IMPLEMENTATION-STACK §7 doctrine reserves for verification items).
//
// W045: "End-to-end test that the same employee can communicate across
//  multiple providers while permissions remain consistent."
//
// The helpers here stage the full cross-module journey every W045 test
// builds on, exercising the modules EXACTLY through their public contracts
// (scope rule: cross-module imports target `src/modules/<m>/contract.ts`
// only — nothing else is imported here):
//
//   people        — the employee record (person + employment)
//   channels      — provider webhook ingestion, verification-challenge
//                   delivery over each provider, outbound sends
//   identity      — on-sight registration, challenge verification,
//                   linking, revocation (the W002 workflow)
//   conversations — the canonical transcript the turns land in
//
// The journey is deliberately provider-realistic: every inbound turn is a
// RAW provider webhook payload (WhatsApp Cloud API envelope, Telegram Bot
// API update, Slack Events API callback, inbound-email webhook JSON), and
// every verification code travels through the provider-neutral transport
// port the way a real delivery would — the test reads it off the wire
// exactly like the account holder reads it off their phone.
//
// Fake credentials (challenge codes, secret-store references) only ever
// exist at runtime inside these tests — they are minted by the identity
// module, carried by the transport, and never persisted (the transcript
// redaction the channels module enforces is asserted in the tests).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  completeIdentityChallenge,
  deliverIdentityChallenge,
  receiveInbound,
  registerChannelConnection,
  setChannelTransport,
  type ChallengeDeliveryResult,
  type ChannelConnection,
  type ChannelProvider,
  type ChannelTransport,
  type CanonicalDeliveryRequest,
  type InboundResult,
  type TransportReceipt,
} from '@/modules/channels/contract';
import {
  linkExternalIdentity,
  createEmployee,
  createPerson,
  type Employee,
  type LinkExternalIdentityResult,
  type Person,
} from '@/modules/people/contract';
import type { ExternalIdentity } from '@/modules/identity/contract';
import { runMigrations } from '../../scripts/migrate';

// ---------------------------------------------------------------------------
// Tenant contexts (explicit, never ambient — IMPLEMENTATION-STACK §8)
// ---------------------------------------------------------------------------

/** A plain tenant member: no authority claims at all. */
export function memberContext(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

/**
 * The tenant's identity administrator: the interim authority claims the
 * identity module's verified-linking workflow requires (identity:attest /
 * identity:link — folded into the W009 matrix later).
 */
export function identityAdminContext(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: ['identity:attest', 'identity:link'] };
}

/** A principal allowed to administer the tenant's W009 authority matrix. */
export function policyAdminContext(tenantId: string): TenantContext {
  return {
    tenantId,
    principalId: newId(),
    authority: ['identity:attest', 'identity:link', 'actions:administer'],
  };
}

// ---------------------------------------------------------------------------
// The provider-neutral transport port (the "wire" the tests read codes off)
// ---------------------------------------------------------------------------

/**
 * A provider-neutral transport that records every delivery request and
 * accepts everything — the stand-in for the real provider APIs. Every
 * accepted delivery gets a UNIQUE provider message id so the transcript's
 * (tenant, channel, providerMessageId) dedupe never collides.
 */
export class RecordingTransport implements ChannelTransport {
  readonly requests: CanonicalDeliveryRequest[] = [];
  private static deliveryCounter = 0;

  async deliver(request: CanonicalDeliveryRequest): Promise<TransportReceipt> {
    this.requests.push(request);
    RecordingTransport.deliveryCounter += 1;
    return {
      status: 'delivered',
      providerMessageId: `w045-wire-${String(RecordingTransport.deliveryCounter).padStart(6, '0')}`,
      detail: null,
    };
  }
}

/** Extracts the single-use verification code a provider message carried. */
export function challengeCodeFrom(messageText: string): string {
  const match = /(\d{6})/.exec(messageText);
  if (match === null) {
    throw new Error(`the delivered provider message carried no 6-digit code: '${messageText}'`);
  }
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Raw provider webhook payloads (realistic shapes; see the channels
// adapters — these never cross any contract as anything but `unknown`)
// ---------------------------------------------------------------------------

// All personas share this base instant; a turn's `seq` offsets it by seconds
// so every turn carries a DISTINCT, increasing sender clock (the transcript
// orders by sentAt — deterministic ordering keeps the journey assertions
// meaningful rather than uuid-tie-broken).
const BASE_EPOCH_SECONDS = 1_760_426_100; // 2026-09-14T09:15:00Z

/** `seq` seconds after the base instant, as an RFC 2822 date (email style). */
function rfc2822At(seq: number): string {
  return new Date((BASE_EPOCH_SECONDS + seq) * 1_000).toUTCString();
}

/** WhatsApp Cloud API webhook envelope (text message from `from`). */
export function whatsappWebhook(options: {
  from: string;
  text: string;
  wamid: string;
  displayName?: string;
  businessNumber?: string;
  timestamp?: number;
}): Record<string, unknown> {
  const business = (options.businessNumber ?? '+15550100001').replace('+', '');
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: business },
              contacts: [
                {
                  profile: { name: options.displayName ?? 'Maya Chen' },
                  wa_id: options.from.replace('+', ''),
                },
              ],
              messages: [
                {
                  from: options.from.replace('+', ''),
                  id: options.wamid,
                  timestamp: options.timestamp ?? BASE_EPOCH_SECONDS,
                  type: 'text',
                  text: { body: options.text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Telegram Bot API `update` (private-chat text message). */
export function telegramUpdate(options: {
  userId: number;
  chatId: number;
  messageId: number;
  text: string;
  displayName?: string;
  date?: number;
}): Record<string, unknown> {
  return {
    message: {
      message_id: options.messageId,
      from: { id: options.userId, first_name: options.displayName ?? 'Maya', last_name: 'Chen' },
      chat: { id: options.chatId, type: 'private' },
      date: options.date ?? BASE_EPOCH_SECONDS,
      text: options.text,
    },
  };
}

/** Slack Events API event_callback (a member message in a channel). */
export function slackEvent(options: {
  userId: string;
  channelId: string;
  text: string;
  ts: string;
  teamId?: string;
}): Record<string, unknown> {
  return {
    type: 'event_callback',
    team_id: options.teamId ?? 'TACME0001',
    event: {
      type: 'message',
      user: options.userId,
      text: options.text,
      ts: options.ts,
      channel: options.channelId,
    },
  };
}

/** Inbound-email webhook JSON (SendGrid Inbound Parse / SES receipt style). */
export function emailWebhook(options: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId: string;
  date?: string;
}): Record<string, unknown> {
  return {
    from: options.from,
    to: options.to,
    subject: options.subject,
    text: options.text,
    messageId: options.messageId,
    date: options.date ?? rfc2822At(0),
  };
}

// ---------------------------------------------------------------------------
// The employee's provider personas (one human, four channel accounts)
// ---------------------------------------------------------------------------

export interface ProviderPersona {
  provider: ChannelProvider;
  /** Canonical account id of the EMPLOYEE on this provider (adapter-normalized). */
  account: string;
  /** The tenant's own sending endpoint on this provider (a ChannelConnection). */
  connectionAccount: string;
  connectionName: string;
  /**
   * Builds the RAW provider webhook payload for one inbound turn of this
   * persona. `text` is what the employee says; `seq` keeps the provider's
   * own message id unique across turns (redelivery dedupe) AND offsets the
   * sender clock so every turn's sentAt is distinct and increasing.
   */
  inbound: (text: string, seq: number) => unknown;
}

/** Maya Chen's channel footprint: four providers, one human. */
export function providerPersonas(): ProviderPersona[] {
  return [
    {
      provider: 'whatsapp',
      account: '+15550102299',
      connectionAccount: '+15550100001',
      connectionName: 'Acme WhatsApp line',
      inbound: (text, seq) =>
        whatsappWebhook({
          from: '+15550102299',
          text,
          wamid: `wamid.W045.WA.${String(seq).padStart(4, '0')}`,
          displayName: 'Maya Chen',
          timestamp: BASE_EPOCH_SECONDS + seq,
        }),
    },
    {
      provider: 'telegram',
      account: '77123456',
      connectionAccount: '700100200',
      connectionName: 'Acme Telegram bot',
      inbound: (text, seq) =>
        telegramUpdate({
          userId: 77123456,
          chatId: 91000111,
          messageId: 5000 + seq,
          text,
          displayName: 'Maya',
          date: BASE_EPOCH_SECONDS + seq,
        }),
    },
    {
      provider: 'slack',
      account: 'U9MAYA01',
      connectionAccount: 'TAURUM01',
      connectionName: 'Acme Slack workspace',
      inbound: (text, seq) =>
        slackEvent({
          userId: 'U9MAYA01',
          channelId: 'C9ACME01',
          text,
          ts: `${BASE_EPOCH_SECONDS + seq}.000200`,
        }),
    },
    {
      provider: 'email',
      account: 'maya.chen@acme.example',
      connectionAccount: 'aurum@acme.example',
      connectionName: 'Acme Aurum mailbox',
      inbound: (text, seq) =>
        emailWebhook({
          from: 'Maya Chen <maya.chen@acme.example>',
          to: 'aurum@acme.example',
          subject: 'Q3 vendor renewal',
          text,
          messageId: `<w045-email-${String(seq).padStart(4, '0')}@acme.example>`,
          date: rfc2822At(seq),
        }),
    },
  ];
}

// ---------------------------------------------------------------------------
// The end-to-end onboarding journey
// ---------------------------------------------------------------------------

export interface ProviderJourney {
  persona: ProviderPersona;
  /** The tenant's sending endpoint for this provider. */
  connection: ChannelConnection;
  /** First inbound turn: the account is registered on sight, unverified → `external`. */
  firstTurn: InboundResult;
  /** The single-use code delivered over the employee's own channel. */
  challenge: { delivery: ChallengeDeliveryResult; code: string; replyTurn: InboundResult };
  /** Identity state right after the channel-replied code completed verification. */
  verified: ExternalIdentity;
  /** The member-context link attempt that must fail (`forbidden`) — captured, asserted in tests. */
  memberLinkError: unknown;
  /** The admin link through the people contract — the identity becomes the employee's. */
  link: LinkExternalIdentityResult;
}

export interface OnboardingFixture {
  tenantId: string;
  member: TenantContext;
  identityAdmin: TenantContext;
  person: Person;
  employee: Employee;
  /** The transport that was wired during the journey (challenge deliveries). */
  transport: RecordingTransport;
  providers: ProviderJourney[];
}

let journeyCounter = 0;

/**
 * Runs the complete W045 onboarding journey for one employee across all
 * provider personas, strictly through public contracts:
 *
 *   1. the employee exists (person + employment, people contract);
 *   2. each provider gets a tenant-owned sending endpoint (connections);
 *   3. the employee makes first contact over every provider (raw webhooks)
 *      — accounts register on sight, unverified, turns stay `external`;
 *   4. each account is verified by the FULL challenge loop: code delivered
 *      over the account's own channel, account holder replies with the
 *      code over that same channel, the reply completes verification;
 *   5. a plain member may NOT link the identities (uniform `forbidden`);
 *   6. the identity admin links every verified account to the employee.
 *
 * The function captures every intermediate result and performs no
 * assertions — the test files interpret the evidence.
 */
export async function onboardEmployeeAcrossProviders(options: {
  tenantId: string;
  fullName: string;
  email?: string;
  title?: string;
  department?: string;
}): Promise<OnboardingFixture> {
  const member = memberContext(options.tenantId);
  const identityAdmin = identityAdminContext(options.tenantId);

  // 1. the employee
  const person = await createPerson(member, {
    fullName: options.fullName,
    email: options.email ?? null,
  });
  const employee = await createEmployee(member, {
    personId: person.id,
    employeeNumber: `ACME-${String(++journeyCounter).padStart(4, '0')}`,
    title: options.title ?? 'Operations Lead',
    department: options.department ?? 'Operations',
    hiredAt: '2024-03-04T00:00:00Z',
  });

  // 2. tenant sending endpoints (one per provider)
  const personas = providerPersonas();
  const connections = new Map<string, ChannelConnection>();
  for (const persona of personas) {
    const { connection } = await registerChannelConnection(member, {
      provider: persona.provider,
      providerAccountId: persona.connectionAccount,
      displayName: persona.connectionName,
      // opaque secret-store reference — never a credential value
      credentialRef: `secret-store://w045/${persona.provider}/${options.tenantId}`,
    });
    connections.set(persona.provider, connection);
  }

  // 3–6. the per-provider journey
  const transport = new RecordingTransport();
  setChannelTransport(transport);
  try {
    const providers: ProviderJourney[] = [];
    for (const [index, persona] of personas.entries()) {
      const base = index * 100;

      // 3. first contact — account registered on sight, unverified
      const firstTurn = await receiveInbound(member, {
        provider: persona.provider,
        payload: persona.inbound(
          index === 0
            ? 'Hi Aurum — this is Maya. I hear you can help me keep vendor renewals on rails?'
            : 'Same question from my other screen — can we track the Q3 renewals here too?',
          base + 1,
        ),
      });

      // 4. the challenge loop over the employee's OWN channel
      const delivery = await deliverIdentityChallenge(member, {
        identityId: firstTurn.identity.id,
      });
      const code = challengeCodeFrom(transport.requests[transport.requests.length - 1]!.message.text);
      const replyTurn = await receiveInbound(member, {
        provider: persona.provider,
        payload: persona.inbound(code, base + 2),
      });
      const verified = await completeIdentityChallenge(member, {
        identityId: firstTurn.identity.id,
        code,
      });

      // 5. a plain member may not link (captured — tests assert `forbidden`)
      let memberLinkError: unknown = null;
      try {
        await linkExternalIdentity(member, {
          personId: person.id,
          identityId: firstTurn.identity.id,
        });
      } catch (error) {
        memberLinkError = error;
      }

      // 6. the identity admin links the verified account to the employee
      const link = await linkExternalIdentity(identityAdmin, {
        personId: person.id,
        identityId: firstTurn.identity.id,
      });

      providers.push({
        persona,
        connection: connections.get(persona.provider)!,
        firstTurn,
        challenge: { delivery, code, replyTurn },
        verified,
        memberLinkError,
        link,
      });
    }
    return {
      tenantId: options.tenantId,
      member,
      identityAdmin,
      person,
      employee,
      transport,
      providers,
    };
  } finally {
    setChannelTransport(null);
  }
}

/** Boots the embedded database and applies every module migration (idempotent). */
export async function prepareDatabase(): Promise<void> {
  await runMigrations(getDb());
}

/** Closes the embedded database (call from afterAll). */
export async function teardownDatabase(): Promise<void> {
  setChannelTransport(null);
  await closeDb();
}
