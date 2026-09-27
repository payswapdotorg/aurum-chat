// Telnyx LIVE REST transport (MODULE-INTERNAL — implements the
// provider-neutral CellularTransport port against the documented Telnyx
// v2 REST API; lock 16 / IMPLEMENTATION-STACK §6: vendor wire protocol
// named only here).
//
// API surfaces used (documented Telnyx v2 contracts):
//
//   SMS — POST {base}/v2/messages
//         `Authorization: Bearer <API key>`, JSON body
//         { from: '+E.164', to: '+E.164', text: '…' }.
//         2xx → { data: { id: 'uuid', status: 'queued', … } } — the
//         carrier's own message id is `data.id` (receipt correlation:
//         the message.delivery_updated webhook reports the same id).
//
//   VOICE (Call Control) — the documented flow is webhook-driven and
//   asynchronous: POST {base}/v2/calls with
//         { from, to, connection_id: <Call Control Application id> }
//   creates the call (2xx → { data: { id: <call control id>, … } });
//   when the callee answers, Telnyx fires call.answered, and the caller
//   issues POST {base}/v2/calls/{id}/actions/speak with
//         { payload: 'spoken text' }
//   to speak the message. The CellularTransport port is synchronous and
//   the frozen voice-fallback decision consumes the receipt immediately,
//   so this transport BRIDGES the two honestly on a bounded wait window:
//   create → poll GET {base}/v2/calls/{id} (data.call_state) until the
//   answered state → issue the documented speak command → poll until a
//   terminal state. Receipt mapping:
//        terminal-completed after speak      → 'answered'
//        no-answer / busy / canceled         → 'no_answer'
//        failed                              → 'failed'
//   Window expiry: an observed answered state → 'answered' (the speak
//   command was accepted); a last-observed ringing-ish state →
//   'no_answer'; otherwise 'failed' — each with an explicit
//   incomplete-observation detail. Carrier call.* webhooks keep refining
//   the recorded attempt afterwards (the module's applyCallStatus path).
//   NOTE: this voice leg is SHAPE-VERIFIED against the documented API
//   only — no live Telnyx call was placed (no credentials exist in any
//   audited environment; see the W108 evidence record).
//
//   A transport constructed WITHOUT a call control application id
//   delivers SMS only and fails voice placements honestly (explicit
//   detail) — SMS-only wiring is a legal configuration.
//
// Delivery-error taxonomy (the module's frozen discipline — see
// transport-shared.ts): 2xx → 'accepted'; 401/402/429/5xx/network/timeout
// → 'failed' (TRANSIENT, budget-retried); every other 4xx → 'rejected'
// (PERMANENT — e.g. invalid phone number, unowned 'from' number).
// Telnyx's `errors[0]` code/title/detail ride in `detail`.
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

const PROVIDER = 'telnyx' as const;
const DEFAULT_BASE_URL = 'https://api.telnyx.com';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_VOICE_WAIT_MS = 60_000;
const DEFAULT_VOICE_POLL_INTERVAL_MS = 2_000;

/** Configuration of the live Telnyx v2 REST transport. */
export interface TelnyxTransportConfig {
  /** The Telnyx API key (Bearer credential). */
  apiKey: string;
  /**
   * The Call Control Application id voice legs are placed through
   * (Telnyx `connection_id`). Optional — without it the transport
   * delivers SMS only and fails voice placements honestly.
   */
  callControlAppId?: string | null;
  /** API base URL override (default: the documented https://api.telnyx.com). */
  baseUrl?: string;
  /** Per-request HTTP timeout in ms (default 10 000). */
  requestTimeoutMs?: number;
  /** Bounded total wait for a voice call's terminal state in ms (default 60 000). */
  voiceWaitMs?: number;
  /** Voice state poll interval in ms (default 2 000). */
  voicePollIntervalMs?: number;
  /** Injectable HTTP entry point (tests substitute a deterministic double). */
  fetchImpl?: TransportFetch;
}

interface HttpConfig {
  baseUrl: string;
  authHeader: string;
  requestTimeoutMs: number;
  voiceWaitMs: number;
  voicePollIntervalMs: number;
  fetchImpl: TransportFetch;
}

