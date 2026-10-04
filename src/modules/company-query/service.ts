// Company query plane (W126) — the query pipeline (spec §6, all ten steps).
//
//   1.  resolve tenant and principal context          (explicit TenantContext — asserted, never ambient)
//   2.  determine the requested company scope        (validation: question + surface filter)
//   3.  retrieve canonical records through contracts (world / epistemics / memory / observations /
//                                                     sources / channels / freshness / goals)
//   4.  consider coverage for the requested scope    (conservative query-side derivation until W125)
//   5.  distinguish observed facts / derived beliefs / hypotheses / unknowns
//   6.  attach provenance and freshness to material claims
//   7.  identify material coverage gaps
//   8.  preserve uncertainty and contradictions
//   9.  produce language through the LLM Gateway when needed (presentation only)
//   10. never allow LLM output to become authoritative (by construction; test-locked)
//
// COMPOSITION DISCIPLINE: every read goes through a module CONTRACT
// (lock 31/32/34 — the architecture gate enforces it). Nothing here parses
// a provider object, touches a provider adapter or reads a domain table of
// another module directly. The only persistence this module owns is its
// append-only query audit (migrations/001) — a log of WHAT was asked and
// how strong the answer was, never answer content as domain truth.
//
// LLM (steps 9/10): the gateway invocation is optional-by-design — when
// the tenant has no wired AI account/transport, or the invocation fails,
// the answer is served fully structured with `llm.used === false`. The
// generated text re-renders the ALREADY-assembled answer; it is stored
// nowhere and feeds no domain record (lock 10). The prompt passes the
// deterministic summary + claim texts ONLY, and instructs the model not to
// introduce facts — and even if it did, nothing downstream treats the text
// as anything but presentation.

import { now } from '@/infra/clock';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { getDb } from '@/infra/db';

import {
  classifyFreshness,
  evidenceAgeSeconds,
  resolveFreshnessPolicy,
} from '@/modules/freshness/contract';
import type { FreshnessThresholds } from '@/modules/freshness/contract';
import { listObservations } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { listSources } from '@/modules/sources/contract';
import { listChannelConnections } from '@/modules/channels/contract';
import {
  getBelief,
  listBeliefs,
  listClaims,
  listContradictions,
  listHypotheses,
  listUnknowns,
} from '@/modules/epistemics/contract';
import type { Belief } from '@/modules/epistemics/contract';
import { listEntities } from '@/modules/world/contract';
import { listGoals } from '@/modules/goals/contract';
import { listKnowledgeEntries } from '@/modules/memory/contract';
import type { KnowledgeEntry } from '@/modules/memory/contract';
import { invokeLlm } from '@/modules/llm/contract';
import type { LlmExecution } from '@/modules/llm/contract';

import { CompanyQueryError } from './errors';
import {
  assertCompanyQueryTenantContext,
  validateCompanyQueryInput,
} from './validation';
import type { ValidatedCompanyQueryInput } from './validation';
import {
  DEFAULT_EVIDENCE_THRESHOLDS,
  answerCoverageQuestion,
  composeDeterministicSummary,
  deriveCaveats,
  deriveMaterialGaps,
  deriveSurfaceCoverage,
  surfacesForObservationKind,
} from './coverage';
import type { CoverageSourceCandidate } from './coverage';
import type {
  CompanyClaimProvenance,
  CompanyQueryClaim,
  CompanyQueryContradiction,
  CompanyQueryCoverageContext,
  CompanyQueryInput,
  CompanyQueryLlmPresentation,
  CompanyQueryResponse,
  CompanyQueryUnknown,
  CompanySurface,
} from './types';
import { COMPANY_SURFACES } from './types';

/** How many observations feed the evidence census (bounded window, honest counts). */
const EVIDENCE_WINDOW_LIMIT = 200;
/** Per-source latest-evidence probe depth (enough to pick the newest OBSERVED, not just the newest recorded). */
const PER_SOURCE_PROBE_LIMIT = 5;
/** How many contract-listed records compose the answer (the same caps the tower applies). */
const LIST_LIMIT = 100;

// ---------------------------------------------------------------------------
// Step 1 + 2 — context and scope
// ---------------------------------------------------------------------------

