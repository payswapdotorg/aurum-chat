// W111 — the HOSTED-PostgreSQL leg of the real-reader path: the same
// full migration journey as migration-readers-real.test.ts, executed
// against a REAL external PostgreSQL server when AURUM_TEST_DATABASE_URL
// is provided (the src/infra/worker-realpostgres.test.ts precedent — in
// CI this is the postgres:16 service container; in staging it is the
// same node-postgres backend Neon serves). Skipped otherwise so ordinary
// gate runs need no servers.
//
// STATUS AT DELIVERY: the operator-provisioned hosted environment
// (Neon, keys provided with the work order) was UNREACHABLE from this
// sandbox — api.neon.tech is DNS-unresolvable from every sandbox on this
// platform (verified by the tech lead AND re-probed for the evidence
// file; see docs/productization-evidence/W111/neon-dns-probes.txt). The
// embedded real PostgreSQL (PGlite) leg in migration-readers-real.test.ts
// is therefore the real environment the full path is PROVEN on; this
// hosted leg stands ready for any reachable AURUM_TEST_DATABASE_URL.

const realDatabaseUrl = process.env.AURUM_TEST_DATABASE_URL;

// The db port's singleton is LAZY (environment read at first use, never
// at import), so the postgres backend is selected here — before the
// first getDb() call — exactly like the worker-realpostgres precedent
// (an explicit AURUM_DB would override DATABASE_URL, so it stays unset).
if (realDatabaseUrl) {
  delete process.env.AURUM_DB;
  delete process.env.AURUM_DB_MEMORY;
  process.env.DATABASE_URL = realDatabaseUrl;
} else {
  process.env.AURUM_DB = 'embedded';
  process.env.AURUM_DB_MEMORY = '1';
  delete process.env.DATABASE_URL;
}
delete process.env.REDIS_URL;

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as sourcesContract from '@/modules/sources/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import { runMigrations } from '../../../../scripts/migrate';
import * as migration from '../contract';
import { createCsvExportIncumbentReader } from '../adapters/csv-export-incumbent-reader';
import { createWorldEntitiesNativeReader } from '../adapters/world-native-reader';

const { registerSource, setSourceTransport } = sourcesContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;

const HEADER = 'external_id,match_key,entity_type,deleted_at,payload_json';

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvRow(...cells: string[]): string {
  return cells.map(csvCell).join(',');
}

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

let roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aurum-w111-hosted-'));
  roots.push(root);
  return root;
}

async function writeExportVersion(
  root: string,
  version: number,
  content: string,
): Promise<void> {
  const dir = path.join(root, `csv-export-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'records.csv'), content);
}

class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  async fetch(): Promise<sourcesContract.SourceFetchResult> {
    return {
      records: [directoryRecord('w111h-crm', 'W111 Hosted CRM')],
      nextCursor: null,
      hasMore: false,
    };
  }
}

function directoryRecord(
  externalId: string,
  displayName: string,
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${externalId}`,
    kind: 'directory.system.discovered',
    payload: { externalId, displayName, capabilityClasses: ['customer-records'] },
    occurredAt: '2026-09-27T10:00:00Z',
  };
}

