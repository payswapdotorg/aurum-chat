// Shared HTTP transport plumbing for the cellular vendor transports
// (MODULE-INTERNAL — real telecom transports live inside adapters/,
// IMPLEMENTATION-STACK §6 provider isolation; lock 16: vendor request/
// response objects never cross the port).
//
// The transports are deliberately boring, plain-`fetch` REST clients in
// the email adapter's discipline (src/infra/email.ts): no SDK, the
// adapter is the ONLY place the vendor and its wire protocol are named,
// every call is timeout-bounded, and vendor failures are classified into
// the module's delivery-error taxonomy BEFORE they cross the port:
//
//   * 'accepted'  — the carrier took the message (2xx);
//   * 'rejected'  — the carrier PERMANENTLY refused the send (4xx other
//                   than auth/rate: bad request, invalid number, blocked
//                   content, …). The SMS leg is terminal;
//   * 'failed'    — TRANSIENT (auth/billing/rate 401/402/429, 5xx,
//                   network error, timeout). Retried within the module's
//                   budget (connection problems are transient — the
//                   notifications module's discipline).
//
// Transports are constructed from CONFIGURATION OBJECTS (never ambient
// singletons) and never leak vendor types across the port: they speak
// CellularSmsRequest/CellularVoiceRequest in and
// CellularSmsReceipt/CellularVoiceReceipt out.

import { CellularError } from '../errors';

/** What one vendor HTTP exchange resolved to. */
export type VendorHttpStatus =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'http_error'; status: number; body: unknown }
  | { kind: 'network_error'; detail: string };

/** The transport's injectable HTTP entry point (tests substitute a double). */
export type TransportFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface VendorHttpConfig {
  /** The vendor API base URL (e.g. 'https://api.twilio.com'). */
  baseUrl: string;
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** The fetch implementation (tests inject a deterministic double). */
  fetchImpl: TransportFetch;
}

/** Normalize a configured base URL: trim, strip the trailing slash. */
export function normalizeBaseUrl(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || !/^https?:\/\//i.test(trimmed)) {
    throw new CellularError(
      'invalid_cellular_input',
      `${field} must be an http(s) URL (got '${raw}')`,
    );
  }
  return trimmed.replace(/\/+$/, '');
}

/** Positive-integer configuration guard. */
export function positiveMs(raw: number | null | undefined, field: string, fallback: number): number {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new CellularError('invalid_cellular_input', `${field} must be a positive integer of milliseconds`);
  }
  return raw;
}

/**
 * One vendor HTTP exchange with timeout + network classification. Never
 * throws: network errors and timeouts resolve to `network_error` (the
 * TRANSIENT bucket), HTTP statuses are surfaced verbatim.
 */
export async function vendorFetch(
  config: VendorHttpConfig,
  url: string,
  init: RequestInit,
): Promise<VendorHttpStatus> {
  let response: Response;
  try {
    response = await config.fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    return { kind: 'network_error', detail: error instanceof Error ? error.message : String(error) };
  }
  const body = await readBody(response);
  if (response.status >= 200 && response.status < 300) {
    return { kind: 'ok', status: response.status, body };
  }
  return { kind: 'http_error', status: response.status, body };
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '');
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A vendor error body's best human-readable detail (bounded length). */
export function vendorErrorDetail(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const holder = body as Record<string, unknown>;
    // Twilio: { message, code, more_info }; Telnyx: { errors: [{ title,
    // detail, code }] } — both are surfaced honestly, bounded.
    const message = typeof holder.message === 'string' ? holder.message : null;
    const code = typeof holder.code === 'number' ? String(holder.code) : typeof holder.code === 'string' ? holder.code : null;
    const errors = Array.isArray(holder.errors) ? holder.errors : null;
    if (errors !== null && errors.length > 0 && typeof errors[0] === 'object' && errors[0] !== null) {
      const first = errors[0] as Record<string, unknown>;
      const title = typeof first.title === 'string' ? first.title : '';
      const detail = typeof first.detail === 'string' ? first.detail : '';
      const errCode = typeof first.code === 'string' ? first.code : typeof first.code === 'number' ? String(first.code) : '';
      const joined = [title, detail].filter((part) => part !== '').join(': ');
      return `vendor error ${errCode !== '' ? `${errCode} ` : ''}${joined !== '' ? joined : fallback}`.slice(0, 2_000);
    }
    if (message !== null || code !== null) {
      return `vendor error ${code !== null ? `${code} ` : ''}${message ?? fallback}`.slice(0, 2_000);
    }
  }
  if (typeof body === 'string' && body.trim() !== '') {
    return body.slice(0, 2_000);
  }
  return fallback;
}

/**
 * The delivery-error taxonomy classification of one non-2xx vendor
 * exchange (the module's TRANSIENT/PERMANENT discipline):
 *
 *   TRANSIENT ('failed')  — 401/402/429 (auth, billing, rate: the tenant
 *   or operator can fix these and the budget retries), 5xx (carrier
 *   trouble), network errors, timeouts;
 *   PERMANENT ('rejected')— every other 4xx (the request itself is wrong:
 *   invalid number, malformed content, forbidden content…). Retrying the
 *   identical request can never succeed.
 */
export function classifyHttpError(status: number): 'rejected' | 'failed' {
  if (status === 401 || status === 402 || status === 429) return 'failed';
  if (status >= 500) return 'failed';
  return 'rejected';
}

/** Build the canonical receipt detail of a transient (network/timeout) failure. */
export function networkFailureDetail(operation: string, detail: string): string {
  return `${operation} failed transiently (network/timeout): ${detail}`.slice(0, 2_000);
}

/** Read one vendor JSON object field as a trimmed string (null when absent). */
export function vendorString(holder: unknown, field: string): string | null {
  if (holder === null || typeof holder !== 'object' || Array.isArray(holder)) return null;
  const value = (holder as Record<string, unknown>)[field];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