export async function runCompanyQuery(
  context: TenantContext,
  input: CompanyQueryInput,
): Promise<CompanyQueryResponse> {
  assertCompanyQueryTenantContext(context); // step 1
  const valid: ValidatedCompanyQueryInput = validateCompanyQueryInput(input); // step 2
  const asOfDate = now();
  const asOf = asOfDate.toISOString();

  // -------------------------------------------------------------------------
  // Step 3 — retrieve canonical records through module contracts.
  // Every read below is tenant-scoped by the owning module's SQL layer.
  // -------------------------------------------------------------------------
  const retrieval = await retrieveThroughContracts(context);
  const evidence = censusFromObservations(retrieval.observations, valid.surfaces);

  // -------------------------------------------------------------------------
  // Step 4 — consider coverage for the requested scope (conservative,
  // query-side derivation; the freshness policy resolves through the
  // freshness contract, falling back to the query-side default).
  // -------------------------------------------------------------------------
  const thresholds = await evidenceThresholds(context);
  const surfaceSummaries = deriveSurfaceCoverage({
    surfaces: valid.surfaces,
    sources: retrieval.coverageSources,
    evidence,
    asOf,
    thresholds,
  });

  // -------------------------------------------------------------------------
  // Steps 5 + 6 — claims with epistemic class, provenance and freshness.
  // -------------------------------------------------------------------------
  const claims = assembleClaims(retrieval, asOf, thresholds, valid.surfaces);

  // -------------------------------------------------------------------------
  // Step 8 — contradictions and unknowns stay visible (never merged).
  // -------------------------------------------------------------------------
  const contradictions = assembleContradictions(retrieval, asOf, thresholds);
  const unknowns = assembleUnknowns(retrieval);

  // -------------------------------------------------------------------------
  // Step 7 — material coverage gaps + caveats + §7 honesty answer.
  // -------------------------------------------------------------------------
  const materialGaps = deriveMaterialGaps(valid.question, surfaceSummaries);
  const caveats = deriveCaveats(surfaceSummaries);
  const honesty = answerCoverageQuestion(valid.question, surfaceSummaries);

  const coveredSurfaces = surfaceSummaries.filter((summary) => summary.state === 'covered').length;
  const summary = composeDeterministicSummary({
    question: valid.question,
    scopeSurfaces: valid.surfaces,
    observationCount: evidence.total,
    claimCount: claims.filter((claim) => claim.kind === 'observed-fact').length,
    beliefCount: claims.filter((claim) => claim.kind === 'derived-belief').length,
    openContradictionCount: contradictions.filter((entry) => entry.status === 'open').length,
    openUnknownCount: unknowns.filter((entry) => entry.status === 'open').length,
    coveredSurfaces,
    scopeSize: valid.surfaces.length,
    worldEntityCount: retrieval.entityCount,
    worldEntityKindCount: retrieval.entityKindCount,
    activeGoalCount: retrieval.activeGoalCount,
  });

  // -------------------------------------------------------------------------
  // Step 9 — language through the LLM Gateway, when a tenant model is
  // wired. Presentation only (step 10 is enforced by construction: the
  // text is stored NOWHERE and feeds no domain record).
  // -------------------------------------------------------------------------
  const llm = await renderPresentationLayer(
    context,
    valid.question,
    summary,
    claims,
    materialGaps.map((gap) => gap.why),
  );

  const coverageContext: CompanyQueryCoverageContext = {
    surfaces: surfaceSummaries,
    caveats,
    materialGaps,
    honesty,
    derivation: 'query-side-conservative',
  };

  // The append-only audit row (governance: what was asked, how strong the
  // answer was — never answer content as domain truth).
  await appendQueryAudit(context, {
    question: valid.question,
    surfaces: valid.surfaces,
    generatedAt: asOf,
    claimCount: claims.length,
    contradictionCount: contradictions.length,
    unknownCount: unknowns.length,
    materialGapCount: materialGaps.length,
    llmUsed: llm.used,
  });

  return {
    generatedAt: asOf,
    answer: {
      question: valid.question,
      scopeSurfaces: valid.surfaces,
      summary,
      claims,
      contradictions,
      unknowns,
      llm,
    },
    coverageContext,
  };
}

