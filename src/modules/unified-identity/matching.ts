// The ambiguity guard (W095) — PURE decision logic, no I/O.
//
// An observation's contact facets (email / E.164 phone) are only EVIDENCE:
// they become a link when they point at EXACTLY ONE organizational person
// through that person's VERIFIED, subject-linked identities, and they
// become an AMBIGUITY when they point at more than one (or away from an
// existing link). Ambiguous evidence NEVER merges the observation onto a
// subject — the acceptance rule — and display names are deliberately
// never evidence (name similarity is not identity proof).
//
// Candidate GATHERING (which verified identities a facet matches) is the
// service layer's job through the identity contract; this file only
// decides what a gathered candidate set means.

import type { MatchCandidate } from './types';

export type MatchDecision =
  | { kind: 'none' }
  | { kind: 'unique'; personId: string; candidates: MatchCandidate[] }
  | { kind: 'ambiguous'; candidates: MatchCandidate[] };

/** Distinct person ids among the candidates, in first-appearance order. */
export function distinctPersons(candidates: MatchCandidate[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const candidate of candidates) {
    if (!seen.has(candidate.personId)) {
      seen.add(candidate.personId);
      ordered.push(candidate.personId);
    }
  }
  return ordered;
}

/**
 * The ambiguity-guarded match decision:
 * - no candidate            → `none`  (stays unverified; nothing to merge);
 * - exactly one distinct person → `unique` (the one legal auto-link);
 * - more than one distinct person → `ambiguous` (never auto-merged).
 */
export function decideMatch(candidates: MatchCandidate[]): MatchDecision {
  const persons = distinctPersons(candidates);
  if (persons.length === 0) return { kind: 'none' };
  if (persons.length === 1) return { kind: 'unique', personId: persons[0]!, candidates };
  return { kind: 'ambiguous', candidates };
}

/** How gathered evidence relates to an ALREADY-VERIFIED row's subject. */
export type LinkedEvidenceRelation =
  | { relation: 'consistent'; candidates: MatchCandidate[] }
  | { relation: 'no_evidence' }
  | {
      relation: 'conflict';
      /** The distinct persons the evidence points at (excluding none). */
      candidates: MatchCandidate[];
    };

/**
 * Evidence vs an existing verified link: consistent when every candidate
 * agrees with the linked subject (or there is no evidence at all);
 * a conflict otherwise — the conflict is recorded as an ambiguity and the
 * link is RETAINED (stability: unification never re-links behind the
 * tenant's back).
 */
export function relateEvidenceToSubject(
  linkedPersonId: string,
  candidates: MatchCandidate[],
): LinkedEvidenceRelation {
  if (candidates.length === 0) return { relation: 'no_evidence' };
  const persons = distinctPersons(candidates);
  if (persons.length === 1 && persons[0] === linkedPersonId) {
    return { relation: 'consistent', candidates };
  }
  return { relation: 'conflict', candidates };
}

/** Renders the evidence trail for a link/ambiguity record (human-readable). */
export function describeCandidates(candidates: MatchCandidate[]): string {
  return candidates
    .map(
      (candidate) =>
        `${candidate.matchedVia} identity '${candidate.providerAccountId}' → person ${candidate.personId}`,
    )
    .join('; ');
}
