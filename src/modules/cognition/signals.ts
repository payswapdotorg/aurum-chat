// Pure acquisition-signal derivation of the cognition module (W013).
//
// The knowledge-acquisition stage of the canonical loop (§19) drives the
// W012 planner. The planner's contract (knowledge-acquisition/types.ts)
// is explicit about the division of labor:
//
//   "The signal VALUES are caller input at this layer (W013 cognition and
//    W052 knowledge source ranking compute them from memory, the world
//    model and the CompanyModel); the planner owns the deterministic
//    evaluation, selection, budgeting, questioning and the persisted
//    rationale."
//
// This file is that W013 half: a DETERMINISTIC, workflow-level default
// that derives one ADR-0018 signal vector per candidate of the mission's
// current menu from the data that exists on this base — the tenant's
// transactive memory (W010: "who knows, owns, decides, has experience
// with, influences, or can perform a capability"). The same menu plus the
// same memory state always produce the same vectors (ADR-0018:
// "ranking is deterministic at the policy/workflow level"), and the
// planner persists the full rationale, so a selection that changed
// because memory changed is reconstructable from the two snapshots.
//
// What the default knows today, per signal:
//   relevance — for a `person` candidate with an id: the share of the
//     execution's focus topics that transactive memory attributes to that
//     person (topic coverage in [0, 1]; 0 when memory knows nothing about
//     them). Every other candidate (and id-less persons) takes the
//     neutral prior: memory carries no per-source coverage for systems,
//     documents, external sources, agents or analyses yet.
//   reliability / freshness / authority / expectedQuality — the neutral
//     prior: no contribution history (W042), reliability tracking (W052)
//     or freshness evaluation (W006-derived source stats) exists on this
//     base; learning may never invent confidence it cannot source.
//   priorContributionValue — 0 for the same reason (no contributions
//     module yet).
//   cost — 0 minor units: no source-cost policy exists yet (W036/W052);
//     the mission-budget gate in W012 therefore stays permissive until a
//     tenant configures costs.
//   access — 'allowed': explicit access scopes are caller input at the
//     W012 layer; this default never fabricates a restriction it cannot
//     source, and never overrides one (the planner excludes 'forbidden'
//     candidates itself).
//
// W052 (Knowledge Source Ranking) will replace this default with the
// learned, versioned source-ranking policy; the loop stage calls whatever
// deterministic policy is wired here, so the swap is local.

import type { CandidateSignals } from '@/modules/knowledge-acquisition/contract';
import type { MissionCandidate, MissionCandidateKind } from '@/modules/missions/contract';

/** Neutral prior for signals no module on this base can source yet. */
export const NEUTRAL_SIGNAL = 0.5;

/** Default investigation cost (minor units) while no source-cost policy exists. */
export const DEFAULT_INVESTIGATION_COST = 0;

/**
 * The transactive-memory view the derivation consumes: one row per
 * entry — which organizational actor it is about, and the topics it
 * covers. Produced by the service through the memory contract
 * (listTransactiveEntries filtered to the execution's focus topics);
 * kept as a plain structural type so this file stays pure.
 */
export interface TransactiveCoverageRow {
  actorKind: 'person' | 'agent' | 'team';
  actorId: string | null;
  topics: string[];
}

export interface SignalDerivationInput {
  /** The execution's focus topics (1..16 lowercase slugs). */
  focusTopics: string[];
  /** The mission's CURRENT candidate menu (the W012 planner's menu). */
  menu: MissionCandidate[];
  /** Transactive-memory entries matching the focus topics. */
  transactive: TransactiveCoverageRow[];
}

/**
 * Topic coverage of one person: the share of `focusTopics` that at least
 * one transactive-memory entry attributes to them. Deterministic and
 * order-independent (set semantics).
 */
export function personTopicCoverage(
  personId: string,
  focusTopics: string[],
  transactive: TransactiveCoverageRow[],
): number {
  const focus = new Set(focusTopics);
  if (focus.size === 0) return 0;
  const covered = new Set<string>();
  for (const row of transactive) {
    if (row.actorKind !== 'person' || row.actorId !== personId) continue;
    for (const topic of row.topics) {
      if (focus.has(topic)) covered.add(topic);
    }
  }
  return covered.size / focus.size;
}

/**
 * Derive the deterministic default signal vector for every candidate of
 * the mission's menu. One vector per menu entry, menu order preserved —
 * exactly the `candidates` array `planNextAcquisition` expects (the
 * planner itself rejects missing or extra entries, so completeness is
 * structural here: the caller passes the mission's live menu).
 */
export function deriveAcquisitionSignals(
  input: SignalDerivationInput,
): CandidateSignals[] {
  return input.menu.map((candidate: MissionCandidate): CandidateSignals => {
    let relevance = NEUTRAL_SIGNAL;
    if (candidate.kind === 'person' && typeof candidate.id === 'string') {
      relevance = personTopicCoverage(candidate.id, input.focusTopics, input.transactive);
    }
    return {
      kind: candidate.kind as MissionCandidateKind,
      id: candidate.id ?? null,
      label: candidate.label ?? null,
      relevance: round6(relevance),
      reliability: NEUTRAL_SIGNAL,
      freshness: NEUTRAL_SIGNAL,
      authority: NEUTRAL_SIGNAL,
      expectedQuality: NEUTRAL_SIGNAL,
      priorContributionValue: 0,
      cost: DEFAULT_INVESTIGATION_COST,
      access: 'allowed',
    };
  });
}

/** Round to 6 decimals — the planner's score precision (deterministic output). */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
