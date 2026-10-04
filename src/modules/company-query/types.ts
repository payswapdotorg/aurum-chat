// Public domain types of the company-query module (W126 — Company Query
// Plane).
//
// The company query plane is a provider-independent QUERY/READ surface over
// authorized evidence (spec/COMPANY-COVERAGE-ARCHITECTURE.md §6): one
// question about the company, answered from the canonical records the
// existing module contracts already expose, with provenance, freshness,
// retained contradictions, unknowns and an explicit coverage context —
// never from provider-specific objects, never from raw persistence, and
// never with LLM output as authority.
//
// A response has TWO LAYERS (§6):
//
//   Answer          — the best evidence-backed answer: material claims
//                     (each with claim-level provenance + freshness),
//                     retained contradictions with provenance on BOTH
//                     sides, surfaced unknowns, and — purely as
//                     PRESENTATION — optional LLM-generated language.
//   CoverageContext — what was visible when answering, which sources
//                     contributed, freshness/authorization caveats, and
//                     the material coverage gaps that could change the
//                     answer if closed (§7 "every meeting/every ticket"
//                     honesty rules live here).
//
// INTEGRATION NOTE (W125): the coverage vocabulary below (CompanySurface /
// CoverageState / the gap and summary shapes) is the query-side LOCAL
// mirror of the TL-frozen coverage type vocabulary
// (spec/COMPANY-COVERAGE-ARCHITECTURE.md §3/§4/§5). The coverage module
// (W125) does not exist at this base SHA, so per the work order these
// types are defined HERE, query-side, and derive conservatively from
// connection/source state readable through existing contracts. When W125's
// registry lands, the Tech Lead re-points this module at
// `@/modules/coverage/contract` and deletes the local mirror — the shapes
// were kept deliberately aligned with the spec's object model
// (CoverageSurface / CoverageSource / CoverageClaim / CoverageGap /
// CoverageSnapshot §3, the §4 dimensions that are derivable query-side,
// and the §5 state vocabulary verbatim).

import type { ObservationSourceKind } from '@/modules/observations/contract';
import type { SourceProvider, SourceStatus } from '@/modules/sources/contract';
import type { ChannelProvider } from '@/modules/channels/contract';
import type { FreshnessStatus } from '@/modules/freshness/contract';

// ---------------------------------------------------------------------------
// Company surfaces (spec §3 CoverageSurface — provider-neutral)
// ---------------------------------------------------------------------------

/**
 * A logical area of company reality Aurum may observe (spec §3). A surface
 * is provider-neutral by construction: "support-tickets" is the semantic
 * category; Zendesk and Jira are provider implementations that stay inside
 * their adapters (the sources module's discipline).
 */
export const COMPANY_SURFACES = [
  'people-organization',
  'customer-interactions',
  'support-tickets',
  'sales-opportunities',
  'projects-tasks',
  'meetings',
  'internal-communications',
  'finance',
  'operations',
  'suppliers',
  'documents-knowledge',
  'external-environment',
  'agent-activity',
] as const;

export type CompanySurface = (typeof COMPANY_SURFACES)[number];

// ---------------------------------------------------------------------------
// Coverage states (spec §5 — verbatim provider-neutral vocabulary)
// ---------------------------------------------------------------------------

/**
 * The §5 coverage-state vocabulary. These are NOT provider states and no
 * raw provider error code ever appears on this surface.
 */
export const COVERAGE_STATES = [
  'covered',
  'partial',
  'stale',
  'unavailable',
  'unauthorized',
  'excluded',
  'unknown',
] as const;

export type CoverageState = (typeof COVERAGE_STATES)[number];

// ---------------------------------------------------------------------------
// Epistemic classes of answer material (spec §6 step 5)
// ---------------------------------------------------------------------------

/**
 * The four-way epistemic split a query MUST distinguish (§6 step 5):
 *
 *   observed-fact   — directly observed evidence (an observation W004) or
 *                     an evidence-derived proposition (an epistemics claim
 *                     W007: an immutable proposition derived from ≥1
 *                     readable observation);
 *   derived-belief  — the current working understanding (an active
 *                     epistemics belief W007, versioned through freshness
 *                     W006);
 *   hypothesis      — an unresolved candidate explanation (epistemics W007);
 *   unknown         — a consequential question Aurum cannot answer
 *                     (epistemics W007, lock 7).
 */
