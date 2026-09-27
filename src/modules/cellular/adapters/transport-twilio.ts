// Twilio LIVE REST transport (MODULE-INTERNAL — implements the
// provider-neutral CellularTransport port against the documented Twilio
// REST API; lock 16 / IMPLEMENTATION-STACK §6: vendor wire protocol named
// only here).
//
// API surfaces used (documented Twilio REST contracts):
//
//   SMS  — POST {base}/2010-04-01/Accounts/{AccountSid}/Messages.json
//          HTTP Basic auth (AccountSid : Auth Token), form-encoded
//          To / From / Body. 201 → { sid: 'SM…', status: 'queued', … }.
//          The carrier's own message id is `sid` (receipt correlation —
//          the delivery-status webhook reports the same MessageSid).
//
//   VOICE — POST {base}/2010-04-01/Accounts/{AccountSid}/Calls.json
//          HTTP Basic auth, form-encoded To / From / Twiml, where Twiml is
//          `<Response><Say>…</Say></Response>` (the documented way to
//          place a call that speaks text when answered; Twilio evaluates
//          the Twiml on answer). 201 → { sid: 'CA…', status: 'queued' }.
//          Call placement is ASYNCHRONOUS at the vendor: the answered/
//          not-answered outcome arrives through call-status webhooks. The
//          CellularTransport port is synchronous and the frozen
//          voice-fallback decision consumes the receipt immediately, so
//          this transport BRIDGES the two honestly: after creation it
//          POLLS GET …/Calls/{CallSid}.json (documented response carries
//          `status`) on a bounded window until the call reaches a
//          terminal state, and maps:
//              completed                      → 'answered'  (message spoken, call ended)
//              no-answer | busy | canceled    → 'no_answer'
//              failed                         → 'failed'
//          Window expiry: 'in-progress' → 'answered' (the call was
//          answered; the Say already played), still 'ringing'/'queued' →
//          'no_answer' with an explicit incomplete-observation detail.
//          Carrier call-status webhooks keep refining the recorded
//          attempt afterwards (the module's applyCallStatus path).
//
// Delivery-error taxonomy (the module's frozen discipline — see
// transport-shared.ts): 2xx → 'accepted'; 401/402/429/5xx/network/timeout
// → 'failed' (TRANSIENT, budget-retried); every other 4xx → 'rejected'
// (PERMANENT — e.g. 21211 invalid 'To' number, 21611 unverified number).
// Twilio's numeric error code and message ride in `detail`.
//
// Idempotency honesty: the port hands the transport the pre-minted
// attemptId (the module's idempotency key), but the Twilio Messages API
// documents no client-supplied idempotency token — request-level dedupe
// is therefore NOT vendor-guaranteed; the module's at-least-once
// discipline (guarded status updates, ledger dedupe on events) is the
// correctness boundary. Recorded as a known transport limitation.
//
// Constructed from a CONFIGURATION OBJECT (never an ambient singleton);
// tests inject `fetchImpl` (no network in tests).

import type { CellularSmsReceipt, CellularTransport, CellularVoiceReceipt } from '../types';
import { CellularError } from '../errors';
import {
  classifyHttpError,
  networkFailureDetail,
  normalizeBaseUrl,
  positiveMs,
  sleep,
  vendorErrorDetail,
  vendorFetch,
  vendorString,
  type TransportFetch,
} from './transport-shared';

const PROVIDER = 'twilio' as const;
const DEFAULT_BASE_URL = 'https://api.twilio.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_VOICE_WAIT_MS = 60_000;
const DEFAULT_VOICE_POLL_INTERVAL_MS = 2_000;

/** Configuration of the live Twilio REST transport (all values plain config). */
export interface TwilioTransportConfig {
  /** The Twilio account the transport delivers for (Account SID, 'AC…'). */
  accountSid: string;
  /** The account's auth token (HTTP Basic credential; also co-signs webhooks). */
  authToken: string;
  /** API base URL override (default: the documented https://api.twilio.com). */
  baseUrl?: string;
  /** Per-request HTTP timeout in ms (default 10 000). */
  requestTimeoutMs?: number;
  /** Bounded total wait for a voice call's terminal state in ms (default 60 000). */
  voiceWaitMs?: number;
  /** Voice status poll interval in ms (default 2 000). */
  voicePollIntervalMs?: number;
  /** Injectable HTTP entry point (tests substitute a deterministic double). */
  fetchImpl?: TransportFetch;
}

interface HttpConfig {
  baseUrl: string;
  accountSid: string;
  authHeader: string;
  requestTimeoutMs: number;
  voiceWaitMs: number;
  voicePollIntervalMs: number;
  fetchImpl: TransportFetch;
}

function requireNonEmpty(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CellularError('invalid_cellular_input', `twilio transport ${field} must be a non-empty string`);
  }
  return trimmed;
}

