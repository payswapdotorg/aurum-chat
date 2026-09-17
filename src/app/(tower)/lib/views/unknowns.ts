// Management Control Tower (W033) — the Unknowns view.
//
// Unknown is first-class (lock 7): a question Aurum cannot answer PLUS
// the consequence of the gap. The tower lists open unknowns (the
// management-visible knowledge debt) and recently resolved ones, through
// the epistemics contract only.

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listUnknowns } from '@/modules/epistemics/contract';
import type { Unknown } from '@/modules/epistemics/contract';

const CAP = 200;

export interface UnknownItem {
  id: string;
  question: string;
  consequence: string;
  subject: Unknown['subject'];
  recordedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
  related: { observations: number; claims: number; beliefs: number };
}

export interface UnknownsView {
  generatedAt: string;
  open: { total: number; capped: boolean; items: UnknownItem[] };
  resolved: { total: number; items: UnknownItem[] };
}

/** Build the Unknowns view (open knowledge gaps first-class). */
export async function buildUnknownsView(ctx: TenantContext): Promise<UnknownsView> {
  const [open, resolved] = await Promise.all([
    listUnknowns(ctx, { status: 'open', limit: CAP }),
    listUnknowns(ctx, { status: 'resolved', limit: 20 }),
  ]);
  const item = (unknown: Unknown): UnknownItem => ({
    id: unknown.id,
    question: unknown.question,
    consequence: unknown.consequence,
    subject: unknown.subject,
    recordedAt: unknown.recordedAt,
    resolvedAt: unknown.resolvedAt,
    resolutionNote: unknown.resolutionNote,
    related: {
      observations: unknown.relatedObservationIds.length,
      claims: unknown.relatedClaimIds.length,
      beliefs: unknown.relatedBeliefIds.length,
    },
  });
  return {
    generatedAt: now().toISOString(),
    open: {
      total: open.length,
      capped: open.length >= CAP,
      items: open.map(item),
    },
    resolved: { total: resolved.length, items: resolved.map(item) },
  };
}
