// Evidence, audit & explainability (W065) — the view builders.
//
// Server-side composition of EXISTING module contracts only (lock 31/32:
// contracts, never persistence — product surfaces are never a second
// source of organizational truth). This surface is plan §2 Journey K and
// §4 W065: ONE causal evidence view that reconstructs any consequential
// answer or decision —
//
//   input → observations → evidence → belief/unknown → mission →
//   source selection (reliability/freshness) → policy → recommendation →
//   approval → execution → outcome → learning
//
// built on the audit module's §24 reconstruction (W046 reconstructDecision)
// and enriched with the two things the §24 chain deliberately leaves to
// the presenting surface:
//
//   * SOURCE RELIABILITY/FRESHNESS (W006/W030) — per-observation freshness
//     (age, latency, classification) and, for registered sources, the
//     connection status and stream freshness (the reliability signals the
//     contracts actually record — no invented scores);
//   * CONTRADICTION DISPLAY (lock 12 — W007) — the retained conflicts
//     involving the decision's evidence, both sides human-labeled, open
//     conflicts and their resolutions kept.
//
// Honesty rules (the intelligence/interventions surface discipline):
//   * a FAILING family read renders an empty section plus a `degraded`
//     note — never fake emptiness, never a crash;
//   * a MISSING anchor throws the audit contract's uniform not-found —
//     surfaced by the page as its honest not-found state (no existence
//     leak across tenants);
//   * what is ABSENT on the chain is stated (the reconstruction's own
//     per-link completeness report is rendered, never hidden);
//   * uuids are addresses, not content — every row leads with human text
//     (plan §8 gate 10).
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's executions, requests, audit records and contradictions
// are indistinguishable from missing ones — the contracts' own uniform
// not-found, no scope parameter in any URL.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  listAuditRecords,
  reconstructDecision,
} from '@/modules/audit/contract';
import type {
  AuditRecord,
  ChainLinkReport,
  DecisionEvidence,
  EvidenceObservation,
} from '@/modules/audit/contract';
import { listExecutions } from '@/modules/cognition/contract';
import type { CognitiveExecution } from '@/modules/cognition/contract';
import { listActionRequests } from '@/modules/actions/contract';
import type { ActionRequest } from '@/modules/actions/contract';
import { getObservation } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';
import { getClaim, listContradictions } from '@/modules/epistemics/contract';
import type { Contradiction } from '@/modules/epistemics/contract';
import {
  evaluateObservationFreshness,
  evaluateSourceFreshness,
} from '@/modules/freshness/contract';
import { getSource } from '@/modules/sources/contract';

import type { PillTone } from '../../lib/states';
import type { AnchorKind } from './anchors';
import { ANCHOR_KIND_LABEL, anchorHref, isUuidShape, reconstructQuery } from './anchors';
import {
  ageLabel,
  causalLabel,
  clip,
  executionStateLabel,
  executionStateTone,
  gateLabel,
  payloadSummary,
  requestStatusLabel,
  requestStatusTone,
  slugLabel,
  spanLabel,
} from './labels';

// ---------------------------------------------------------------------------
// Caps (the surface stays calm; reads stay bounded)
// ---------------------------------------------------------------------------

/** Recent decision cycles the index reads. */
export const INDEX_EXECUTION_ROWS = 12;
/** Recent action requests the index reads. */
export const INDEX_REQUEST_ROWS = 12;
/** Merged decision rows the index renders. */
export const INDEX_ROW_CAP = 20;
/** Audit-trail events the index renders. */
export const INDEX_AUDIT_ROWS = 16;
/** Evidence observations enriched with per-observation freshness. */
export const EVIDENCE_ROW_CAP = 24;
/** Distinct registered sources evaluated for reliability/freshness. */
export const SOURCE_CAP = 8;
/** Evidence refs queried for retained contradictions. */
export const CONTRADICTION_REF_CAP = 16;
/** Contradiction rows rendered. */
export const CONTRADICTION_ROW_CAP = 12;
/** Contradiction rows accepted per evidence ref. */
const CONTRADICTION_PER_REF_CAP = 10;
/** Mission/unknown/claim/belief rows rendered per link. */
export const CHAIN_ITEM_CAP = 12;

