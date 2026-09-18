// Management Control Tower (W033) — the Situation view.
//
// "Situation" is the tenant's current working picture of itself and its
// environment (ARCHITECTURE.md §4): the world model's entities and
// relationships (W005 — mutable current understanding), the epistemics
// module's active beliefs (W007 — versioned working understanding with
// provenance, lock 11), the latest derived claims and the open
// contradictions that are deliberately retained (lock 12).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import { listClaims } from '@/modules/epistemics/contract';
import type { Claim } from '@/modules/epistemics/contract';
import { listContradictions } from '@/modules/epistemics/contract';
import type { Contradiction } from '@/modules/epistemics/contract';
import { getBelief, listBeliefs } from '@/modules/epistemics/contract';
import { EpistemicsError } from '@/modules/epistemics/contract';
import type { Belief, BeliefAnchor } from '@/modules/epistemics/contract';
import { listEntities } from '@/modules/world/contract';
import type { WorldEntity } from '@/modules/world/contract';
import { listRelationships } from '@/modules/world/contract';
import type { WorldRelationship } from '@/modules/world/contract';

const CAP = 200;

export interface SituationWorldEntity {
  id: string;
  kind: string;
  name: string;
  description: string | null;
  updatedAt: string;
}

export interface SituationRelationship {
  id: string;
  type: string;
  from: string;
  to: string;
}

export interface SituationBelief {
  id: string;
  proposition: string;
  confidence: number;
  validFrom: string;
  recordedAt: string;
  version: number;
  provenanceCount: number;
}

export interface SituationClaim {
  id: string;
  proposition: string;
  confidence: number;
  recordedAt: string;
  evidenceCount: number;
}

export interface SituationContradiction {
  id: string;
  note: string;
  detectedAt: string;
  evidenceA: Contradiction['evidenceA'];
  evidenceB: Contradiction['evidenceB'];
}

export interface SituationView {
  generatedAt: string;
  world: {
    total: number;
    capped: boolean;
    byKind: { kind: string; count: number }[];
    entities: SituationWorldEntity[];
    relationships: SituationRelationship[];
    relationshipCount: number;
  };
  beliefs: {
    activeCount: number;
    latest: SituationBelief[];
  };
  claims: SituationClaim[];
  contradictions: { openCount: number; latest: SituationContradiction[] };
}

/** Build the Situation view from world + epistemics contracts. */
export async function buildSituationView(ctx: TenantContext): Promise<SituationView> {
  const [entities, relationships, beliefAnchors, claims, openContradictions] =
    await Promise.all([
      listEntities(ctx, { limit: CAP }),
      listRelationships(ctx, { limit: CAP }),
      listBeliefs(ctx, { limit: CAP }),
      listClaims(ctx, { limit: 10 }),
      listContradictions(ctx, { status: 'open', limit: CAP }),
    ]);

  const kindCounts = new Map<string, number>();
  for (const entity of entities) {
    kindCounts.set(entity.kind, (kindCounts.get(entity.kind) ?? 0) + 1);
  }

  const activeAnchors: BeliefAnchor[] = beliefAnchors.filter(
    (anchor) => anchor.status === 'active',
  );
  // listBeliefs returns anchors; the current statement of each belief is
  // resolved per belief (bounded: the newest 8 active anchors). An anchor
  // whose first version is not yet valid (validFrom in the future) has no
  // statement as of now — it stays counted but is not listed as current
  // understanding.
  const beliefs: Belief[] = [];
  for (const anchor of activeAnchors.slice(0, 8)) {
    try {
      beliefs.push(await getBelief(ctx, { beliefId: anchor.id }));
    } catch (error) {
      if (
        error instanceof EpistemicsError &&
        error.code === 'belief_version_not_found'
      ) {
        continue;
      }
      throw error;
    }
  }

  return {
    generatedAt: now().toISOString(),
    world: {
      total: entities.length,
      capped: entities.length >= CAP,
      byKind: [...kindCounts.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
      entities: entities.slice(0, 12).map((entity: WorldEntity) => ({
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        description: entity.description,
        updatedAt: entity.updatedAt,
      })),
      relationships: relationships
        .slice(0, 8)
        .map((rel: WorldRelationship) => ({
          id: rel.id,
          type: rel.type,
          from: rel.fromEntityId,
          to: rel.toEntityId,
        })),
      relationshipCount: relationships.length,
    },
    beliefs: {
      activeCount: activeAnchors.length,
      latest: beliefs.map((belief: Belief) => ({
        id: belief.id,
        proposition: belief.statement.proposition,
        confidence: belief.statement.confidence.value,
        validFrom: belief.validFrom,
        recordedAt: belief.recordedAt,
        version: belief.version,
        provenanceCount: belief.provenance.observationIds.length,
      })),
    },
    claims: claims.map((claim: Claim) => ({
      id: claim.id,
      proposition: claim.proposition,
      confidence: claim.confidence.value,
      recordedAt: claim.recordedAt,
      evidenceCount: claim.evidenceObservationIds.length,
    })),
    contradictions: {
      openCount: openContradictions.length,
      latest: openContradictions.slice(0, 8).map((c: Contradiction) => ({
        id: c.id,
        note: c.note,
        detectedAt: c.detectedAt,
        evidenceA: c.evidenceA,
        evidenceB: c.evidenceB,
      })),
    },
  };
}
