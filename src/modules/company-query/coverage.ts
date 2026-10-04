// Company query plane (W126) — the PURE coverage derivation.
//
// Everything here is deterministic and database-free: the service layer
// feeds it the connection/source/evidence state it read through module
// contracts, and these functions derive the conservative coverage context
// the spec demands (COMPANY-COVERAGE-ARCHITECTURE.md §3/§4/§5/§7). Pure
// means unit-testable without PGlite (see tests/company-query-unit.test.ts).
//
// WHY "CONSERVATIVE": until the W125 coverage registry lands (integration
// note in types.ts), the query plane derives coverage itself from what it
// can legitimately read:
//   * the tenant's registered sources (sources contract, W036);
//   * the tenant's channel connections (channels contract, W030);
//   * the evidence actually observed per source (observations contract,
//     W004) and its age (freshness classifiers, W006).
// The derivation follows the §7 honesty rule by CONSTRUCTION: a configured
// integration with no evidence never yields a covered state ("never imply
// universal capture from a single connector"), and no percentage is ever
// compressed out of heterogeneous dimensions (§4).
//
// The provider → surface mapping is a QUERY-SIDE semantic classification
// (spec §11: customer interactions and tickets are semantic categories,
// not vertical subsystems). It deliberately claims LESS than a provider
// might deliver: a source contributes to a surface only through the
// canonical observation kinds its adapter actually emits.

import { classifyFreshness, evidenceAgeSeconds } from '@/modules/freshness/contract';
import type { FreshnessThresholds } from '@/modules/freshness/contract';
import type { SourceProvider } from '@/modules/sources/contract';
import type { ChannelProvider } from '@/modules/channels/contract';
import type { Observation } from '@/modules/observations/contract';
import {
  COMPANY_SURFACES,
  type CompanySurface,
  type CompanyCoverageGap,
  type CompanyCoverageSourceSummary,
  type CompanyCoverageSurfaceSummary,
  type CompanyHonestyAnswer,
} from './types';

// ---------------------------------------------------------------------------
// Provider → surface classification (query-side, conservative)
// ---------------------------------------------------------------------------

/**
 * Which company surfaces a SOURCE provider may contribute to. Claims are
 * conservative: a provider is mapped only to the surfaces its canonical
 * record kinds unambiguously address (the adapters' kind vocabulary:
 * crm.deal.* → sales opportunities, support.ticket.* → support tickets…).
 */
export const SOURCE_PROVIDER_SURFACES: Readonly<Record<SourceProvider, readonly CompanySurface[]>> = {
  salesforce: ['sales-opportunities', 'customer-interactions', 'people-organization'],
  hubspot: ['sales-opportunities', 'customer-interactions', 'people-organization'],
  zendesk: ['support-tickets', 'customer-interactions'],
  jira: ['projects-tasks'],
  linear: ['projects-tasks'],
  confluence: ['documents-knowledge'],
  notion: ['documents-knowledge'],
  github: ['projects-tasks'],
  'google-drive': ['documents-knowledge'],
  'google-calendar': ['meetings'],
  stripe: ['finance'],
  quickbooks: ['finance'],
  zapier: ['operations'],
};

/**
 * Which company surfaces a CHANNEL connection may contribute to. Inbound
 * conversational channels are the customer-interaction class (spec §11);
 * workplace channels additionally carry internal communications.
 */
export const CHANNEL_PROVIDER_SURFACES: Readonly<
  Record<ChannelProvider, readonly CompanySurface[]>
> = {
  whatsapp: ['customer-interactions'],
  telegram: ['customer-interactions'],
  signal: ['customer-interactions'],
  slack: ['customer-interactions', 'internal-communications'],
  x: ['customer-interactions'],
  instagram: ['customer-interactions'],
  facebook: ['customer-interactions'],
  linkedin: ['customer-interactions'],
  email: ['customer-interactions', 'internal-communications'],
  sms: ['customer-interactions'],
  voice: ['customer-interactions'],
  web: ['customer-interactions'],
};

/**
 * Observation-kind prefixes → surfaces, for counting the evidence that was
 * ACTUALLY observed per surface (the §7 anti-"connected = captured" rule:
 * states come from evidence, configurations only nominate candidates).
 */
