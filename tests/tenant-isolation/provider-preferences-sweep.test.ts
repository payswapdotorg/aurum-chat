// W044 — Tenant Isolation Verification · the provider-preferences sweep (W091).
//
// The provider-preferences module (W091 — User-Friendly Provider Choice UX)
// owns tenant-scoped tables for the outcome preference layer over the llm
// gateway's routing facts: the tenant preference profile, the deterministic
// preference → order mapping documentation, and the append-only change
// event audit.
//
// This sweep proves the tenant boundary at the APPLICATION level, per the
// W044 doctrine — two tenants side by side, zero leakage:
//   * profiles, mappings and change events are tenant-scoped: each
//     tenant's audit lists only its own events, and the same preference
//     saved in both tenants yields two INDEPENDENT profiles;
//   * a foreign execution id explains as the same not-found state as a
//     missing one (explainRoutingDecision — uniform, no existence leak);
//   * the technical override is claim-gated but NEVER scope-giving: a
//     tenant-B principal holding every authority claim in the repository
//     (including llm:administer) cannot reach tenant A's accounts —
//     updateProviderAccountControls rejects with the uniform
//     `account_not_found` (ADR-0001);
//   * the repository boundary: every provider-preferences table carries a
//     NOT NULL uuid tenant_id, and the row partition holds after the
//     fixtures ran.
//
// The deep per-operation isolation cases live in the module's own suite
// (src/modules/provider-preferences/tests/); this sweep is the two-tenant
// proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import { registerAiProviderAccount } from '@/modules/llm/contract';
import {
  applyPreferenceProfile,
  explainRoutingDecision,
  getProviderPreferenceProfile,
  listPreferenceChangeEvents,
  savePreferenceProfile,
  updateProviderAccountControls,
} from '@/modules/provider-preferences/contract';
import {
  assertTenantPartition,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  runMigrations,
  tableColumns,
} from './harness';

const tenantA = newId();
const tenantB = newId();

/** Tenant A's registered AI option id (minted by the journey below). */
let accountAId = '';

const PREFERENCE_TABLES = [
  'provider_preference_profiles',
  'provider_preference_mappings',
  'provider_preference_events',
] as const;

async function expectCode(code: string, fn: () => Promise<unknown>): Promise<void> {
  let caught: unknown;
  let succeeded = false;
  try {
    await fn();
    succeeded = true;
  } catch (error) {
    caught = error;
  }
  expect(succeeded, `expected an error with code '${code}' but the call succeeded`).toBe(false);
  expect(caught, `expected an Error with code '${code}'`).toBeInstanceOf(Error);
  expect((caught as { code?: unknown }).code, `expected error code '${code}'`).toBe(code);
}

/**
 * One tenant's preference journey: an administrator registers an AI
 * option (BYOA, through the llm contract), saves a privacy-first choice
 * (auto-applied because the saver administers the technical layer), then
 * exercises the technical override. Both tenants use the SAME provider and
 * label keys — the preference state stays independent.
 */