// ---------------------------------------------------------------------------
// Step 3 helpers — contract reads
// ---------------------------------------------------------------------------

interface ContractRetrieval {
  observations: Observation[];
  coverageSources: CoverageSourceCandidate[];
  claims: Awaited<ReturnType<typeof listClaims>>;
  beliefs: Belief[];
  hypotheses: Awaited<ReturnType<typeof listHypotheses>>;
  contradictions: Awaited<ReturnType<typeof listContradictions>>;
  unknowns: Awaited<ReturnType<typeof listUnknowns>>;
  knowledge: KnowledgeEntry[];
  entityCount: number;
  entityKindCount: number;
  activeGoalCount: number;
  goalEvidenceLabels: string[];
}

async function retrieveThroughContracts(context: TenantContext): Promise<ContractRetrieval> {
  try {
    const [sources, channelConnections, observations, claims, beliefAnchors, hypotheses, contradictions, unknowns, entities, goals, knowledge] =
      await Promise.all([
        listSources(context, { limit: 500 }),
        listChannelConnections(context, { limit: 500 }),
        listObservations(context, { limit: EVIDENCE_WINDOW_LIMIT }),
        listClaims(context, { limit: LIST_LIMIT }),
        listBeliefs(context, { status: 'active', limit: LIST_LIMIT }),
        listHypotheses(context, { limit: LIST_LIMIT }),
        listContradictions(context, { limit: LIST_LIMIT }),
        listUnknowns(context, { limit: LIST_LIMIT }),
        listEntities(context, { limit: 500 }),
        listGoals(context, { limit: LIST_LIMIT }),
        listKnowledgeEntries(context, { limit: LIST_LIMIT }),
      ]);

    // Per-source newest evidence (§7: coverage claims come from evidence,
    // not configuration). Bounded probe per registered source; "newest"
    // is by OBSERVED time (the source's clock — the freshness module's
    // discipline), not ingestion order.
    const latestBySource = new Map<string, Observation>();
    const noteLatest = (sourceId: string, seen: Observation[]): void => {
      const current = latestBySource.get(sourceId) ?? null;
      const newest = seen.reduce<Observation | null>((best, observation) => {
        if (best === null) return observation;
        return observation.observedAt > best.observedAt ? observation : best;
      }, current);
      if (newest !== null) latestBySource.set(sourceId, newest);
    };
    for (const source of sources) {
      noteLatest(
        source.id,
        await listObservations(context, {
          sourceKind: 'source',
          sourceId: source.id,
          limit: PER_SOURCE_PROBE_LIMIT,
        }),
      );
    }
    for (const connection of channelConnections) {
      noteLatest(
        connection.id,
        await listObservations(context, {
          sourceKind: 'source',
          sourceId: connection.id,
          limit: PER_SOURCE_PROBE_LIMIT,
        }),
      );
    }

    const coverageSources: CoverageSourceCandidate[] = [
      ...sources.map((source) => ({
        sourceId: source.id,
        sourceModule: 'source' as const,
        provider: source.provider,
        displayName: source.displayName,
        status: source.status,
        latestObservation: latestBySource.get(source.id) ?? null,
        oauthExpiresAt: source.oauthExpiresAt,
      })),
      ...channelConnections.map((connection) => ({
        sourceId: connection.id,
        sourceModule: 'channel' as const,
        provider: connection.provider,
        displayName: connection.displayName,
        status: connection.status,
        latestObservation: latestBySource.get(connection.id) ?? null,
        oauthExpiresAt: null,
      })),
    ];

    // Resolve the ACTIVE beliefs' current statements (listBeliefs returns
    // anchors; getBelief resolves the version valid now — the epistemics
    // contract's own read path, bounded to the listed anchors).
    const beliefs: Belief[] = [];
    for (const anchor of beliefAnchors) {
      if (anchor.status !== 'active') continue;
      beliefs.push(await getBelief(context, { beliefId: anchor.id }));
    }

    const entityKinds = new Set(entities.map((entity) => entity.kind));
    const activeGoals = goals.filter((goal) => goal.content.status === 'active');
    const goalEvidenceLabels = activeGoals.flatMap((goal) =>
      goal.content.evidenceSources
        .filter((source) => source.label !== null && source.label !== undefined)
        .map((source) => source.label as string),
    );

    return {
      observations,
      coverageSources,
      claims,
      beliefs,
      hypotheses,
      contradictions,
      unknowns,
      knowledge,
      entityCount: entities.length,
      entityKindCount: entityKinds.size,
      activeGoalCount: activeGoals.length,
      goalEvidenceLabels,
    };
  } catch (error) {
    if (error instanceof CompanyQueryError) throw error;
    throw new CompanyQueryError(
      'retrieval_failed',
      `a composed contract read failed: ${error instanceof Error ? error.message : 'unknown failure'}`,
    );
  }
}

