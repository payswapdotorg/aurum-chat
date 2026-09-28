// W111 — the REAL reader adapters' deterministic suite: the CSV
// export-library incumbent reader (real files on the real file system),
// the world-entities native reader (the real W005 schema through the db
// port against the embedded PostgreSQL engine), the read-only file-share
// edge adapter, the env-driven wiring honesty contract, and the
// rejection-ledger composition (no silent data loss).
//
// The FULL real-environment migration path (staged import → verification
// → conflict → delta → native catch-up → comparison → retirement →
// sequestration rollback) lives in migration-readers-real.test.ts; this
// file pins the ADAPTER behaviors and edge cases.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
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
import * as worldContract from '@/modules/world/contract';
import * as edgeConnector from '@/modules/edge-connector/contract';
import { runMigrations } from '../../../../scripts/migrate';
import { MigrationError } from '../errors';
import * as migration from '../contract';
import {
  createCsvExportIncumbentReader,
} from '../adapters/csv-export-incumbent-reader';
import { createWorldEntitiesNativeReader } from '../adapters/world-native-reader';
import { createCsvFileShareAdapter } from '../adapters/file-share-verify';
import {
  ensureMigrationReadersWired,
  resetMigrationReadersWiring,
} from '../adapters/env-wiring';

const { registerSource, setSourceTransport } = sourcesContract;
const { grantDiscoverySource, listSystems, runDiscovery } = integrationContract;
const { completeConnection, createEmbeddedBroker, initiateConnection, wireConnectionBrokers } =
  brokerContract;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADER = 'external_id,match_key,entity_type,deleted_at,payload_json';

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectMigrationError(
  code: MigrationError['code'],
  fn: () => Promise<unknown>,
): Promise<MigrationError> {
  try {
    await fn();
    throw new Error(`expected MigrationError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof MigrationError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

/** Creates a real temp export root; the test writes version dirs into it. */
async function tempExportRoot(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'aurum-w111-'));
}

async function writeExportVersion(
  root: string,
  version: number,
  content: string | Buffer,
): Promise<void> {
  const dir = path.join(root, `csv-export-${version}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'records.csv'), content);
}

