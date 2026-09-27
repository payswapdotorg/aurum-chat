// Tests of the env-driven cellular transport wiring (W108 —
// src/infra/cellular.ts, the email/blob Family-A discipline). No
// database, no network: these prove the ENVIRONMENT → TRANSPORT
// construction mapping and the HONEST unset/partial posture (an unwired
// transport stays `provider_unavailable`, never a faked success).
//
// The end-to-end honesty (unset env → reachAnyone fails explicitly with
// provider_unavailable) is proven in
// src/modules/cellular/tests/cellular-live-composition.test.ts against
// the embedded database.

delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  cellularWebhookSignatureUrl,
  ensureCellularTransportsWired,
  getCellularWebhookVerificationConfig,
  resetCellularTransportWiring,
  wiredCellularTransport,
} from './cellular';
import { getCellularTransport } from '@/modules/cellular/contract';

const ENV_KEYS = [
  'CELLULAR_TWILIO_ACCOUNT_SID',
  'CELLULAR_TWILIO_AUTH_TOKEN',
  'CELLULAR_TELNYX_API_KEY',
  'CELLULAR_TELNYX_CALL_CONTROL_APP_ID',
  'CELLULAR_TELNYX_PUBLIC_KEY',
  'CELLULAR_WEBHOOK_PUBLIC_URL',
] as const;

function clearCellularEnv(): void {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
}

afterEach(() => {
  clearCellularEnv();
  resetCellularTransportWiring();
});

afterAll(() => {
  resetCellularTransportWiring();
});

describe('ensureCellularTransportsWired — the env → transport construction', () => {
  it('no configuration: both providers honestly unwired', () => {
    clearCellularEnv();
    const report = ensureCellularTransportsWired();
    expect(report.providers).toHaveLength(2);
    for (const state of report.providers) {
      expect(state.state).toBe('unwired');
    }
    expect(wiredCellularTransport('twilio')).toBeNull();
    expect(wiredCellularTransport('telnyx')).toBeNull();
    expect(getCellularTransport()).toBeNull(); // the single seam is untouched
  });

  it('full twilio configuration: the live REST transport is wired for the twilio provider', () => {
    process.env.CELLULAR_TWILIO_ACCOUNT_SID = 'AC_placeholder';
    process.env.CELLULAR_TWILIO_AUTH_TOKEN = 'token_placeholder';
    const report = ensureCellularTransportsWired();
    const twilio = report.providers.find((state) => state.provider === 'twilio')!;
    expect(twilio.state).toBe('wired');
    expect(wiredCellularTransport('twilio')?.provider).toBe('twilio');
    expect(wiredCellularTransport('telnyx')).toBeNull();
  });

  it('partial twilio configuration (sid without token): incomplete, unwired, honest', () => {
    process.env.CELLULAR_TWILIO_ACCOUNT_SID = 'AC_placeholder';
    const report = ensureCellularTransportsWired();
    const twilio = report.providers.find((state) => state.provider === 'twilio')!;
    expect(twilio.state).toBe('incomplete');
    expect(twilio.detail).toContain('BOTH CELLULAR_TWILIO_ACCOUNT_SID and CELLULAR_TWILIO_AUTH_TOKEN');
    expect(wiredCellularTransport('twilio')).toBeNull();
  });

  it('partial twilio configuration (token without sid): incomplete, unwired, honest', () => {
    process.env.CELLULAR_TWILIO_AUTH_TOKEN = 'token_placeholder';
    const report = ensureCellularTransportsWired();
    expect(report.providers.find((state) => state.provider === 'twilio')!.state).toBe('incomplete');
    expect(wiredCellularTransport('twilio')).toBeNull();
  });

  it('telnyx API key alone: wired in the documented SMS-only mode', () => {
    process.env.CELLULAR_TELNYX_API_KEY = 'KEY_placeholder';
    const report = ensureCellularTransportsWired();
    const telnyx = report.providers.find((state) => state.provider === 'telnyx')!;
    expect(telnyx.state).toBe('wired');
    expect(telnyx.detail).toContain('SMS-ONLY');
    expect(wiredCellularTransport('telnyx')?.provider).toBe('telnyx');
  });

  it('telnyx key + call control app: wired for SMS and voice', () => {
    process.env.CELLULAR_TELNYX_API_KEY = 'KEY_placeholder';
    process.env.CELLULAR_TELNYX_CALL_CONTROL_APP_ID = 'app_placeholder';
    const report = ensureCellularTransportsWired();
    const telnyx = report.providers.find((state) => state.provider === 'telnyx')!;
    expect(telnyx.state).toBe('wired');
    expect(telnyx.detail).toContain('Call Control');
  });

  it('call control app without an API key: unwired, honest (no credential, no transport)', () => {
    process.env.CELLULAR_TELNYX_CALL_CONTROL_APP_ID = 'app_placeholder';
    const report = ensureCellularTransportsWired();
    const telnyx = report.providers.find((state) => state.provider === 'telnyx')!;
    expect(telnyx.state).toBe('unwired');
    expect(telnyx.detail).toContain('no credential, no transport');
    expect(wiredCellularTransport('telnyx')).toBeNull();
  });

  it('both providers fully configured: both wired simultaneously (the per-provider registry)', () => {
    process.env.CELLULAR_TWILIO_ACCOUNT_SID = 'AC_placeholder';
    process.env.CELLULAR_TWILIO_AUTH_TOKEN = 'token_placeholder';
    process.env.CELLULAR_TELNYX_API_KEY = 'KEY_placeholder';
    process.env.CELLULAR_TELNYX_CALL_CONTROL_APP_ID = 'app_placeholder';
    const report = ensureCellularTransportsWired();
    expect(report.providers.filter((state) => state.state === 'wired')).toHaveLength(2);
    expect(wiredCellularTransport('twilio')?.provider).toBe('twilio');
    expect(wiredCellularTransport('telnyx')?.provider).toBe('telnyx');
  });

  it('is idempotent per process (the globalThis-guarded singleton)', () => {
    process.env.CELLULAR_TWILIO_ACCOUNT_SID = 'AC_placeholder';
    process.env.CELLULAR_TWILIO_AUTH_TOKEN = 'token_placeholder';
    const first = ensureCellularTransportsWired();
    // A late env change must NOT re-wire: the first computation stands
    // (the same discipline as the email port's cached backend choice).
    process.env.CELLULAR_TELNYX_API_KEY = 'KEY_placeholder';
    const second = ensureCellularTransportsWired();
    expect(second).toBe(first);
    expect(wiredCellularTransport('telnyx')).toBeNull();
  });

  it('reset restores the unwired state (tests and process shutdown)', () => {
    process.env.CELLULAR_TWILIO_ACCOUNT_SID = 'AC_placeholder';
    process.env.CELLULAR_TWILIO_AUTH_TOKEN = 'token_placeholder';
    ensureCellularTransportsWired();
    expect(wiredCellularTransport('twilio')).not.toBeNull();
    resetCellularTransportWiring();
    expect(wiredCellularTransport('twilio')).toBeNull();
    clearCellularEnv();
    expect(ensureCellularTransportsWired().providers.find((s) => s.provider === 'twilio')!.state).toBe(
      'unwired',
    );
  });
});