/** Build the per-surface evidence census from the observed window. */
function censusFromObservations(
  observations: Observation[],
  surfaces: CompanySurface[],
): { countsBySurface: Record<CompanySurface, number>; total: number } {
  const countsBySurface = Object.fromEntries(
    COMPANY_SURFACES.map((surface) => [surface, 0]),
  ) as Record<CompanySurface, number>;
  let total = 0;
  const inScope = new Set(surfaces);
  for (const observation of observations) {
    total += 1;
    for (const surface of surfacesForObservationKind(observation.kind)) {
      if (inScope.has(surface)) countsBySurface[surface] = (countsBySurface[surface] ?? 0) + 1;
    }
  }
  return { countsBySurface, total };
}

/** Resolve the evidence-age thresholds (tenant 'source' policy, else default). */
async function evidenceThresholds(context: TenantContext): Promise<FreshnessThresholds | null> {
  try {
    const policy = await resolveFreshnessPolicy(context, { subjectKind: 'source' });
    if (policy === null) return DEFAULT_EVIDENCE_THRESHOLDS;
    return { staleAfterSeconds: policy.staleAfterSeconds, agingAfterSeconds: policy.agingAfterSeconds };
  } catch {
    // A policy read failure never blocks the answer — fall back to the
    // conservative default and let freshness be reported, not guessed.
    return DEFAULT_EVIDENCE_THRESHOLDS;
  }
}

// ---------------------------------------------------------------------------
// Steps 5 + 6 — claim assembly with provenance + freshness
// ---------------------------------------------------------------------------

/** Observation → provenance chip (the claim-level unit of §6 step 6). */
function provenanceFor(
  observation: Observation,
  sourceLabels: ReadonlyMap<string, string>,
  asOf: string,
  thresholds: FreshnessThresholds | null,
): CompanyClaimProvenance {
  const label =
    observation.source.label ??
    sourceLabels.get(observation.source.id ?? '') ??
    `${observation.source.kind} source`;
  return {
    observationId: observation.id,
    sourceKind: observation.source.kind,
    sourceLabel: label,
    channel: observation.channel,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    freshness: classifyFreshness(thresholds, evidenceAgeSeconds(observation.observedAt, asOf)),
  };
}

/**
 * A compact, honest text for one observation: its canonical kind, where it
 * came from and a bounded gist of its payload. NEVER a narrative the
 * evidence does not state.
 */
function observationText(observation: Observation): string {
  const gist = payloadGist(observation.payload);
  const origin = observation.source.label ?? `${observation.source.kind} evidence`;
  return gist === null
    ? `Observed ${observation.kind} via ${observation.channel} (${origin})`
    : `Observed ${observation.kind} via ${observation.channel} (${origin}): ${gist}`;
}

/** A ≤160-char deterministic gist of a JSON payload (or null). */
function payloadGist(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  let text: string;
  try {
    text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  } catch {
    return null;
  }
  if (text === '' || text === '{}' || text === '[]') return null;
  const clamped = text.length > 160 ? `${text.slice(0, 157)}…` : text;
  return clamped;
}

