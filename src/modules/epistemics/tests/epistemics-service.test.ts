// Integration tests for the epistemics module against the embedded
// PostgreSQL (PGlite, `:memory:`) through the db port, including the
// cross-module integration with the observations contract (evidence links)
// and the freshness contract (belief versioning under subject kind
// 'epistemics.belief'). Covers the W007 acceptance:
//
//  * CLAIMS — immutable evidence-derived propositions: system-minted commit
//    time, validated evidence links (in-tenant, principal-readable),
//    storage-level immutability (UPDATE/DELETE/TRUNCATE rejected by
//    triggers), filtered listing including evidence containment.
//  * CONTRADICTIONS — retained conflicts: canonical pair ordering (one row
//    per unordered pair per tenant), duplicate registration rejected,
//    one-way resolution, and storage-level retention guards (identity
//    frozen, no deletion, no status regression).
//  * HYPOTHESES — unresolved explanations with optional supporting
//    evidence; one-way open → confirmed | refuted; identity frozen.
//  * UNKNOWNS — consequential gaps (question + consequence both required);
//    validated related references; one-way resolution.
//  * BELIEFS — versioned working understanding: anchors here, statements
//    versioned through the freshness machinery (provenance = supporting
//    observations, state = the statement with its supporting claims),
//    strictly increasing validFrom, asOf resolution, one-way retirement,
//    belief freshness against tenant stale-after policies (lock 11).
//  * CONFLICTING EVIDENCE IS RETAINED (the explicit W007 verification):
//    the full observation → claim → contradiction → belief scenario, then
//    resolution and belief revision — with every piece of conflicting
//    evidence, both claims, the contradiction record and the belief's own
//    version history still retrievable afterwards, and storage-level
//    mutation attempts rejected.
//  * tenant isolation (ADR-0001) across every surface, with uniform
//    not-found semantics (no existence leaks).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import * as epistemicsContract from '../contract';
import * as observationsContract from '@/modules/observations/contract';
import * as freshnessContract from '@/modules/freshness/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { runMigrations } from '../../../../scripts/migrate';

const {
  evaluateBeliefFreshness,
  formBelief,
  getBelief,
  getClaim,
  getContradiction,
  getHypothesis,
  getUnknown,
  listBeliefHistory,
  listBeliefs,
  listClaims,
  listContradictions,
  listHypotheses,
  listUnknowns,
  recordClaim,
  recordHypothesis,
  recordUnknown,
  registerContradiction,
  resolveContradiction,
  resolveHypothesis,
  resolveUnknown,
  retireBelief,
  reviseBelief,
} = epistemicsContract;
const { recordObservation } = observationsContract;
const { evaluateTemporalStateFreshness, listTemporalHistory, setFreshnessPolicy } =
  freshnessContract;

// Dedicated tenants per concern (and per test with absolute list
// assertions) so every assertion below sees only what it created itself.
const tenantClaimsRecord = newId();
const tenantClaimsList = newId();
const tenantClaimsEvidence = newId();
const tenantClaimsStorage = newId();
const tenantForeign = newId();
const tenantContraRegister = newId();
const tenantContraReject = newId();
const tenantContraList = newId();
const tenantContraResolve = newId();
const tenantContraStorage = newId();
const tenantHypoRecord = newId();
const tenantHypoResolve = newId();
const tenantHypoStorage = newId();
const tenantUnknownRecord = newId();
const tenantUnknownResolve = newId();
const tenantUnknownStorage = newId();
const tenantBeliefForm = newId();
const tenantBeliefRevise = newId();
const tenantBeliefAsOf = newId();
const tenantBeliefChain = newId();
const tenantBeliefRetire = newId();
const tenantBeliefList = newId();
const tenantAcceptance = newId();
const tenantFreshness = newId();
const tenantA = newId();
const tenantB = newId();

const T0 = '2026-09-14T09:15:00.000Z'; // .000Z — the format instants round-trip in
const T0_PLUS = (seconds: number): string =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();

function member(tenantId: string): TenantContext {
  return { tenantId, principalId: newId(), authority: [] };
}

function memberAs(tenantId: string, principalId: string): TenantContext {
  return { tenantId, principalId, authority: [] };
}

/** A minimal observation input, parameterized on observedAt. */
function observationInput(observedAt: string): Parameters<typeof recordObservation>[1] {
  return {
    kind: 'document.note',
    payload: { note: 'delivery report' },
    observedAt,
    source: { kind: 'person', label: 'office-manager' },
    channel: 'ingestion',
    confidence: { value: 0.9, method: 'source_trust' },
  };
}

async function seedObservation(
  ctx: TenantContext,
  observedAt: string,
): Promise<{ id: string; observedAt: string }> {
  const recorded = await recordObservation(ctx, { ...observationInput(observedAt) });
  return { id: recorded.id, observedAt: recorded.observedAt };
}

/** A minimal claim input citing the given evidence. */
function claimInput(evidenceObservationIds: string[]): Parameters<typeof recordClaim>[1] {
  return {
    proposition: 'supplier Acme delivers within five business days',
    subject: { kind: 'world.entity', id: newId() },
    confidence: { value: 0.8, method: 'evidence_weighing', basis: 'delivery notes' },
    evidenceObservationIds,
    rationale: 'derived from delivery notes',
  };
}

/** A minimal belief input citing the given evidence. */
function beliefInput(
  supportingObservationIds: string[],
  validFrom: string,
): Parameters<typeof formBelief>[1] {
  return {
    proposition: 'supplier Acme is reliable',
    confidence: { value: 0.7, method: 'evidence_weighing' },
    supportingObservationIds,
    alternatives: ['the good deliveries were cherry-picked'],
    disconfirmation: 'a late delivery observed after this quarter',
    subject: { kind: 'world.entity', id: newId() },
    validFrom,
    rationale: 'weighing the delivery evidence',
  };
}

beforeAll(async () => {
  await runMigrations(getDb());
});

afterAll(async () => {
  await closeDb();
});

