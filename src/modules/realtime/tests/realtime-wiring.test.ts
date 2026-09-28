// Deterministic tests for the env-driven realtime transport wiring (W109)
// — the cellular.ts discipline applied to the realtime transport port:
// globalThis-anchored singleton, honest unset/partial/complete states,
// fail-closed provider_unavailable, additive wiring, and the
// deterministic scripted transport remaining available for tests.
//
// The env is manipulated with save/restore around every case (the wiring
// is computed once per process; resetRealtimeTransportWiring() is the
// test seam).

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import {
  ensureRealtimeTransportsWired,
  getRealtimeTransport,
  resetRealtimeTransportWiring,
  setRealtimeTransport,
} from '../contract';

const ENV_KEYS = [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'LIVEKIT_ACCOUNT_ID',
  'LIVEKIT_EGRESS_STREAM_URL',
  'LIVEKIT_SIP_TRUNK_ID',
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  resetRealtimeTransportWiring();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetRealtimeTransportWiring();
});

afterAll(() => {
  resetRealtimeTransportWiring();
});

describe('realtime transport env wiring (W109 — the cellular.ts discipline)', () => {
  it('reports livekit honestly unwired when no configuration is present', () => {
    const report = ensureRealtimeTransportsWired();
    expect(report.providers).toEqual([
      {
        provider: 'livekit',
        state: 'unwired',
        detail: expect.stringContaining('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET unset'),
      },
    ]);
    expect(report.livekitAccountId).toBeNull();
    expect(getRealtimeTransport()).toBeNull();
  });

  it('reports a PARTIAL configuration as incomplete and wires nothing', () => {
    process.env.LIVEKIT_URL = 'wss://partial.example';
    process.env.LIVEKIT_API_KEY = 'APIpartial';
    // LIVEKIT_API_SECRET intentionally unset.
    const report = ensureRealtimeTransportsWired();
    expect(report.providers[0]).toMatchObject({
      provider: 'livekit',
      state: 'incomplete',
      detail: expect.stringContaining('LIVEKIT_API_SECRET'),
    });
    expect(getRealtimeTransport()).toBeNull();
    expect(report.livekitAccountId).toBeNull();
  });

  it('wires the live transport from a complete configuration (default account id = URL host)', () => {
    process.env.LIVEKIT_URL = 'wss://zeck-vuo9lv9v.livekit.cloud';
    process.env.LIVEKIT_API_KEY = 'APIwired';
    process.env.LIVEKIT_API_SECRET = 'secret-wired';
    const report = ensureRealtimeTransportsWired();
    expect(report.providers[0]).toMatchObject({
      provider: 'livekit',
      state: 'wired',
      detail: expect.stringContaining("account 'zeck-vuo9lv9v.livekit.cloud'"),
    });
    expect(report.livekitAccountId).toBe('zeck-vuo9lv9v.livekit.cloud');
    const transport = getRealtimeTransport();
    expect(transport).not.toBeNull();
    expect(transport!.provider).toBe('livekit');
    // Honest sub-capabilities in the report.
    expect(report.providers[0]!.detail).toContain('recording UNAVAILABLE');
    expect(report.providers[0]!.detail).toContain('telephony dial-out UNAVAILABLE');
  });

  it('honors LIVEKIT_ACCOUNT_ID and reports configured sub-capabilities', () => {
    process.env.LIVEKIT_URL = 'wss://project.livekit.cloud';
    process.env.LIVEKIT_API_KEY = 'APIwired';
    process.env.LIVEKIT_API_SECRET = 'secret-wired';
    process.env.LIVEKIT_ACCOUNT_ID = 'lk-prod-account';
    process.env.LIVEKIT_EGRESS_STREAM_URL = 'rtmp://media.example/live/aurum';
    process.env.LIVEKIT_SIP_TRUNK_ID = 'st-prod';
    const report = ensureRealtimeTransportsWired();
    expect(report.livekitAccountId).toBe('lk-prod-account');
    expect(report.providers[0]!.detail).toContain('recording (RTMP egress)');
    expect(report.providers[0]!.detail).toContain('telephony dial-out (SIP trunk)');
  });

  it('computes the wiring exactly ONCE per process (globalThis anchor)', () => {
    process.env.LIVEKIT_URL = 'wss://once.example';
    process.env.LIVEKIT_API_KEY = 'APIonce';
    process.env.LIVEKIT_API_SECRET = 'secret-once';
    const first = ensureRealtimeTransportsWired();
    // The env CHANGES afterwards — the per-process wiring must not recompute.
    process.env.LIVEKIT_URL = 'wss://changed.example';
    const second = ensureRealtimeTransportsWired();
    expect(second).toBe(first);
    expect(second.livekitAccountId).toBe('once.example');
  });

  it('reset restores the unwired state (and never fights a test transport)', () => {
    setRealtimeTransport({
      provider: 'livekit',
      async startRoom() {
        throw new Error('scripted');
      },
      async stopRoom() {},
      async speak() {},
      async startRecording() {},
      async stopRecording() {
        return { artifact: null };
      },
      async dial() {
        return { providerParticipantId: 'x' };
      },
      async createJoinGrant() {
        return { url: 'wss://x', token: 't', expiresAt: '2027-01-01T00:00:00Z' };
      },
    });
    expect(getRealtimeTransport()).not.toBeNull();
    resetRealtimeTransportWiring();
    expect(getRealtimeTransport()).toBeNull();
    // A fresh wiring after reset works.
    process.env.LIVEKIT_URL = 'wss://again.example';
    process.env.LIVEKIT_API_KEY = 'APIagain';
    process.env.LIVEKIT_API_SECRET = 'secret-again';
    const report = ensureRealtimeTransportsWired();
    expect(report.providers[0]!.state).toBe('wired');
  });
});
