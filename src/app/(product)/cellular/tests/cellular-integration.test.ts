// Integration tests for the cellular reachability surface (W104 — J18)
// against the embedded PostgreSQL (PGlite, `:memory:`) through the db
// port.
//
// THE JOURNEY'S MANDATORY PROOF — "environment limits recorded as the
// module reports them" — proven end to end through the REAL cellular
// contract:
//
//   * the HONEST ENVIRONMENT LIMIT — no transport is wired in this
//     environment, so a seeded reach request records the module's own
//     report: status 'failed', failureCode 'provider_unavailable' (the
//     retryable classification), and per-leg attempt rows that say
//     exactly "no cellular transport is wired" with NO connection placed
//     — never a faked delivery;
//   * the HUB view — the reach feed (the failed row visible with its
//     failure code), the registered telecom connection, and the
//     routing/cost policy row the request snapshotted;
//   * the DETAIL view — the immutable intent with its policy snapshot,
//     the append-only attempt audit (SMS + voice legs, both honest
//     placement failures), and the (empty) replies;
//   * the HONEST NOT-FOUND — a foreign reach id throws the contract's
//     own reach_not_found (the page renders the not-found state; no
//     existence leak);
//   * TENANCY (ADR-0001) — tenant B's hub is empty and tenant A's reach
//     id reads as missing for tenant B.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../../scripts/migrate';
import { provisionTenant } from '@/modules/organizations/contract';
import type { Tenant } from '@/modules/organizations/contract';
import * as cellular from '@/modules/cellular/contract';
import { buildCellularHomeView, buildReachDetailView } from '../lib/views';

let tenant: Tenant;
let isoTenant: Tenant;
let ctx: TenantContext;
let isoCtx: TenantContext;
let reachId = '';

async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected error code '${code}' but the call succeeded`);
  } catch (error) {
    const actual = (error as { code?: unknown }).code;
    expect(actual).toBe(code);
  }
}

beforeAll(async () => {
  await runMigrations(getDb());

  const platform = { principalId: newId(), authority: ['organizations:provision'] };
  tenant = await provisionTenant(platform, {
    name: 'Cellular Surface Co',
    ownerPrincipalId: newId(),
  });
  isoTenant = await provisionTenant(platform, { name: 'Cellular Iso Co', ownerPrincipalId: newId() });
  ctx = { tenantId: tenant.id, principalId: newId(), authority: [] };
  isoCtx = { tenantId: isoTenant.id, principalId: newId(), authority: [] };

  // The seeded world: one sending connection, a one-attempt + voice-
  // escalation policy, and one reach request — which, with no transport
  // wired, records the honest provider_unavailable environment limit.
  await cellular.registerCellularConnection(ctx, {
    provider: 'twilio',
    providerAccountId: 'twilio-acct-surface',
    phoneNumber: '+15550100184',
    displayName: 'Surface Twilio',
    credentialRef: 'secret-store://twilio/surface',
  });
  await cellular.setCellularPolicy(
    { ...ctx, authority: ['cellular:administer'] },
    {
      reachKind: 'tell',
      voiceFallback: 'on_sms_failure',
      smsMaxAttempts: 1,
      note: 'the surface test policy',
    },
  );
  const reach = await cellular.reachAnyone(ctx, {
    phoneNumber: '+15550100684',
    kind: 'tell',
    text: 'The surface reads the module-reported environment limit.',
  });
  reachId = reach.id;
  expect(reach.status).toBe('failed');
  expect(reach.failureCode).toBe('provider_unavailable');
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The hub view
// ---------------------------------------------------------------------------

describe('buildCellularHomeView', () => {
  it('composes the reach feed, the connection and the policy rows', async () => {
    const view = await buildCellularHomeView(ctx);
    expect(view.degraded).toEqual([]);

    expect(view.reach).toHaveLength(1);
    const row = view.reach[0]!;
    expect(row.id).toBe(reachId);
    expect(row.kind).toBe('tell');
    expect(row.phoneNumber).toBe('+15550100684');
    expect(row.text).toContain('environment limit');
    expect(row.href).toBe(`/cellular/reach/${reachId}`);

    expect(view.connections).toHaveLength(1);
    expect(view.connections[0]!.phoneNumber).toBe('+15550100184');
    expect(view.connections[0]!.status).toBe('active');

    expect(view.policies).toHaveLength(1);
    expect(view.policies[0]!.reachKind).toBe('tell');
    expect(view.policies[0]!.voiceFallback).toBe('on_sms_failure');
    expect(view.policies[0]!.smsMaxAttempts).toBe(1);
  });

  it('THE ENVIRONMENT LIMIT rides the feed row exactly as the module recorded it', async () => {
    const view = await buildCellularHomeView(ctx);
    const row = view.reach[0]!;
    expect(row.status).toBe('failed');
    expect(row.failureCode).toBe('provider_unavailable');
    expect(row.smsAttemptsCount).toBe(1);
    expect(row.voiceAttemptsCount).toBe(1);
  });

  it('an empty tenant sees honest empty families (never fake emptiness)', async () => {
    const view = await buildCellularHomeView(isoCtx);
    expect(view.reach).toEqual([]);
    expect(view.connections).toEqual([]);
    expect(view.policies).toEqual([]);
    expect(view.degraded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The detail view
// ---------------------------------------------------------------------------

describe('buildReachDetailView', () => {
  it('composes the intent, its policy snapshot, the attempt audit and the replies', async () => {
    const view = await buildReachDetailView(ctx, reachId);
    expect(view.degraded).toEqual([]);

    const reach = view.reach;
    expect(reach.text).toContain('environment limit');
    expect(reach.recipientKind).toBe('unknown_number');
    expect(reach.actionKind).toBe('external-communication');
    expect(reach.policySource).toBe('kind');
    expect(reach.voiceFallback).toBe('on_sms_failure');
    expect(reach.smsMaxAttempts).toBe(1);

    // The append-only audit: one SMS leg and one voice leg, both honest
    // placement failures — no connection used, the module's own detail
    // string, zero cost recorded.
    expect(view.attempts.length).toBe(2);
    expect(view.attempts.map((attempt) => attempt.leg).sort()).toEqual(['sms', 'voice']);
    for (const attempt of view.attempts) {
      expect(attempt.status).toBe('failed');
      expect(attempt.connectionId).toBeNull();
      expect(attempt.fromNumber).toBeNull();
      expect(attempt.costMinor).toBe(0);
      expect(attempt.detail).toContain('no cellular transport is wired');
    }

    expect(view.replies).toEqual([]);
  });

  it('a foreign or malformed reach id throws the contract not-found (the honest 404 path)', async () => {
    await expectCode('reach_not_found', () => buildReachDetailView(ctx, newId()));
  });

  it('another tenant sees tenant A\'s reach as missing (no existence leak)', async () => {
    await expectCode('reach_not_found', () => buildReachDetailView(isoCtx, reachId));
  });
});