describe('contract surface (the module exposes exactly its public operations)', () => {
  it('pins the export set — no mutation or erase operation exists', async () => {
    // There is deliberately no updateClaim, no deleteClaim, no
    // mergeContradiction, no reopenContradiction, no deleteUnknown, no
    // reactivateBelief: claims are immutable, contradictions/unknowns/
    // hypotheses resolve one-way, and beliefs version forward or retire.
    expect(Object.keys(epistemicsContract).sort()).toEqual([
      'BELIEF_STATUSES',
      'BELIEF_SUBJECT_KIND',
      'CONTRADICTION_STATUSES',
      'DEFAULT_LIST_LIMIT',
      'EVIDENCE_REF_KINDS',
      'EpistemicsError',
      'HYPOTHESIS_STATUSES',
      'MAX_ALTERNATIVES',
      'MAX_ALTERNATIVE_CHARS',
      'MAX_BELIEF_STATE_BYTES',
      'MAX_DISCONFIRMATION_CHARS',
      'MAX_EVIDENCE_CLAIMS',
      'MAX_EVIDENCE_OBSERVATIONS',
      'MAX_LIST_LIMIT',
      'MAX_NOTE_CHARS',
      'MAX_PROPOSITION_CHARS',
      'MAX_RATIONALE_CHARS',
      'RESOLUTION_REF_KINDS',
      'UNKNOWN_STATUSES',
      'evaluateBeliefFreshness',
      'formBelief',
      'getBelief',
      'getClaim',
      'getContradiction',
      'getHypothesis',
      'getUnknown',
      'isBeliefStatus',
      'isContradictionStatus',
      'isEvidenceRefKind',
      'isHypothesisStatus',
      'isResolutionRefKind',
      'isUnknownStatus',
      'isUuid',
      'listBeliefHistory',
      'listBeliefs',
      'listClaims',
      'listContradictions',
      'listHypotheses',
      'listUnknowns',
      'recordClaim',
      'recordHypothesis',
      'recordUnknown',
      'registerContradiction',
      'resolveContradiction',
      'resolveHypothesis',
      'resolveUnknown',
      'retireBelief',
      'reviseBelief',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

describe('claims — immutable propositions derived from evidence', () => {
  it('records a claim with system-minted identity, commit time and evidence links', async () => {
    const ctx = member(tenantClaimsRecord);
    const evidenceA = await seedObservation(ctx, T0);
    const evidenceB = await seedObservation(ctx, T0_PLUS(60));

    const before = new Date();
    const claim = await recordClaim(ctx, {
      ...claimInput([evidenceB.id, evidenceA.id, evidenceB.id]),
    });
    const after = new Date();

    expect(claim.tenantId).toBe(tenantClaimsRecord);
    expect(claim.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(claim.proposition).toBe('supplier Acme delivers within five business days');
    expect(claim.subject!.kind).toBe('world.entity');
    expect(claim.confidence).toEqual({
      value: 0.8,
      method: 'evidence_weighing',
      basis: 'delivery notes',
    });
    // evidence links are a set: deduplicated and sorted
    expect(claim.evidenceObservationIds).toEqual([evidenceA.id, evidenceB.id].sort());
    expect(claim.rationale).toBe('derived from delivery notes');
    expect(Date.parse(claim.recordedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(claim.recordedAt)).toBeLessThanOrEqual(after.getTime());

    const roundTrip = await getClaim(ctx, { claimId: claim.id });
    expect(roundTrip).toEqual(claim);
  });

  it('reports missing claims uniformly and rejects malformed queries', async () => {
    const ctx = member(tenantClaimsRecord);
    await expect(getClaim(ctx, { claimId: newId() })).rejects.toMatchObject({
      code: 'claim_not_found',
    });
    await expect(getClaim(ctx, { claimId: 'not-a-uuid' })).rejects.toMatchObject({
      code: 'invalid_query',
    });
  });

  it('lists claims by subject and by contained evidence, honoring the limit', async () => {
    const ctx = member(tenantClaimsList);
    const subjectId = newId();
    const evidence = await seedObservation(ctx, T0_PLUS(120));

    const target = await recordClaim(ctx, {
      ...claimInput([evidence.id]),
      subject: { kind: 'world.entity', id: subjectId },
    });
    const otherSubject = await recordClaim(ctx, {
      ...claimInput([evidence.id]),
      subject: { kind: 'world.entity', id: newId() },
    });
    const noEvidence = await recordClaim(ctx, {
      ...claimInput([(await seedObservation(ctx, T0_PLUS(180))).id]),
      subject: null, // unclassified subject: invisible to the kind filter below
    });

    const bySubject = await listClaims(ctx, { subjectKind: 'world.entity', subjectId });
    expect(bySubject.map((claim) => claim.id)).toEqual([target.id]);

    const byKind = await listClaims(ctx, { subjectKind: 'world.entity' });
    expect(byKind.map((claim) => claim.id).sort()).toEqual([target.id, otherSubject.id].sort());

    // evidence containment: claims whose evidence includes this observation
    const byEvidence = await listClaims(ctx, { evidenceObservationId: evidence.id });
    expect(byEvidence.map((claim) => claim.id).sort()).toEqual(
      [target.id, otherSubject.id].sort(),
    );
    expect(byEvidence.every((claim) => claim.id !== noEvidence.id)).toBe(true);

    const limited = await listClaims(ctx, { limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('rejects evidence that is missing, cross-tenant or principal-restricted (no existence leak)', async () => {
    const ctx = member(tenantClaimsEvidence);
    const owner = newId();

    // missing observation
    await expect(recordClaim(ctx, claimInput([newId()]))).rejects.toMatchObject({
      code: 'invalid_evidence',
    });

    // cross-tenant observation (exists, but in another tenant)
    const foreignEvidence = await seedObservation(member(tenantForeign), T0);
    await expect(recordClaim(ctx, claimInput([foreignEvidence.id]))).rejects.toMatchObject({
      code: 'invalid_evidence',
    });

    // principal-restricted observation of another principal
    const restricted = await recordObservation(ctx, {
      ...observationInput(T0),
      permissions: { visibility: 'principal', principalId: owner },
    });
    await expect(recordClaim(ctx, claimInput([restricted.id]))).rejects.toMatchObject({
      code: 'invalid_evidence',
    });

    // ...while the owning principal CAN cite it
    const ownClaim = await recordClaim(memberAs(tenantClaimsEvidence, owner), claimInput([restricted.id]));
    expect(ownClaim.evidenceObservationIds).toEqual([restricted.id]);
  });

  it('rejects UPDATE, DELETE and TRUNCATE on claims at the storage layer (lock 12)', async () => {
    const ctx = member(tenantClaimsStorage);
    const evidence = await seedObservation(ctx, T0_PLUS(240));
    const claim = await recordClaim(ctx, claimInput([evidence.id]));

    await expect(
      getDb().query(`UPDATE claims SET proposition = 'rewritten' WHERE id = $1`, [claim.id]),
    ).rejects.toThrow(/claims are immutable/);
    await expect(getDb().query(`DELETE FROM claims WHERE id = $1`, [claim.id])).rejects.toThrow(
      /claims are immutable/,
    );
    await expect(getDb().query(`TRUNCATE TABLE claims`)).rejects.toThrow(/claims are immutable/);

    const survivor = await getClaim(ctx, { claimId: claim.id });
    expect(survivor.proposition).toBe(claim.proposition);
  });
});

// ---------------------------------------------------------------------------
// Contradictions
// ---------------------------------------------------------------------------

describe('contradictions — retained conflicts between two evidence references', () => {
  it('registers a contradiction in canonical pair order, regardless of input order', async () => {
    const ctx = member(tenantContraRegister);
    const evidence = await seedObservation(ctx, T0);
    const claim = await recordClaim(ctx, claimInput([evidence.id]));

    const before = new Date();
    const contradiction = await registerContradiction(ctx, {
      // observation given as LEFT, claim as RIGHT — 'claim' sorts first
      left: { kind: 'observation', id: evidence.id },
      right: { kind: 'claim', id: claim.id },
      note: 'the observation contradicts the claim on delivery time',
    });
    const after = new Date();

    expect(contradiction.tenantId).toBe(tenantContraRegister);
    expect(contradiction.evidenceA).toEqual({ kind: 'claim', id: claim.id });
    expect(contradiction.evidenceB).toEqual({ kind: 'observation', id: evidence.id });
    expect(contradiction.status).toBe('open');
    expect(contradiction.resolvedAt).toBeNull();
    expect(contradiction.resolvedBy).toBeNull();
    expect(contradiction.resolutionNote).toBeNull();
    expect(Date.parse(contradiction.detectedAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(contradiction.detectedAt)).toBeLessThanOrEqual(after.getTime());

    // the same pair in the other input order is the SAME stored row
    await expect(
      registerContradiction(ctx, {
        left: { kind: 'claim', id: claim.id },
        right: { kind: 'observation', id: evidence.id },
        note: 're-registered in the other order',
      }),
    ).rejects.toMatchObject({ code: 'contradiction_conflict' });

    const all = await listContradictions(ctx, {});
    expect(all).toHaveLength(1);
    expect(all[0]!.note).toBe('the observation contradicts the claim on delivery time');
  });

  it('rejects self-contradictions and unreadable evidence references', async () => {
    const ctx = member(tenantContraReject);
    const evidence = await seedObservation(ctx, T0);

    await expect(
      registerContradiction(ctx, {
        left: { kind: 'observation', id: evidence.id },
        right: { kind: 'observation', id: evidence.id },
        note: 'self conflict',
      }),
    ).rejects.toMatchObject({ code: 'invalid_contradiction_input' });

    await expect(
      registerContradiction(ctx, {
        left: { kind: 'claim', id: newId() },
        right: { kind: 'observation', id: evidence.id },
        note: 'one side is missing',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    const foreignEvidence = await seedObservation(member(tenantForeign), T0);
    await expect(
      registerContradiction(ctx, {
        left: { kind: 'observation', id: foreignEvidence.id },
        right: { kind: 'observation', id: evidence.id },
        note: 'one side is foreign',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
  });

  it('lists contradictions by either evidence side and by status', async () => {
    const ctx = member(tenantContraList);
    const evidenceX = await seedObservation(ctx, T0_PLUS(300));
    const evidenceY = await seedObservation(ctx, T0_PLUS(360));
    const evidenceZ = await seedObservation(ctx, T0_PLUS(420));
    const claimX = await recordClaim(ctx, claimInput([evidenceX.id]));

    const first = await registerContradiction(ctx, {
      left: { kind: 'claim', id: claimX.id },
      right: { kind: 'observation', id: evidenceY.id },
      note: 'first conflict',
    });
    const second = await registerContradiction(ctx, {
      left: { kind: 'observation', id: evidenceY.id },
      right: { kind: 'observation', id: evidenceZ.id },
      note: 'second conflict',
    });

    // either side matches
    const involvingY = await listContradictions(ctx, {
      evidenceRef: { kind: 'observation', id: evidenceY.id },
    });
    expect(involvingY.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());

    const involvingClaim = await listContradictions(ctx, {
      evidenceRef: { kind: 'claim', id: claimX.id },
    });
    expect(involvingClaim.map((row) => row.id)).toEqual([first.id]);

    const open = await listContradictions(ctx, { status: 'open' });
    expect(open).toHaveLength(2);
    const resolved = await listContradictions(ctx, { status: 'resolved' });
    expect(resolved).toHaveLength(0);
  });

  it('resolves a contradiction one-way, with a validated resolution reference', async () => {
    const ctx = member(tenantContraResolve);
    const evidenceA = await seedObservation(ctx, T0_PLUS(480));
    const evidenceB = await seedObservation(ctx, T0_PLUS(540));
    const claim = await recordClaim(ctx, claimInput([evidenceA.id]));
    const belief = await formBelief(ctx, beliefInput([evidenceA.id], T0));

    const contradiction = await registerContradiction(ctx, {
      left: { kind: 'claim', id: claim.id },
      right: { kind: 'observation', id: evidenceB.id },
      note: 'delivery time mismatch',
    });

    // a resolution reference must exist and be readable
    await expect(
      resolveContradiction(ctx, {
        contradictionId: contradiction.id,
        resolvedBy: { kind: 'belief', id: newId() },
        note: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    const before = new Date();
    const resolved = await resolveContradiction(ctx, {
      contradictionId: contradiction.id,
      resolvedBy: { kind: 'belief', id: belief.id },
      note: 'newer evidence favors the observation; the claim was misderived',
    });
    const after = new Date();

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedBy).toEqual({ kind: 'belief', id: belief.id });
    expect(resolved.resolutionNote).toBe(
      'newer evidence favors the observation; the claim was misderived',
    );
    expect(Date.parse(resolved.resolvedAt!)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(resolved.resolvedAt!)).toBeLessThanOrEqual(after.getTime());
    // the retained record is untouched: pair and note frozen
    expect(resolved.evidenceA).toEqual(contradiction.evidenceA);
    expect(resolved.evidenceB).toEqual(contradiction.evidenceB);
    expect(resolved.note).toBe(contradiction.note);
    expect(resolved.detectedAt).toBe(contradiction.detectedAt);

    // one-way: resolving again is an error, never a rewrite
    await expect(
      resolveContradiction(ctx, {
        contradictionId: contradiction.id,
        note: 'second attempt',
      }),
    ).rejects.toMatchObject({ code: 'invalid_resolution' });

    await expect(
      resolveContradiction(ctx, { contradictionId: newId(), note: 'x' }),
    ).rejects.toMatchObject({ code: 'contradiction_not_found' });
  });

  it('retention guards at the storage layer: no deletion, no rewrite, no regression', async () => {
    const ctx = member(tenantContraStorage);
    const evidenceA = await seedObservation(ctx, T0_PLUS(600));
    const evidenceB = await seedObservation(ctx, T0_PLUS(660));
    const claim = await recordClaim(ctx, claimInput([evidenceA.id]));

    const staysOpen = await registerContradiction(ctx, {
      left: { kind: 'claim', id: claim.id },
      right: { kind: 'observation', id: evidenceA.id },
      note: 'claim vs its own evidence',
    });
    const getsResolved = await registerContradiction(ctx, {
      left: { kind: 'observation', id: evidenceA.id },
      right: { kind: 'observation', id: evidenceB.id },
      note: 'manifests disagree',
    });
    const resolved = await resolveContradiction(ctx, {
      contradictionId: getsResolved.id,
      note: 'the second manifest corrected the first',
    });

    // DELETE and TRUNCATE are forbidden — contradictions are retained
    await expect(
      getDb().query(`DELETE FROM contradictions WHERE id = $1`, [staysOpen.id]),
    ).rejects.toThrow(/contradictions are retained/);
    await expect(getDb().query(`TRUNCATE TABLE contradictions`)).rejects.toThrow(
      /contradictions are retained/,
    );

    // an OPEN row may not change at all (only the one-way resolution may)
    await expect(
      getDb().query(
        `UPDATE contradictions SET evidence_a_id = $2 WHERE tenant_id = $1 AND id = $3`,
        [tenantContraStorage, evidenceB.id, staysOpen.id],
      ),
    ).rejects.toThrow(/illegal transition/);
    await expect(
      getDb().query(
        `UPDATE contradictions SET note = 'rewritten' WHERE tenant_id = $1 AND id = $2`,
        [tenantContraStorage, staysOpen.id],
      ),
    ).rejects.toThrow(/illegal transition/);

    // a RESOLVED row is terminal: status regression and note rewrite are
    // both rejected
    await expect(
      getDb().query(
        `UPDATE contradictions SET status = 'open' WHERE tenant_id = $1 AND id = $2`,
        [tenantContraStorage, resolved.id],
      ),
    ).rejects.toThrow(/terminal/);
    await expect(
      getDb().query(
        `UPDATE contradictions SET note = 'rewritten' WHERE tenant_id = $1 AND id = $2`,
        [tenantContraStorage, resolved.id],
      ),
    ).rejects.toThrow(/terminal/);
    await expect(
      getDb().query(
        `UPDATE contradictions SET evidence_b_id = $2 WHERE tenant_id = $1 AND id = $3`,
        [tenantContraStorage, claim.id, resolved.id],
      ),
    ).rejects.toThrow(/terminal/);

    // identity-preserving no-op updates on a terminal row stay legal (SQL
    // UPDATE ... SET col = col), but change nothing
    const noOp = await getDb().query(
      `UPDATE contradictions SET resolution_note = resolution_note WHERE tenant_id = $1 AND id = $2 RETURNING id`,
      [tenantContraStorage, resolved.id],
    );
    expect(noOp.rowCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

describe('hypotheses — unresolved explanations', () => {
  it('records hypotheses with optional supporting evidence', async () => {
    const ctx = member(tenantHypoRecord);
    const evidence = await seedObservation(ctx, T0);

    const bare = await recordHypothesis(ctx, {
      proposition: 'the delivery delays come from a single warehouse',
    });
    expect(bare.status).toBe('open');
    expect(bare.supportingObservationIds).toEqual([]);
    expect(bare.resolutionNote).toBeNull();
    expect(bare.resolutionEvidenceObservationIds).toEqual([]);
    expect(bare.resolutionEvidenceClaimIds).toEqual([]);

    const supported = await recordHypothesis(ctx, {
      proposition: 'the delays come from the port authority',
      subject: { kind: 'world.entity', id: newId() },
      supportingObservationIds: [evidence.id],
      note: 'raised after the port strike news',
    });
    expect(supported.supportingObservationIds).toEqual([evidence.id]);
    expect(supported.note).toBe('raised after the port strike news');

    // unreadable supporting evidence is rejected
    await expect(
      recordHypothesis(ctx, {
        proposition: 'x',
        supportingObservationIds: [newId()],
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
  });

  it('resolves hypotheses one-way with validated evidence, and lists by status', async () => {
    const ctx = member(tenantHypoResolve);
    const evidence = await seedObservation(ctx, T0_PLUS(720));
    const claim = await recordClaim(ctx, claimInput([evidence.id]));
    const hypothesis = await recordHypothesis(ctx, {
      proposition: 'the delays come from the port authority',
    });
    await recordHypothesis(ctx, { proposition: 'a rival explanation' });
    await recordHypothesis(ctx, { proposition: 'a third, still-open explanation' });

    // resolution evidence must exist
    await expect(
      resolveHypothesis(ctx, {
        hypothesisId: hypothesis.id,
        outcome: 'confirmed',
        evidenceClaimIds: [newId()],
        note: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    const confirmed = await resolveHypothesis(ctx, {
      hypothesisId: hypothesis.id,
      outcome: 'confirmed',
      evidenceObservationIds: [evidence.id],
      evidenceClaimIds: [claim.id],
      note: 'the warehouse manager confirmed the port backlog',
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.resolutionEvidenceObservationIds).toEqual([evidence.id]);
    expect(confirmed.resolutionEvidenceClaimIds).toEqual([claim.id]);
    expect(confirmed.resolutionNote).toBe('the warehouse manager confirmed the port backlog');
    // identity retained
    expect(confirmed.proposition).toBe(hypothesis.proposition);

    // one-way
    await expect(
      resolveHypothesis(ctx, {
        hypothesisId: hypothesis.id,
        outcome: 'refuted',
        note: 'second attempt',
      }),
    ).rejects.toMatchObject({ code: 'invalid_resolution' });

    const rival = (await listHypotheses(ctx, { status: 'open' })).find(
      (row) => row.proposition === 'a rival explanation',
    )!;
    const refuted = await resolveHypothesis(ctx, {
      hypothesisId: rival.id,
      outcome: 'refuted',
      note: 'contradicted by the ledger',
    });
    expect(refuted.status).toBe('refuted');

    const open = await listHypotheses(ctx, { status: 'open' });
    expect(open.map((row) => row.proposition)).toEqual(['a third, still-open explanation']);
    const all = await listHypotheses(ctx, {});
    expect(all.map((row) => row.status).sort()).toEqual(['confirmed', 'open', 'refuted']);

    await expect(getHypothesis(ctx, { hypothesisId: newId() })).rejects.toMatchObject({
      code: 'hypothesis_not_found',
    });
  });

  it('retention guards at the storage layer: no deletion, frozen identity', async () => {
    const ctx = member(tenantHypoStorage);
    const hypothesis = await recordHypothesis(ctx, { proposition: 'an open explanation' });

    await expect(
      getDb().query(`DELETE FROM hypotheses WHERE id = $1`, [hypothesis.id]),
    ).rejects.toThrow(/hypotheses are retained/);
    await expect(getDb().query(`TRUNCATE TABLE hypotheses`)).rejects.toThrow(
      /hypotheses are retained/,
    );
    // identity is frozen even while open: only resolution may change the row
    await expect(
      getDb().query(`UPDATE hypotheses SET proposition = 'rewritten' WHERE id = $1`, [
        hypothesis.id,
      ]),
    ).rejects.toThrow(/illegal transition/);
    const survivor = await getHypothesis(ctx, { hypothesisId: hypothesis.id });
    expect(survivor.proposition).toBe('an open explanation');
  });
});

// ---------------------------------------------------------------------------
// Unknowns
// ---------------------------------------------------------------------------

describe('unknowns — consequential gaps in knowledge (lock 7)', () => {
  it('records unknowns with validated related references', async () => {
    const ctx = member(tenantUnknownRecord);
    const evidence = await seedObservation(ctx, T0);
    const claim = await recordClaim(ctx, claimInput([evidence.id]));
    const belief = await formBelief(ctx, beliefInput([evidence.id], T0));

    const unknown = await recordUnknown(ctx, {
      question: 'which warehouse causes the delivery delays?',
      consequence: 'without it we cannot fix the delivery slips promised to customers',
      subject: { kind: 'world.entity', id: newId() },
      relatedObservationIds: [evidence.id],
      relatedClaimIds: [claim.id],
      relatedBeliefIds: [belief.id],
      note: 'raised after the reliability belief was formed',
    });
    expect(unknown.status).toBe('open');
    expect(unknown.relatedObservationIds).toEqual([evidence.id]);
    expect(unknown.relatedClaimIds).toEqual([claim.id]);
    expect(unknown.relatedBeliefIds).toEqual([belief.id]);
    expect(unknown.consequence).toContain('delivery slips');

    // every related reference must exist in this tenant
    await expect(
      recordUnknown(ctx, { question: 'q', consequence: 'c', relatedBeliefIds: [newId()] }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(
      recordUnknown(ctx, { question: 'q', consequence: 'c', relatedClaimIds: [newId()] }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(
      recordUnknown(ctx, { question: 'q', consequence: 'c', relatedObservationIds: [newId()] }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    await expect(getUnknown(ctx, { unknownId: unknown.id })).resolves.toEqual(unknown);
    await expect(getUnknown(ctx, { unknownId: newId() })).rejects.toMatchObject({
      code: 'unknown_not_found',
    });
  });

  it('resolves unknowns one-way, with a validated resolution reference, and lists by status', async () => {
    const ctx = member(tenantUnknownResolve);
    const evidence = await seedObservation(ctx, T0_PLUS(780));
    const belief = await formBelief(ctx, beliefInput([evidence.id], T0_PLUS(780)));
    const unknown = await recordUnknown(ctx, {
      question: 'which warehouse causes the delays?',
      consequence: 'delivery promises depend on it',
    });

    await expect(
      resolveUnknown(ctx, {
        unknownId: unknown.id,
        resolution: { kind: 'belief', id: newId() },
        note: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });

    const resolved = await resolveUnknown(ctx, {
      unknownId: unknown.id,
      resolution: { kind: 'belief', id: belief.id },
      note: 'the delay source was identified and is now a belief',
    });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toEqual({ kind: 'belief', id: belief.id });
    expect(resolved.resolutionNote).toBe('the delay source was identified and is now a belief');
    // identity retained
    expect(resolved.question).toBe(unknown.question);
    expect(resolved.consequence).toBe(unknown.consequence);

    await expect(
      resolveUnknown(ctx, { unknownId: unknown.id, note: 'again' }),
    ).rejects.toMatchObject({ code: 'invalid_resolution' });

    const open = await listUnknowns(ctx, { status: 'open' });
    expect(open).toHaveLength(0);
    const all = await listUnknowns(ctx, {});
    expect(all.map((row) => row.status)).toEqual(['resolved']);
  });

  it('retention guards at the storage layer: no deletion, frozen identity', async () => {
    const ctx = member(tenantUnknownStorage);
    const unknown = await recordUnknown(ctx, { question: 'q', consequence: 'c' });

    await expect(
      getDb().query(`DELETE FROM unknowns WHERE id = $1`, [unknown.id]),
    ).rejects.toThrow(/unknowns are retained/);
    await expect(getDb().query(`TRUNCATE TABLE unknowns`)).rejects.toThrow(/unknowns are retained/);
    await expect(
      getDb().query(`UPDATE unknowns SET question = 'rewritten' WHERE id = $1`, [unknown.id]),
    ).rejects.toThrow(/illegal transition/);
    const survivor = await getUnknown(ctx, { unknownId: unknown.id });
    expect(survivor.question).toBe('q');
  });
});

// ---------------------------------------------------------------------------
// Beliefs
// ---------------------------------------------------------------------------

describe('beliefs — versioned current working understanding', () => {
  it('forms a belief: anchor plus version 1 with provenance and a full statement', async () => {
    const ctx = member(tenantBeliefForm);
    const evidenceA = await seedObservation(ctx, T0);
    const evidenceB = await seedObservation(ctx, T0_PLUS(60));
    const claim = await recordClaim(ctx, claimInput([evidenceA.id]));
    const subjectId = newId();

    const before = new Date();
    const belief = await formBelief(ctx, {
      proposition: 'supplier Acme is reliable',
      confidence: { value: 0.7, method: 'evidence_weighing', basis: 'four on-time deliveries' },
      supportingObservationIds: [evidenceB.id, evidenceA.id, evidenceB.id],
      supportingClaimIds: [claim.id],
      alternatives: ['the good deliveries were cherry-picked'],
      disconfirmation: 'a late delivery observed after this quarter',
      subject: { kind: 'world.entity', id: subjectId },
      validFrom: T0,
      rationale: 'initial weighing',
    });
    const after = new Date();

    // anchor
    expect(belief.tenantId).toBe(tenantBeliefForm);
    expect(belief.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(belief.subject).toEqual({ kind: 'world.entity', id: subjectId });
    expect(belief.status).toBe('active');
    expect(belief.retireReason).toBeNull();
    expect(belief.retiredAt).toBeNull();
    expect(Date.parse(belief.createdAt)).toBeGreaterThanOrEqual(before.getTime());
    expect(Date.parse(belief.createdAt)).toBeLessThanOrEqual(after.getTime());
    // version 1
    expect(belief.version).toBe(1);
    expect(belief.current).toBe(true);
    expect(belief.validFrom).toBe(T0);
    expect(belief.validTo).toBeNull();
    expect(belief.rationale).toBe('initial weighing');
    expect(belief.provenance.observationIds).toEqual([evidenceA.id, evidenceB.id].sort());
    // statement (§11: evidence, uncertainty, alternatives, disconfirmation)
    expect(belief.statement).toEqual({
      proposition: 'supplier Acme is reliable',
      confidence: {
        value: 0.7,
        method: 'evidence_weighing',
        basis: 'four on-time deliveries',
      },
      alternatives: ['the good deliveries were cherry-picked'],
      disconfirmation: 'a late delivery observed after this quarter',
      supportingClaimIds: [claim.id],
    });

    // unreadable evidence is rejected before anything is written
    await expect(formBelief(ctx, { ...beliefInput([newId()], T0) })).rejects.toMatchObject({
      code: 'invalid_evidence',
    });
    await expect(
      formBelief(ctx, { ...beliefInput([evidenceA.id], T0), supportingClaimIds: [newId()] }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
    // a failed formation leaves no phantom belief behind
    expect(await listBeliefs(ctx, {})).toHaveLength(1);
  });

  it('revises by appending: version 2 supersedes, version 1 is retained untouched', async () => {
    const ctx = member(tenantBeliefRevise);
    const evidence1 = await seedObservation(ctx, T0);
    const evidence2 = await seedObservation(ctx, T0_PLUS(1800));
    const claim1 = await recordClaim(ctx, claimInput([evidence1.id]));
    const claim2 = await recordClaim(ctx, claimInput([evidence2.id]));

    const v1 = await formBelief(ctx, {
      ...beliefInput([evidence1.id], T0),
      supportingClaimIds: [claim1.id],
    });
    const v2 = await reviseBelief(ctx, {
      beliefId: v1.id,
      proposition: 'supplier Acme is unreliable',
      confidence: { value: 0.65, method: 'evidence_weighing' },
      supportingObservationIds: [evidence2.id],
      supportingClaimIds: [claim2.id],
      alternatives: [],
      disconfirmation: null,
      validFrom: T0_PLUS(3600),
      rationale: 'a late delivery contradicted the prior understanding',
    });

    expect(v2.version).toBe(2);
    expect(v2.current).toBe(true);
    expect(v2.statement.proposition).toBe('supplier Acme is unreliable');
    expect(v2.statement.alternatives).toEqual([]);
    expect(v2.statement.disconfirmation).toBeNull();
    expect(v2.provenance.observationIds).toEqual([evidence2.id]);

    const history = await listBeliefHistory(ctx, { beliefId: v1.id });
    expect(history.map((version) => version.version)).toEqual([1, 2]);
    // derived intervals
    expect(history[0]!.validTo).toBe(T0_PLUS(3600));
    expect(history[1]!.validTo).toBeNull();
    expect(history.map((version) => version.current)).toEqual([false, true]);
    // v1 is retained UNTOUCHED: its evidence, its claims, its statement
    expect(history[0]!.provenance.observationIds).toEqual([evidence1.id]);
    expect(history[0]!.statement.supportingClaimIds).toEqual([claim1.id]);
    expect(history[0]!.statement.proposition).toBe('supplier Acme is reliable');
    expect(history[0]!.statement.alternatives).toEqual(['the good deliveries were cherry-picked']);
  });

  it('resolves the version valid at an asOf instant (what did we believe as of <t>)', async () => {
    const ctx = member(tenantBeliefAsOf);
    const evidence = await seedObservation(ctx, T0);
    const belief = await formBelief(ctx, beliefInput([evidence.id], T0));
    await reviseBelief(ctx, {
      ...beliefInput([evidence.id], T0_PLUS(7200)),
      beliefId: belief.id,
    });

    // before the first version: nothing valid yet
    await expect(
      getBelief(ctx, { beliefId: belief.id, asOf: T0_PLUS(-1) }),
    ).rejects.toMatchObject({ code: 'belief_version_not_found' });
    // exactly at validFrom: inclusive
    const atStart = await getBelief(ctx, { beliefId: belief.id, asOf: T0 });
    expect(atStart.version).toBe(1);
    expect(atStart.validTo).toBe(T0_PLUS(7200));
    expect(atStart.current).toBe(false);
    // between: v1; after: v2; default (now): v2
    expect((await getBelief(ctx, { beliefId: belief.id, asOf: T0_PLUS(3600) })).version).toBe(1);
    expect((await getBelief(ctx, { beliefId: belief.id, asOf: T0_PLUS(86_400) })).version).toBe(2);
    expect((await getBelief(ctx, { beliefId: belief.id })).version).toBe(2);

    await expect(getBelief(ctx, { beliefId: newId() })).rejects.toMatchObject({
      code: 'belief_not_found',
    });
  });

  it('enforces the strictly increasing valid-time chain on revisions', async () => {
    const ctx = member(tenantBeliefChain);
    const evidence = await seedObservation(ctx, T0);
    const belief = await formBelief(ctx, beliefInput([evidence.id], T0_PLUS(3600)));

    // equal validFrom
    await expect(
      reviseBelief(ctx, { ...beliefInput([evidence.id], T0_PLUS(3600)), beliefId: belief.id }),
    ).rejects.toMatchObject({ code: 'invalid_belief_input' });
    // back-dated validFrom
    await expect(
      reviseBelief(ctx, { ...beliefInput([evidence.id], T0), beliefId: belief.id }),
    ).rejects.toMatchObject({ code: 'invalid_belief_input' });

    const history = await listBeliefHistory(ctx, { beliefId: belief.id });
    expect(history).toHaveLength(1); // nothing was appended
  });

  it('retires beliefs one-way; retired beliefs keep their history but accept no revisions', async () => {
    const ctx = member(tenantBeliefRetire);
    const evidence = await seedObservation(ctx, T0);
    const belief = await formBelief(ctx, beliefInput([evidence.id], T0));

    const retired = await retireBelief(ctx, {
      beliefId: belief.id,
      rationale: 'the supplier relationship ended; the topic is no longer tracked',
    });
    expect(retired.status).toBe('retired');
    expect(retired.retireReason).toBe(
      'the supplier relationship ended; the topic is no longer tracked',
    );
    expect(retired.retiredAt).not.toBeNull();

    // one-way
    await expect(
      retireBelief(ctx, { beliefId: belief.id, rationale: 'again' }),
    ).rejects.toMatchObject({ code: 'belief_retired' });
    // no revisions on a retired belief
    await expect(
      reviseBelief(ctx, { ...beliefInput([evidence.id], T0_PLUS(3600)), beliefId: belief.id }),
    ).rejects.toMatchObject({ code: 'belief_retired' });
    // history and last statement remain readable
    const read = await getBelief(ctx, { beliefId: belief.id });
    expect(read.status).toBe('retired');
    expect(read.version).toBe(1);
    expect(await listBeliefHistory(ctx, { beliefId: belief.id })).toHaveLength(1);

    // lifecycle guards at the storage layer
    await expect(
      getDb().query(`DELETE FROM beliefs WHERE id = $1`, [belief.id]),
    ).rejects.toThrow(/belief anchors are retained/);
    await expect(getDb().query(`TRUNCATE TABLE beliefs`)).rejects.toThrow(
      /belief anchors are retained/,
    );
    // a retired anchor is terminal
    await expect(
      getDb().query(`UPDATE beliefs SET status = 'active' WHERE id = $1`, [belief.id]),
    ).rejects.toThrow(/terminal/);
    // an active anchor's identity is frozen (only retirement may change it)
    const fresh = await formBelief(ctx, beliefInput([evidence.id], T0_PLUS(5400)));
    await expect(
      getDb().query(`UPDATE beliefs SET subject_kind = 'other' WHERE id = $1`, [fresh.id]),
    ).rejects.toThrow(/illegal transition/);
  });

  it('lists belief anchors with filters (statements resolve via getBelief)', async () => {
    const ctx = member(tenantBeliefList);
    const evidence = await seedObservation(ctx, T0_PLUS(840));
    const subjectId = newId();

    const target = await formBelief(ctx, {
      ...beliefInput([evidence.id], T0_PLUS(840)),
      subject: { kind: 'world.entity', id: subjectId },
    });
    const other = await formBelief(ctx, beliefInput([evidence.id], T0_PLUS(841)));
    await retireBelief(ctx, { beliefId: other.id, rationale: 'moot' });

    const bySubject = await listBeliefs(ctx, { subjectKind: 'world.entity', subjectId });
    expect(bySubject.map((anchor) => anchor.id)).toEqual([target.id]);
    const active = await listBeliefs(ctx, { status: 'active' });
    expect(active.map((anchor) => anchor.id)).toEqual([target.id]);
    const retired = await listBeliefs(ctx, { status: 'retired' });
    expect(retired.map((anchor) => anchor.id)).toEqual([other.id]);

    // anchors list without statements — the statement resolves on read
    expect(active[0]!).not.toHaveProperty('statement');
    expect(active[0]!).not.toHaveProperty('provenance');
  });
});

// ---------------------------------------------------------------------------
// THE W007 ACCEPTANCE — conflicting evidence is retained
// ---------------------------------------------------------------------------

describe('W007 acceptance: conflicting evidence is retained (lock 12)', () => {
  it('keeps every piece of conflicting evidence, both claims, the contradiction and the belief history', async () => {
    const ctx = member(tenantAcceptance);

    // 1. Two sources deliver CONFLICTING evidence about the same delivery.
    const obsFast = await recordObservation(ctx, {
      kind: 'document.note',
      payload: { note: 'delivery report', days: 5 },
      observedAt: T0,
      source: { kind: 'person', label: 'office-manager' },
      channel: 'ingestion',
      confidence: { value: 0.9, method: 'source_trust' },
    });
    const obsSlow = await recordObservation(ctx, {
      kind: 'document.note',
      payload: { note: 'carrier manifest', days: 15 },
      observedAt: T0_PLUS(3600),
      source: { kind: 'source', label: 'carrier-portal' },
      channel: 'connector',
      confidence: { value: 0.95, method: 'source_trust' },
    });

    // 2. One claim is derived from each side of the evidence.
    const claimFast = await recordClaim(ctx, {
      proposition: 'supplier Acme delivers within five business days',
      subject: { kind: 'world.entity', id: newId() },
      confidence: { value: 0.8, method: 'evidence_weighing' },
      evidenceObservationIds: [obsFast.id],
      rationale: 'derived from the office manager report',
    });
    const claimSlow = await recordClaim(ctx, {
      proposition: 'supplier Acme delivers within fifteen business days',
      subject: { kind: 'world.entity', id: newId() },
      confidence: { value: 0.85, method: 'evidence_weighing' },
      evidenceObservationIds: [obsSlow.id],
      rationale: 'derived from the carrier manifest',
    });

    // 3. The conflict becomes a first-class, RETAINED contradiction.
    const contradiction = await registerContradiction(ctx, {
      left: { kind: 'claim', id: claimFast.id },
      right: { kind: 'claim', id: claimSlow.id },
      note: 'the two derivations disagree on delivery time',
    });
    expect(contradiction.status).toBe('open');

    // 4. A belief is formed that weighs BOTH sides and cites BOTH claims,
    //    exposing alternatives (§11) instead of silently merging.
    const belief = await formBelief(ctx, {
      proposition: 'supplier Acme delivery time is uncertain (5 vs 15 days)',
      confidence: { value: 0.4, method: 'evidence_weighing', basis: 'conflicting sources' },
      supportingObservationIds: [obsFast.id, obsSlow.id],
      supportingClaimIds: [claimFast.id, claimSlow.id],
      alternatives: [
        'the office manager report is outdated',
        'the carrier manifest covers a different shipment',
      ],
      disconfirmation: 'a carrier manifest that agrees with the office manager report',
      validFrom: T0_PLUS(7200),
      rationale: 'both sides retained pending resolution',
    });

    // Everything is retrievable BEFORE resolution.
    expect((await observationsContract.getObservation(ctx, obsFast.id)).id).toBe(obsFast.id);
    expect((await observationsContract.getObservation(ctx, obsSlow.id)).id).toBe(obsSlow.id);
    expect((await getClaim(ctx, { claimId: claimFast.id })).evidenceObservationIds).toEqual([
      obsFast.id,
    ]);
    expect((await getClaim(ctx, { claimId: claimSlow.id })).evidenceObservationIds).toEqual([
      obsSlow.id,
    ]);
    expect((await getContradiction(ctx, { contradictionId: contradiction.id })).status).toBe(
      'open',
    );
    expect(belief.provenance.observationIds).toEqual([obsFast.id, obsSlow.id].sort());
    expect(belief.statement.supportingClaimIds).toEqual([claimFast.id, claimSlow.id].sort());

    // 5. New evidence arrives and the conflict is RESOLVED...
    const obsSlowConfirm = await recordObservation(ctx, {
      kind: 'document.note',
      payload: { note: 'revised delivery report', days: 15 },
      observedAt: T0_PLUS(86_400),
      source: { kind: 'person', label: 'office-manager' },
      channel: 'ingestion',
      confidence: { value: 0.9, method: 'source_trust' },
    });
    const claimSlowConfirm = await recordClaim(ctx, {
      proposition: 'the office manager revised the estimate to fifteen days',
      confidence: { value: 0.9, method: 'evidence_weighing' },
      evidenceObservationIds: [obsSlowConfirm.id],
    });
    const resolvedContradiction = await resolveContradiction(ctx, {
      contradictionId: contradiction.id,
      resolvedBy: { kind: 'claim', id: claimSlowConfirm.id },
      note: 'the revised report favors the fifteen-day estimate',
    });
    // ...and the belief is revised to weigh the newer evidence.
    const revisedBelief = await reviseBelief(ctx, {
      beliefId: belief.id,
      proposition: 'supplier Acme delivers within fifteen business days',
      confidence: { value: 0.8, method: 'evidence_weighing', basis: 'revised report' },
      supportingObservationIds: [obsSlow.id, obsSlowConfirm.id],
      supportingClaimIds: [claimSlow.id, claimSlowConfirm.id],
      alternatives: ['the revision is itself wrong'],
      disconfirmation: 'a subsequent on-time five-day delivery',
      validFrom: T0_PLUS(90_000),
      rationale: 'resolved in favor of the carrier manifest and revised report',
    });
    expect(revisedBelief.version).toBe(2);

    // 6. THE VERIFICATION: nothing was merged away or deleted.
    //    Both conflicting observations remain readable evidence.
    expect((await observationsContract.getObservation(ctx, obsFast.id)).payload).toEqual({
      note: 'delivery report',
      days: 5,
    });
    expect((await observationsContract.getObservation(ctx, obsSlow.id)).payload).toEqual({
      note: 'carrier manifest',
      days: 15,
    });
    //    Both claims remain, each with its original evidence link.
    const fastAfter = await getClaim(ctx, { claimId: claimFast.id });
    const slowAfter = await getClaim(ctx, { claimId: claimSlow.id });
    expect(fastAfter.proposition).toContain('five business days');
    expect(fastAfter.evidenceObservationIds).toEqual([obsFast.id]);
    expect(slowAfter.evidenceObservationIds).toEqual([obsSlow.id]);
    expect(
      (await listClaims(ctx, { evidenceObservationId: obsFast.id })).map((claim) => claim.id),
    ).toContain(claimFast.id);
    //    The contradiction record is retained with its resolution annotation —
    //    the evidence pair, note and detection time are untouched.
    expect(resolvedContradiction.evidenceA).toEqual(contradiction.evidenceA);
    expect(resolvedContradiction.evidenceB).toEqual(contradiction.evidenceB);
    expect(resolvedContradiction.note).toBe(contradiction.note);
    expect(resolvedContradiction.detectedAt).toBe(contradiction.detectedAt);
    expect((await listContradictions(ctx, { status: 'resolved' })).map((row) => row.id)).toEqual([
      contradiction.id,
    ]);
    //    And the belief's OWN version history still carries the conflict:
    //    version 1 kept both claims and both observations it weighed.
    const history = await listBeliefHistory(ctx, { beliefId: belief.id });
    expect(history.map((version) => version.version)).toEqual([1, 2]);
    expect(history[0]!.statement.proposition).toContain('uncertain');
    expect(history[0]!.statement.supportingClaimIds).toEqual([claimFast.id, claimSlow.id].sort());
    expect(history[0]!.provenance.observationIds).toEqual([obsFast.id, obsSlow.id].sort());
    expect(history[0]!.current).toBe(false);
    expect(history[1]!.current).toBe(true);

    // 7. Storage-level: even a caller bypassing the service cannot erase the
    //    conflict — claims and contradictions reject mutation outright.
    await expect(
      getDb().query(`DELETE FROM claims WHERE id = $1`, [claimFast.id]),
    ).rejects.toThrow(/claims are immutable/);
    await expect(
      getDb().query(`UPDATE claims SET proposition = 'merged away' WHERE id = $1`, [
        claimSlow.id,
      ]),
    ).rejects.toThrow(/claims are immutable/);
    await expect(
      getDb().query(`DELETE FROM contradictions WHERE id = $1`, [contradiction.id]),
    ).rejects.toThrow(/contradictions are retained/);
  });
});

// ---------------------------------------------------------------------------
// Freshness wiring (W006 machinery — lock 11: beliefs carry freshness metadata)
// ---------------------------------------------------------------------------

describe('beliefs are versioned through the freshness machinery (lock 11)', () => {
  it('exposes belief versions as temporal revisions under subject kind epistemics.belief', async () => {
    const ctx = member(tenantFreshness);
    const evidence = await seedObservation(ctx, T0);
    const belief = await formBelief(ctx, beliefInput([evidence.id], T0));
    await reviseBelief(ctx, { ...beliefInput([evidence.id], T0_PLUS(3600)), beliefId: belief.id });

    // the freshness module's own contract sees the belief's versions
    const revisions = await listTemporalHistory(ctx, {
      subjectKind: 'epistemics.belief',
      subjectId: belief.id,
    });
    expect(revisions.map((revision) => revision.version)).toEqual([1, 2]);
    // the statement travels as the revision state; the evidence as provenance
    expect(revisions[0]!.provenance.observationIds).toEqual([evidence.id]);
    expect((revisions[0]!.state as { proposition: string }).proposition).toBe(
      'supplier Acme is reliable',
    );

    // and the freshness module's own evaluation resolves the same subject
    const evaluated = await evaluateTemporalStateFreshness(ctx, {
      subjectKind: 'epistemics.belief',
      subjectId: belief.id,
    });
    expect(evaluated.revision.version).toBe(2);
  });

  it('evaluates belief freshness against tenant stale-after policies keyed by epistemics.belief', async () => {
    const ctx = member(tenantFreshness);
    const staleEvidence = await seedObservation(ctx, T0); // yesterday
    const belief = await formBelief(ctx, beliefInput([staleEvidence.id], T0));

    // no policy → unknown
    const unknown = await evaluateBeliefFreshness(ctx, { beliefId: belief.id });
    expect(unknown.status).toBe('unknown');
    expect(unknown.policy).toBeNull();
    expect(unknown.evidenceObservedAt).toBe(T0);
    expect(unknown.supportingObservations).toBe(1);

    // a kind-wide belief policy classifies the same belief as stale (the
    // evidence is a day old; the policy allows an hour)
    await setFreshnessPolicy(ctx, {
      subjectKind: 'epistemics.belief',
      staleAfterSeconds: 3600,
      agingAfterSeconds: 600,
    });
    const stale = await evaluateBeliefFreshness(ctx, { beliefId: belief.id });
    expect(stale.status).toBe('stale');
    expect(stale.policy?.staleAfterSeconds).toBe(3600);
    expect(stale.revision.version).toBe(1);

    // a generous policy classifies it as current
    await setFreshnessPolicy(ctx, {
      subjectKind: 'epistemics.belief',
      staleAfterSeconds: 2_592_000, // 30 days
    });
    const current = await evaluateBeliefFreshness(ctx, { beliefId: belief.id });
    expect(current.status).toBe('current');

    // evaluation surface errors mirror getBelief's
    await expect(
      evaluateBeliefFreshness(ctx, { beliefId: newId() }),
    ).rejects.toMatchObject({ code: 'belief_not_found' });
    await expect(
      evaluateBeliefFreshness(ctx, { beliefId: belief.id, asOf: T0_PLUS(-1) }),
    ).rejects.toMatchObject({ code: 'belief_version_not_found' });
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (ADR-0001)
// ---------------------------------------------------------------------------

describe('tenant isolation across every epistemic surface (ADR-0001)', () => {
  it('another tenant sees nothing: uniform not-found, no existence leaks', async () => {
    const ctxA = member(tenantA);
    const ctxB = member(tenantB);

    // tenant A builds one of everything
    const evidenceA = await seedObservation(ctxA, T0);
    const claimA = await recordClaim(ctxA, claimInput([evidenceA.id]));
    const claimA2 = await recordClaim(ctxA, claimInput([evidenceA.id]));
    const contradictionA = await registerContradiction(ctxA, {
      left: { kind: 'claim', id: claimA.id },
      right: { kind: 'claim', id: claimA2.id },
      note: 'conflict inside tenant A',
    });
    const hypothesisA = await recordHypothesis(ctxA, { proposition: 'tenant A hypothesis' });
    const beliefA = await formBelief(ctxA, beliefInput([evidenceA.id], T0));
    const unknownA = await recordUnknown(ctxA, {
      question: 'tenant A question?',
      consequence: 'tenant A consequence',
    });

    // tenant B: reads are uniformly not-found
    await expect(getClaim(ctxB, { claimId: claimA.id })).rejects.toMatchObject({
      code: 'claim_not_found',
    });
    await expect(
      getContradiction(ctxB, { contradictionId: contradictionA.id }),
    ).rejects.toMatchObject({ code: 'contradiction_not_found' });
    await expect(getHypothesis(ctxB, { hypothesisId: hypothesisA.id })).rejects.toMatchObject({
      code: 'hypothesis_not_found',
    });
    await expect(getUnknown(ctxB, { unknownId: unknownA.id })).rejects.toMatchObject({
      code: 'unknown_not_found',
    });
    await expect(getBelief(ctxB, { beliefId: beliefA.id })).rejects.toMatchObject({
      code: 'belief_not_found',
    });

    // lists are empty
    expect(await listClaims(ctxB, {})).toEqual([]);
    expect(await listContradictions(ctxB, {})).toEqual([]);
    expect(await listHypotheses(ctxB, {})).toEqual([]);
    expect(await listUnknowns(ctxB, {})).toEqual([]);
    expect(await listBeliefs(ctxB, {})).toEqual([]);

    // writes cannot reach across: tenant B cannot build on tenant A's records
    await expect(recordClaim(ctxB, claimInput([evidenceA.id]))).rejects.toMatchObject({
      code: 'invalid_evidence',
    });
    await expect(
      registerContradiction(ctxB, {
        left: { kind: 'claim', id: claimA.id },
        right: { kind: 'observation', id: evidenceA.id },
        note: 'cross-tenant conflict',
      }),
    ).rejects.toMatchObject({ code: 'invalid_evidence' });
    await expect(
      resolveContradiction(ctxB, { contradictionId: contradictionA.id, note: 'x' }),
    ).rejects.toMatchObject({ code: 'contradiction_not_found' });
    await expect(
      resolveHypothesis(ctxB, { hypothesisId: hypothesisA.id, outcome: 'confirmed', note: 'x' }),
    ).rejects.toMatchObject({ code: 'hypothesis_not_found' });
    await expect(
      resolveUnknown(ctxB, { unknownId: unknownA.id, note: 'x' }),
    ).rejects.toMatchObject({ code: 'unknown_not_found' });
    await expect(
      reviseBelief(ctxB, { ...beliefInput([evidenceA.id], T0_PLUS(3600)), beliefId: beliefA.id }),
    ).rejects.toMatchObject({ code: 'belief_not_found' });
    await expect(retireBelief(ctxB, { beliefId: beliefA.id, rationale: 'x' })).rejects.toMatchObject(
      { code: 'belief_not_found' },
    );
    await expect(listBeliefHistory(ctxB, { beliefId: beliefA.id })).rejects.toMatchObject({
      code: 'belief_not_found',
    });

    // identical inputs produce independent records per tenant
    const evidenceB = await seedObservation(ctxB, T0);
    const claimB = await recordClaim(ctxB, claimInput([evidenceB.id]));
    expect(claimB.id).not.toBe(claimA.id);
    expect(claimB.tenantId).toBe(tenantB);
    const byEvidenceB = await listClaims(ctxB, { evidenceObservationId: evidenceB.id });
    expect(byEvidenceB.map((claim) => claim.id)).toEqual([claimB.id]);
    // tenant A still sees only its own claims
    expect(
      (await listClaims(ctxA, { evidenceObservationId: evidenceA.id }))
        .map((claim) => claim.id)
        .sort(),
    ).toEqual([claimA.id, claimA2.id].sort());
  });
});