describe('getCellularWebhookVerificationConfig — the carrier edge credentials', () => {
  it('twilio: requires the auth token; carries it as the credential', () => {
    clearCellularEnv();
    expect(getCellularWebhookVerificationConfig('twilio')).toBeNull();
    process.env.CELLULAR_TWILIO_AUTH_TOKEN = 'token_placeholder';
    const config = getCellularWebhookVerificationConfig('twilio');
    expect(config).toMatchObject({ provider: 'twilio', credential: 'token_placeholder' });
  });

  it('telnyx: requires the public key; carries it as the webhook public key', () => {
    clearCellularEnv();
    expect(getCellularWebhookVerificationConfig('telnyx')).toBeNull();
    process.env.CELLULAR_TELNYX_PUBLIC_KEY = 'public-key-placeholder';
    const config = getCellularWebhookVerificationConfig('telnyx');
    expect(config).toMatchObject({ provider: 'telnyx', webhookPublicKey: 'public-key-placeholder' });
  });
});

describe('cellularWebhookSignatureUrl — the proxy-safe signature URL', () => {
  it('uses the request URL when no override is configured', () => {
    clearCellularEnv();
    expect(cellularWebhookSignatureUrl('https://internal/api/webhooks/cellular/twilio?q=1')).toBe(
      'https://internal/api/webhooks/cellular/twilio?q=1',
    );
  });

  it('uses the configured public URL (with the actual query) behind proxies', () => {
    process.env.CELLULAR_WEBHOOK_PUBLIC_URL = 'https://public.example.com/api/webhooks/cellular/twilio/';
    expect(cellularWebhookSignatureUrl('https://internal/api/webhooks/cellular/twilio?q=1')).toBe(
      'https://public.example.com/api/webhooks/cellular/twilio?q=1',
    );
  });
});
