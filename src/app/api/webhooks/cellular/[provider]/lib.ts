// The carrier-facing cellular webhook edge's handling logic (W108).
// Tested directly without booting Next.js (the same discipline the
// worker/tower/product APIs follow); route.ts is a thin NextResponse
// adapter over this handler.
//
// THE ROUTE CONTRACT (what the CARRIER is configured with — see the W108
// runbook): Twilio and Telnyx deliver their webhooks to
//   POST /api/webhooks/cellular/twilio
//   POST /api/webhooks/cellular/telnyx
// with the vendor's default content types (Twilio:
// application/x-www-form-urlencoded; Telnyx: application/json) and the
// vendor's request signature:
//   * Twilio   — `X-Twilio-Signature` (HMAC-SHA1 with the account AUTH
//     TOKEN over the full URL + sorted POST params). The signature URL
//     is the request's own URL, or CELLULAR_WEBHOOK_PUBLIC_URL when the
//     deployment sits behind a proxy that rewrites the Host.
//   * Telnyx   — `Telnyx-Signature` + `Telnyx-Timestamp` (Ed25519 over
//     `${timestamp}|${rawBody}` verified with the configured PUBLIC KEY).
// Requests that fail signature verification are rejected 403 — NEVER
// processed. When the provider's verification credential is not
// configured at all the route fails CLOSED (503): an unverifiable
// carrier edge never processes anything.
//
// RESPONSE CONTRACT (the carrier retry semantics):
//   200 — applied (or a recognized non-record ping acknowledged; body
//         carries `applied:false` on redelivery — the event ledger
//         deduped it);
//   202 — observed, not errored: the envelope's vendor account belongs
//         to no registered tenant (the carrier must not retry);
//   400 — malformed carrier envelope (configuration error, will not
//         heal by retrying);
//   403 — signature verification failed;
//   413 — body above the 1 MiB carrier-body guard;
//   503 — verification not configured (fail-closed).
//
// The handler also ensures the process's cellular TRANSPORTS are wired
// (the lazy process-start hook for this surface — the env-driven
// production wiring; see src/infra/cellular.ts).

import {
  cellularWebhookSignatureUrl,
  ensureCellularTransportsWired,
  getCellularWebhookVerificationConfig,
} from '@/infra/cellular';
import { receiveCellularCarrierWebhook } from '@/modules/cellular/contract';

/** Carrier webhook bodies are tiny; anything above this is not a carrier. */
const MAX_CARRIER_BODY_BYTES = 1_048_576;

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const PROVIDERS = new Set(['twilio', 'telnyx']);

/** POST /api/webhooks/cellular/<provider> — the carrier → Aurum edge. */
export async function handleCellularWebhookPost(
  provider: string,
  request: Request,
): Promise<HandlerResult> {
  if (!PROVIDERS.has(provider)) {
    return {
      status: 404,
      body: {
        ok: false,
        error: `unknown cellular provider '${provider}' (supported: twilio, telnyx)`,
      },
    };
  }
  const canonicalProvider = provider as 'twilio' | 'telnyx';

  // The lazy process-start wiring of the delivery port (idempotent).
  ensureCellularTransportsWired();

  // Fail closed before reading anything: no verification credential →
  // the carrier edge cannot authenticate anyone.
  const verification = getCellularWebhookVerificationConfig(canonicalProvider);
  if (verification === null) {
    return {
      status: 503,
      body: {
        ok: false,
        error: `carrier webhook verification is not configured for '${canonicalProvider}' (set ${
          canonicalProvider === 'twilio'
            ? 'CELLULAR_TWILIO_AUTH_TOKEN'
            : 'CELLULAR_TELNYX_PUBLIC_KEY'
        }; the edge stays closed until the carrier's requests can be verified)`,
      },
    };
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_CARRIER_BODY_BYTES) {
    return {
      status: 413,
      body: { ok: false, error: 'carrier webhook body exceeds the 1 MiB guard' },
    };
  }

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = await receiveCellularCarrierWebhook(verification, {
    provider: canonicalProvider,
    url: cellularWebhookSignatureUrl(request.url),
    rawBody,
    headers,
    contentType: headers['content-type'] ?? null,
  });

  switch (result.status) {
    case 'unconfigured':
      // Defense in depth: the module re-checks its own configuration.
      return { status: 503, body: { ok: false, error: result.detail } };
    case 'unverified':
      return { status: 403, body: { ok: false, error: result.detail } };
    case 'invalid':
      return { status: 400, body: { ok: false, error: result.detail } };
    case 'unsupported':
      // Acknowledge recognized non-record pings (queued/sent statuses) so
      // the carrier does not retry them.
      return { status: 200, body: { ok: true, status: 'unsupported', detail: result.detail } };
    case 'unknown_tenant':
      // Observed, not errored: the account belongs to no registered
      // tenant — retrying cannot change that.
      return {
        status: 202,
        body: {
          ok: true,
          status: 'unknown_tenant',
          provider: result.provider,
          providerAccountId: result.providerAccountId,
        },
      };
    case 'applied':
      return {
        status: 200,
        body: {
          ok: true,
          status: 'applied',
          applied: result.applied,
          kind: result.kind,
          replyId: result.replyId,
          reachId: result.reachId,
        },
      };
  }
}
