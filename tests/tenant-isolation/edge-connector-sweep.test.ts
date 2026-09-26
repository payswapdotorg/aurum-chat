// W044 — Tenant Isolation Verification · the edge-connector sweep (W088).
//
// The edge-connector module (W088 — Aurum Edge Connector) owns
// tenant-scoped tables for its concepts: the enrolled edge runtimes with
// their derived health, the capability allowlists (opaque secret
// references + scopes), the append-only heartbeat health/version
// evidence, the signed tenant-scoped job envelopes and their execution
// outcomes, and the append-only lifecycle events.
//
// This sweep proves the tenant boundary at the APPLICATION level, per
// the W044 doctrine — two tenants side by side, zero leakage:
//   * an edge (and its allowlist, heartbeats, jobs and events) is
//     invisible to the other tenant: every read and every dispatch
//     through another tenant's edge id is uniformly not-found (no
//     existence leak);
//   * cross-tenant dial-home authentication is uniformly refused (the
//     auth's tenant scopes the edge lookup);
//   * a foreign-tenant envelope is refused at Aurum-side adjudication
//     (tenant scope) and at the edge boundary (the runtime's own
//     tenant check);
//   * each tenant's listings show exactly its own edges and jobs.
//
// The deep per-phase isolation cases live in the module's own suite
// (src/modules/edge-connector/tests/); this sweep is the two-tenant
// proof the W044 coverage manifest claims.

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../scripts/migrate';
import * as edge from '@/modules/edge-connector/contract';
import { EdgeConnectorError } from '@/modules/edge-connector/errors';

const tenantA = newId();
const tenantB = newId();

function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}