export const COMPANY_CLAIM_KINDS = [
  'observed-fact',
  'derived-belief',
  'hypothesis',
  'unknown',
] as const;

export type CompanyClaimKind = (typeof COMPANY_CLAIM_KINDS)[number];

// ---------------------------------------------------------------------------
// Provenance (spec §6 step 6 — attached to every material claim)
// ---------------------------------------------------------------------------

/**
 * Claim-level provenance: one piece of evidence behind a material claim,
 * with where it came from, when it happened per the source's clock, when
 * Aurum committed it, and its evidence-age freshness classification
 * (freshness module vocabulary; 'unknown' when no policy applies).
 */
export interface CompanyClaimProvenance {
  /** The observation's uuid (immutable evidence — always resolvable). */
  observationId: string;
  sourceKind: ObservationSourceKind;
  /** Human-readable origin (the registered source's name, or the observation's own label). */
  sourceLabel: string;
  /** Provider-neutral channel key recorded on the observation. */
  channel: string;
  /** ISO 8601 — when the observed thing happened (source clock). */
  observedAt: string;
  /** ISO 8601 — when Aurum committed the observation. */
  recordedAt: string;
  /** Evidence-age classification against the applicable stale-after policy. */
  freshness: FreshnessStatus;
}

// ---------------------------------------------------------------------------
// The Answer layer (spec §6)
// ---------------------------------------------------------------------------

/** One material claim in the answer, with its epistemic class. */
export interface CompanyQueryClaim {
  kind: CompanyClaimKind;
  /** The claim text — an honest rendering of the underlying record, never fabricated. */
  text: string;
  /** Calibrated confidence of the underlying record (inclusive [0,1]); null when the record carries none. */
  confidence: number | null;
  /**
   * Provenance for the claim's material statements (≥1 for observed facts
   * and derived beliefs; hypotheses may carry only their motivating
   * observations; unknowns carry their bounding related evidence).
   */
  provenance: CompanyClaimProvenance[];
}

/** One side of a retained contradiction, with its own provenance. */
export interface CompanyQueryContradictionSide {
  /** The evidence record's module kind ('observation' or 'claim'). */
  evidenceKind: 'observation' | 'claim';
  evidenceId: string;
  text: string;
  provenance: CompanyClaimProvenance[];
}

/**
 * One retained contradiction (epistemics W007, lock 12): the disagreement
 * itself is PRESERVED — both sides render with their own provenance, and
 * nothing on this surface weighs or merges them.
 */
export interface CompanyQueryContradiction {
  note: string;
  status: 'open' | 'resolved';
  detectedAt: string;
  sideA: CompanyQueryContradictionSide;
  sideB: CompanyQueryContradictionSide;
}

/** One surfaced unknown (epistemics W007): the question AND its consequence. */
export interface CompanyQueryUnknown {
  question: string;
  consequence: string;
  status: 'open' | 'resolved';
}

/**
 * The LLM presentation half of the answer — explicitly NON-AUTHORITATIVE
 * (§6 step 9/10; ARCHITECTURE.md lock 10): the gateway's text is a
 * rendering of the ALREADY-ASSEMBLED structured answer and nothing else.
 * Every structured field of the answer is fully derivable with
 * `used === false` (test-locked).
 */
export interface CompanyQueryLlmPresentation {
  used: boolean;
  /** The generated presentation text (null when not used). */
  text: string | null;
  /** The gateway execution's evidence id (null when not used). */
  executionId: string | null;
}

/** The Answer layer: the best evidence-backed response (§6). */
export interface CompanyQueryAnswer {
  question: string;
  /** The company scope the question was resolved against. */
  scopeSurfaces: CompanySurface[];
  /**
   * A DETERMINISTIC summary of what the evidence shows — composed from the
   * contract reads, never from LLM output (the LLM only ever re-renders
   * what this summary and the claims already say).
   */
  summary: string;
  claims: CompanyQueryClaim[];
  contradictions: CompanyQueryContradiction[];
  unknowns: CompanyQueryUnknown[];
  llm: CompanyQueryLlmPresentation;
}

