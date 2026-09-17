// Management Control Tower (W033) — the Evidence view.
//
// Immutable observations with full provenance (W004, lock 5): source,
// channel, timestamps, extraction lineage, permissions and confidence.
// The tower lists the tenant's evidence feed through the observations
// contract only — it can never mutate, promote or "verify" evidence
// (lock 10: observations are never authoritative truth).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listObservations } from '@/modules/observations/contract';
import type { Observation } from '@/modules/observations/contract';

const CAP = 100;

export interface EvidenceItem {
  id: string;
  kind: string;
  channel: string;
  source: Observation['source'];
  observedAt: string;
  recordedAt: string;
  confidence: Observation['confidence'];
  visibility: Observation['permissions']['visibility'];
  lineageMethod: string | null;
}

export interface EvidenceView {
  generatedAt: string;
  total: number;
  capped: boolean;
  byKind: { kind: string; count: number }[];
  items: EvidenceItem[];
}

/** Build the Evidence view (the immutable observation feed). */
export async function buildEvidenceView(ctx: TenantContext): Promise<EvidenceView> {
  const observations = await listObservations(ctx, { limit: CAP });
  const kindCounts = new Map<string, number>();
  for (const observation of observations) {
    kindCounts.set(observation.kind, (kindCounts.get(observation.kind) ?? 0) + 1);
  }
  return {
    generatedAt: now().toISOString(),
    total: observations.length,
    capped: observations.length >= CAP,
    byKind: [...kindCounts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
    items: observations.map((observation: Observation) => ({
      id: observation.id,
      kind: observation.kind,
      channel: observation.channel,
      source: observation.source,
      observedAt: observation.observedAt,
      recordedAt: observation.recordedAt,
      confidence: observation.confidence,
      visibility: observation.permissions.visibility,
      lineageMethod: observation.lineage.method,
    })),
  };
}
