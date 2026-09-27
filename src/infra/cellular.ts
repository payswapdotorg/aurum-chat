// Cellular provider wiring (W108) — the env-driven production wiring of
// the cellular module's delivery port, in the email/blob infra
// discipline (Family A: a globalThis-guarded lazy singleton, computed
// once per process at first use; Next dev compiles route bundles into
// separate module registries — a module-level variable would diverge
// per registry, the W058 incident).
//
// ENVIRONMENT CONTRACT (documented for the operator; see
// docs/DEPLOYMENT.md §6 and docs/productization-evidence/W108/):
//
//   CELLULAR_TWILIO_ACCOUNT_SID     — the Twilio account the transport
//                                      delivers for ('AC…').
//   CELLULAR_TWILIO_AUTH_TOKEN      — the account's auth token (REST
//                                      Basic auth AND webhook signature
//                                      verification).
//   CELLULAR_TELNYX_API_KEY         — the Telnyx API key (Bearer auth).
//   CELLULAR_TELNYX_CALL_CONTROL_APP_ID — the Call Control Application
//                                      id voice legs are placed through
//                                      (optional — without it the
//                                      telnyx transport delivers SMS
//                                      only and fails voice honestly).
//   CELLULAR_TELNYX_PUBLIC_KEY      — the Telnyx webhook signing PUBLIC
//                                      key (base64 DER/SPKI Ed25519).
//   CELLULAR_WEBHOOK_PUBLIC_URL     — optional override of the URL used
//                                      to verify X-Twilio-Signature when
//                                      the deployment sits behind a
//                                      proxy that rewrites the Host.
//
// HONESTY CONTRACT: unset or PARTIAL configuration leaves the matching
// transport UNWIRED — cellular deliveries then fail explicitly with
// `provider_unavailable` (retryable, visible; never a faked success).
// The tenant-scoped sending numbers are NOT environment configuration:
// they are per-tenant CONNECTION data (registerCellularConnection) — the
// architectural home of the endpoint identity.
//
// INVOCATION: `ensureCellularTransportsWired()` is idempotent per
// process. It is invoked by the carrier webhook edge (the production
// cellular HTTP surface; see src/app/api/webhooks/cellular/**) and is
// exported for every future delivery entry point (the worker pump
// composition is the W112 certification frontier — the resident worker
// does not pump cellular today).

import { envString } from './config';
import {
  createCellularTransportFromConfig,
  getCellularTransportForProvider,
  setCellularTransportForProvider,
  type CellularProviderCredentials,
} from '@/modules/cellular/contract';

export type CellularProviderKey = 'twilio' | 'telnyx';

/** The per-provider wiring outcome (machine-readable, operator-auditable). */
export interface CellularTransportWiringState {
  provider: CellularProviderKey;
  state: 'wired' | 'unwired' | 'incomplete';
  detail: string;
}

export interface CellularTransportWiringReport {
  providers: CellularTransportWiringState[];
}

interface CellularWiringGlobal {
  __aurumCellularTransportWiring?: CellularTransportWiringReport;
}

const wiringGlobal = globalThis as unknown as CellularWiringGlobal;

/**
 * Wire the configured live transports ONCE per process (idempotent; the
 * globalThis guard survives Next's per-bundle module registries).
 * Unset/partial env → the provider's transport stays unwired (honest
 * `provider_unavailable`), never half-constructed.
 */
export function ensureCellularTransportsWired(): CellularTransportWiringReport {
  wiringGlobal.__aurumCellularTransportWiring ??= wireFromEnv();
  return wiringGlobal.__aurumCellularTransportWiring;
}

/** The currently wired transport of one provider (null = honestly unwired). */
export function wiredCellularTransport(provider: CellularProviderKey) {
  return getCellularTransportForProvider(provider);
}

/** Reset the wiring (tests and process shutdown). */
export function resetCellularTransportWiring(): void {
  wiringGlobal.__aurumCellularTransportWiring = undefined;
  setCellularTransportForProvider('twilio', null);
  setCellularTransportForProvider('telnyx', null);
}