// ---------------------------------------------------------------------------
// The decision index (/explain)
// ---------------------------------------------------------------------------

/** One reconstructable decision on the index (the entry, never a naked id). */
export interface DecisionEntryRow {
  key: string;
  href: string;
  /** 'Decision cycle' | 'Action request' — the anchor kind, human-labeled. */
  kindLabel: string;
  /** The human title: the trigger's label or the action kind, humanized. */
  title: string;
  /** One line of context under the title. */
  subtitle: string;
  statusLabel: string;
  tone: PillTone;
  /** ISO 8601 — when the decision began (or was requested). */
  when: string;
}

/** One append-only audit-trail event on the index. */
export interface AuditEventRow {
  id: string;
  event: string;
  /** The §24 chain stage, human-labeled. */
  stageLabel: string;
  summary: string;
  recordedAt: string;
  /** Deep link when the event's subject is a reconstructable decision. */
  href: string | null;
}

/** The /explain index view. */
export interface EvidenceIndexView {
  generatedAt: string;
  decisions: DecisionEntryRow[];
  auditEvents: AuditEventRow[];
  degraded: string[];
}

/** The human title of a cognitive execution (its trigger, never its uuid). */
export function executionTitle(execution: CognitiveExecution): string {
  const trigger = execution.trigger;
  if (trigger.label !== null && trigger.label.trim() !== '') return clip(trigger.label, 120);
  if (trigger.kind !== null && trigger.kind.trim() !== '') return slugLabel(trigger.kind);
  return 'A decision cycle';
}

/** The human title of an action request (its action kind, humanized). */
export function actionRequestTitle(request: ActionRequest): string {
  return slugLabel(request.actionKind);
}

/** An execution's one-line context. */
function executionSubtitle(execution: CognitiveExecution): string {
  const outcome =
    execution.outcome === null
      ? 'no recorded outcome yet'
      : `${slugLabel(execution.outcome.kind)} — ${clip(execution.outcome.summary, 90)}`;
  return `Cycle of the intelligence loop · ${outcome}`;
}

/** An action request's one-line context. */
function actionRequestSubtitle(request: ActionRequest): string {
  const gate = gateLabel(request.evaluation.outcome);
  return `Authority ${request.authorityLevel} · ${gate}`;
}

/** Deep link for an audit subject, when it is a reconstructable decision. */
function auditSubjectHref(record: AuditRecord): string | null {
  if (record.subject.id === null) return null;
  if (record.subject.kind === 'cognition.execution') {
    return anchorHref('execution', record.subject.id);
  }
  if (record.subject.kind === 'actions.request') {
    return anchorHref('action-request', record.subject.id);
  }
  return null;
}

/**
 * The /explain index: every recent reconstructable decision (decision
 * cycles and action requests, merged newest-first) plus the append-only
 * audit trail. A mid-flight decision is listed exactly like a completed
 * one — the view states completeness, the index does not prejudge it.
 */