export const OBSERVATION_KIND_SURFACES: readonly {
  prefix: string;
  surface: CompanySurface;
}[] = [
  { prefix: 'crm.', surface: 'sales-opportunities' },
  { prefix: 'deal.', surface: 'sales-opportunities' },
  { prefix: 'contact.', surface: 'customer-interactions' },
  { prefix: 'customer.', surface: 'customer-interactions' },
  { prefix: 'support.', surface: 'support-tickets' },
  { prefix: 'issue.', surface: 'projects-tasks' },
  { prefix: 'code.', surface: 'projects-tasks' },
  { prefix: 'document.', surface: 'documents-knowledge' },
  { prefix: 'page.', surface: 'documents-knowledge' },
  { prefix: 'calendar.', surface: 'meetings' },
  { prefix: 'meeting.', surface: 'meetings' },
  { prefix: 'charge.', surface: 'finance' },
  { prefix: 'invoice.', surface: 'finance' },
  { prefix: 'payment.', surface: 'finance' },
  { prefix: 'channel.', surface: 'customer-interactions' },
  { prefix: 'conversation.', surface: 'customer-interactions' },
  { prefix: 'agent.', surface: 'agent-activity' },
  { prefix: 'automation.', surface: 'operations' },
];

/** The surfaces an observation kind contributes to (empty = unmapped). */
export function surfacesForObservationKind(kind: string): CompanySurface[] {
  return OBSERVATION_KIND_SURFACES.filter((entry) => kind.startsWith(entry.prefix)).map(
    (entry) => entry.surface,
  );
}

// ---------------------------------------------------------------------------
// Freshness (pure classifiers of the freshness contract, W006)
// ---------------------------------------------------------------------------

/**
 * The query-side default evidence-age policy while no tenant policy is
 * set for a subject: aging after 7 days, stale after 30 days. Conservative
 * in the §4 sense — freshness is REPORTED, never silently ignored.
 */
export const DEFAULT_EVIDENCE_THRESHOLDS: FreshnessThresholds = {
  staleAfterSeconds: 30 * 24 * 60 * 60,
  agingAfterSeconds: 7 * 24 * 60 * 60,
};

/** Classify one observation's evidence age (null observation → 'unknown'). */
export function observationFreshness(
  observation: Pick<Observation, 'observedAt'> | null,
  asOf: string,
  thresholds: FreshnessThresholds | null,
): 'current' | 'aging' | 'stale' | 'unknown' {
  if (observation === null) return 'unknown';
  return classifyFreshness(thresholds, evidenceAgeSeconds(observation.observedAt, asOf));
}

// ---------------------------------------------------------------------------
// Surface coverage derivation (spec §3 CoverageClaim, query-side)
// ---------------------------------------------------------------------------

/** One source candidate for the derivation (service-composed, pure-consumed). */
export interface CoverageSourceCandidate {
  sourceId: string;
  sourceModule: 'source' | 'channel';
  provider: SourceProvider | ChannelProvider;
  displayName: string | null;
  status: 'active' | 'disabled';
  /** The newest observation seen from this source (null = none). */
  latestObservation: Pick<Observation, 'observedAt'> | null;
  /** OAuth grant expiry (sources only; null = non-expiring/unknown). */
  oauthExpiresAt: string | null;
}

/** The evidence census the derivation consumes (bounded window, honest counts). */
export interface CoverageEvidenceCensus {
  /** Per-surface observation counts inside the retrieval window. */
  countsBySurface: Readonly<Record<CompanySurface, number>>;
  /** Total observations seen in the window (any kind, mapped or not). */
  total: number;
}

/** Derivation input: everything the pure functions need. */
export interface CoverageDerivationInput {
  surfaces: CompanySurface[];
  sources: CoverageSourceCandidate[];
  evidence: CoverageEvidenceCensus;
  asOf: string;
  thresholds: FreshnessThresholds | null;
}

const EMPTY_CENSUS: CoverageEvidenceCensus = {
  countsBySurface: Object.fromEntries(COMPANY_SURFACES.map((surface) => [surface, 0])) as Record<
    CompanySurface,
    number
  >,
  total: 0,
};

/** An empty census (used when the retrieval window saw nothing). */
export function emptyEvidenceCensus(): CoverageEvidenceCensus {
  return { countsBySurface: { ...EMPTY_CENSUS.countsBySurface }, total: 0 };
}

/**
 * Derive the per-surface coverage summaries (§5 states, §3 claims).
 *
 * State resolution, most-specific first:
 *   * no contributing source at all            → 'unavailable' (nothing is
 *     connected for this surface — the honest label; the gap kind says
 *     'missing');
 *   * every contributor disabled               → 'unavailable' ('disabled' gap);
 *   * an active OAuth contributor whose grant
 *     has lapsed                               → 'unauthorized' (§5);
 *   * contributors active, evidence exists,
 *     newest evidence stale                    → 'stale' (§5);
 *   * contributors active, no evidence at all  → 'unknown' — §7: a
 *     configured integration NEVER implies capture;
 *   * evidence exists and is current/aging     → 'covered' when the window
 *     saw a healthy census, else 'partial' (some evidence, but thin —
 *     the §4 breadth/depth distinction kept as two honest states).
 */