async function expectCode(
  code: EdgeConnectorError['code'],
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected EdgeConnectorError('${code}') but the call succeeded`);
  } catch (error) {
    if (!(error instanceof EdgeConnectorError)) throw error;
    expect(error.code).toBe(code);
  }
}

// Fake enrollment key material assembled from fragments at runtime.
const KEY_ID = 'key-2026-sweep';
const KEY_MATERIAL = ['edge-enroll-', 'sweep', '-w088'].join('');

const READ_CRM = {
  capabilityKey: 'read.customer-records',
  mode: 'read' as const,
  connectivity: 'private-api' as const,
  secretRef: 'edge-vault://crm-read',
  secretScopes: ['crm.read'],
};
const WRITE_CRM = {
  capabilityKey: 'write.customer-records',
  mode: 'write' as const,
  connectivity: 'private-api' as const,
  secretRef: 'edge-vault://crm-write',
  secretScopes: ['crm.write'],
};

beforeAll(async () => {
  await runMigrations(getDb());
  edge.wireEdgeSigner(edge.createHmacSigner({ secretKeys: { [KEY_ID]: KEY_MATERIAL } }));
});

afterAll(async () => {
  edge.wireEdgeSigner(null);
  await closeDb();
});

describe('W044 sweep — edge-connector (W088)', () => {
  let edgeA: string;
  let edgeB: string;

  it('the runtimes, allowlists, heartbeats, jobs and events stay per-tenant (zero leakage)', async () => {
    const adminA = memberOf(tenantA, ['edge-connector:administer']);
    const adminB = memberOf(tenantB, ['edge-connector:administer']);
    const memberA = memberOf(tenantA);
    const memberB = memberOf(tenantB);

    const detailA = await edge.registerEdgeRuntime(adminA, {
      name: 'Sweep edge A',
      signingKeyId: KEY_ID,
      connectivity: ['private-api'],
      allowlist: [READ_CRM, WRITE_CRM],
    });
    const detailB = await edge.registerEdgeRuntime(adminB, {
      name: 'Sweep edge B',
      signingKeyId: KEY_ID,
      connectivity: ['private-api'],
      allowlist: [READ_CRM, WRITE_CRM],
    });
    edgeA = detailA.runtime.id;
    edgeB = detailB.runtime.id;

    // Each tenant's runtime dials home through its own deterministic
    // double (the same contract calls a real edge makes).
    const simA = edge.createInMemoryEdgeRuntime({
      tenantId: tenantA,
      edgeId: edgeA,
      keyId: KEY_ID,
      secretKey: KEY_MATERIAL,
      localAllowlist: [READ_CRM, WRITE_CRM],
      localSecrets: {
        'edge-vault://crm-read': 'sweep-material-a-read',
        'edge-vault://crm-write': 'sweep-material-a-write',
      },
    });
    await simA.heartbeat({ version: '1.0.0' });

    // Tenant A dispatches a job; the edge executes it.
    const issuedA = await edge.issueEdgeJob(memberA, {
      edgeId: edgeA,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-sweep-a',
    });
    await simA.dialHomeOnce();
    expect((await edge.getEdgeJob(memberA, { jobId: issuedA.job.id })).state).toBe('succeeded');

    // Cross-tenant reads and dispatches are uniformly not-found — no
    // existence leak, before any state moves.
    await expectCode('edge_not_found', () => edge.getEdgeRuntime(memberB, { edgeId: edgeA }));
    await expectCode('edge_not_found', () =>
      edge.issueEdgeJob(memberB, {
        edgeId: edgeA,
        kind: 'inspect',
        capabilityKey: 'read.customer-records',
        target: 'cust-sweep-a',
      }),
    );
    await expectCode('job_not_found', () =>
      edge.getEdgeJob(memberB, { jobId: issuedA.job.id }),
    );
    await expectCode('edge_not_found', () =>
      edge.listEdgeHeartbeats(memberB, { edgeId: edgeA }),
    );
    await expectCode('edge_not_found', () => edge.listEdgeEvents(memberB, { edgeId: edgeA }));

    // A's edge state never moved: B's own runtime is still pending, and
    // each tenant's listings hold exactly its own records.
    expect((await edge.getEdgeRuntime(memberA, { edgeId: edgeA })).runtime.status).toBe(
      'connected',
    );
    expect((await edge.getEdgeRuntime(memberB, { edgeId: edgeB })).runtime.status).toBe('pending');
    expect((await edge.listEdgeRuntimes(memberA, {})).map((s) => s.runtime.id)).toEqual([edgeA]);
    expect((await edge.listEdgeRuntimes(memberB, {})).map((s) => s.runtime.id)).toEqual([edgeB]);
    expect(await edge.listEdgeJobs(memberA, {})).toHaveLength(1);
    expect(await edge.listEdgeJobs(memberB, {})).toHaveLength(0);
  });

  it('the dial-home channel and the envelope boundary are tenant-walled', async () => {
    const memberA = memberOf(tenantA);

    // Cross-tenant dial-home authentication is uniformly refused.
    const foreignAuth = {
      tenantId: tenantB,
      edgeId: edgeA,
      requestNonce: 'sweep-b-pull-1',
      proof: '0'.repeat(64),
    };
    await expectCode('edge_not_found', () =>
      edge.pullPendingEdgeJobs(foreignAuth, { limit: 1 }),
    );

    // A foreign-tenant envelope (correctly signed, re-addressed to B) is
    // refused at Aurum-side adjudication (tenant scope).
    const issued = await edge.issueEdgeJob(memberA, {
      edgeId: edgeA,
      kind: 'inspect',
      capabilityKey: 'read.customer-records',
      target: 'cust-sweep-a-2',
    });
    const foreignBody = { ...issued.envelope.envelope, tenantId: tenantB };
    const foreignSigned = {
      envelope: foreignBody,
      signature: edge
        .createHmacSigner({ secretKeys: { [KEY_ID]: KEY_MATERIAL } })
        .sign(KEY_ID, edge.canonicalJson(foreignBody)),
    };
    await expectCode('invalid_envelope', () =>
      edge.verifyEdgeJobEnvelope(memberA, foreignSigned),
    );

    // B's member cannot adjudicate A's genuine envelope either — the
    // envelope's tenant scope is checked against the CALLING context.
    await expectCode('invalid_envelope', () =>
      edge.verifyEdgeJobEnvelope(memberOf(tenantB), issued.envelope),
    );

    // The deterministic edge double keeps refusing foreign-tenant
    // envelopes at ITS boundary (its own tenant check — the runtime
    // trusts only its own configuration).
    const simB = edge.createInMemoryEdgeRuntime({
      tenantId: tenantB,
      edgeId: edgeB,
      keyId: KEY_ID,
      secretKey: KEY_MATERIAL,
      localAllowlist: [READ_CRM],
      localSecrets: { 'edge-vault://crm-read': 'sweep-material-b-read' },
    });
    const refusal = await simB.executeEnvelope(issued.envelope);
    expect(refusal.refusal?.stage).toBe('tenant');
  });
});