function basicAuthHeader(accountSid: string, authToken: string): string {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

/** XML-escape the spoken text inside the Twiml <Say> element. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sayTwiml(text: string): string {
  return `<Response><Say>${escapeXml(text)}</Say></Response>`;
}

/** Create the live Twilio transport implementing the provider-neutral port. */
export function createTwilioTransport(config: TwilioTransportConfig): CellularTransport {
  const accountSid = requireNonEmpty(config.accountSid, 'accountSid');
  const http: HttpConfig = {
    baseUrl: normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL, 'twilio transport baseUrl'),
    accountSid,
    authHeader: basicAuthHeader(accountSid, requireNonEmpty(config.authToken, 'authToken')),
    requestTimeoutMs: positiveMs(config.requestTimeoutMs, 'requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS),
    voiceWaitMs: positiveMs(config.voiceWaitMs, 'voiceWaitMs', DEFAULT_VOICE_WAIT_MS),
    voicePollIntervalMs: positiveMs(
      config.voicePollIntervalMs,
      'voicePollIntervalMs',
      DEFAULT_VOICE_POLL_INTERVAL_MS,
    ),
    fetchImpl: config.fetchImpl ?? ((url, init) => fetch(url, init)),
  };
  const messagesUrl = `${http.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const callsUrl = `${http.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`;

  return {
    provider: PROVIDER,

    async sendSms(request): Promise<CellularSmsReceipt> {
      const body = new URLSearchParams({
        To: request.toNumber,
        From: request.fromNumber,
        Body: request.text,
      });
      const outcome = await vendorFetch(http, messagesUrl, {
        method: 'POST',
        headers: {
          authorization: http.authHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (outcome.kind === 'network_error') {
        return {
          status: 'failed',
          providerMessageId: null,
          detail: networkFailureDetail('twilio sendSms', outcome.detail),
        };
      }
      if (outcome.kind === 'http_error') {
        return {
          status: classifyHttpError(outcome.status),
          providerMessageId: null,
          detail: `twilio sendSms http ${outcome.status}: ${vendorErrorDetail(outcome.body, 'twilio refused the message')}`,
        };
      }
      const sid = vendorString(outcome.body, 'sid');
      if (sid === null) {
        // 2xx without a usable sid — transient (the module retries within
        // budget; a provider message id is never fabricated).
        return {
          status: 'failed',
          providerMessageId: null,
          detail: 'twilio sendSms returned 2xx without a message sid',
        };
      }
      return { status: 'accepted', providerMessageId: sid, detail: null };
    },

    async placeVoiceCall(request): Promise<CellularVoiceReceipt> {
      const body = new URLSearchParams({
        To: request.toNumber,
        From: request.fromNumber,
        Twiml: sayTwiml(request.text),
      });
      const created = await vendorFetch(http, callsUrl, {
        method: 'POST',
        headers: {
          authorization: http.authHeader,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      if (created.kind === 'network_error') {
        return {
          status: 'failed',
          providerCallId: null,
          detail: networkFailureDetail('twilio placeVoiceCall', created.detail),
        };
      }
      if (created.kind === 'http_error') {
        // The frozen voice-receipt taxonomy has no permanent slot; the
        // detail carries the vendor's code/message either way.
        return {
          status: 'failed',
          providerCallId: null,
          detail: `twilio placeVoiceCall http ${created.status}: ${vendorErrorDetail(created.body, 'twilio refused the call')}`,
        };
      }
      const callSid = vendorString(created.body, 'sid');
      if (callSid === null) {
        return {
          status: 'failed',
          providerCallId: null,
          detail: 'twilio placeVoiceCall returned 2xx without a call sid',
        };
      }
      return pollTwilioCall(http, callSid);
    },
  };
}

/**
 * Poll the documented call resource until a terminal status or the
 * bounded wait window expires (the synchronous receipt bridge — see the
 * file header for the honest mapping table).
 */
async function pollTwilioCall(http: HttpConfig, callSid: string): Promise<CellularVoiceReceipt> {
  const callUrl = `${http.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(http.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`;
  const deadline = Date.now() + http.voiceWaitMs;
  let lastStatus: string | null = null;
  while (Date.now() <= deadline) {
    const poll = await vendorFetch(http, callUrl, {
      method: 'GET',
      headers: { authorization: http.authHeader },
    });
    if (poll.kind === 'ok') {
      lastStatus = vendorString(poll.body, 'status');
      if (lastStatus === 'completed') {
        return { status: 'answered', providerCallId: callSid, detail: null };
      }
      if (lastStatus === 'no-answer' || lastStatus === 'busy' || lastStatus === 'canceled') {
        return { status: 'no_answer', providerCallId: callSid, detail: `twilio call status '${lastStatus}'` };
      }
      if (lastStatus === 'failed') {
        return { status: 'failed', providerCallId: callSid, detail: "twilio call status 'failed'" };
      }
    }
    await sleep(http.voicePollIntervalMs);
  }
  // Window expiry — the honest incomplete-observation mapping.
  if (lastStatus === 'in-progress') {
    return {
      status: 'answered',
      providerCallId: callSid,
      detail:
        "twilio call still 'in-progress' at the transport wait window's end (answered; carrier events refine the attempt)",
    };
  }
  return {
    status: lastStatus === null ? 'failed' : 'no_answer',
    providerCallId: callSid,
    detail: `twilio call did not reach a terminal status within the transport wait window (last observed: '${lastStatus ?? 'unobserved'}')`,
  };
}
