// Pure webhook logic of the api module (W038 — Public API): event-type
// pattern matching, the delivery retry/backoff policy, the canonical
// signature scheme and delivery-URL validation. No database, no context —
// everything here is a total function of its arguments, unit-testable in
// isolation (the goals/missions validation precedent).
//
// SIGNATURE SCHEME (the subscriber-facing contract): every delivery attempt
// carries `aurum-webhook-timestamp` (the signing instant, ISO 8601) and
// `aurum-webhook-signature` = hex(HMAC-SHA256(secret,
// `${timestamp}.${body}`)) where `body` is the EXACT byte string POSTed and
// `secret` is the signing secret the subscriber stored when the
// subscription was created (referenced opaquely by `secretRef`; the value
// never reaches any domain table — IMPLEMENTATION-STACK §8). Subscribers
// verify by recomputing the HMAC over the raw request body.

import { createHmac } from 'node:crypto';
import { ApiError } from './errors';
import type { WebhookAttemptOutcome, WebhookTransportReceipt } from './types';

/** Event-type ids share the events module's canonical pattern. */
const EVENT_TYPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Smallest accepted subscription size. */
export const MIN_EVENT_TYPE_PATTERNS = 1;

/** Largest accepted subscription size. */
export const MAX_EVENT_TYPE_PATTERNS = 20;

/** Backoff base for transient failures (seconds). */
export const WEBHOOK_BACKOFF_BASE_SECONDS = 30;

/** Backoff ceiling for transient failures (seconds). */
export const WEBHOOK_BACKOFF_CAP_SECONDS = 3600;

/** Default delivery attempt budget. */
export const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 5;

/** Largest configurable delivery attempt budget. */
export const MAX_WEBHOOK_MAX_ATTEMPTS = 10;

/** Is `type` a canonical event-type id (no wildcard)? */
export function isEventTypeId(value: unknown): boolean {
  return typeof value === 'string' && EVENT_TYPE_ID_PATTERN.test(value);
}

/**
 * A legal subscription pattern: `*` (everything), an exact event-type id,
 * or a dotted-prefix wildcard `prefix.*` (matches `prefix.` + anything).
 */
export function isEventTypePattern(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string') return false;
  if (pattern === '*') return true;
  if (isEventTypeId(pattern)) return true;
  if (pattern.endsWith('.*')) return isEventTypeId(pattern.slice(0, -2));
  return false;
}

/** Does `pattern` match the concrete event `type`? */
export function eventTypeMatches(pattern: string, type: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1); // keep the trailing '.'
    return type.startsWith(prefix) && type.length > prefix.length;
  }
  return pattern === type;
}

/** Validate a subscription's pattern list (throws `invalid_input`). */
export function parseEventTypePatterns(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError('invalid_input', 'eventTypes must be an array of patterns');
  }
  if (value.length < MIN_EVENT_TYPE_PATTERNS || value.length > MAX_EVENT_TYPE_PATTERNS) {
    throw new ApiError(
      'invalid_input',
      `eventTypes must hold ${MIN_EVENT_TYPE_PATTERNS}..${MAX_EVENT_TYPE_PATTERNS} patterns`,
    );
  }
  const seen = new Set<string>();
  for (const pattern of value) {
    if (!isEventTypePattern(pattern)) {
      throw new ApiError('invalid_input', `invalid event type pattern '${String(pattern)}'`);
    }
    if (seen.has(pattern)) {
      throw new ApiError('invalid_input', `duplicate event type pattern '${pattern}'`);
    }
    seen.add(pattern);
  }
  return [...seen];
}

/**
 * Seconds to wait after the n-th (1-based) failed attempt before the next:
 * exponential from the base, capped — 30, 60, 120, 240, 480, then 3600.
 */
export function backoffSecondsForAttempt(attemptNo: number): number {
  const n = Math.max(1, Math.floor(attemptNo));
  const seconds = WEBHOOK_BACKOFF_BASE_SECONDS * 2 ** (n - 1);
  return Math.min(seconds, WEBHOOK_BACKOFF_CAP_SECONDS);
}

/**
 * The canonical webhook signature: hex HMAC-SHA256 over
 * `${timestamp}.${body}` keyed by the subscription's signing secret.
 */
export function computeWebhookSignature(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

/**
 * Classify one transport receipt: 2xx succeeds; no response, 408, 429 and
 * 5xx are transient (retryable); every other status is terminal.
 */
export function classifyWebhookReceipt(receipt: WebhookTransportReceipt): WebhookAttemptOutcome {
  if (receipt.ok) return 'succeeded';
  const statusCode = receipt.statusCode;
  if (statusCode === null) return 'transient_failure';
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return 'transient_failure';
  return 'terminal_failure';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate a subscription delivery URL: http(s) only, https required except
 * on loopback hosts (dev/test), host present, no credentials, ≤ 2048 chars.
 * Returns the normalized URL string; throws `invalid_input` otherwise.
 */
export function validateWebhookUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new ApiError('invalid_input', 'url must be a non-empty string of at most 2048 chars');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('invalid_input', 'url is not a valid absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ApiError('invalid_input', 'url must use https (http is loopback-only)');
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new ApiError('invalid_input', 'plain http is only allowed on loopback hosts');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ApiError('invalid_input', 'url must not embed credentials');
  }
  return parsed.toString();
}
