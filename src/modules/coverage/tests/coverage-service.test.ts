// Integration tests for the coverage module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port. Covers the W125
// acceptance — tenant-scoped CoverageSurface/CoverageSource/CoverageClaim/
// CoverageGap/CoverageSnapshot semantics; separate dimensions; the seven
// §5 states; evidence/connection-based derivation; no credentials in
// coverage state; coverage never becomes a second source of truth:
//
//  * THE REGISTRY — surfaces/sources: system-minted identity and tenancy;
//    duplicate registration refused; claims only address registered
//    surfaces/sources (§2: the registry is the authority on what is
//    tracked); credential-shaped input rejected end to end (§13).
//  * THE MEASUREMENT MODEL — evaluateSnapshot derives every surface
//    rollup, all nine §4 dimensions (separately), the §5 policy
//    restrictions and the §3 gaps EXCLUSIVELY from recorded claims; the
//    latest claim per (surface, source) is the current statement
//    (re-evaluation appends, never rewrites).
//  * THE SNAPSHOT — immutable-at-evaluation-time: UPDATE/DELETE/TRUNCATE
//    rejected by triggers on claims, snapshots and gaps; a later
//    snapshot never rewrites an earlier one; getSnapshot/listSnapshots/
//    listGaps read the derived history.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as coverageContract from '../contract';
import { CoverageError } from '../errors';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

const {
  evaluateSnapshot,
  getSnapshot,
  listClaims,
  listGaps,
  listSnapshots,
  listSources,
  listSurfaces,
  recordClaim,
  registerSource,
  registerSurface,
} = coverageContract;

// Dedicated tenants per concern so every assertion below sees only what
// it created itself.
const tenantRegistry = newId();
const tenantMeasure = newId();
const tenantImmutable = newId();
const tenantIsoA = newId();
const tenantIsoB = newId();
const tenantVisibleB = newId();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

async function expectCode(code: string, fn: () => unknown): Promise<void> {
  try {
    await fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CoverageError);
    expect((error as CoverageError).code).toBe(code);
  }
}

const UUID_A = '0b2f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e8f';
const UUID_B = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e90';
// Clock-relative instants so freshness measurements are deterministic
// regardless of when the suite runs: 30 minutes ago is within an 86400s
// policy; two hours ago is outside a 3600s policy.
const HALF_HOUR_AGO = new Date(Date.now() - 30 * 60_000).toISOString();
const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600_000).toISOString();
const FRESH_INSTANT = HALF_HOUR_AGO;
const OLD_INSTANT = TWO_HOURS_AGO;

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