export function deriveSurfaceCoverage(input: CoverageDerivationInput): CompanyCoverageSurfaceSummary[] {
  const { surfaces, sources, evidence, asOf, thresholds } = input;

  return surfaces.map((surface) => {
    const contributors = sources.filter((source) => {
      const mapped =
        source.sourceModule === 'source'
          ? (SOURCE_PROVIDER_SURFACES[source.provider as SourceProvider] ?? [])
          : (CHANNEL_PROVIDER_SURFACES[source.provider as ChannelProvider] ?? []);
      return mapped.includes(surface);
    });

    const contributingSources: CompanyCoverageSourceSummary[] = contributors.map((source) => ({
      sourceId: source.sourceId,
      sourceModule: source.sourceModule,
      provider: source.provider,
      displayName: source.displayName,
      status: source.status,
      latestObservedAt: source.latestObservation?.observedAt ?? null,
      freshness: observationFreshness(source.latestObservation, asOf, thresholds),
    }));

    const activeContributors = contributors.filter((source) => source.status === 'active');
    const lapsedGrant = activeContributors.some(
      (source) =>
        source.oauthExpiresAt !== null &&
        Number.isFinite(Date.parse(source.oauthExpiresAt)) &&
        Date.parse(source.oauthExpiresAt) < Date.parse(asOf),
    );
    const newestEvidenceAt = contributors
      .map((source) => (source.latestObservation === null ? null : source.latestObservation.observedAt))
      .filter((value): value is string => value !== null)
      .sort()
      .at(-1) ?? null;
    const newestFreshness = observationFreshness(
      newestEvidenceAt === null ? null : { observedAt: newestEvidenceAt },
      asOf,
      thresholds,
    );
    const observationCount = evidence.countsBySurface[surface] ?? 0;

    let state: CompanyCoverageSurfaceSummary['state'];
    let explanation: string;
    if (contributors.length === 0) {
      state = 'unavailable';
      explanation = 'no authorized source for this surface is connected';
    } else if (activeContributors.length === 0) {
      state = 'unavailable';
      explanation = `${contributors.length} source(s) connected, all disabled`;
    } else if (lapsedGrant) {
      state = 'unauthorized';
      explanation = 'an active source\u2019s authorization grant has lapsed';
    } else if (newestFreshness === 'unknown') {
      state = 'unknown';
      explanation = `${activeContributors.length} source(s) connected but no evidence observed yet — connected does not mean captured`;
    } else if (newestFreshness === 'stale') {
      state = 'stale';
      explanation = `evidence exists but the newest is stale (observed ${newestEvidenceAt})`;
    } else if (observationCount >= 10) {
      state = 'covered';
      explanation = `${activeContributors.length} active source(s), ${observationCount} observation(s) in the window, newest evidence ${newestFreshness}`;
    } else {
      state = 'partial';
      explanation = `${activeContributors.length} active source(s) but only ${observationCount} observation(s) in the window`;
    }

    return {
      surface,
      state,
      contributingSources,
      latestObservedAt: newestEvidenceAt,
      observationCount,
      explanation,
    };
  });
}

// ---------------------------------------------------------------------------
// Question → surface materiality (§6 step 7)
// ---------------------------------------------------------------------------