export async function buildEvidenceIndexView(ctx: TenantContext): Promise<EvidenceIndexView> {
  const degraded: string[] = [];
  const [executions, requests, audit] = await Promise.all([
    safe(
      'decision cycles',
      degraded,
      () => listExecutions(ctx, { limit: INDEX_EXECUTION_ROWS }),
    ),
    safe(
      'action requests',
      degraded,
      () => listActionRequests(ctx, { limit: INDEX_REQUEST_ROWS }),
    ),
    safe(
      'audit trail',
      degraded,
      () => listAuditRecords(ctx, { limit: INDEX_AUDIT_ROWS }),
    ),
  ]);

  const decisions: DecisionEntryRow[] = [];
  for (const execution of executions ?? []) {
    decisions.push({
      key: `execution:${execution.id}`,
      href: anchorHref('execution', execution.id),
      kindLabel: ANCHOR_KIND_LABEL.execution,
      title: executionTitle(execution),
      subtitle: executionSubtitle(execution),
      statusLabel: executionStateLabel(execution.state),
      tone: executionStateTone(execution.state),
      when: execution.createdAt,
    });
  }
  for (const request of requests ?? []) {
    decisions.push({
      key: `request:${request.id}`,
      href: anchorHref('action-request', request.id),
      kindLabel: ANCHOR_KIND_LABEL['action-request'],
      title: actionRequestTitle(request),
      subtitle: actionRequestSubtitle(request),
      statusLabel: requestStatusLabel(request.status),
      tone: requestStatusTone(request.status),
      when: request.requestedAt,
    });
  }
  decisions.sort((left, right) =>
    left.when === right.when
      ? left.key.localeCompare(right.key)
      : left.when < right.when
        ? 1
        : -1,
  );
  decisions.length = Math.min(decisions.length, INDEX_ROW_CAP);

  const auditEvents: AuditEventRow[] = (audit ?? []).map((record) => ({
    id: record.id,
    event: record.event,
    stageLabel: causalLabel(record.chainStage),
    summary: clip(record.summary, 220),
    recordedAt: record.recordedAt,
    href: auditSubjectHref(record),
  }));

  return { generatedAt: now().toISOString(), decisions, auditEvents, degraded };
}

// ---------------------------------------------------------------------------
// The decision view (/explain/<kind>/<id>)
// ---------------------------------------------------------------------------

/** One evidence observation with its freshness signal (or a restricted marker). */
export interface EvidenceRowView {
  id: string;
  unreadable: boolean;
  kind: string;
  observedAt: string;
  recordedAt: string;
  channel: string;
  sourceLabel: string | null;
  /** The registered source's uuid, when the observation cites one. */
  sourceId: string | null;
  confidence: number | null;
  payload: string | null;
  extractor: { provider: string; model: string } | null;
  /** Per-observation freshness (age, latency, classification) — the W006 read. */
  freshness: {
    status: string;
    age: string;
    latency: string;
    latencyExceeded: boolean;
  } | null;
}

/** One registered source's reliability/freshness signals. */
export interface SourceRowView {
  id: string;
  label: string;
  provider: string;
  /** Connection status ('active'/'disabled') — the reliability signal the contract records. */
  status: string;
  /** Stream freshness (the W006 source evaluation) — null when unavailable. */
  freshness: {
    status: string;
    age: string;
    avgLatency: string | null;
    maxLatency: string | null;
    considered: number;
  } | null;
  /** How many of the decision's observations cite this source. */
  observationCount: number;
}

/** One side of a retained contradiction, human-labeled. */
export interface ContradictionSideView {
  refKind: 'observation' | 'claim';
  id: string;
  label: string;
}

