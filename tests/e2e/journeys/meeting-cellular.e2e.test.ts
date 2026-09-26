// W097 — the Meeting and Cellular End-to-End journey suite.
//
// Executes the machine-readable fixture at
// tests/e2e/fixtures/meeting-cellular/meeting-cellular.fixture.json
// (schema `aurum.meeting-cellular-fixture`, version 1) against the REAL
// module services — meetings (W085), realtime (W086), cellular (W087),
// unified-identity (W095) and their dependency contracts — through the
// fixture runner in ./meeting-cellular.fixture-runner.ts:
//
//   * provider webhook envelopes are parsed by the modules' PRIVATE
//     zoom/livekit/twilio adapters (the documented shapes — no mock of the
//     interpreter's own invention);
//   * deliveries go through scripted transports implementing the modules'
//     provider-neutral ports (no live telephony/meeting networks in the
//     suite — no credentials exist in this environment, so every live path
//     stays fixture-covered and environment-dependent);
//   * every hop's assertions read DURABLE state back through the contracts.
//
// Suite registration: this file matches the repository's journey-suite
// runner pattern — vitest discovers tests/e2e/journeys/*.e2e.test.ts
// through the `**/*.test.ts` testMatch (vitest.config.ts), so `bun run
// test` executes it exactly like journeys.e2e.test.ts. It introduces NO
// new user-visible route (existing module surfaces only), so the
// discoverability instruments list is deliberately NOT extended. The
// tenant-isolation dimension is carried INSIDE the journey (the
// `foreignInvisible` assertions of the golden-journey and
// manager-originated scenarios — another tenant sees the whole chain as
// uniformly missing) rather than as a tests/tenant-isolation sweep: the
// four underlying modules already own their sweeps (meetings-sweep,
// realtime-sweep, cellular-sweep, unified-identity-sweep) and the coverage
// manifest maps src/modules directories exactly — no new module is added
// here, so no new manifest entry is legal without breaking the tripwire.
//
// The scenarios, in fixture order:
//   1. golden-journey           — the full acceptance chain: meeting
//      transcript/artifact ingestion → Meeting Companion (consented
//      recording, spoken response, durable finalization) → SMS fallback
//      (delivery + reply-to-Aurum continuity) → voice fallback (spoken
//      reply) → W095 recognition at every modality hop (one person, one
//      organizational identity, five modalities).
//   2. consent-and-policy-refusal — consent absent → nothing sent, the
//      refusal recorded with its policy reason, auditable, the asking
//      manager notified; consent granted → sends; consent revoked →
//      nothing more sent; plus the realtime all-party consent floor
//      (refused start → explicit blocked event; mid-recording revocation
//      → stop).
//   3. manager-originated       — a manager with no usable Internet data
//      texts and calls Aurum's own number; both requests return into
//      Aurum with attribution and land as canonical conversation turns.
//      The authority-gate record for inbound requests is DEFERRED (the
//      fixture itself carries the deferred note + the exact missing
//      contract).
//   4. provider-failure         — honest degradation: explicit meeting
//      access failure (event + observation), provider-side companion
//      failure (failed session still finalizes), unwired cellular
//      transport (provider_unavailable, retryable), unanswered voice
//      fallback (voice_no_answer + failure notification).
//   5. ambiguous-identity       — the W095 rule in-chain: a companion
//      participant with disagreeing facets stays external/unverified with
//      an OPEN ambiguity — never auto-merged.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeBlobStore } from '@/infra/blob';
import { closeDb, getDb } from '@/infra/db';
import { runMigrations } from '../../../scripts/migrate';
import {
  FIXTURE_SCHEMA,
  FIXTURE_VERSION,
  loadFixture,
  runScenario,
  validateFixture,
} from './meeting-cellular.fixture-runner';

const fixture = loadFixture();

describe('W097 — Meeting and Cellular End-to-End Fixture', () => {
  beforeAll(async () => {
    await runMigrations(getDb());
  });

  afterAll(async () => {
    closeBlobStore();
    await closeDb();
  });

  it('the fixture is machine-readable against its versioned schema', () => {
    expect(fixture.schema).toBe(FIXTURE_SCHEMA);
    expect(fixture.version).toBe(FIXTURE_VERSION);
    expect(fixture.scenarios.map((scenario) => scenario.id)).toEqual([
      'golden-journey',
      'consent-and-policy-refusal',
      'manager-originated',
      'provider-failure',
      'ambiguous-identity',
    ]);
    for (const scenario of fixture.scenarios) {
      expect(scenario.proves.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.script.length, scenario.id).toBeGreaterThan(0);
      expect(scenario.final.length, scenario.id).toBeGreaterThan(0);
    }
    // Validation is deterministic and idempotent over a round trip.
    expect(() => validateFixture(JSON.parse(JSON.stringify(fixture)))).not.toThrow();

    // The manager-originated scenario records its DEFERRED contract gap
    // inside the fixture itself (machine-readable, not prose-only).
    const manager = fixture.scenarios.find((scenario) => scenario.id === 'manager-originated');
    expect(manager).toBeDefined();
    expect(manager!.deferred?.length ?? 0).toBeGreaterThan(0);
    expect(manager!.deferred![0]!.missingContract).toContain('inbound-request audit surface');
  });

  for (const scenario of fixture.scenarios) {
    it(`scenario '${scenario.id}' executes end-to-end against the real module services`, async () => {
      await runScenario(scenario);
    });
  }
});