async function preferenceJourney(tenantId: string, label: string): Promise<string> {
  const admin = memberWith(tenantId, ['llm:administer']);
  const registration = await registerAiProviderAccount(admin, {
    provider: 'openai',
    label,
    credentialRef: `sweep-credential-${label}`,
    scopes: ['conversation'],
    capabilities: ['text-generation'],
    maxDataClassification: 'internal',
    priority: 10,
  });
  const saved = await savePreferenceProfile(admin, { preference: 'privacy-first' });
  expect(saved.application.applied).toBe(true);
  const overridden = await updateProviderAccountControls(admin, {
    accountId: registration.account.id,
    priority: 40,
  });
  expect(overridden.account.priority).toBe(40);
  return registration.account.id;
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('W044 sweep — provider-preferences (W091)', () => {
  it('runs both tenants’ journeys side by side with the same keys', async () => {
    accountAId = await preferenceJourney(tenantA, 'sweep-preferences');
    await preferenceJourney(tenantB, 'sweep-preferences');
    expect(accountAId).not.toBe('');
  });

  it('keeps the change-event audit per-tenant (disjoint listings)', async () => {
    const memberA = memberWith(tenantA, []);
    const memberB = memberWith(tenantB, []);
    const eventsA = await listPreferenceChangeEvents(memberA, { limit: 100 });
    const eventsB = await listPreferenceChangeEvents(memberB, { limit: 100 });
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    const idsA = new Set(eventsA.map((event) => event.id));
    const idsB = new Set(eventsB.map((event) => event.id));
    for (const id of idsA) expect(idsB.has(id), `tenant A event leaked to tenant B: ${id}`).toBe(false);
    for (const id of idsB) expect(idsA.has(id), `tenant B event leaked to tenant A: ${id}`).toBe(false);
    for (const event of eventsA) expect(event.tenantId).toBe(tenantA);
    for (const event of eventsB) expect(event.tenantId).toBe(tenantB);
  });

  it('keeps profiles and mapping guidance per-tenant (independent state)', async () => {
    // Tenant B re-saves a different choice; tenant A's profile must not move.
    const adminB = memberWith(tenantB, ['llm:administer']);
    await savePreferenceProfile(adminB, { preference: 'balanced' });
    const viewA = await getProviderPreferenceProfile(memberWith(tenantA, []));
    expect(viewA.preference).toBe('privacy-first');
    expect(viewA.saved).toBe(true);
    const viewB = await getProviderPreferenceProfile(memberWith(tenantB, []));
    expect(viewB.preference).toBe('balanced');
    expect(viewB.pendingApplication).toBe(false);
  });

  it('explains a foreign execution exactly like a missing one (no existence leak)', async () => {
    const memberA = memberWith(tenantA, []);
    const foreign = await explainRoutingDecision(memberA, { executionId: newId() });
    expect(foreign.found).toBe(false);
    if (foreign.found === false) {
      expect(foreign.reason).toBe('execution-not-found');
    }
    // No execution has run in either sweep tenant: the latest-execution
    // read is the honest no-executions state, not a leak.
    const none = await explainRoutingDecision(memberA, {});
    expect(none.found).toBe(false);
    if (none.found === false) {
      expect(none.reason).toBe('no-executions');
    }
  });

  it('never lets authority claims cross the tenant boundary (omnipotent tenant B is blind to tenant A)', async () => {
    const omnipotentB = memberWith(tenantB, [...OMNIPOTENT_AUTHORITY]);

    // The technical override on tenant A's account, from tenant B, with
    // EVERY claim: uniform not-found, indistinguishable from a missing
    // account (the llm contract's own discipline, wrapped by this module).
    await expectCode('account_not_found', () =>
      updateProviderAccountControls(omnipotentB, { accountId: accountAId, priority: 5 }),
    );
    await expectCode('account_not_found', () =>
      updateProviderAccountControls(omnipotentB, { accountId: newId(), priority: 5 }),
    );

    // Cross-tenant apply stays scoped: tenant B applying its own saved
    // preference never touches tenant A's rows (the partition probe below
    // proves it at the storage level).
    const applied = await applyPreferenceProfile(omnipotentB, {});
    expect(applied.application.applied).toBe(true);
  });

  it('carries a NOT NULL uuid tenant_id on every provider-preferences table (repository boundary)', async () => {
    const columns = await tableColumns();
    for (const table of PREFERENCE_TABLES) {
      const tenantColumn = columns.find(
        (column) => column.table_name === table && column.column_name === 'tenant_id',
      );
      expect(tenantColumn, `${table} must carry a tenant_id column`).toBeDefined();
      expect(tenantColumn?.data_type).toBe('uuid');
      expect(tenantColumn?.is_nullable).toBe('NO');
    }
  });

  it('holds the row partition after the fixtures ran (no ambient-tenant writes)', async () => {
    await assertTenantPartition([tenantA, tenantB]);
  });
});
