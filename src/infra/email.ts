// Email port: transactional email ONLY (invitations, verification,
// alerts) — never domain truth (ARCHITECTURE-LOCK 35 discipline for
// infrastructure state).
//
// Backends (W069 — plan §7 free-tier dogfood stack):
//   * `resend` — RESEND_API_KEY set: the Resend REST API
//     (https://api.resend.com/emails) via the platform `fetch`. Plain HTTP,
//     no SDK — the adapter is the ONLY place the provider is named, so a
//     different transactional provider is an adapter swap, not a domain
//     change (provider isolation).
//   * `memory` — default dev/test: deliveries are recorded in an
//     in-process outbox (`getMemoryEmailOutbox`) and nothing leaves the
//     machine. Legal for the same reason the queue's memory backend is:
//     email delivery state is not organizational truth.
//
// Usage guardrail (plan §7 "usage guardrails"): the port enforces a daily
// send budget (AURUM_EMAIL_DAILY_LIMIT, default 100 — the Resend Free
// allowance) counted through the cache port, so the limit is shared across
// instances in production (Redis) and per-process in dev. The counter is
// best-effort (read-modify-write, no cross-instance locking): it guards a
// free-tier budget, it is not an accounting ledger. 0 disables the cap.
//
// Observability: counters live in the worker/deployment metrics registry
// (email sent/failed/budget-rejected) surfaced by /api/health.

import { envString } from './config';
import { getCache } from './cache';
import { now } from './clock';
import { newId } from './ids';

/** One transactional email (kept deliberately minimal — plain content, no templates). */
export interface EmailMessage {
  /** Recipient address (validated lightly; the provider re-validates). */
  to: string;
  subject: string;
  /** Plain-text body (always required — HTML is the optional rendering). */
  text: string;
  /** Optional HTML body. */
  html?: string;
  /** Optional Reply-To header. */
  replyTo?: string;
}

/** What a successful send produced (no content echo — receipts only). */
export interface EmailDelivery {
  id: string;
  to: string;
  subject: string;
  provider: 'memory' | 'resend';
  sentAt: string;
}

export type EmailErrorCode = 'invalid_message' | 'budget_exceeded' | 'provider_error';

export class EmailError extends Error {
  constructor(
    public readonly code: EmailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EmailError';
  }
}

export interface EmailPort {
  send(message: EmailMessage): Promise<EmailDelivery>;
}

/** Default From for the Resend backend (overridable via EMAIL_FROM). */
const DEFAULT_RESEND_FROM = 'Aurum <onboarding@resend.dev>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Provider call timeout — a free-tier provider must never wedge a caller. */
const RESEND_TIMEOUT_MS = 10_000;

function isEmailMessage(value: unknown): value is EmailMessage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EmailMessage>;
  return (
    typeof candidate.to === 'string' &&
    candidate.to.trim().length > 3 &&
    candidate.to.includes('@') &&
    typeof candidate.subject === 'string' &&
    candidate.subject.trim().length > 0 &&
    candidate.subject.length <= 998 &&
    typeof candidate.text === 'string' &&
    candidate.text.length > 0 &&
    (candidate.html === undefined || typeof candidate.html === 'string') &&
    (candidate.replyTo === undefined || typeof candidate.replyTo === 'string')
  );
}

interface MemoryOutbox {
  deliveries: EmailDelivery[];
}

function memoryEmailBackend(outbox: MemoryOutbox): EmailPort {
  return {
    async send(message) {
      const delivery: EmailDelivery = {
        id: newId(),
        to: message.to,
        subject: message.subject,
        provider: 'memory',
        sentAt: now().toISOString(),
      };
      outbox.deliveries.push(delivery);
      return delivery;
    },
  };
}

async function resendSend(apiKey: string, from: string, message: EmailMessage): Promise<string> {
  const body: Record<string, string> = {
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
  };
  if (message.html !== undefined) body.html = message.html;
  if (message.replyTo !== undefined) body.reply_to = message.replyTo;

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw new EmailError(
      'provider_error',
      `resend request failed: ${error instanceof Error ? error.message : 'network error'}`,
    );
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new EmailError(
      'provider_error',
      `resend rejected the send (HTTP ${response.status}): ${detail}`,
    );
  }
  const payload = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (payload === null || typeof payload.id !== 'string') {
    throw new EmailError('provider_error', 'resend response did not carry a delivery id');
  }
  return payload.id;
}

/** UTC day bucket for the daily budget counter. */
function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Seconds until the UTC day rolls over (TTL for the counter). */
function secondsUntilUtcDayEnd(at: Date): number {
  const end = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1);
  return Math.max(1, Math.ceil((end - at.getTime()) / 1000));
}

interface EmailGlobal {
  __aurumEmailPort?: EmailPort;
  __aurumEmailOutbox?: MemoryOutbox;
  __aurumEmailDailyLimit?: number;
}
const emailGlobal = globalThis as unknown as EmailGlobal;

/**
 * The transactional email port (singleton; backend chosen once from the
 * environment — RESEND_API_KEY selects Resend, otherwise memory).
 */
export function getEmail(): EmailPort {
  emailGlobal.__aurumEmailPort ??= (() => {
    const apiKey = envString('RESEND_API_KEY');
    if (apiKey === undefined) {
      const outbox: MemoryOutbox = { deliveries: [] };
      emailGlobal.__aurumEmailOutbox = outbox;
      return memoryEmailBackend(outbox);
    }
    const from = envString('EMAIL_FROM') ?? DEFAULT_RESEND_FROM;
    return {
      async send(message) {
        const id = await resendSend(apiKey, from, message);
        return {
          id,
          to: message.to,
          subject: message.subject,
          provider: 'resend',
          sentAt: now().toISOString(),
        };
      },
    };
  })();
  return emailGlobal.__aurumEmailPort;
}

/** The recorded deliveries of the memory backend (empty for Resend — receipts live with the provider). */
export function getMemoryEmailOutbox(): EmailDelivery[] {
  emailGlobal.__aurumEmailOutbox ??= { deliveries: [] };
  return emailGlobal.__aurumEmailOutbox.deliveries;
}

/** Reset the singleton (and the memory outbox) — tests and process shutdown. */
export function closeEmail(): void {
  emailGlobal.__aurumEmailPort = undefined;
  emailGlobal.__aurumEmailOutbox = undefined;
  emailGlobal.__aurumEmailDailyLimit = undefined;
}

/**
 * Send one transactional email with the daily budget guardrail applied.
 * The budget is counted through the cache port (shared when Redis backs
 * it) and only enforced when a positive limit is configured.
 */
export async function sendTransactionalEmail(
  message: EmailMessage,
  dailyLimit: number,
): Promise<EmailDelivery> {
  if (!isEmailMessage(message)) {
    throw new EmailError('invalid_message', 'a valid EmailMessage (to, subject, text) is required');
  }
  if (dailyLimit > 0) {
    const cache = getCache();
    const at = now();
    const key = `email:daily:${dayBucket(at)}`;
    const current = Number.parseInt((await cache.get(key)) ?? '0', 10);
    if (Number.isFinite(current) && current >= dailyLimit) {
      throw new EmailError(
        'budget_exceeded',
        `transactional email daily limit reached (${current}/${dailyLimit}) — raised by AURUM_EMAIL_DAILY_LIMIT when the provider plan allows`,
      );
    }
    await cache.set(key, String(current + 1), secondsUntilUtcDayEnd(at));
  }
  return getEmail().send(message);
}