function assembleClaims(
  retrieval: ContractRetrieval,
  asOf: string,
  thresholds: FreshnessThresholds | null,
  surfaces: CompanySurface[],
): CompanyQueryClaim[] {
  const sourceLabels = new Map<string, string>();
  for (const source of retrieval.coverageSources) {
    if (source.displayName !== null) sourceLabels.set(source.sourceId, source.displayName);
  }
  const byId = new Map(retrieval.observations.map((observation) => [observation.id, observation]));
  const inScope = new Set(surfaces);
  const claims: CompanyQueryClaim[] = [];

  const relevance = (observation: Observation | undefined): boolean => {
    if (observation === undefined) return true; // evidence outside the window still counts for epistemic records
    if (surfaces.length === COMPANY_SURFACES.length) return true;
    const mapped = surfacesForObservationKind(observation.kind);
    return mapped.length === 0 || mapped.some((surface) => inScope.has(surface));
  };

  // observed facts — the observations themselves (W004)
  for (const observation of retrieval.observations) {
    if (!relevance(observation)) continue;
    claims.push({
      kind: 'observed-fact',
      text: observationText(observation),
      confidence: observation.confidence.value,
      provenance: [provenanceFor(observation, sourceLabels, asOf, thresholds)],
    });
  }

  // observed facts — evidence-derived propositions (epistemics claims, W007)
  for (const claim of retrieval.claims) {
    const provenance = claim.evidenceObservationIds
      .map((id) => byId.get(id))
      .filter((observation): observation is Observation => observation !== undefined)
      .map((observation) => provenanceFor(observation, sourceLabels, asOf, thresholds));
    claims.push({
      kind: 'observed-fact',
      text: claim.proposition,
      confidence: claim.confidence.value,
      provenance,
    });
  }

  // observed facts — evidence-backed organizational knowledge (memory, W010)
  for (const entry of retrieval.knowledge) {
    const provenance = entry.evidenceObservationIds
      .map((id) => byId.get(id))
      .filter((observation): observation is Observation => observation !== undefined)
      .map((observation) => provenanceFor(observation, sourceLabels, asOf, thresholds));
    claims.push({
      kind: 'observed-fact',
      text: `${entry.title} — ${entry.summary}`,
      confidence: null,
      provenance,
    });
  }

  // derived beliefs — the active working understanding (epistemics beliefs, W007)
  for (const belief of retrieval.beliefs) {
    if (belief.status !== 'active') continue;
    const provenance = belief.provenance.observationIds
      .map((id) => byId.get(id))
      .filter((observation): observation is Observation => observation !== undefined)
      .map((observation) => provenanceFor(observation, sourceLabels, asOf, thresholds));
    claims.push({
      kind: 'derived-belief',
      text: belief.statement.proposition,
      confidence: belief.statement.confidence.value,
      provenance,
    });
  }

  // hypotheses — unresolved candidate explanations (epistemics, W007)
  for (const hypothesis of retrieval.hypotheses) {
    if (hypothesis.status !== 'open') continue;
    const provenance = hypothesis.supportingObservationIds
      .map((id) => byId.get(id))
      .filter((observation): observation is Observation => observation !== undefined)
      .map((observation) => provenanceFor(observation, sourceLabels, asOf, thresholds));
    claims.push({
      kind: 'hypothesis',
      text: hypothesis.proposition,
      confidence: null,
      provenance,
    });
  }

  return claims;
}

// ---------------------------------------------------------------------------
// Step 8 — contradictions and unknowns (preserved, both sides)
// ---------------------------------------------------------------------------

function sideFallbackText(evidence: { kind: string; id: string }): string {
  return `${evidence.kind} ${evidence.id}`;
}

function assembleContradictions(
  retrieval: ContractRetrieval,
  asOf: string,
  thresholds: FreshnessThresholds | null,
): CompanyQueryContradiction[] {
  const sourceLabels = new Map<string, string>();
  for (const source of retrieval.coverageSources) {
    if (source.displayName !== null) sourceLabels.set(source.sourceId, source.displayName);
  }
  const observationById = new Map(
    retrieval.observations.map((observation) => [observation.id, observation]),
  );
  const claimById = new Map(retrieval.claims.map((claim) => [claim.id, claim]));

  const resolveSide = (
    evidence: { kind: string; id: string },
  ): {
    evidenceKind: 'observation' | 'claim';
    evidenceId: string;
    text: string;
    provenance: CompanyClaimProvenance[];
  } => {
    if (evidence.kind === 'observation') {
      const observation = observationById.get(evidence.id);
      if (observation !== undefined) {
        return {
          evidenceKind: 'observation',
          evidenceId: observation.id,
          text: observationText(observation),
          provenance: [provenanceFor(observation, sourceLabels, asOf, thresholds)],
        };
      }
    }
    if (evidence.kind === 'claim') {
      const claim = claimById.get(evidence.id);
      if (claim !== undefined) {
        const provenance = claim.evidenceObservationIds
          .map((id) => observationById.get(id))
          .filter((observation): observation is Observation => observation !== undefined)
          .map((observation) => provenanceFor(observation, sourceLabels, asOf, thresholds));
        return { evidenceKind: 'claim', evidenceId: claim.id, text: claim.proposition, provenance };
      }
    }
    return { evidenceKind: 'claim', evidenceId: evidence.id, text: sideFallbackText(evidence), provenance: [] };
  };

  return retrieval.contradictions.map((contradiction) => ({
    note: contradiction.note,
    status: contradiction.status,
    detectedAt: contradiction.detectedAt,
    sideA: resolveSide(contradiction.evidenceA),
    sideB: resolveSide(contradiction.evidenceB),
  }));
}

