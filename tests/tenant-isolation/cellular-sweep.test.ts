// W044 — Tenant Isolation Verification · the cellular sweep (W087).
//
// The cellular module (W087 — Cellular Reachability and Communication
// Fallback) owns tenant-scoped tables for its Reach Anyone surface:
// telecom connections, routing/cost policies, reach requests, delivery
// attempts, the provider event ledger and recorded inbound replies.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * connections are tenant-scoped: a carrier envelope whose account
//     belongs to the other tenant is uniformly not-found (the event path
//     refuses cross-tenant account resolution BEFORE anything is applied —
//     no existence leak);
//   * reach requests, attempts, replies and the event ledger of one tenant
//     are invisible to the other (uniform not-found, disjoint listings);
//   * a reach request of one tenant cannot be retried from the other;
//   * policy administration is claim-gated but NEVER scope-giving: a
//     tenant-B principal holding every authority claim in the repository
//     (plus 'cellular:administer') stays blind to tenant A — authority
//     authorizes operations, never tenant scope (ADR-0001);
//   * the repository boundary: every cellular table carries a NOT NULL
//     uuid tenant_id, and the row partition holds after the fixtures ran.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/cellular/tests/); this sweep is the two-tenant proof the
// W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { systemClock } from '@/infra/clock';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import {
  assertTenantPartition,
  member,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  runMigrations,
  tableColumns,
} from './harness';
import {
  getCellularConnection,
  getCellularReach,
  listCellularAttempts,
  listCellularConnections,
  listCellularEvents,
  listCellularReach,
  listCellularReplies,
  pumpCellularReach,
  reachAnyone,
  receiveCellularEvent,
  registerCellularConnection,
  retryCellularReach,
  setCellularPolicy,
  setCellularTransport,
} from '@/modules/cellular/contract';
import { CellularError } from '@/modules/cellular/errors';
import type { CellularTransport } from '@/modules/cellular/types';

const tenantA = newId();
const tenantB = newId();

const CELLULAR_TABLES = [
  'cellular_connections',
  'cellular_policies',
  'cellular_reach_requests',
  'cellular_attempts',
  'cellular_events',
  'cellular_replies',
] as const;