function wireFromEnv(): CellularTransportWiringReport {
  const providers: CellularTransportWiringState[] = [];

  const twilioSid = envString('CELLULAR_TWILIO_ACCOUNT_SID');
  const twilioToken = envString('CELLULAR_TWILIO_AUTH_TOKEN');
  if (twilioSid === undefined && twilioToken === undefined) {
    providers.push({
      provider: 'twilio',
      state: 'unwired',
      detail:
        'no twilio configuration present (CELLULAR_TWILIO_ACCOUNT_SID / CELLULAR_TWILIO_AUTH_TOKEN unset) — deliveries fail honestly with provider_unavailable',
    });
  } else if (twilioSid === undefined || twilioToken === undefined) {
    providers.push({
      provider: 'twilio',
      state: 'incomplete',
      detail:
        'partial twilio configuration — BOTH CELLULAR_TWILIO_ACCOUNT_SID and CELLULAR_TWILIO_AUTH_TOKEN are required; the transport stays unwired (honest provider_unavailable)',
    });
  } else {
    setCellularTransportForProvider(
      'twilio',
      createCellularTransportFromConfig({ provider: 'twilio', accountSid: twilioSid, credential: twilioToken }),
    );
    providers.push({
      provider: 'twilio',
      state: 'wired',
      detail: 'twilio live REST transport wired (Messages + Calls APIs)',
    });
  }

  const telnyxKey = envString('CELLULAR_TELNYX_API_KEY');
  const telnyxApp = envString('CELLULAR_TELNYX_CALL_CONTROL_APP_ID');
  if (telnyxKey === undefined) {
    const partial =
      telnyxApp !== undefined
        ? ' (CELLULAR_TELNYX_CALL_CONTROL_APP_ID is set, but CELLULAR_TELNYX_API_KEY is not — no credential, no transport)'
        : '';
    providers.push({
      provider: 'telnyx',
      state: 'unwired',
      detail: `no telnyx configuration present (CELLULAR_TELNYX_API_KEY unset)${partial} — deliveries fail honestly with provider_unavailable`,
    });
  } else {
    const smsOnly = telnyxApp === undefined;
    setCellularTransportForProvider(
      'telnyx',
      createCellularTransportFromConfig({
        provider: 'telnyx',
        credential: telnyxKey,
        callControlAppId: telnyxApp ?? null,
      }),
    );
    providers.push({
      provider: 'telnyx',
      state: 'wired',
      detail: smsOnly
        ? 'telnyx live REST transport wired in SMS-ONLY mode (Messages API; CELLULAR_TELNYX_CALL_CONTROL_APP_ID unset — voice legs fail honestly)'
        : 'telnyx live REST transport wired (Messages + Call Control APIs)',
    });
  }

  return { providers };
}

/**
 * The carrier-webhook VERIFICATION credentials of one provider, read
 * from the environment (twilio: the auth token that co-signs
 * X-Twilio-Signature; telnyx: the Ed25519 public key that verifies
 * Telnyx-Signature). Null when the provider's verification credential is
 * absent — the webhook route then FAILS CLOSED (503): an unverifiable
 * carrier edge never processes anything.
 */
export function getCellularWebhookVerificationConfig(
  provider: CellularProviderKey,
): CellularProviderCredentials | null {
  if (provider === 'twilio') {
    const authToken = envString('CELLULAR_TWILIO_AUTH_TOKEN');
    if (authToken === undefined) return null;
    return { provider: 'twilio', credential: authToken };
  }
  const publicKey = envString('CELLULAR_TELNYX_PUBLIC_KEY');
  if (publicKey === undefined) return null;
  return { provider: 'telnyx', webhookPublicKey: publicKey };
}

/**
 * The URL a carrier request's signature is computed against: the exact
 * configured public URL when CELLULAR_WEBHOOK_PUBLIC_URL is set (proxy
 * deployments whose Host header the platform rewrites), otherwise the
 * request's own URL. The query string always comes from the actual
 * request.
 */
export function cellularWebhookSignatureUrl(requestUrl: string): string {
  const override = envString('CELLULAR_WEBHOOK_PUBLIC_URL');
  if (override === undefined) return requestUrl;
  const request = new URL(requestUrl);
  const base = override.replace(/\/+$/, '');
  return `${base}${request.search}`;
}