class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(request: brokerContract.BrokerHttpRequest): Promise<brokerContract.BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.w111h.example/oauth/${state}`,
          state,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const connectionId = decodeURIComponent(callback[1]!);
      const body = request.body as { state?: string };
      if (this.authorizations.get(connectionId) !== body.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb-${this.counter.toString().padStart(3, '0')}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: ['read'],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

async function connectIncumbentSystem(
  tenantId: string,
): Promise<{ systemId: string; systemKey: string; connectionId: string }> {
  const admin = memberOf(tenantId, ['integration-intelligence:administer']);
  const member = memberOf(tenantId);
  const { source } = await registerSource(admin, {
    provider: 'notion',
    providerAccountId: `w111h-crm-${tenantId.slice(0, 8)}`,
    displayName: 'W111 hosted directory',
    authKind: 'oauth',
    credentialRef: 'secret-store://w111h/crm/ref',
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await grantDiscoverySource(admin, { sourceId: source.id });
  await runDiscovery(member, { sourceId: source.id });
  const systems = await listSystems(member, {});
  const system = systems.find((entry) => entry.displayName === 'W111 Hosted CRM');
  if (system === undefined) {
    throw new Error("the scripted directory did not surface 'W111 Hosted CRM'");
  }
  const initiated = await initiateConnection(member, {
    provider: 'notion',
    connectionKey: `w111h-crm-${tenantId.slice(0, 8)}`,
    displayName: 'W111 Hosted CRM',
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(member, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return { systemId: system.id, systemKey: system.systemKey, connectionId: completed.connection.id };
}

describe.skipIf(!realDatabaseUrl)('the full migration path on a REAL hosted PostgreSQL (W111)', () => {
  beforeAll(async () => {
    // The full module migration set applies through the db port's
    // postgres backend (the deployment "migrations" path).
    await runMigrations(getDb());
    setSourceTransport(new ScriptedDirectoryTransport());
    wireConnectionBrokers([
      createEmbeddedBroker({
        baseUrl: 'https://broker.w111h.example',
        apiToken: ['embedded_tok_', 'w111h', '_fragment'].join(''),
        httpClient: new ScriptedBrokerBackend(),
      }),
    ]);
  });

  afterEach(() => {
    migration.setMigrationIncumbentReader(null);
    migration.setMigrationNativeReader(null);
    migration.setMigrationVerificationTransport(null);
  });

  afterAll(async () => {
    setSourceTransport(null);
    wireConnectionBrokers(null);
    migration.setMigrationIncumbentReader(null);
    migration.setMigrationNativeReader(null);
    migration.setMigrationVerificationTransport(null);
    await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots = [];
    await closeDb();
  });

  it('walks staged import → verification-free commit → native catch-up → clean comparison → retirement against the real server', async () => {
    const tenant = newId();
    const admin = memberOf(tenant, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const reviewer = memberOf(tenant, [migration.MIGRATION_AUTHORITY_REVIEW]);
    const member = memberOf(tenant);

    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [
        HEADER,
        csvRow('H-1', 'k-1', 'customer', '', JSON.stringify({ stage: 'active', seats: 3 })),
        csvRow('H-2', 'k-2', 'customer', '', JSON.stringify({ stage: 'onboarding' })),
        csvRow('H-3', 'k-3', 'customer', '', 'broken json'), // rejected row 3
      ].join('\n'),
    );
    migration.setMigrationIncumbentReader(createCsvExportIncumbentReader({ exportRoot: root }));

    const side = await connectIncumbentSystem(tenant);
    const created = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const migrationId = created.migration.id;

    // Staged import with the no-silent-loss reconciliation.
    const captured = await migration.captureSnapshot(member, { migrationId });
    expect(captured.round.snapshotRef).toBe('csv-export-1');
    expect(captured.records).toHaveLength(2);
    expect(captured.rejections).toHaveLength(1);
    expect(captured.records.length + captured.rejections.length).toBe(3);
    await migration.transformImportRound(member, { roundId: captured.round.id });
    await migration.reviewImportRound(reviewer, { roundId: captured.round.id });
    const commit = await migration.commitImportRound(admin, { roundId: captured.round.id });
    expect(commit.round.status).toBe('committed');
    expect(commit.mapEntries).toHaveLength(2);

    // The native catch-up carrying the map's minted ids, through REAL SQL.
    const db = getDb();
    for (const record of commit.records) {
      await db.query(
        `INSERT INTO world_entities (
           id, tenant_id, kind, category, name, description, attributes,
           external_module, external_id, created_at, updated_at
         ) VALUES ($1, $2, 'company', 'company', $3, 'W111 hosted catch-up', $4::jsonb, 'migration', $1, now(), now())`,
        [record.aurumEntityId, tenant, record.externalId, JSON.stringify(record.payload)],
      );
    }
    migration.setMigrationNativeReader(createWorldEntitiesNativeReader(tenant));

    // The comparison converges clean → the retirement checkpoints.
    const round = await migration.runComparisonRound(member, { migrationId });
    expect(round.round.comparedEntityCount).toBe(2);
    expect(round.round.divergenceCount).toBe(0);
    await migration.advanceToCompareClean(admin, { migrationId });
    await migration.advanceToIncumbentReadOnly(admin, { migrationId });
    const retired = await migration.retireIncumbent(admin, { migrationId });
    expect(retired.status).toBe('incumbent-retired');
    const resolved = await migration.resolveExternalId(member, {
      sourceSystemKey: side.systemKey,
      externalId: 'H-1',
    });
    expect(resolved.entry.aurumEntityId).toBe(
      commit.records.find((record) => record.externalId === 'H-1')!.aurumEntityId,
    );
  });
});