/** Task vocabulary per surface — a user's words naming the surface. */
export const SURFACE_QUESTION_KEYWORDS: Readonly<Record<CompanySurface, readonly string[]>> = {
  'people-organization': ['people', 'person', 'employee', 'staff', 'team', 'org', 'organization', 'role', 'roles', 'hire', 'hiring', 'workforce'],
  'customer-interactions': ['customer', 'customers', 'conversation', 'conversations', 'chat', 'chats', 'message', 'messages', 'whatsapp', 'sms', 'email', 'call', 'interaction', 'interactions', 'complaint'],
  'support-tickets': ['support', 'ticket', 'tickets', 'helpdesk', 'zendesk', 'case', 'cases', 'escalation'],
  'sales-opportunities': ['sales', 'sale', 'deal', 'deals', 'opportunity', 'opportunities', 'pipeline', 'crm', 'revenue', 'lead', 'leads', 'forecast'],
  'projects-tasks': ['project', 'projects', 'task', 'tasks', 'jira', 'issue', 'issues', 'sprint', 'delivery', 'milestone', 'roadmap'],
  meetings: ['meeting', 'meetings', 'zoom', 'transcript', 'transcripts', 'call recording', 'attendee', 'participants'],
  'internal-communications': ['internal', 'slack', 'announcement', 'announcements', 'team chat', 'standup'],
  finance: ['finance', 'financial', 'invoice', 'invoices', 'payment', 'payments', 'charge', 'charges', 'billing', 'cash', 'spend', 'expense', 'expenses', 'quickbooks', 'stripe', 'subscription'],
  operations: ['operations', 'operation', 'workflow', 'workflows', 'automation', 'automations', 'process', 'processes', 'zapier'],
  suppliers: ['supplier', 'suppliers', 'vendor', 'vendors', 'procurement', 'lead time'],
  'documents-knowledge': ['document', 'documents', 'doc', 'docs', 'knowledge', 'wiki', 'notion', 'confluence', 'note', 'notes', 'file', 'files'],
  'external-environment': ['market', 'markets', 'competitor', 'competitors', 'industry', 'news', 'external', 'regulation', 'regulations'],
  'agent-activity': ['agent', 'agents', 'bot', 'bots', 'assistant', 'automation ran'],
};

/**
 * Which surfaces the question explicitly names (word-boundary match,
 * case-insensitive). Used for scoping materiality — a gap is material when
 * the question touches the surface, or when the surface has nothing at all
 * behind it.
 */
export function surfacesForQuestion(question: string): CompanySurface[] {
  const normalized = ` ${question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')} `;
  const matched = new Set<CompanySurface>();
  for (const surface of COMPANY_SURFACES) {
    for (const keyword of SURFACE_QUESTION_KEYWORDS[surface]) {
      if (normalized.includes(` ${keyword} `)) {
        matched.add(surface);
        break;
      }
    }
  }
  return COMPANY_SURFACES.filter((surface) => matched.has(surface));
}