/** The directory surfaces three incumbent systems (the W081 chain). */
class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  async fetch(): Promise<sourcesContract.SourceFetchResult> {
    return {
      records: [
        directoryRecord('w111-crm', 'W111 Legacy CRM'),
        directoryRecord('w111-erp', 'W111 Legacy ERP'),
        directoryRecord('w111-billing', 'W111 Legacy Billing'),
      ],
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
          authorization_url: `https://broker.w111.example/oauth/${state}`,
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

/** Discovers + connects one incumbent system for a tenant (the W094 pattern). */
async function connectIncumbentSystem(
  tenantId: string,
  options: { externalId: string; displayName: string },
): Promise<{ systemId: string; systemKey: string; connectionId: string }> {
  const admin = memberOf(tenantId, ['integration-intelligence:administer']);
  const member = memberOf(tenantId);
  const { source } = await registerSource(admin, {
    provider: 'notion',
    providerAccountId: `w111-${options.externalId}-${tenantId.slice(0, 8)}`,
    displayName: `W111 directory ${options.externalId}`,
    authKind: 'oauth',
    credentialRef: ['secret-store://', 'w111/', `${options.externalId}/ref`].join(''),
    oauthScopes: ['directory.read'],
    oauthExpiresAt: '2027-01-01T00:00:00Z',
  });
  await grantDiscoverySource(admin, { sourceId: source.id });
  await runDiscovery(member, { sourceId: source.id });
  const systems = await listSystems(member, {});
  const system = systems.find((entry) => entry.displayName === options.displayName);
  if (system === undefined) {
    throw new Error(`the scripted directory did not surface '${options.displayName}'`);
  }
  const initiated = await initiateConnection(member, {
    provider: 'notion',
    connectionKey: `w111-${options.externalId}-${tenantId.slice(0, 8)}`,
    displayName: options.displayName,
    inventorySystemId: system.id,
  });
  const completed = await completeConnection(member, {
    connectionId: initiated.connection.id,
    state: initiated.authorization.state,
  });
  return {
    systemId: system.id,
    systemKey: system.systemKey,
    connectionId: completed.connection.id,
  };
}

let roots: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await tempExportRoot();
  roots.push(root);
  return root;
}

beforeAll(async () => {
  await runMigrations(getDb());
  setSourceTransport(new ScriptedDirectoryTransport());
  wireConnectionBrokers([
    createEmbeddedBroker({
      baseUrl: 'https://broker.w111.example',
      apiToken: ['embedded_tok_', 'w111', '_fragment'].join(''),
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
  edgeConnector.wireEdgeSigner(null);
  await Promise.allSettled(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots = [];
  await closeDb();
});

// ---------------------------------------------------------------------------
// The CSV export-library incumbent reader (real files, real parsing)
// ---------------------------------------------------------------------------

describe('the csv export-library incumbent reader (W111)', () => {
  it('reads a real full export: canonical rows, versioned snapshot refs, request pass-through', async () => {
    const root = await freshRoot();
    // Real-world edges baked in: a multi-value field (JSON array), quoted
    // fields embedding commas, doubled quotes and a LINE BREAK, and a
    // header in non-canonical column order.
    await writeExportVersion(
      root,
      1,
      [
        'payload_json,external_id,match_key,entity_type,deleted_at',
        '"{""stage"":""active"",""seats"":10,""emails"":[""a@x.com"",""b@x.com""]}",C-100,k-100,customer,',
        '"{""stage"":""onboarding"",""note"":""multi-line, with commas""}",C-200,k-200,customer,',
        '{"stage":"active"},C-300,,customer,',
      ].join('\r\n'),
    );
    const reader = createCsvExportIncumbentReader({ exportRoot: root });
    const result = await reader.readSnapshot({
      connectionId: 'conn-1',
      credentialRef: 'opaque-ref-1',
      systemKey: 'w111-crm-system',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: null,
      idempotencyKey: 'migration:round-1',
    });

    expect(result.snapshotRef).toBe('csv-export-1');
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toEqual({
      externalId: 'C-100',
      matchKey: 'k-100',
      entityType: 'customer',
      payload: { stage: 'active', seats: 10, emails: ['a@x.com', 'b@x.com'] },
      deletedAt: null,
    });
    // The quoted multi-line row parsed as ONE record with the embedded
    // comma and escaped quotes intact.
    expect(result.records[1]).toEqual({
      externalId: 'C-200',
      matchKey: 'k-200',
      entityType: 'customer',
      payload: { stage: 'onboarding', note: 'multi-line, with commas' },
      deletedAt: null,
    });
    // An empty match_key cell is null (the record mints a fresh entity).
    expect(result.records[2]!.matchKey).toBeNull();
    // The opaque credentialRef passed straight through, uninterpreted.
    expect(reader.requests[0]!.credentialRef).toBe('opaque-ref-1');
    expect(reader.requests[0]!.systemKey).toBe('w111-crm-system');
    expect(reader.requests[0]!.sinceSnapshotRef).toBeNull();
    expect(reader.drainRejections()).toEqual([]);
  });

  it('rejects every malformed row explicitly with a recorded reason — counts reconcile (no silent loss)', async () => {
    const root = await freshRoot();
    const oversizedPayload = JSON.stringify({ blob: 'x'.repeat(300_000) });
    // Rows in order (data-row line numbers 1..12):
    //  1  good
    //  2  wrong field count (5 header cols, 4 cells)
    //  3  payload_json not JSON
    //  4  payload not a plain object (a JSON array)
    //  5  empty external_id
    //  6  bad deleted_at (not strict ISO)
    //  7  tombstone WITH a payload
    //  8  live row without payload (empty payload_json)
    //  9  duplicate external id of row 1
    // 10  oversized payload (> 256 KiB)
    // 11  (written as raw bytes) invalid UTF-8
    // 12  good tombstone (deleted_at set, no payload)
    const lines = [
      HEADER,
      'D-1,k-1,customer,,{"stage":"active"}',
      'D-2,k-2,customer,"oops"',
      'D-3,k-3,customer,,"oops"',
      'D-4,k-4,customer,,"[1,2,3]"',
      ',k-5,customer,,{"stage":"active"}',
      'D-6,k-6,customer,2026-13-45 99:00:00,{"stage":"active"}',
      'D-7,k-7,customer,2026-09-27T09:00:00Z,{"stage":"tombstoned"}',
      'D-8,k-8,customer,,',
      'D-1,k-1,customer,,{"stage":"active"}',
      `D-10,k-10,customer,,${oversizedPayload}`,
      // Row 11 is spliced in as raw bytes below.
      'D-12,,customer,2026-09-27T09:30:00Z,',
    ];
    const goodPart = Buffer.from(lines.join('\n') + '\n', 'utf8');
    // A row whose bytes are not valid UTF-8 (0xC3 0x28 is an invalid
    // continuation) — it must be rejected as a ROW, not poison the file.
    const badBytes = Buffer.from('D-\uFFFD-bad,k-bad,customer,,{"stage":"active"}', 'utf8');
    badBytes[2] = 0xc3;
    badBytes[3] = 0x28;
    const content = Buffer.concat([goodPart, badBytes, Buffer.from('\n', 'utf8')]);
    await writeExportVersion(root, 1, content);

    const reader = createCsvExportIncumbentReader({ exportRoot: root });
    const result = await reader.readSnapshot({
      connectionId: 'conn-1',
      credentialRef: 'ref',
      systemKey: 'sys',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: null,
      idempotencyKey: 'migration:r1',
    });

    // The two good rows crossed; everything else is an explicit rejection.
    expect(result.records.map((record) => record.externalId)).toEqual(['D-1', 'D-12']);
    expect(result.records[1]!.deletedAt).toBe('2026-09-27T09:30:00Z');
    expect(result.records[1]!.payload).toBeNull();

    const rejections = reader.drainRejections();
    const byLine = new Map(rejections.map((rejection) => [rejection.lineNumber, rejection]));
    expect(rejections).toHaveLength(10);
    expect(byLine.get(2)!.reasonCode).toBe('wrong-field-count');
    expect(byLine.get(3)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(3)!.reason).toContain('not valid JSON');
    expect(byLine.get(4)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(4)!.reason).toContain('plain JSON object');
    expect(byLine.get(5)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(5)!.reason).toContain('externalId');
    expect(byLine.get(6)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(6)!.reason).toContain('deletedAt');
    expect(byLine.get(7)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(7)!.reason).toContain('tombstone with a payload');
    expect(byLine.get(8)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(8)!.reason).toContain('without a payload');
    expect(byLine.get(9)!.reasonCode).toBe('duplicate-external-id');
    expect(byLine.get(9)!.externalId).toBe('D-1');
    expect(byLine.get(10)!.reasonCode).toBe('invalid-record');
    expect(byLine.get(10)!.reason).toContain('exceeds the maximum');
    // The oversized row's raw evidence is bounded and marked truncated.
    expect(byLine.get(10)!.rawRow!.length).toBeLessThanOrEqual(4_000);
    expect(byLine.get(10)!.rawRow!.endsWith('…[truncated]')).toBe(true);
    expect(byLine.get(12)!.reasonCode).toBe('invalid-encoding');
    expect(byLine.get(12)!.reason).toContain('not valid UTF-8');
    // Every rejection carries its raw source evidence.
    for (const rejection of rejections) {
      expect(rejection.readerKind).toBe('csv-export');
      expect(rejection.snapshotRef).toBe('csv-export-1');
      expect(rejection.rawRow).not.toBeNull();
      expect(rejection.reason.length).toBeGreaterThan(0);
    }

    // NO SILENT LOSS: every data row is either a returned record or an
    // explicit rejection — 12 rows in, 2 + 10 out.
    const dataRows = 12;
    expect(result.records.length + rejections.length).toBe(dataRows);
    expect(reader.drainRejections()).toEqual([]);
  });

  it('delta reads diff base → latest by canonical row equality; vanished rows surface explicitly', async () => {
    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [
        HEADER,
        'E-1,k-1,customer,,{"stage":"active"}',
        'E-2,k-2,customer,,{"stage":"onboarding"}',
        'E-3,k-3,customer,,{"stage":"active"}',
      ].join('\n'),
    );
    await writeExportVersion(
      root,
      2,
      [
        HEADER,
        // E-1 CHANGED.
        'E-1,k-1,customer,,{"stage":"churned"}',
        // E-2 UNCHANGED (must not surface in the delta).
        'E-2,k-2,customer,,{"stage":"onboarding"}',
        // E-3 became a TOMBSTONE (the incumbent's soft-delete export).
        'E-3,k-3,customer,2026-09-27T10:00:00Z,',
        // E-4 is NEW.
        'E-4,k-4,customer,,{"stage":"active"}',
      ].join('\n'),
    );
    await writeExportVersion(
      root,
      3,
      [
        HEADER,
        'E-1,k-1,customer,,{"stage":"churned"}',
        'E-2,k-2,customer,,{"stage":"onboarding"}',
        'E-3,k-3,customer,2026-09-27T10:00:00Z,',
        'E-4,k-4,customer,,{"stage":"active"}',
        // E-5 exists ONLY in version 3 (a mid-chain addition).
        'E-5,k-5,customer,,{"stage":"active"}',
      ].join('\n'),
    );

    const reader = createCsvExportIncumbentReader({ exportRoot: root });
    // A stale delta (since csv-export-1 while latest is 3): E-1's change
    // and E-3's tombstone still surface (the base is version 1).
    const sinceV1 = await reader.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: 'csv-export-1',
      idempotencyKey: 'migration:d1',
    });
    expect(sinceV1.snapshotRef).toBe('csv-export-3');
    const sinceV1Ids = sinceV1.records.map((record) => record.externalId).sort();
    expect(sinceV1Ids).toEqual(['E-1', 'E-3', 'E-4', 'E-5']);
    expect(reader.drainRejections()).toEqual([]);

    // A fresh delta (since csv-export-2 while latest is 3): only E-5.
    const sinceV2 = await reader.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: 'csv-export-2',
      idempotencyKey: 'migration:d2',
    });
    expect(sinceV2.records.map((record) => record.externalId)).toEqual(['E-5']);
    expect(reader.drainRejections()).toEqual([]);
    // The request carried the module-provided base reference.
    expect(reader.requests[1]!.sinceSnapshotRef).toBe('csv-export-2');

    // A row that VANISHED without a tombstone (present in base, absent
    // from latest) is an explicit rejection — never a silent delete.
    await writeExportVersion(
      root,
      4,
      [
        HEADER,
        'E-1,k-1,customer,,{"stage":"churned"}',
        // E-2 REMOVED with no tombstone row.
        'E-3,k-3,customer,2026-09-27T10:00:00Z,',
        'E-4,k-4,customer,,{"stage":"active"}',
        'E-5,k-5,customer,,{"stage":"active"}',
      ].join('\n'),
    );
    const sinceV3 = await reader.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: 'csv-export-3',
      idempotencyKey: 'migration:d3',
    });
    expect(sinceV3.snapshotRef).toBe('csv-export-4');
    expect(sinceV3.records).toHaveLength(0);
    const rejections = reader.drainRejections();
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.reasonCode).toBe('disappeared-without-tombstone');
    expect(rejections[0]!.externalId).toBe('E-2');
    expect(rejections[0]!.lineNumber).toBe(2);
    expect(rejections[0]!.snapshotRef).toBe('csv-export-4');
  });

  it('fails honestly on unknown bases, broken headers, missing shares and the per-round cap', async () => {
    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [HEADER, 'F-1,k-1,customer,,{"stage":"active"}'].join('\n'),
    );
    const reader = createCsvExportIncumbentReader({ exportRoot: root });
    const request = (sinceSnapshotRef: string | null) => reader.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef,
      idempotencyKey: 'migration:x',
    });

    // An unknown base version / a garbage reference.
    await expectMigrationError('invalid_reader_result', () => request('csv-export-99'));
    await expectMigrationError('invalid_reader_result', () => request('fixsnap-1'));
    // A failed read leaves no stale rejections behind.
    expect(reader.drainRejections()).toEqual([]);

    // Header violations fail the WHOLE read loudly (nothing row-wise can
    // be trusted when the header lies): unknown column, duplicate column,
    // missing required column.
    const brokenRoot = await freshRoot();
    await writeExportVersion(brokenRoot, 1, 'external_id,payload_json,notes\nF-1,{}\n');
    const brokenReader = createCsvExportIncumbentReader({ exportRoot: brokenRoot });
    await expectMigrationError(
      'invalid_reader_result',
      () =>
        brokenReader.readSnapshot({
          connectionId: 'c',
          credentialRef: 'r',
          systemKey: 's',
          readCapabilityKey: 'read.customer-records',
          sinceSnapshotRef: null,
          idempotencyKey: 'migration:x',
        }),
    );
    await writeExportVersion(brokenRoot, 2, 'external_id,external_id,payload_json\nF-1,F-1,{}\n');
    await expectMigrationError(
      'invalid_reader_result',
      () =>
        brokenReader.readSnapshot({
          connectionId: 'c',
          credentialRef: 'r',
          systemKey: 's',
          readCapabilityKey: 'read.customer-records',
          sinceSnapshotRef: null,
          idempotencyKey: 'migration:x',
        }),
    );
    await writeExportVersion(brokenRoot, 3, 'match_key,payload_json\nk-1,{}\n');
    await expectMigrationError(
      'invalid_reader_result',
      () =>
        brokenReader.readSnapshot({
          connectionId: 'c',
          credentialRef: 'r',
          systemKey: 's',
          readCapabilityKey: 'read.customer-records',
          sinceSnapshotRef: null,
          idempotencyKey: 'migration:x',
        }),
    );

    // An empty share (no export versions) is an honest loud failure.
    const emptyRoot = await freshRoot();
    const emptyReader = createCsvExportIncumbentReader({ exportRoot: emptyRoot });
    await expectMigrationError(
      'invalid_reader_result',
      () =>
        emptyReader.readSnapshot({
          connectionId: 'c',
          credentialRef: 'r',
          systemKey: 's',
          readCapabilityKey: 'read.customer-records',
          sinceSnapshotRef: null,
          idempotencyKey: 'migration:x',
        }),
    );

    // The per-round cap fails honestly (the operator batches windows).
    const capRoot = await freshRoot();
    const rows = [HEADER];
    for (let index = 1; index <= 5_001; index += 1) {
      rows.push(`G-${index},k-${index},customer,,{"n":${index}}`);
    }
    await writeExportVersion(capRoot, 1, rows.join('\n'));
    const capReader = createCsvExportIncumbentReader({ exportRoot: capRoot });
    await expectMigrationError(
      'snapshot_too_large',
      () =>
        capReader.readSnapshot({
          connectionId: 'c',
          credentialRef: 'r',
          systemKey: 's',
          readCapabilityKey: 'read.customer-records',
          sinceSnapshotRef: null,
          idempotencyKey: 'migration:x',
        }),
    );
  });

  it('parses BOM, LF-only, CRLF and missing-final-newline files identically', async () => {
    const payload = '{"stage":"active"}';
    // Each file shape lives in its OWN root so each is the latest (and
    // only) version when read.
    const shapes: Array<{ label: string; content: string }> = [
      { label: 'BOM + CRLF', content: `\uFEFF${HEADER}\r\nH-1,k-1,customer,,${payload}\r\n` },
      { label: 'LF only', content: `${HEADER}\nH-1,k-1,customer,,${payload}\n` },
      { label: 'no trailing separator', content: `${HEADER}\r\nH-1,k-1,customer,,${payload}` },
    ];
    for (const shape of shapes) {
      const root = await freshRoot();
      await writeExportVersion(root, 1, shape.content);
      const reader = createCsvExportIncumbentReader({ exportRoot: root });
      const result = await reader.readSnapshot({
        connectionId: 'c',
        credentialRef: 'r',
        systemKey: 's',
        readCapabilityKey: 'read.customer-records',
        sinceSnapshotRef: null,
        idempotencyKey: 'migration:shape',
      });
      expect(result.snapshotRef, shape.label).toBe('csv-export-1');
      expect(result.records, shape.label).toHaveLength(1);
      expect(result.records[0]!.payload, shape.label).toEqual({ stage: 'active' });
      expect(reader.drainRejections(), shape.label).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The world-entities native reader (the real W005 schema through the db port)
// ---------------------------------------------------------------------------

describe('the world-entities native reader (W111)', () => {
  it('reads the tenant\u2019s real world_entities, keyed by world_entities.id, state = attributes', async () => {
    const tenantA = newId();
    const tenantB = newId();
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    // REAL entities through the world module's own contract.
    const alpha = await worldContract.createEntity(memberA, {
      kind: 'company',
      name: 'Alpha Ltd',
      attributes: { stage: 'active', seats: 10, emails: ['a@x.com'] },
    });
    const beta = await worldContract.createEntity(memberA, {
      kind: 'team',
      name: 'Beta Team',
      attributes: {},
    });
    await worldContract.createEntity(memberB, {
      kind: 'company',
      name: 'Other Tenant Co',
      attributes: { stage: 'foreign' },
    });

    const reader = createWorldEntitiesNativeReader(tenantA);
    const complete = await reader.readNativeStates({ entityIds: null });
    // ONLY tenant A's entities — tenant B's are indistinguishable from absent.
    expect(complete.states).toHaveLength(2);
    const byId = new Map(complete.states.map((entry) => [entry.aurumEntityId, entry.state]));
    expect(byId.get(alpha.id)).toEqual({ stage: 'active', seats: 10, emails: ['a@x.com'] });
    expect(byId.get(beta.id)).toEqual({});
    expect([...byId.keys()].includes(alpha.id)).toBe(true);

    // The targeted read: existing ids answer; foreign/nonexistent ids are
    // simply absent (never faked).
    const targeted = await reader.readNativeStates({
      entityIds: [alpha.id, newId(), 'not-a-uuid'],
    });
    expect(targeted.states).toHaveLength(1);
    expect(targeted.states[0]!.aurumEntityId).toBe(alpha.id);

    // An entity-less tenant answers an EMPTY state set.
    const empty = createWorldEntitiesNativeReader(newId());
    expect((await empty.readNativeStates({ entityIds: null })).states).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The file-share edge adapter (the W088 verification leg's customer side)
// ---------------------------------------------------------------------------

describe('the csv file-share edge adapter (W111)', () => {
  it('re-reads the real export by external id; execute is refused by policy', async () => {
    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [
        HEADER,
        'J-1,k-1,customer,,{"stage":"active"}',
        'J-2,k-2,customer,2026-09-27T10:00:00Z,',
      ].join('\n'),
    );
    const adapter = createCsvFileShareAdapter({ exportRoot: root });
    expect(adapter.connectivity).toBe('file-share');

    const live = await adapter.inspect({
      connectivity: 'file-share',
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'J-1',
      payload: null,
      secretRef: null,
      secretScopes: [],
    });
    expect(live.receipt.status).toBe('accepted');
    expect(live.state).toEqual({ found: true, state: { stage: 'active' } });

    const tombstone = await adapter.inspect({
      connectivity: 'file-share',
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'J-2',
      payload: null,
      secretRef: null,
      secretScopes: [],
    });
    expect(tombstone.state).toEqual({ found: true, state: null });

    const absent = await adapter.inspect({
      connectivity: 'file-share',
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'J-404',
      payload: null,
      secretRef: null,
      secretScopes: [],
    });
    expect(absent.state).toEqual({ found: false, state: null });

    // The adapter re-reads from the REAL file system: a new version
    // dropped onto the share changes the answer (no caching).
    await writeExportVersion(
      root,
      2,
      [HEADER, 'J-1,k-1,customer,,{"stage":"churned"}', 'J-2,k-2,customer,2026-09-27T10:00:00Z,'].join(
        '\n',
      ),
    );
    const reread = await adapter.inspect({
      connectivity: 'file-share',
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'J-1',
      payload: null,
      secretRef: null,
      secretScopes: [],
    });
    expect(reread.state).toEqual({ found: true, state: { stage: 'churned' } });

    // EXECUTE is refused by policy — read-only forever.
    const refused = await adapter.execute({
      connectivity: 'file-share',
      kind: 'execute',
      capabilityKey: 'write.customer-records',
      target: 'J-1',
      payload: { stage: 'tampered' },
      secretRef: null,
      secretScopes: [],
    });
    expect(refused.receipt.status).toBe('rejected');
    expect(refused.receipt.detail).toContain('read-only by policy');
    expect(adapter.requests.map((request) => request.kind)).toEqual([
      'inspect',
      'inspect',
      'inspect',
      'inspect',
      'execute',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The rejection-ledger composition (captureSnapshot persists rejections)
// ---------------------------------------------------------------------------

describe('the rejection ledger composition (W111 — no silent data loss)', () => {
  it('captureSnapshot persists drained rejections into the tenant-scoped ledger, linked to the round', async () => {
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
        'K-1,k-1,customer,,{"stage":"active"}',
        'K-2,k-2,customer,,"not json"', // rejected row 2
        'K-3,k-3,customer,,{"stage":"onboarding"}',
      ].join('\n'),
    );
    const reader = createCsvExportIncumbentReader({ exportRoot: root });
    migration.setMigrationIncumbentReader(reader);

    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w111-crm',
      displayName: 'W111 Legacy CRM',
    });
    const created = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });

    const captured = await migration.captureSnapshot(member, {
      migrationId: created.migration.id,
    });
    // The returned rejections mirror the drained rows.
    expect(captured.records.map((record) => record.externalId)).toEqual(['K-1', 'K-3']);
    expect(captured.rejections).toHaveLength(1);
    expect(captured.rejections[0]!.reasonCode).toBe('invalid-record');
    expect(captured.rejections[0]!.lineNumber).toBe(2);
    expect(captured.rejections[0]!.roundId).toBe(captured.round.id);
    expect(captured.rejections[0]!.migrationId).toBe(created.migration.id);
    expect(captured.rejections[0]!.rawRow).toContain('not json');

    // The ledger read (per round and per migration) reconciles.
    const perRound = await migration.listReaderRejections(member, {
      migrationId: created.migration.id,
      roundId: captured.round.id,
    });
    expect(perRound).toEqual(captured.rejections);
    const perMigration = await migration.listReaderRejections(member, {
      migrationId: created.migration.id,
    });
    expect(perMigration).toHaveLength(1);

    // NO SILENT LOSS: 3 export rows = 2 staged + 1 rejected (+ 0 conflicted).
    expect(captured.records.length + perRound.length).toBe(3);
    expect(captured.round.rawRecordCount).toBe(2);

    // The audit feed surfaced the rejection count.
    const events = await migration.listMigrationEvents(member, { migrationId: created.migration.id });
    expect(
      events.some(
        (event) =>
          event.event === 'snapshot-captured' && event.detail!.includes('1 row(s) explicitly rejected'),
      ),
    ).toBe(true);

    // The staged lifecycle proceeds for the clean records.
    await migration.transformImportRound(member, { roundId: captured.round.id });
    await migration.reviewImportRound(reviewer, { roundId: captured.round.id });
    const commit = await migration.commitImportRound(admin, { roundId: captured.round.id });
    expect(commit.round.status).toBe('committed');
    expect(commit.records.every((record) => record.state === 'committed')).toBe(true);

    // Tenant isolation: another tenant sees nothing (no existence leak).
    const outsider = memberOf(newId());
    await expectMigrationError('migration_not_found', () =>
      migration.listReaderRejections(outsider, { migrationId: created.migration.id }),
    );
    const outsiderOwn = await connectIncumbentSystem(newId(), {
      externalId: 'w111-erp',
      displayName: 'W111 Legacy ERP',
    });
    expect(outsiderOwn.systemId).toBeTruthy();
  });

  it('a reader without the rejection capability (the fixture double) records no rejections', async () => {
    const tenant = newId();
    const admin = memberOf(tenant, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const member = memberOf(tenant);
    migration.setMigrationIncumbentReader(
      new migration.FixtureIncumbent([
        { externalId: 'L-1', matchKey: 'k-1', entityType: null, payload: { stage: 'active' } },
      ]),
    );
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w111-billing',
      displayName: 'W111 Legacy Billing',
    });
    const created = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    const captured = await migration.captureSnapshot(member, { migrationId: created.migration.id });
    expect(captured.records).toHaveLength(1);
    expect(captured.rejections).toEqual([]);
    const ledger = await migration.listReaderRejections(member, { migrationId: created.migration.id });
    expect(ledger).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The env-driven wiring (the W108 cellular.ts Family A precedent)
// ---------------------------------------------------------------------------

describe('the env-driven reader wiring (W111)', () => {
  afterEach(() => {
    resetMigrationReadersWiring();
    delete process.env.MIGRATION_CSV_EXPORT_ROOT;
    delete process.env.MIGRATION_NATIVE_TENANT_ID;
  });

  it('unset environment leaves both ports unwired — reads fail honestly', async () => {
    resetMigrationReadersWiring();
    const report = ensureMigrationReadersWired();
    expect(report.readers.map((entry) => entry.state)).toEqual(['unwired', 'unwired']);
    expect(migration.getMigrationIncumbentReader()).toBeNull();
    expect(migration.getMigrationNativeReader()).toBeNull();
    // The honest failures the module defines for unwired ports.
    const tenant = newId();
    const admin = memberOf(tenant, [migration.MIGRATION_AUTHORITY_ADMINISTER]);
    const side = await connectIncumbentSystem(tenant, {
      externalId: 'w111-crm',
      displayName: 'W111 Legacy CRM',
    });
    const created = await migration.createMigration(admin, {
      incumbentSystemId: side.systemId,
      incumbentConnectionId: side.connectionId,
      incumbentReadCapabilityKey: 'read.customer-records',
    });
    await expectMigrationError('reader_unavailable', () =>
      migration.captureSnapshot(memberOf(tenant), { migrationId: created.migration.id }),
    );
    await expectMigrationError('native_reader_unavailable', () =>
      migration.runComparisonRound(memberOf(tenant), { migrationId: created.migration.id }),
    );
  });

  it('full environment wires the real readers; an invalid tenant id stays honestly unwired', async () => {
    const root = await freshRoot();
    await writeExportVersion(
      root,
      1,
      [HEADER, 'M-1,k-1,customer,,{"stage":"active"}'].join('\n'),
    );
    const tenant = newId();
    const member = memberOf(tenant);
    // Seed one real world entity for the native leg.
    const entity = await worldContract.createEntity(member, {
      kind: 'company',
      name: 'Env Wired Co',
      attributes: { stage: 'active' },
    });

    process.env.MIGRATION_CSV_EXPORT_ROOT = root;
    process.env.MIGRATION_NATIVE_TENANT_ID = 'not-a-uuid';
    resetMigrationReadersWiring();
    const partial = ensureMigrationReadersWired();
    expect(partial.readers.map((entry) => entry.state)).toEqual(['wired', 'incomplete']);
    expect(migration.getMigrationNativeReader()).toBeNull();

    process.env.MIGRATION_NATIVE_TENANT_ID = tenant;
    resetMigrationReadersWiring();
    const wired = ensureMigrationReadersWired();
    expect(wired.readers.map((entry) => entry.state)).toEqual(['wired', 'wired']);
    expect(migration.getMigrationIncumbentReader()).not.toBeNull();
    expect(migration.getMigrationNativeReader()).not.toBeNull();

    // The wired native reader really reads this tenant's world entities.
    const native = await migration.getMigrationNativeReader()!.readNativeStates({ entityIds: null });
    expect(native.states.map((state) => state.aurumEntityId)).toEqual([entity.id]);

    // The wired incumbent reader really reads the export share.
    const incumbent = await migration.getMigrationIncumbentReader()!.readSnapshot({
      connectionId: 'c',
      credentialRef: 'r',
      systemKey: 's',
      readCapabilityKey: 'read.customer-records',
      sinceSnapshotRef: null,
      idempotencyKey: 'migration:env',
    });
    expect(incumbent.snapshotRef).toBe('csv-export-1');
    expect(incumbent.records).toHaveLength(1);

    // Idempotence: a second call returns the SAME report, no re-wiring.
    expect(ensureMigrationReadersWired()).toEqual(wired);
  });
});