/** GET /v2/calls/{id} observed states that mean "the callee answered". */
const ANSWERED_CALL_STATES = new Set(['answered', 'bridged', 'bridge_active', 'in-progress']);
/** Observed states that mean "the call ended after the message played". */
const COMPLETED_CALL_STATES = new Set(['completed', 'done']);
/** Observed states that mean "the call ended unanswered". */
const UNANSWERED_CALL_STATES = new Set(['no-answer', 'no_answer', 'busy', 'canceled']);

function requireNonEmpty(raw: string, field: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new CellularError('invalid_cellular_input', `telnyx transport ${field} must be a non-empty string`);
  }
  return trimmed;
}

/** Extract data.call_state from a poll response (null when unrecognizable). */
function observedCallState(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = (body as Record<string, unknown>).data;
  return vendorString(data, 'call_state');
}

/** Create the live Telnyx transport implementing the provider-neutral port. */
export function createTelnyxTransport(config: TelnyxTransportConfig): CellularTransport {
  const apiKey = requireNonEmpty(config.apiKey, 'apiKey');
  const callControlAppId =
    config.callControlAppId === undefined || config.callControlAppId === null
      ? null
      : requireNonEmpty(config.callControlAppId, 'callControlAppId');
  const http: HttpConfig = {
    baseUrl: normalizeBaseUrl(config.baseUrl ?? DEFAULT_BASE_URL, 'telnyx transport baseUrl'),
    authHeader: `Bearer ${apiKey}`,
    requestTimeoutMs: positiveMs(config.requestTimeoutMs, 'requestTimeoutMs', DEFAULT_REQUEST_TIMEOUT_MS),
    voiceWaitMs: positiveMs(config.voiceWaitMs, 'voiceWaitMs', DEFAULT_VOICE_WAIT_MS),
    voicePollIntervalMs: positiveMs(
      config.voicePollIntervalMs,
      'voicePollIntervalMs',
      DEFAULT_VOICE_POLL_INTERVAL_MS,
    ),
    fetchImpl: config.fetchImpl ?? ((url, init) => fetch(url, init)),
  };
  const messagesUrl = `${http.baseUrl}/v2/messages`;
  const callsUrl = `${http.baseUrl}/v2/calls`;

  return {
    provider: PROVIDER,

    async sendSms(request): Promise<CellularSmsReceipt> {
      const outcome = await vendorFetch(http, messagesUrl, {
        method: 'POST',
        headers: {
          authorization: http.authHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: request.fromNumber,
          to: request.toNumber,
          text: request.text,
        }),
      });
      if (outcome.kind === 'network_error') {
        return {
          status: 'failed',
          providerMessageId: null,
          detail: networkFailureDetail('telnyx sendSms', outcome.detail),
        };
      }
      if (outcome.kind === 'http_error') {
        return {
          status: classifyHttpError(outcome.status),
          providerMessageId: null,
          detail: `telnyx sendSms http ${outcome.status}: ${vendorErrorDetail(outcome.body, 'telnyx refused the message')}`,
        };
      }
      const data = outcome.body === null || typeof outcome.body !== 'object' || Array.isArray(outcome.body)
        ? null
        : (outcome.body as Record<string, unknown>).data;
      const messageId = vendorString(data, 'id');
      if (messageId === null) {
        // 2xx without a usable message id — transient (never fabricate one).
        return {
          status: 'failed',
          providerMessageId: null,
          detail: 'telnyx sendSms returned 2xx without a message id',
        };
      }
      return { status: 'accepted', providerMessageId: messageId, detail: null };
    },

    async placeVoiceCall(request): Promise<CellularVoiceReceipt> {
      if (callControlAppId === null) {
        return {
          status: 'failed',
          providerCallId: null,
          detail:
            'telnyx transport has no call control application configured (set CELLULAR_TELNYX_CALL_CONTROL_APP_ID to enable voice legs)',
        };
      }
      const created = await vendorFetch(http, callsUrl, {
        method: 'POST',
        headers: {
          authorization: http.authHeader,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: request.fromNumber,
          to: request.toNumber,
          connection_id: callControlAppId,
        }),
      });
      if (created.kind === 'network_error') {
        return {
          status: 'failed',
          providerCallId: null,
          detail: networkFailureDetail('telnyx placeVoiceCall', created.detail),
        };
      }
      if (created.kind === 'http_error') {
        return {
          status: 'failed',
          providerCallId: null,
          detail: `telnyx placeVoiceCall http ${created.status}: ${vendorErrorDetail(created.body, 'telnyx refused the call')}`,
        };
      }
      const data = created.body === null || typeof created.body !== 'object' || Array.isArray(created.body)
        ? null
        : (created.body as Record<string, unknown>).data;
      const callControlId = vendorString(data, 'id');
      if (callControlId === null) {
        return {
          status: 'failed',
          providerCallId: null,
          detail: 'telnyx placeVoiceCall returned 2xx without a call control id',
        };
      }
      return speakOnAnswered(http, callControlId, request.text);
    },
  };
}

