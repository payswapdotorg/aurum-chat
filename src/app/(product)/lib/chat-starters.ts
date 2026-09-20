// Product shell (W057) — the chat discovery starters.
//
// PRODUCT-SURFACE-DEPLOYMENT-PLAN §3 "Chat discovery starters": "The first
// Aurum conversation should expose useful examples" — the eight canonical
// starters, verbatim. In this shell they are the honest empty state of the
// conversation area: until the chat experience (W060) lands the live
// workflow, a starter selects itself into the URL (`/chat?q=<id>`) so the
// selection survives navigation and the composer-to-be has a stable input
// contract to consume.

export interface ChatStarter {
  /** Stable slug — also the `?q=` value. */
  id: string;
  /** The starter question, verbatim from the plan. */
  question: string;
  /** Why a manager would ask this. */
  hint: string;
  /** The starter's chat href (scope is appended at render time). */
  href: string;
}

function starter(
  id: string,
  question: string,
  hint: string,
): ChatStarter {
  return { id, question, hint, href: `/chat?q=${id}` };
}

/** The eight canonical starters, in plan order. */
export const CHAT_STARTERS: readonly ChatStarter[] = [
  starter('attention', 'What needs my attention?', 'The urgent few, ranked'),
  starter('changed', 'What changed?', 'Movement since you last looked'),
  starter('unknowns', "What don't we know?", 'Open unknowns and their cost'),
  starter('goals', 'How are we doing against our goals?', 'Goal progress and drift'),
  starter('inefficiency', 'Where are we inefficient?', 'Processes, duplication, effort'),
  starter('improve', 'What should we improve?', 'Aurum’s current best recommendations'),
  starter('why', 'Show me why.', 'Evidence and reasoning behind a finding'),
  starter('learning', 'What is Aurum learning about our company?', 'The versioned company model'),
];

/** Look up the starter a `?q=` value refers to (ids only — no free text yet). */
export function findStarter(q: string | null | undefined): ChatStarter | null {
  if (q === null || q === undefined) return null;
  const trimmed = q.trim();
  if (trimmed === '') return null;
  return CHAT_STARTERS.find((candidate) => candidate.id === trimmed) ?? null;
}

/**
 * The href for a starter with an optional query suffix appended (starts
 * with `?` when non-empty — the starter href already carries `?q=`).
 * Since W058 the suffix is empty: the session carries the scope.
 */
export function starterHref(
  candidate: ChatStarter,
  scopeQuery: string,
): string {
  if (scopeQuery === '') return candidate.href;
  return candidate.href.includes('?')
    ? `${candidate.href}&${scopeQuery.slice(1)}`
    : `${candidate.href}${scopeQuery}`;
}
