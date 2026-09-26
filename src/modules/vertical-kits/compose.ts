// Pure recipe composition (W092) — how a kit's deep-action recipe
// template becomes the deep-actions gateway's own input shape.
//
// This file contains NO execution logic and touches no database: it is
// the proof that a kit's recipes are DATA validated against the W084
// contract shapes — given a kit, one of its recipes and the caller's
// resolved broker connections (kit requirement key → the tenant's W082
// connection id), it derives an ordinary `CreateDeepActionInput` the
// gateway accepts as-is. The tenant's own deep-action creation call
// (and its W009 gate, W083 invocations, receipts, pre/post-state
// evidence and reconciliation) stays ENTIRELY in the deep-actions
// module — this module never executes, proposes or authorizes anything.
//
// The edge expectation rides along as DATA ONLY: an edge-expecting
// recipe composes exactly like any other (the W088 edge path is
// pending; nothing here waits for it, claims it or simulates it).

import type { CreateDeepActionInput } from '@/modules/deep-actions/contract';
import type { DeepActionRecipeTemplate, VerticalKitDefinition } from './types';
import { VerticalKitsError } from './errors';

/**
 * Instantiate one kit recipe into the deep-actions gateway's input
 * shape. `resolvedConnections` maps each connection requirement key the
 * recipe rides to the tenant's concrete broker connection id (W082 —
 * opaque); every referenced requirement must be resolved or the
 * composition is refused (fail-closed, before any gateway call).
 */
export function composeDeepActionInput(
  kit: VerticalKitDefinition,
  recipe: DeepActionRecipeTemplate,
  resolvedConnections: Record<string, string>,
): CreateDeepActionInput {
  if (typeof resolvedConnections !== 'object' || resolvedConnections === null) {
    throw new VerticalKitsError('invalid_input', 'resolvedConnections must be an object');
  }
  if (!kit.deepActionRecipes.some((candidate) => candidate.recipeKey === recipe.recipeKey)) {
    throw new VerticalKitsError(
      'invalid_input',
      `recipe '${recipe.recipeKey}' is not a recipe of kit '${kit.kitKey}'`,
    );
  }
  for (const operation of recipe.operations) {
    const connectionId = resolvedConnections[operation.connectionKey];
    if (typeof connectionId !== 'string' || connectionId.trim().length === 0) {
      throw new VerticalKitsError(
        'invalid_input',
        `operation '${operation.key}' rides connection requirement '${operation.connectionKey}' which has no resolved broker connection — resolve the tenant's connection first`,
      );
    }
  }
  return {
    taskContext: {
      description: recipe.description,
      requestedFor: null,
    },
    operations: recipe.operations.map((operation) => ({
      key: operation.key,
      connectionId: resolvedConnections[operation.connectionKey]!,
      capabilityKey: operation.capabilityKey,
      target: operation.targetTemplate,
      payload: operation.payload,
      expectation: operation.expectation,
    })),
    idempotencyKey: null,
  };
}
