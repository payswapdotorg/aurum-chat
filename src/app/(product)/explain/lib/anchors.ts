// Evidence, audit & explainability (W065) — anchor addressing.
//
// The audit module's `reconstructDecision` (W046) anchors a causal
// reconstruction on exactly one of three things:
//
//   · a cognitive execution id      (the canonical decision cycle),
//   · an action request id          (the approval-centric view), or
//   · a §25 correlation id          (a whole logical flow).
//
// This module is the URL grammar of the explain surface: the short,
// human-typed path segments (`execution` / `action` / `correlation`)
// mapped onto those anchors, and back. It is PURE (no server imports) so
// the unit tests cover it without a database, and every page, row and
// deep link in the surface builds its href through ONE function — links
// can never drift from the router.

/** The path segments the explain surface addresses anchors by. */
export const ANCHOR_SEGMENTS = ['execution', 'action', 'correlation'] as const;

export type AnchorSegment = (typeof ANCHOR_SEGMENTS)[number];

/** The audit contract's anchor kinds these segments map onto. */
export type AnchorKind = 'execution' | 'action-request' | 'correlation';

/** The segment each anchor kind is addressed by. */
const SEGMENT_BY_KIND: Record<AnchorKind, AnchorSegment> = {
  execution: 'execution',
  'action-request': 'action',
  correlation: 'correlation',
};

/** The anchor kind each segment addresses. */
const KIND_BY_SEGMENT: Record<AnchorSegment, AnchorKind> = {
  execution: 'execution',
  action: 'action-request',
  correlation: 'correlation',
};

/** Human labels for the anchor kinds (gate 10: no naked vocabulary). */
export const ANCHOR_KIND_LABEL: Record<AnchorKind, string> = {
  execution: 'Decision cycle',
  'action-request': 'Action request',
  correlation: 'Decision flow',
};

/** Is this path segment one of the surface's anchor segments? */
export function isAnchorSegment(value: string): value is AnchorSegment {
  return (ANCHOR_SEGMENTS as readonly string[]).includes(value);
}

/** Map a path segment onto the anchor kind it addresses (null when foreign). */
export function anchorKindForSegment(segment: string): AnchorKind | null {
  return isAnchorSegment(segment) ? KIND_BY_SEGMENT[segment] : null;
}

/** The segment an anchor kind is addressed by. */
export function segmentForAnchorKind(kind: AnchorKind): AnchorSegment {
  return SEGMENT_BY_KIND[kind];
}

/** The shape a uuid must have (the contracts' ids are uuids; ids are not truth). */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Does this look like a uuid? (A shape check only — existence is the contracts' call.) */
export function isUuidShape(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/** The deep link to one reconstructable decision, by anchor kind + id. */
export function anchorHref(kind: AnchorKind, id: string): string {
  return `/explain/${segmentForAnchorKind(kind)}/${id}`;
}

/** The query object `reconstructDecision` takes for this anchor kind + id. */
export function reconstructQuery(
  kind: AnchorKind,
  id: string,
): { executionId: string } | { actionRequestId: string } | { correlationId: string } {
  if (kind === 'execution') return { executionId: id };
  if (kind === 'action-request') return { actionRequestId: id };
  return { correlationId: id };
}