/** Whether the question is a §7 coverage-class question ("how much can you see"). */
const COVERAGE_QUESTION_PATTERNS: readonly RegExp[] = [
  /how much\b.*\b(can|could|do|does)?\s*(you|aurum|we)?\s*(see|visible|access)/i,
  /\b(can|cannot|can't)\s+(you|aurum)\s+see\b/i,
  /\bwhat\s+(can|do)\s+(you|aurum)\s+see\b/i,
  /\b(what|which)\b.*\b(coverage|covered|visible|blind\s?spot)/i,
  /\bevery\s+(meeting|ticket|conversation|message|email|call|deal|invoice)\b/i,
  /\ball\s+(our|the)\s+(conversations|messages|meetings|tickets|emails|calls)\b/i,
  /\bhow much of\b/i,
];

/** Recognize a §7 honesty-class coverage question. */
export function isCoverageQuestion(question: string): boolean {
  return COVERAGE_QUESTION_PATTERNS.some((pattern) => pattern.test(question));
}

/**
 * Derive the MATERIAL coverage gaps (§6 step 7): gaps that could change
 * THIS answer. Materiality rule (documented, conservative):
 *   * when the question NAMES surfaces (§7 vocabulary match), only those
 *     surfaces' non-covered states are material — the answer's subject is
 *     blind exactly there, and an unconnected surface the question never
 *     touches cannot change it;
 *   * when the question names nothing (a broad company question), the
 *     surfaces with NOTHING at all behind them (state 'unavailable', zero
 *     evidence) are material — active-but-thin surfaces stay honest
 *     caveats, not headline gaps.
 */
export function deriveMaterialGaps(
  question: string,
  summaries: readonly CompanyCoverageSurfaceSummary[],
): CompanyCoverageGap[] {
  const named = new Set(surfacesForQuestion(question));
  const gaps: CompanyCoverageGap[] = [];

  for (const summary of summaries) {
    if (summary.state === 'covered' || summary.state === 'excluded') continue;
    const namedHere = named.has(summary.surface);
    if (named.size > 0 && !namedHere) continue;
    if (named.size === 0 && !(summary.state === 'unavailable' && summary.observationCount === 0)) {
      continue;
    }
    const kind: CompanyCoverageGap['kind'] =
      summary.state === 'unavailable'
        ? summary.contributingSources.length === 0
          ? 'missing'
          : 'disabled'
        : summary.state === 'unauthorized'
          ? 'unauthorized'
          : summary.state === 'stale'
            ? 'stale'
            : 'partial';
    const label = summary.surface.replace(/-/g, ' ');
    const why = namedHere
      ? `the question asks about ${label}, and this surface is ${summary.state} (${summary.explanation}) — closing this gap could change the answer`
      : `nothing is connected for ${label} (${summary.explanation}) — if the answer depends on it, this blind spot stands`;
    gaps.push({ surface: summary.surface, kind, why });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// The §7 honesty answer
// ---------------------------------------------------------------------------

/**
 * Answer a coverage-class question from the REAL derived state (§7):
 * states, contributing sources, evidence counts and freshness — with the
 * explicit anti-universality wording the spec mandates. Deterministic.
 */
export function answerCoverageQuestion(
  question: string,
  summaries: readonly CompanyCoverageSurfaceSummary[],
): CompanyHonestyAnswer | null {
  if (!isCoverageQuestion(question)) return null;
  const named = surfacesForQuestion(question);
  const namedSet = new Set(named);
  const about = (named.length === 0 ? summaries : summaries.filter((s) => namedSet.has(s.surface))).map(
    (summary) => summary.surface,
  );

  const lines: string[] = [];
  const aboutSet = new Set(about);
  for (const summary of summaries) {
    if (!aboutSet.has(summary.surface)) continue;
    const label = summary.surface.replace(/-/g, ' ');
    const sources = summary.contributingSources
      .map((source) => source.displayName ?? source.provider)
      .join(', ');
    const sourceText = sources === '' ? 'no connected source' : `sources: ${sources}`;
    const evidenceText =
      summary.observationCount === 0
        ? 'no evidence observed yet — connected does not mean captured'
        : `${summary.observationCount} observation(s) in the retrieval window, newest ${summary.latestObservedAt ?? 'unknown'} (${summary.contributingSources.find((s) => s.freshness !== 'unknown')?.freshness ?? 'unknown'} freshness)`;
    lines.push(`${label} is ${summary.state} — ${sourceText}; ${evidenceText}.`);
  }
  const text =
    lines.length === 0
      ? 'No company surfaces are in this query\u2019s scope.'
      : `${lines.join(' ')} Aurum never claims universal capture: a surface counts as covered only through observed, authorized evidence within its freshness policy — a connected integration alone claims nothing.`;

  return { question, surfaces: about, text };
}

// ---------------------------------------------------------------------------
// Caveats + deterministic summary (§6 answer layer)
// ---------------------------------------------------------------------------

/** Freshness/authorization caveats that qualify the answer (§6). */
export function deriveCaveats(
  summaries: readonly CompanyCoverageSurfaceSummary[],
): string[] {
  const caveats: string[] = [];
  for (const summary of summaries) {
    if (summary.state === 'stale') {
      caveats.push(
        `${summary.surface.replace(/-/g, ' ')} evidence is stale (newest observed ${summary.latestObservedAt ?? 'unknown'}) — the answer may not reflect the present`,
      );
    } else if (summary.state === 'unauthorized') {
      caveats.push(
        `${summary.surface.replace(/-/g, ' ')} authorization has lapsed — its evidence is excluded from this answer`,
      );
    } else if (summary.state === 'unknown') {
      caveats.push(
        `${summary.surface.replace(/-/g, ' ')} has a connected source but no observed evidence — nothing was claimed from configuration alone`,
      );
    }
  }
  return caveats;
}

/** Compose the deterministic answer summary (never LLM — §6 step 9/10). */
export function composeDeterministicSummary(input: {
  question: string;
  scopeSurfaces: CompanySurface[];
  observationCount: number;
  claimCount: number;
  beliefCount: number;
  openContradictionCount: number;
  openUnknownCount: number;
  coveredSurfaces: number;
  scopeSize: number;
  worldEntityCount: number;
  worldEntityKindCount: number;
  activeGoalCount: number;
}): string {
  const parts: string[] = [];
  parts.push(
    `Evidence at answer time: ${input.observationCount} observation(s), ${input.claimCount} evidence-derived claim(s) and knowledge entries, ${input.beliefCount} active working belief(s)`,
  );
  parts.push(
    `The world model holds ${input.worldEntityCount} entity record(s) across ${input.worldEntityKindCount} kind(s); ${input.activeGoalCount} goal(s) are active`,
  );
  parts.push(
    `${input.openContradictionCount} retained contradiction(s) and ${input.openUnknownCount} open unknown(s) are preserved below — neither is merged away`,
  );
  parts.push(
    `Coverage: ${input.coveredSurfaces} of ${input.scopeSize} surface(s) in scope are covered; the coverage context lists every surface's state, the material gaps, and what could change this answer`,
  );
  return parts.join('. ') + '.';
}