/**
 * The synchronous receipt bridge: poll the documented call resource until
 * the answered state, issue the documented speak command, then poll until
 * a terminal state or the bounded wait window expires.
 */
async function speakOnAnswered(
  http: HttpConfig,
  callControlId: string,
  text: string,
): Promise<CellularVoiceReceipt> {
  const callUrl = `${http.baseUrl}/v2/calls/${encodeURIComponent(callControlId)}`;
  const deadline = Date.now() + http.voiceWaitMs;
  let lastState: string | null = null;
  let spoke = false;

  while (Date.now() <= deadline) {
    const poll = await vendorFetch(http, callUrl, {
      method: 'GET',
      headers: { authorization: http.authHeader },
    });
    if (poll.kind === 'http_error' && (poll.status === 404 || poll.status === 410)) {
      // The call resource is gone without a terminal observation — the
      // honest receipt is a transient failure with the explicit detail.
      return {
        status: 'failed',
        providerCallId: callControlId,
        detail: `telnyx call resource disappeared (http ${poll.status}) before a terminal state was observed`,
      };
    }
    if (poll.kind === 'ok') {
      lastState = observedCallState(poll.body);
      if (lastState !== null) {
        if (UNANSWERED_CALL_STATES.has(lastState)) {
          return { status: 'no_answer', providerCallId: callControlId, detail: `telnyx call state '${lastState}'` };
        }
        if (lastState === 'failed') {
          return { status: 'failed', providerCallId: callControlId, detail: "telnyx call state 'failed'" };
        }
        if (!spoke && ANSWERED_CALL_STATES.has(lastState)) {
          // The documented speak command (accepted on answer).
          const speak = await vendorFetch(http, `${callUrl}/actions/speak`, {
            method: 'POST',
            headers: {
              authorization: http.authHeader,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ payload: text }),
          });
          if (speak.kind === 'http_error') {
            return {
              status: 'failed',
              providerCallId: callControlId,
              detail: `telnyx speak command rejected (http ${speak.status}): ${vendorErrorDetail(speak.body, 'telnyx refused the speak command')}`,
            };
          }
          if (speak.kind === 'network_error') {
            return {
              status: 'failed',
              providerCallId: callControlId,
              detail: networkFailureDetail('telnyx speak command', speak.detail),
            };
          }
          spoke = true;
        }
        if (spoke && COMPLETED_CALL_STATES.has(lastState)) {
          return { status: 'answered', providerCallId: callControlId, detail: null };
        }
      }
    }
    await sleep(http.voicePollIntervalMs);
  }

  // Window expiry — the honest incomplete-observation mapping.
  if (spoke) {
    return {
      status: 'answered',
      providerCallId: callControlId,
      detail:
        "telnyx call still active at the transport wait window's end (speak command accepted; carrier events refine the attempt)",
    };
  }
  if (lastState !== null && (ANSWERED_CALL_STATES.has(lastState) || isRingingIsh(lastState))) {
    return {
      status: 'no_answer',
      providerCallId: callControlId,
      detail: `telnyx call did not reach a terminal state within the transport wait window (last observed: '${lastState}')`,
    };
  }
  return {
    status: 'failed',
    providerCallId: callControlId,
    detail: `telnyx call did not reach a recognizable state within the transport wait window (last observed: '${lastState ?? 'unobserved'}')`,
  };
}

function isRingingIsh(state: string): boolean {
  return state === 'ringing' || state === 'dialing' || state === 'parked' || state === 'queued';
}