async function expectCode(code: CellularError['code'], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    throw new Error(`expected CellularError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof CellularError)) throw error;
    expect(error.code).toBe(code);
  }
}

/** A minimal scripted transport (provider-neutral; deterministic receipts). */
class SweepTransport implements CellularTransport {
  readonly provider = 'twilio' as const;
  private seq = 0;
  async sendSms() {
    this.seq += 1;
    return {
      status: 'accepted' as const,
      providerMessageId: `SM_sweep_${newId().slice(0, 8)}_${this.seq}`,
      detail: null,
    };
  }
  async placeVoiceCall() {
    this.seq += 1;
    return {
      status: 'answered' as const,
      providerCallId: `CA_sweep_${newId().slice(0, 8)}_${this.seq}`,
      detail: null,
    };
  }
}

/**
 * One tenant's cellular journey: connection → policy → a raw-number reach
 * (accepted, then a reply) → the ledger and reply rows.
 */
async function cellularJourney(
  tenantId: string,
  key: string,
): Promise<{ reachId: string }> {
  const ctx: TenantContext = memberWith(tenantId, ['cellular:administer']);
  const { connection } = await registerCellularConnection(ctx, {
    provider: 'twilio',
    providerAccountId: `AC-${key}`,
    phoneNumber: `+1555010${key === 'a' ? '000' : '111'}0`,
    credentialRef: `secret-store:cellular/${key}`,
  });
  await setCellularPolicy(ctx, { voiceFallback: 'on_sms_failure' });
  const phone = `+1555${key === 'a' ? '300111' : '300222'}1`;
  const reach = await reachAnyone(ctx, {
    phoneNumber: phone,
    kind: 'tell',
    text: `Journey ${key} message.`,
    connectionId: connection.id,
  });
  // The carrier confirms delivery, then the recipient replies.
  const attempts = await listCellularAttempts(ctx, { reachRequestId: reach.id });
  await receiveCellularEvent(ctx, {
    provider: 'twilio',
    payload: {
      MessageSid: attempts[0]!.providerMessageId,
      MessageStatus: 'delivered',
      AccountSid: `AC-${key}`,
    },
  });
  await receiveCellularEvent(ctx, {
    provider: 'twilio',
    payload: {
      From: phone,
      To: `+1555010${key === 'a' ? '000' : '111'}0`,
      Body: `Journey ${key} reply.`,
      MessageSid: `SM_sweep_reply_${key}`,
      AccountSid: `AC-${key}`,
    },
  });
  return { reachId: reach.id };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  setCellularTransport(null);
  await closeDb();
});

beforeEach(() => {
  vi.spyOn(systemClock, 'now').mockImplementation(() => new Date('2026-09-25T10:00:00Z'));
  setCellularTransport(new SweepTransport());
});

afterEach(() => {
  vi.restoreAllMocks();
  setCellularTransport(null);
});

describe('W044 sweep — cellular (W087)', () => {
  it('runs both tenants side by side with zero leakage', async () => {
    const { reachId: reachA } = await cellularJourney(tenantA, 'a');
    const { reachId: reachB } = await cellularJourney(tenantB, 'b');

    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    // Listings are disjoint.
    const reachesA = await listCellularReach(ctxA, { limit: 500 });
    const reachesB = await listCellularReach(ctxB, { limit: 500 });
    expect(reachesA).toHaveLength(1);
    expect(reachesB).toHaveLength(1);
    expect(reachesA[0]!.id).toBe(reachA);
    expect(reachesB[0]!.id).toBe(reachB);

    // Cross-tenant reads are uniformly not-found.
    await expectCode('reach_not_found', () => getCellularReach(ctxA, { reachRequestId: reachB }));
    await expectCode('reach_not_found', () => getCellularReach(ctxB, { reachRequestId: reachA }));
    await expectCode('reach_not_found', () =>
      listCellularAttempts(ctxA, { reachRequestId: reachB }));
    await expectCode('reach_not_found', () =>
      listCellularReplies(ctxB, { reachRequestId: reachA }));
    await expectCode('reach_not_found', () => retryCellularReach(ctxA, { reachRequestId: reachB }));

    // The reply trail of each tenant is its own (and stays that way).
    const repliesA = await listCellularReplies(ctxA, { reachRequestId: reachA });
    const repliesB = await listCellularReplies(ctxB, { reachRequestId: reachB });
    expect(repliesA.map((r) => r.text)).toEqual(['Journey a reply.']);
    expect(repliesB.map((r) => r.text)).toEqual(['Journey b reply.']);
    expect(repliesA[0]!.inboundKind).toBe('reach_reply');
    expect(repliesA[0]!.reachRequestId).toBe(reachA);

    // THE event boundary: an envelope whose account belongs to the other
    // tenant is uniformly not-found — nothing is applied, no existence
    // leak. The refused delivery left no trace in tenant A's ledger.
    await expectCode('connection_not_found', () =>
      receiveCellularEvent(ctxA, {
        provider: 'twilio',
        payload: {
          From: '+15553002221',
          To: '+15550100000',
          Body: 'foreign probe',
          MessageSid: 'SM_sweep_foreign',
          AccountSid: 'AC-b',
        },
      }),
    );
    const eventsA = await listCellularEvents(ctxA, { limit: 500 });
    expect(eventsA.every((event) => event.tenantId === tenantA)).toBe(true);
    expect(eventsA.length).toBe(2); // the delivery receipt + the reply

    // Connections and the pump stay tenant-scoped.
    const connectionsA = await listCellularConnections(ctxA, {});
    expect(connectionsA).toHaveLength(1);
    expect(connectionsA[0]!.providerAccountId).toBe('AC-a');
    const connectionsB = await listCellularConnections(ctxB, {});
    expect(connectionsB[0]!.providerAccountId).toBe('AC-b');
    await expectCode('connection_not_found', () =>
      getCellularConnection(ctxA, { connectionId: connectionsB[0]!.id }),
    );
    const pumpA = await pumpCellularReach(ctxA, {});
    expect(pumpA.processed).toBe(0); // nothing pending — both tenants delivered
    expect((await pumpCellularReach(ctxB, {})).processed).toBe(0);
  });

  it('policy administration is claim-gated but never scope-giving (omniscient blind probe)', async () => {
    // A tenant-B principal holding every authority claim this repository
    // checks — including W087's own 'cellular:administer' — stays blind to
    // tenant A. Authority authorizes operations, never tenant scope.
    const blindB = memberWith(tenantB, [...OMNIPOTENT_AUTHORITY, 'cellular:administer']);
    const reachesA = await listCellularReach(member(tenantA), { limit: 500 });
    const reachA = reachesA[0]!;
    await expectCode('reach_not_found', () => getCellularReach(blindB, { reachRequestId: reachA.id }));
    await expectCode('reach_not_found', () =>
      listCellularAttempts(blindB, { reachRequestId: reachA.id }),
    );
    await expectCode('reach_not_found', () =>
      retryCellularReach(blindB, { reachRequestId: reachA.id }),
    );
    // Tenant B's own view is untouched by the probe.
    expect((await listCellularReach(blindB, { limit: 500 })).map((r) => r.id)).toEqual([
      (await listCellularReach(member(tenantB), { limit: 500 }))[0]!.id,
    ]);
  });

  it('carries a NOT NULL uuid tenant_id on every cellular table (repository boundary)', async () => {
    const columns = await tableColumns();
    for (const table of CELLULAR_TABLES) {
      const tenantColumn = columns.find(
        (column) => column.table_name === table && column.column_name === 'tenant_id',
      );
      expect(tenantColumn, `${table} must carry a tenant_id column`).toBeDefined();
      expect(tenantColumn!.data_type, `${table}.tenant_id must be uuid`).toBe('uuid');
      expect(tenantColumn!.is_nullable, `${table}.tenant_id must be NOT NULL`).toBe('NO');
    }
  });

  it('holds the row partition across every tenant-scoped table after the fixtures ran', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