/** One retained contradiction involving the decision's evidence (lock 12). */
export interface ContradictionRowView {
  id: string;
  left: ContradictionSideView;
  right: ContradictionSideView;
  note: string;
  status: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** The enriched, render-ready causal view of one decision. */
export interface DecisionExplainView {
  anchorKind: AnchorKind;
  anchorId: string;
  kindLabel: string;
  title: string;
  subtitle: string;
  correlationId: string | null;
  reconstructedAt: string;
  /** The §24 chain, field per link (audit types, enriched below). */
  chain: DecisionEvidence['chain'];
  /** Per-link completeness, §24 order — what is absent is stated. */
  completeness: ChainLinkReport[];
  /** The evidence link, enriched. */
  evidenceRows: EvidenceRowView[];
  sources: SourceRowView[];
  contradictions: ContradictionRowView[];
  /** Deep links into the intelligence workflow (the working routes). */
  links: {
    /** Mission rows link to the tower Missions surface (see DEVIATIONS: the product mission route is mis-shipped at base). */
    missionBase: string;
    unknown: (unknownId: string) => string;
  };
  auditRecords: AuditRecord[];
  degraded: string[];
}

/** What building the decision view can resolve to. */
export type ExplainResolution =
  | { status: 'found'; view: DecisionExplainView }
  | { status: 'not-found' };

// ---------------------------------------------------------------------------
// Composition internals
// ---------------------------------------------------------------------------

/** Run one bounded read; a failure degrades the family, never the page. */
async function safe<T>(family: string, degraded: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

/** The decision's title, derived from its anchor. */
function decisionTitle(
  anchorKind: AnchorKind,
  evidence: DecisionEvidence,
): string {
  const request = evidence.chain.recommendation.actionRequest;
  if (anchorKind === 'action-request' && request !== null) {
    return slugLabel(request.actionKind);
  }
  const executions = evidence.chain.execution.executions;
  if (executions.length > 0) {
    const trigger = executions[0]!.trigger;
    if (trigger.label !== null && trigger.label.trim() !== '') return clip(trigger.label, 120);
    if (trigger.kind.trim() !== '') return slugLabel(trigger.kind);
  }
  if (anchorKind === 'correlation') return 'A decision flow';
  return 'A decision';
}

/** The decision's one-line subtitle. */
function decisionSubtitle(evidence: DecisionEvidence): string {
  const parts: string[] = [];
  const request = evidence.chain.recommendation.actionRequest;
  if (request !== null) {
    parts.push(`Proposed: ${slugLabel(request.actionKind)} (${request.authorityLevel})`);
  } else {
    parts.push('No consequential action was proposed');
  }
  const outcome = evidence.chain.outcome.outcomes[0];
  if (outcome !== undefined && outcome.summary !== '') {
    parts.push(clip(outcome.summary, 110));
  }
  return parts.join(' · ');
}

/** Map an audit-chain evidence observation to its enriched row. */
async function toEvidenceRow(
  ctx: TenantContext,
  observation: EvidenceObservation,
  degraded: string[],
): Promise<EvidenceRowView> {
  if (observation.unreadable) {
    return {
      id: observation.id,
      unreadable: true,
      kind: '—',
      observedAt: '',
      recordedAt: '',
      channel: '—',
      sourceLabel: null,
      sourceId: null,
      confidence: null,
      payload: 'Restricted — you may not read this observation',
      extractor: null,
      freshness: null,
    };
  }
  const freshness = await safe('freshness', degraded, () =>
    evaluateObservationFreshness(ctx, { observationId: observation.id }),
  );
  return {
    id: observation.id,
    unreadable: false,
    kind: observation.kind,
    observedAt: observation.observedAt,
    recordedAt: observation.recordedAt,
    channel: observation.channel,
    sourceLabel: observation.sourceLabel,
    sourceId: null,
    confidence: observation.confidenceValue,
    payload: payloadSummary(observation.payload),
    extractor: observation.extractor,
    freshness:
      freshness === null
        ? null
        : {
            status: freshness.status,
            age: ageLabel(freshness.ageSeconds),
            latency: spanLabel(freshness.latencySeconds),
            latencyExceeded: freshness.latencyExceeded,
          },
  };
}

/** Resolve the registered source refs the enriched observations cite (the source label carries the id in the chain's rows). */
async function buildSourceRows(
  ctx: TenantContext,
  observations: Observation[],
  degraded: string[],
): Promise<SourceRowView[]> {
  // Distinct registered-source ids, in first-cited order (bounded).
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const id = observation.source.id;
    if (id === null || id === undefined) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const sourceIds = [...counts.keys()].slice(0, SOURCE_CAP);

  const rows: SourceRowView[] = [];
  for (const sourceId of sourceIds) {
    const [source, freshness] = await Promise.all([
      safe('sources', degraded, () => getSource(ctx, sourceId)),
      safe('source freshness', degraded, () =>
        evaluateSourceFreshness(ctx, { sourceKind: 'source', sourceId }),
      ),
    ]);
    if (source === null) continue;
    rows.push({
      id: source.id,
      label: source.displayName ?? slugLabel(source.provider),
      provider: source.provider,
      status: source.status,
      freshness:
        freshness === null
          ? null
          : {
              status: freshness.status,
              age: ageLabel(freshness.ageSeconds),
              avgLatency:
                freshness.avgObservedLatencySeconds === null
                  ? null
                  : spanLabel(freshness.avgObservedLatencySeconds),
              maxLatency:
                freshness.maxObservedLatencySeconds === null
                  ? null
                  : spanLabel(freshness.maxObservedLatencySeconds),
              considered: freshness.observationsConsidered,
            },
      observationCount: counts.get(source.id) ?? 0,
    });
  }
  rows.sort((left, right) => left.label.localeCompare(right.label));
  return rows;
}

/** Human-label one side of a contradiction (chain evidence first, then a bounded read). */
async function contradictionSideLabel(
  ctx: TenantContext,
  ref: { kind: 'observation' | 'claim'; id: string },
  evidenceById: Map<string, EvidenceRowView>,
  claimsById: Map<string, { proposition: string }>,
  degraded: string[],
): Promise<ContradictionSideView> {
  if (ref.kind === 'observation') {
    const inChain = evidenceById.get(ref.id);
    if (inChain !== undefined && !inChain.unreadable) {
      return {
        refKind: 'observation',
        id: ref.id,
        label: `${inChain.kind}: ${inChain.payload ?? ''}`.trim(),
      };
    }
    const observation = await safe('contradiction evidence', degraded, () =>
      getObservation(ctx, ref.id),
    );
    if (observation !== null) {
      return {
        refKind: 'observation',
        id: ref.id,
        label: `${observation.kind}: ${payloadSummary(observation.payload, 90)}`,
      };
    }
    return { refKind: 'observation', id: ref.id, label: 'an observation you may not read' };
  }
  const chainClaim = claimsById.get(ref.id);
  if (chainClaim !== undefined) {
    return { refKind: 'claim', id: ref.id, label: clip(chainClaim.proposition, 110) };
  }
  const claim = await safe('contradiction evidence', degraded, () => getClaim(ctx, { claimId: ref.id }));
  if (claim !== null) {
    return { refKind: 'claim', id: ref.id, label: clip(claim.proposition, 110) };
  }
  return { refKind: 'claim', id: ref.id, label: 'a claim you may not read' };
}

/**
 * The retained contradictions involving the decision's evidence — queried
 * per evidence ref through the epistemics contract (both sides, both
 * statuses; lock 12: conflicts are kept, never merged away).
 */
async function buildContradictionRows(
  ctx: TenantContext,
  evidenceRows: EvidenceRowView[],
  chainClaims: DecisionEvidence['chain']['claimsBeliefs']['claims'],
  degraded: string[],
): Promise<ContradictionRowView[]> {
  const refs: { kind: 'observation' | 'claim'; id: string }[] = [];
  for (const row of evidenceRows) {
    if (!row.unreadable) refs.push({ kind: 'observation', id: row.id });
  }
  for (const claim of chainClaims) {
    refs.push({ kind: 'claim', id: claim.id });
  }
  const boundedRefs = refs.slice(0, CONTRADICTION_REF_CAP);

  const byId = new Map<string, Contradiction>();
  for (const ref of boundedRefs) {
    const found = await safe('contradictions', degraded, () =>
      listContradictions(ctx, { evidenceRef: ref, limit: CONTRADICTION_PER_REF_CAP }),
    );
    for (const contradiction of found ?? []) {
      if (byId.size >= CONTRADICTION_ROW_CAP) break;
      byId.set(contradiction.id, contradiction);
    }
    if (byId.size >= CONTRADICTION_ROW_CAP) break;
  }

  const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
  const claimsById = new Map(chainClaims.map((claim) => [claim.id, claim]));

  const rows: ContradictionRowView[] = [];
  for (const contradiction of byId.values()) {
    const [left, right] = await Promise.all([
      contradictionSideLabel(ctx, contradiction.evidenceA, evidenceById, claimsById, degraded),
      contradictionSideLabel(ctx, contradiction.evidenceB, evidenceById, claimsById, degraded),
    ]);
    rows.push({
      id: contradiction.id,
      left,
      right,
      note: contradiction.note,
      status: contradiction.status,
      detectedAt: contradiction.detectedAt,
      resolvedAt: contradiction.resolvedAt,
      resolutionNote: contradiction.resolutionNote,
    });
  }
  rows.sort((left, right) =>
    left.detectedAt === right.detectedAt
      ? left.id.localeCompare(right.id)
      : left.detectedAt < right.detectedAt
        ? 1
        : -1,
  );
  return rows;
}

/**
 * The causal view of ONE decision: the audit module's §24 reconstruction
 * enriched with source reliability/freshness and contradiction display.
 *
 * Anchor resolution is the audit contract's own: a missing (or foreign,
 * or malformed) anchor resolves to `not-found` — the uniform outcome, no
 * existence leak. Everything else degrades per family, never crashes.
 */
export async function buildDecisionExplainView(
  ctx: TenantContext,
  anchorKind: AnchorKind,
  anchorId: string,
): Promise<ExplainResolution> {
  if (!isUuidShape(anchorId)) return { status: 'not-found' };

  let evidence: DecisionEvidence;
  try {
    evidence = await reconstructDecision(ctx, reconstructQuery(anchorKind, anchorId));
  } catch {
    // The audit contract's uniform not-found (another tenant's anchors
    // included) — the page renders its honest not-found state.
    return { status: 'not-found' };
  }

  const degraded: string[] = [];

  // Evidence rows, bounded, enriched with per-observation freshness.
  const observations = evidence.chain.evidence.observations.slice(0, EVIDENCE_ROW_CAP);
  const evidenceRows: EvidenceRowView[] = [];
  for (const observation of observations) {
    evidenceRows.push(await toEvidenceRow(ctx, observation, degraded));
  }

  // Source reliability/freshness: resolve the registered sources the
  // readable observations cite. The §24 rows carry only source LABELS, so
  // the registered ids are re-read through the observations contract
  // (bounded by the same cap as the rendered rows).
  const readableRows = evidenceRows.filter((row) => !row.unreadable);
  const sourceObservations: Observation[] = [];
  for (const row of readableRows) {
    const observation = await safe('evidence', degraded, () => getObservation(ctx, row.id));
    if (observation !== null) sourceObservations.push(observation);
  }
  const sources = await buildSourceRows(ctx, sourceObservations, degraded);
  const sourceIds = new Set(sources.map((source) => source.id));
  const sourceLabelById = new Map(
    sources.map((source) => [source.id, `${source.label} (${source.provider})`]),
  );
  for (const row of readableRows) {
    const observation = sourceObservations.find((candidate) => candidate.id === row.id);
    const sourceId = observation?.source.id ?? null;
    if (sourceId !== null && sourceIds.has(sourceId)) {
      row.sourceId = sourceId;
      row.sourceLabel = sourceLabelById.get(sourceId) ?? row.sourceLabel;
    }
  }

  // Contradiction display (lock 12).
  const contradictions = await buildContradictionRows(
    ctx,
    evidenceRows,
    evidence.chain.claimsBeliefs.claims,
    degraded,
  );

  return {
    status: 'found',
    view: {
      anchorKind,
      anchorId,
      kindLabel: ANCHOR_KIND_LABEL[anchorKind],
      title: decisionTitle(anchorKind, evidence),
      subtitle: decisionSubtitle(evidence),
      correlationId: evidence.correlationId,
      reconstructedAt: evidence.reconstructedAt,
      chain: evidence.chain,
      completeness: evidence.completeness,
      evidenceRows,
      sources,
      contradictions,
      links: {
        // The tower Missions surface is the working mission destination
        // at this base (the product mission route is mis-shipped — see
        // the delivery report's DEVIATIONS).
        missionBase: '/missions',
        unknown: (unknownId: string) => `/intelligence/unknowns/${unknownId}`,
      },
      auditRecords: evidence.auditRecords,
      degraded,
    },
  };
}