function assembleUnknowns(retrieval: ContractRetrieval): CompanyQueryUnknown[] {
  return retrieval.unknowns.map((unknown) => ({
    question: unknown.question,
    consequence: unknown.consequence,
    status: unknown.status,
  }));
}

// ---------------------------------------------------------------------------
// Step 9 — the LLM presentation layer (never authoritative)
// ---------------------------------------------------------------------------

async function renderPresentationLayer(
  context: TenantContext,
  question: string,
  summary: string,
  claims: CompanyQueryClaim[],
  gapWhys: string[],
): Promise<CompanyQueryLlmPresentation> {
  const digest = [
    summary,
    ...claims.slice(0, 25).map((claim) => `[${claim.kind}] ${claim.text}`),
    ...(gapWhys.length === 0 ? [] : ['Material coverage gaps:', ...gapWhys]),
  ].join('\n');

  try {
    const execution: LlmExecution = await invokeLlm(context, {
      capability: 'text-generation',
      scope: 'analysis',
      dataClassification: 'internal',
      messages: [
        {
          role: 'system',
          content:
            'You are the presentation layer of Aurum\u2019s company query plane. You are given an ALREADY-ASSEMBLED, evidence-backed answer. Render it as one calm, honest paragraph for a company member. Rules: use ONLY the facts in the provided material; never introduce numbers, names or claims that are not there; keep the stated uncertainties, contradictions and coverage gaps visible; never claim universal capture. Your text is presentation, not authority — it will not be stored as domain truth.',
        },
        {
          role: 'user',
          content: `Question: ${question}\n\nAssembled answer material:\n${digest}`,
        },
      ],
      maxOutputTokens: 512,
      temperature: 0.2,
    });
    const text = execution.result?.kind === 'text-generation' ? execution.result.text : null;
    if (typeof text === 'string' && text.trim() !== '') {
      return { used: true, text: text.trim(), executionId: execution.id };
    }
    return { used: false, text: null, executionId: null };
  } catch {
    // No tenant AI account / no wired transport / provider unavailable: the
    // structured answer stands on its own (§6 step 10 — the LLM is never a
    // dependency of correctness).
    return { used: false, text: null, executionId: null };
  }
}

// ---------------------------------------------------------------------------
// The append-only query audit (this module's ONLY persistence)
// ---------------------------------------------------------------------------

interface QueryAuditRow {
  question: string;
  surfaces: CompanySurface[];
  generatedAt: string;
  claimCount: number;
  contradictionCount: number;
  unknownCount: number;
  materialGapCount: number;
  llmUsed: boolean;
}

async function appendQueryAudit(context: TenantContext, audit: QueryAuditRow): Promise<void> {
  try {
    await getDb().query(
      `INSERT INTO company_query_log
         (id, tenant_id, principal_id, question, surfaces, generated_at,
          claim_count, contradiction_count, unknown_count, material_gap_count, llm_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        newId(),
        context.tenantId,
        context.principalId,
        audit.question,
        audit.surfaces,
        audit.generatedAt,
        audit.claimCount,
        audit.contradictionCount,
        audit.unknownCount,
        audit.materialGapCount,
        audit.llmUsed,
      ],
    );
  } catch (error) {
    throw new CompanyQueryError(
      'audit_failed',
      `the query audit append failed: ${error instanceof Error ? error.message : 'unknown failure'}`,
    );
  }
}