// ---------------------------------------------------------------------------
// The CoverageContext layer (spec §6/§7)
// ---------------------------------------------------------------------------

/** One authorized source contributing observations to a surface. */
export interface CompanyCoverageSourceSummary {
  /** Opaque id of the registered source/channel record. */
  sourceId: string;
  /** 'source' (sources module) or 'channel' (channels module connection). */
  sourceModule: 'source' | 'channel';
  /** Canonical, provider-neutral provider key (the owning module's vocabulary). */
  provider: SourceProvider | ChannelProvider;
  displayName: string | null;
  status: SourceStatus | 'active' | 'disabled';
  /** ISO 8601 of the newest observation seen from this source (null = no evidence yet). */
  latestObservedAt: string | null;
  /** Evidence-age classification of the newest observation ('unknown' when none). */
  freshness: FreshnessStatus;
}

/**
 * The derived observability statement for one surface (the query-side
 * CoverageClaim of spec §3, until W125's registry lands).
 */
export interface CompanyCoverageSurfaceSummary {
  surface: CompanySurface;
  state: CoverageState;
  contributingSources: CompanyCoverageSourceSummary[];
  /** ISO 8601 of the newest observation contributing to this surface (null = none). */
  latestObservedAt: string | null;
  /** Observations seen for this surface inside the retrieval window (bounded, approximate — honesty, not a census). */
  observationCount: number;
  /** Why the surface got this state — a human-readable reason, never a provider error code. */
  explanation: string;
}

/**
 * A material missing/stale/unauthorized portion of observability that
 * COULD CHANGE THE ANSWER if closed (spec §3 CoverageGap; §6 step 7). Only
 * material gaps are listed — non-material ones stay on the surface
 * summaries where the UI can still show them calmly.
 */
export interface CompanyCoverageGap {
  surface: CompanySurface;
  kind: 'missing' | 'stale' | 'unauthorized' | 'partial' | 'disabled';
  /** Why the gap could materially change this answer. */
  why: string;
}

/**
 * The §7 honesty answer: the structured, evidence-derived response to
 * "How much of our customer support history can you see?"-class questions.
 * Deterministic — never implied from a connector's mere existence
 * ("never claim universal capture from a single connector").
 */
export interface CompanyHonestyAnswer {
  /** The coverage question that was recognized, echoed honestly. */
  question: string;
  /** Which surfaces the question is about. */
  surfaces: CompanySurface[];
  /** The deterministic answer text (states, counts, freshness — no universality claims). */
  text: string;
}

/** The CoverageContext layer (§6): what was visible and what may be missing. */
export interface CompanyQueryCoverageContext {
  /** Per-surface observability within the query's scope. */
  surfaces: CompanyCoverageSurfaceSummary[];
  /** Freshness/authorization caveats that qualify the answer. */
  caveats: string[];
  /** The gaps that could materially change THIS answer (§6 step 7). */
  materialGaps: CompanyCoverageGap[];
  /** The §7 honesty answer when the question is a coverage question (null otherwise). */
  honesty: CompanyHonestyAnswer | null;
  /**
   * How this context was derived. 'query-side-conservative' until the W125
   * coverage registry lands (see the integration note above).
   */
  derivation: 'query-side-conservative';
}

// ---------------------------------------------------------------------------
// Query input + response
// ---------------------------------------------------------------------------

/** Input shape of `runCompanyQuery`. */
export interface CompanyQueryInput {
  /** The question about the company (1..2000 chars after trimming). */
  question: string;
  /** Optional explicit surface scope (subset of COMPANY_SURFACES; default = all). */
  surfaces?: CompanySurface[];
}

/** The two-layer query response (§6). */
export interface CompanyQueryResponse {
  /** ISO 8601 — service clock at answer time. */
  generatedAt: string;
  answer: CompanyQueryAnswer;
  coverageContext: CompanyQueryCoverageContext;
}