describe('the coverage registry (W125 §3)', () => {
  it('registers surfaces with system-minted identity, tenancy and time', async () => {
    const ctx = member(tenantRegistry);
    const surface = await registerSurface(ctx, {
      key: 'support-tickets',
      label: 'Support tickets',
      description: 'Work/support records from authorized systems',
    });
    expect(surface.id).toMatch(/[0-9a-f-]{36}/);
    expect(surface.tenantId).toBe(ctx.tenantId);
    expect(surface.key).toBe('support-tickets');
    expect(surface.label).toBe('Support tickets');
    expect(surface.description).toBe('Work/support records from authorized systems');
    expect(Number.isNaN(new Date(surface.createdAt).getTime())).toBe(false);
  });

  it('refuses duplicate surface registration', async () => {
    const ctx = member(tenantRegistry);
    await registerSurface(ctx, { key: 'meetings', label: 'Meetings' });
    await expectCode('surface_already_registered', () =>
      registerSurface(ctx, { key: 'meetings', label: 'Meetings again' }),
    );
  });

  it('registers sources as opaque registry references and refuses duplicates', async () => {
    const ctx = member(tenantRegistry);
    const source = await registerSource(ctx, {
      registry: 'source',
      ref: UUID_A,
      label: 'Zendesk',
    });
    expect(source.registry).toBe('source');
    expect(source.ref).toBe(UUID_A);
    expect(source.label).toBe('Zendesk');
    await expectCode('source_already_registered', () =>
      registerSource(ctx, { registry: 'source', ref: UUID_A }),
    );
    // The same ref under a different registry is a different source.
    const channel = await registerSource(ctx, { registry: 'channel', ref: UUID_A });
    expect(channel.registry).toBe('channel');
  });

  it('lists surfaces and sources tenant-scoped', async () => {
    const ctxA = member(tenantRegistry);
    const ctxB = member(tenantVisibleB);
    await registerSurface(ctxB, { key: 'private-b', label: 'B only' });
    const surfacesA = await listSurfaces(ctxA);
    expect(surfacesA.map((s) => s.key)).toContain('support-tickets');
    expect(surfacesA.map((s) => s.key)).not.toContain('private-b');
    const sourcesA = await listSources(ctxA, { registry: 'source' });
    expect(sourcesA.map((s) => s.ref)).toContain(UUID_A);
    const channelsA = await listSources(ctxA, { registry: 'channel' });
    expect(channelsA).toHaveLength(1);
  });

  it('rejects credential-shaped input end to end (§13: no credentials in coverage state)', async () => {
    const ctx = member(tenantRegistry);
    await expectCode('invalid_source_input', () =>
      registerSource(ctx, {
        registry: 'source',
        ref: 'ghp_abcdefghijklmnopqrstuvwxyzabcdef123456789012',
      } as never),
    );
    await expectCode('invalid_claim_input', () =>
      recordClaim(ctx, {
        surfaceKey: 'support-tickets',
        source: { registry: 'source', ref: UUID_A },
        observationBasis: { kind: 'observation-set', ids: [] },
        state: 'COVERED',
        confidenceValue: 0.9,
        reason: 'claim',
        accessToken: 'x',
      } as never),
    );
  });

  it('records claims only for REGISTERED surfaces and sources', async () => {
    const ctx = member(tenantRegistry);
    await expectCode('surface_not_found', () =>
      recordClaim(ctx, {
        surfaceKey: 'not-registered',
        source: { registry: 'source', ref: UUID_A },
        observationBasis: { kind: 'observation-set', ids: [UUID_B] },
        state: 'COVERED',
        confidenceValue: 0.9,
        reason: 'unregistered surface',
      }),
    );
    await expectCode('source_not_found', () =>
      recordClaim(ctx, {
        surfaceKey: 'support-tickets',
        source: { registry: 'source', ref: '2d4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e99' },
        observationBasis: { kind: 'observation-set', ids: [UUID_B] },
        state: 'COVERED',
        confidenceValue: 0.9,
        reason: 'unregistered source',
      }),
    );
  });

  it('records a full claim with the recording principal and system time', async () => {
    const ctx = member(tenantRegistry);
    const claim = await recordClaim(ctx, {
      surfaceKey: 'support-tickets',
      source: { registry: 'source', ref: UUID_A },
      observationBasis: {
        kind: 'observation-set',
        ids: [UUID_B],
        lastObservedAt: FRESH_INSTANT,
      },
      state: 'COVERED',
      freshness: { lastUsableAt: FRESH_INSTANT, policyMaxAgeSeconds: 86400 },
      confidenceValue: 0.9,
      reason: 'authorized Zendesk sync within freshness policy',
    });
    expect(claim.tenantId).toBe(ctx.tenantId);
    expect(claim.surfaceKey).toBe('support-tickets');
    expect(claim.source).toEqual({ registry: 'source', ref: UUID_A });
    expect(claim.observationBasis.ids).toEqual([UUID_B]);
    expect(claim.freshness.policyMaxAgeSeconds).toBe(86400);
    expect(claim.evaluatedBy).toBe(ctx.principalId);
    expect(Number.isNaN(new Date(claim.evaluatedAt).getTime())).toBe(false);
  });

  it('lists claims with filters, chronologically', async () => {
    const ctx = member(tenantRegistry);
    // 'meetings' was registered by the duplicate-registration test above;
    // only the Zoom meeting source is new here.
    await registerSource(ctx, { registry: 'meeting', ref: UUID_B, label: 'Zoom' });
    await recordClaim(ctx, {
      surfaceKey: 'meetings',
      source: { registry: 'meeting', ref: UUID_B },
      observationBasis: { kind: 'observation-set', ids: [UUID_A] },
      state: 'PARTIAL',
      confidenceValue: 0.6,
      reason: 'meetings joined but transcripts disabled',
    });
    const filtered = await listClaims(ctx, { surfaceKey: 'meetings' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.state).toBe('PARTIAL');
    const stale = await listClaims(ctx, { state: 'STALE' });
    expect(stale).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The measurement model
// ---------------------------------------------------------------------------

describe('evaluateSnapshot — the W125 measurement model (§3/§4/§5)', () => {
  it('derives rollups, all nine dimensions, restrictions and gaps from recorded claims', async () => {
    const ctx = member(tenantMeasure);

    for (const surface of [
      { key: 'support-tickets', label: 'Support tickets' },
      { key: 'meetings', label: 'Meetings' },
      { key: 'finance', label: 'Finance' },
      { key: 'customer-interactions', label: 'Customer interactions' },
    ]) {
      await registerSurface(ctx, surface);
    }
    const zendesk = await registerSource(ctx, { registry: 'source', ref: UUID_A, label: 'Zendesk' });
    const zoom = await registerSource(ctx, { registry: 'meeting', ref: UUID_B, label: 'Zoom' });
    const crm = await registerSource(ctx, { registry: 'source', ref: '2d4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e91', label: 'CRM' });
    const secondaryRef = '1c3f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e95';
    await registerSource(ctx, { registry: 'source', ref: secondaryRef, label: 'Secondary desk' });

    // support-tickets: one COVERED fresh source + one PARTIAL source.
    await recordClaim(ctx, {
      surfaceKey: 'support-tickets',
      source: { registry: 'source', ref: zendesk.ref },
      observationBasis: { kind: 'observation-set', ids: [UUID_A, UUID_B], lastObservedAt: FRESH_INSTANT },
      state: 'COVERED',
      freshness: { lastUsableAt: FRESH_INSTANT, policyMaxAgeSeconds: 86400 },
      confidenceValue: 0.9,
      reason: 'authorized Zendesk sync within freshness policy',
    });
    await recordClaim(ctx, {
      surfaceKey: 'support-tickets',
      source: { registry: 'source', ref: secondaryRef },
      observationBasis: { kind: 'observation-set', ids: [UUID_A] },
      state: 'PARTIAL',
      confidenceValue: 0.5,
      reason: 'secondary helpdesk only partially migrated',
    });

    // meetings: one STALE source (evidence exists, policy exceeded).
    await recordClaim(ctx, {
      surfaceKey: 'meetings',
      source: { registry: 'meeting', ref: zoom.ref },
      observationBasis: { kind: 'observation-set', ids: [UUID_A, UUID_B], lastObservedAt: OLD_INSTANT },
      state: 'STALE',
      freshness: { lastUsableAt: OLD_INSTANT, policyMaxAgeSeconds: 3600 },
      confidenceValue: 0.7,
      reason: 'Zoom recordings exceeded their freshness policy',
    });

    // customer-interactions: intentionally absent (authorization revoked).
    await recordClaim(ctx, {
      surfaceKey: 'customer-interactions',
      source: { registry: 'source', ref: crm.ref },
      observationBasis: { kind: 'authorization-state', ids: [] },
      state: 'UNAUTHORIZED',
      confidenceValue: 1,
      reason: 'CRM authorization was revoked',
    });

    // finance: no claims at all — an honest UNKNOWN surface.

    const snapshot = await evaluateSnapshot(ctx);

    expect(snapshot.tenantId).toBe(ctx.tenantId);
    expect(Number.isNaN(new Date(snapshot.evaluatedAt).getTime())).toBe(false);

    // Per-surface rollups, in surface-key order.
    const byKey = new Map(snapshot.surfaces.map((s) => [s.surfaceKey, s]));
    expect(byKey.get('support-tickets')!.state).toBe('COVERED');
    expect(byKey.get('support-tickets')!.contributingSources).toBe(2);
    expect(byKey.get('meetings')!.state).toBe('STALE');
    expect(byKey.get('finance')!.state).toBe('UNKNOWN');
    expect(byKey.get('customer-interactions')!.state).toBe('UNKNOWN');

    // All nine §4 dimensions, separately, in frozen order.
    expect(snapshot.dimensions).toHaveLength(9);
    expect(snapshot.dimensions.map((d) => d.dimension)).toEqual([
      'breadth',
      'depth',
      'freshness',
      'identity-continuity',
      'provenance-completeness',
      'temporal-completeness',
      'outcome-completeness',
      'permission-completeness',
      'goal-sufficiency',
    ]);
    const dimension = (name: string) =>
      snapshot.dimensions.find((d) => d.dimension === name)!;

    // breadth: support-tickets + meetings represented → 2/4.
    expect(dimension('breadth')!.value).toBe(0.5);
    // depth: best basis per represented surface — 2 and 2 → 0.2.
    expect(dimension('depth')!.value).toBe(0.2);
    // freshness: Zendesk (30 min ago, 86400s policy) is within; Zoom
    // (2 h ago, 3600s policy) is outside; the policy-less secondary claim
    // does not count → 1 of 2 within policy.
    expect(dimension('freshness')!.value).toBe(0.5);
    // provenance: all three evidence claims carry ids.
    expect(dimension('provenance-completeness')!.value).toBe(1);
    // temporal: claims with >= 2 ids — Zendesk (2), secondary (1), Zoom (2).
    expect(dimension('temporal-completeness')!.value).toBeCloseTo(2 / 3, 3);
    // permission: 3 of 4 registered sources contribute non-UNAUTHORIZED claims.
    expect(dimension('permission-completeness')!.value).toBe(0.75);
    // The not-yet-measurable dimensions stay honestly UNKNOWN.
    expect(dimension('identity-continuity')!.state).toBe('UNKNOWN');
    expect(dimension('outcome-completeness')!.state).toBe('UNKNOWN');
    expect(dimension('goal-sufficiency')!.state).toBe('UNKNOWN');

    // §5 policy restriction, stated calmly.
    expect(snapshot.policyRestrictions).toEqual([
      { surfaceKey: 'customer-interactions', note: 'CRM authorization was revoked' },
    ]);

    // §3 gaps: meetings STALE (material, freshness), finance UNKNOWN
    // (immaterial, breadth), customer-interactions UNKNOWN (immaterial,
    // breadth). COVERED support-tickets has no gap; the UNAUTHORIZED
    // claim is a restriction, not a gap.
    expect(snapshot.gaps).toHaveLength(3);
    const gap = (surfaceKey: string) =>
      snapshot.gaps.find((g) => g.surfaceKey === surfaceKey)!;
    expect(gap('meetings')).toMatchObject({
      dimension: 'freshness',
      state: 'STALE',
      material: true,
      snapshotId: snapshot.id,
    });
    expect(gap('finance')).toMatchObject({ dimension: 'breadth', material: false });
    expect(gap('customer-interactions')).toMatchObject({ dimension: 'breadth', material: false });
    for (const detected of snapshot.gaps) {
      expect(detected.affectedGoalIds).toEqual([]);
      expect(detected.detectedAt).toBe(snapshot.evaluatedAt);
    }
  });

  it('re-evaluation appends: the LATEST claim per source is the current statement', async () => {
    const ctx = member(tenantMeasure);
    await registerSurface(ctx, { key: 'projects', label: 'Projects' });
    const linear = await registerSource(ctx, { registry: 'source', ref: '3e4f8e2a-1c4b-4d8a-9f3e-7a2b6c5d4e92', label: 'Linear' });

    await recordClaim(ctx, {
      surfaceKey: 'projects',
      source: { registry: 'source', ref: linear.ref },
      observationBasis: { kind: 'observation-set', ids: [UUID_A] },
      state: 'PARTIAL',
      confidenceValue: 0.4,
      reason: 'initial partial import',
    });
    const before = await evaluateSnapshot(ctx, { surfaceKeys: ['projects'] });
    expect(before.surfaces[0]!.state).toBe('PARTIAL');

    // Corrected evaluation: append a newer COVERED claim for the same source.
    await recordClaim(ctx, {
      surfaceKey: 'projects',
      source: { registry: 'source', ref: linear.ref },
      observationBasis: { kind: 'observation-set', ids: [UUID_A, UUID_B] },
      state: 'COVERED',
      freshness: { lastUsableAt: FRESH_INSTANT, policyMaxAgeSeconds: 86400 },
      confidenceValue: 0.95,
      reason: 'full backlog import completed',
    });
    const after = await evaluateSnapshot(ctx, { surfaceKeys: ['projects'] });
    expect(after.surfaces[0]!.state).toBe('COVERED');

    // The claim history itself is preserved (append-only).
    const history = await listClaims(ctx, { surfaceKey: 'projects' });
    expect(history).toHaveLength(2);
  });

  it('evaluates a subset when surfaceKeys is provided', async () => {
    const ctx = member(tenantMeasure);
    const snapshot = await evaluateSnapshot(ctx, { surfaceKeys: ['meetings'] });
    expect(snapshot.surfaces).toHaveLength(1);
    expect(snapshot.surfaces[0]!.surfaceKey).toBe('meetings');
    expect(snapshot.gaps).toHaveLength(1);
    // breadth over the considered subset: 1 of 1 represented.
    expect(snapshot.dimensions[0]!.value).toBe(1);
  });

  it('reads snapshots back by id and lists summaries newest-first', async () => {
    const ctx = member(tenantMeasure);
    const first = await evaluateSnapshot(ctx, { surfaceKeys: ['meetings'] });
    const second = await evaluateSnapshot(ctx, { surfaceKeys: ['meetings'] });

    const fetched = await getSnapshot(ctx, { snapshotId: second.id });
    expect(fetched).toEqual(second);
    expect(fetched.id).not.toBe(first.id);

    const summaries = await listSnapshots(ctx, { limit: 10 });
    expect(summaries[0]!.id).toBe(second.id);
    expect(summaries[1]!.id).toBe(first.id);
    expect(summaries[0]!.surfaceCount).toBe(1);
    expect(summaries[0]!.gapCount).toBe(1);
    expect(summaries[1]!.evaluatedAt <= summaries[0]!.evaluatedAt).toBe(true);
  });

  it('lists gaps with filters from the gap store', async () => {
    const ctx = member(tenantMeasure);
    const snapshot = await evaluateSnapshot(ctx);
    const material = await listGaps(ctx, { material: true, limit: 10 });
    expect(material.length).toBeGreaterThanOrEqual(1);
    expect(material.every((gap) => gap.material)).toBe(true);
    const fromSnapshot = await listGaps(ctx, { snapshotId: snapshot.id });
    expect(fromSnapshot.length).toBe(snapshot.gaps.length);
    const meetingsFreshness = await listGaps(ctx, {
      surfaceKey: 'meetings',
      dimension: 'freshness',
    });
    expect(meetingsFreshness.length).toBeGreaterThanOrEqual(1);
    expect(meetingsFreshness[0]!.snapshotId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Immutability (§3: "a later snapshot never rewrites an earlier one")
// ---------------------------------------------------------------------------

describe('coverage history is append-only (§3)', () => {
  it('rejects UPDATE/DELETE/TRUNCATE on claims, snapshots and gaps', async () => {
    const ctx = member(tenantImmutable);
    await registerSurface(ctx, { key: 'operations', label: 'Operations' });
    await registerSource(ctx, { registry: 'integration', ref: UUID_A, label: 'Integration' });
    await recordClaim(ctx, {
      surfaceKey: 'operations',
      source: { registry: 'integration', ref: UUID_A },
      observationBasis: { kind: 'observation-set', ids: [UUID_B] },
      state: 'PARTIAL',
      confidenceValue: 0.6,
      reason: 'partial operational events',
    });
    const snapshot = await evaluateSnapshot(ctx);
    expect(snapshot.gaps).toHaveLength(1);

    const db = getDb();
    await expect(db.query(`UPDATE coverage_claims SET reason = 'rewritten' WHERE tenant_id = $1`, [ctx.tenantId])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM coverage_claims WHERE tenant_id = $1`, [ctx.tenantId])).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE coverage_snapshots SET document = '{}'::jsonb WHERE id = $1`, [snapshot.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM coverage_snapshots WHERE id = $1`, [snapshot.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`UPDATE coverage_gaps SET reason = 'rewritten' WHERE snapshot_id = $1`, [snapshot.id])).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE coverage_gaps`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE coverage_claims`)).rejects.toThrow(/append-only/);
    await expect(db.query(`TRUNCATE coverage_snapshots`)).rejects.toThrow(/append-only/);

    // And the snapshot still reads identical after the attempts.
    const reread = await getSnapshot(ctx, { snapshotId: snapshot.id });
    expect(reread).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation (ADR-0001)', () => {
  it('another tenant sees nothing — uniform not-found, no existence leak', async () => {
    const ctxA = member(tenantIsoA);
    const ctxB = member(tenantIsoB);

    await registerSurface(ctxA, { key: 'support-tickets', label: 'A tickets' });
    await registerSource(ctxA, { registry: 'source', ref: UUID_A, label: 'A source' });
    await recordClaim(ctxA, {
      surfaceKey: 'support-tickets',
      source: { registry: 'source', ref: UUID_A },
      observationBasis: { kind: 'observation-set', ids: [UUID_B] },
      state: 'COVERED',
      confidenceValue: 0.9,
      reason: 'A claim',
    });
    const snapshotA = await evaluateSnapshot(ctxA);

    // B's own registry is empty and B sees none of A's state.
    expect(await listSurfaces(ctxB)).toHaveLength(0);
    expect(await listSources(ctxB)).toHaveLength(0);
    expect(await listClaims(ctxB)).toHaveLength(0);
    expect(await listSnapshots(ctxB)).toHaveLength(0);
    expect(await listGaps(ctxB)).toHaveLength(0);

    // Cross-tenant reads are indistinguishable from missing records.
    await expectCode('snapshot_not_found', () =>
      getSnapshot(ctxB, { snapshotId: snapshotA.id }),
    );
    await expectCode('surface_not_found', () =>
      recordClaim(ctxB, {
        surfaceKey: 'support-tickets',
        source: { registry: 'source', ref: UUID_A },
        observationBasis: { kind: 'observation-set', ids: [] },
        state: 'COVERED',
        confidenceValue: 0.9,
        reason: 'B claiming on A surface',
      }),
    );

    // B's own evaluation is independent of A's.
    const snapshotB = await evaluateSnapshot(ctxB);
    expect(snapshotB.surfaces).toHaveLength(0);
    expect(snapshotB.gaps).toHaveLength(0);
    expect(snapshotB.dimensions[0]!.value).toBeNull();
    expect(snapshotB.tenantId).toBe(ctxB.tenantId);
  });
});
