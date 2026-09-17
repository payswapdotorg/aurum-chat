// The v1 route table and its pure matcher (W038 — Public API).
//
// This file is deliberately framework-free: the table IS the versioned
// public surface, one entry per capability-oriented operation, each naming
// the API scope a key must hold. The Next.js adapter under
// src/app/api/v1/** translates HTTP into (method, path segments) and the
// kernel matches them here — no routing logic lives in the framework
// layer, so the whole surface is testable without HTTP.
//
// Matching discipline: a route matches when methods are equal, segment
// counts are equal and every segment is either statically equal or a
// `:param` capture. When several routes fit, the one with the FEWEST
// parameters wins (static segments beat captures), which is what lets
// `/webhooks/dispatch` and `/agents/executions/:id` coexist with their
// `:param` neighbors.

import { API_KEY_AUTHORITY_CLAIMS, API_SCOPES, type ApiScope } from './scopes';
import {
  API_BASE_PATH,
  API_VERSION,
  type ApiDiscoveryDocument,
  type ApiOperationDescriptor,
} from './types';

export type ApiMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** One row of the v1 surface. */
export interface ApiRouteSpec {
  method: ApiMethod;
  /** Path segments below `/api/v1`; `:name` captures one segment. */
  segments: string[];
  /** Stable operation id (audit payloads + the handler registry). */
  operation: string;
  /** Required capability scope; null marks the unauthenticated surface. */
  scope: ApiScope | null;
  /** Success status for the operation (200; 201 for creations). */
  successStatus?: 200 | 201;
}

const CREATED = 201 as const;

/** The complete v1 public surface (lock 31: capabilities, never tables). */
export const API_ROUTES: readonly ApiRouteSpec[] = [
  // -- discovery ------------------------------------------------------------
  { method: 'GET', segments: [], operation: 'discovery', scope: null },

  // -- goals (inspect management goals, W008) -------------------------------
  { method: 'GET', segments: ['goals'], operation: 'goals.list', scope: 'goals:read' },
  { method: 'GET', segments: ['goals', ':goalId'], operation: 'goals.get', scope: 'goals:read' },
  {
    method: 'GET',
    segments: ['goals', ':goalId', 'versions'],
    operation: 'goals.versions',
    scope: 'goals:read',
  },
  {
    method: 'GET',
    segments: ['goals', ':goalId', 'versions', ':version'],
    operation: 'goals.version',
    scope: 'goals:read',
  },

  // -- unknowns & beliefs (inspect the epistemic state, W007) ---------------
  {
    method: 'GET',
    segments: ['unknowns'],
    operation: 'unknowns.list',
    scope: 'epistemics:read',
  },
  {
    method: 'GET',
    segments: ['unknowns', ':unknownId'],
    operation: 'unknowns.get',
    scope: 'epistemics:read',
  },
  {
    method: 'GET',
    segments: ['beliefs'],
    operation: 'beliefs.list',
    scope: 'epistemics:read',
  },
  {
    method: 'GET',
    segments: ['beliefs', ':beliefId'],
    operation: 'beliefs.get',
    scope: 'epistemics:read',
  },

  // -- missions (inspect + request investigations, W011) --------------------
  {
    method: 'GET',
    segments: ['missions'],
    operation: 'missions.list',
    scope: 'missions:read',
  },
  {
    method: 'GET',
    segments: ['missions', ':missionId'],
    operation: 'missions.get',
    scope: 'missions:read',
  },
  {
    method: 'GET',
    segments: ['missions', ':missionId', 'versions'],
    operation: 'missions.versions',
    scope: 'missions:read',
  },
  {
    method: 'GET',
    segments: ['missions', ':missionId', 'versions', ':version'],
    operation: 'missions.version',
    scope: 'missions:read',
  },
  {
    method: 'POST',
    segments: ['missions'],
    operation: 'missions.create',
    scope: 'missions:write',
    successStatus: CREATED,
  },
  {
    method: 'PATCH',
    segments: ['missions', ':missionId'],
    operation: 'missions.revise',
    scope: 'missions:write',
  },
  {
    method: 'POST',
    segments: ['missions', ':missionId', 'completion'],
    operation: 'missions.complete',
    scope: 'missions:write',
  },
  {
    method: 'POST',
    segments: ['missions', ':missionId', 'abandonment'],
    operation: 'missions.abandon',
    scope: 'missions:write',
  },

  // -- knowledge (query company knowledge, W010) -----------------------------
  {
    method: 'GET',
    segments: ['knowledge'],
    operation: 'knowledge.list',
    scope: 'knowledge:read',
  },
  {
    method: 'GET',
    segments: ['knowledge', ':entryId'],
    operation: 'knowledge.get',
    scope: 'knowledge:read',
  },
  {
    method: 'GET',
    segments: ['knowledge', ':entryId', 'evidence'],
    operation: 'knowledge.evidence',
    scope: 'knowledge:read',
  },

  // -- evidence (retrieve observations + lineage, W004) ----------------------
  {
    method: 'GET',
    segments: ['observations'],
    operation: 'observations.list',
    scope: 'evidence:read',
  },
  {
    method: 'GET',
    segments: ['observations', ':observationId'],
    operation: 'observations.get',
    scope: 'evidence:read',
  },
  {
    method: 'GET',
    segments: ['observations', ':observationId', 'lineage'],
    operation: 'observations.lineage',
    scope: 'evidence:read',
  },

  // -- capabilities (the capability graph + gap findings, W017) --------------
  {
    method: 'GET',
    segments: ['capabilities'],
    operation: 'capabilities.list',
    scope: 'capabilities:read',
  },
  {
    method: 'GET',
    segments: ['capabilities', 'gaps'],
    operation: 'capabilities.gaps',
    scope: 'capabilities:read',
  },
  {
    method: 'GET',
    segments: ['capabilities', ':capabilityId'],
    operation: 'capabilities.get',
    scope: 'capabilities:read',
  },

  // -- agents (inspect the agent workforce + traces, W021) -------------------
  { method: 'GET', segments: ['agents'], operation: 'agents.list', scope: 'agents:read' },
  { method: 'GET', segments: ['agents', ':agentId'], operation: 'agents.get', scope: 'agents:read' },
  {
    method: 'GET',
    segments: ['agents', ':agentId', 'executions'],
    operation: 'agents.executions',
    scope: 'agents:read',
  },
  {
    method: 'GET',
    segments: ['agents', 'executions', ':executionId'],
    operation: 'agents.execution',
    scope: 'agents:read',
  },
  {
    method: 'GET',
    segments: ['agents', 'executions', ':executionId', 'attempts'],
    operation: 'agents.attempts',
    scope: 'agents:read',
  },

  // -- approvals (the W009 authority gates — including proposing agent
  //    recruitment, ARCHITECTURE.md §20/'agent-recruitment') -----------------
  {
    method: 'GET',
    segments: ['approvals'],
    operation: 'approvals.list',
    scope: 'approvals:read',
  },
  {
    method: 'POST',
    segments: ['approvals'],
    operation: 'approvals.create',
    scope: 'approvals:write',
    successStatus: CREATED,
  },
  {
    method: 'GET',
    segments: ['approvals', ':requestId'],
    operation: 'approvals.get',
    scope: 'approvals:read',
  },
  {
    method: 'GET',
    segments: ['approvals', ':requestId', 'decisions'],
    operation: 'approvals.decisions',
    scope: 'approvals:read',
  },
  {
    method: 'POST',
    segments: ['approvals', ':requestId', 'decisions'],
    operation: 'approvals.decide',
    scope: 'approvals:write',
    successStatus: CREATED,
  },

  // -- api keys (manage the machine credentials themselves). Fail-closed
  //    double gate over HTTP: the 'api:administer' SCOPE here plus the
  //    key's 'api:administer' authority claim (service-level gate). -------
  {
    method: 'POST',
    segments: ['api-keys'],
    operation: 'apiKeys.create',
    scope: 'api:administer',
    successStatus: CREATED,
  },
  { method: 'GET', segments: ['api-keys'], operation: 'apiKeys.list', scope: 'api:administer' },
  {
    method: 'DELETE',
    segments: ['api-keys', ':keyId'],
    operation: 'apiKeys.revoke',
    scope: 'api:administer',
  },

  // -- webhooks (the outbound event surface) ----------------------------------
  {
    method: 'POST',
    segments: ['webhooks'],
    operation: 'webhooks.create',
    scope: 'webhooks:manage',
    successStatus: CREATED,
  },
  {
    method: 'GET',
    segments: ['webhooks'],
    operation: 'webhooks.list',
    scope: 'webhooks:manage',
  },
  {
    method: 'GET',
    segments: ['webhooks', ':subscriptionId'],
    operation: 'webhooks.get',
    scope: 'webhooks:manage',
  },
  {
    method: 'DELETE',
    segments: ['webhooks', ':subscriptionId'],
    operation: 'webhooks.deactivate',
    scope: 'webhooks:manage',
  },
  {
    method: 'POST',
    segments: ['webhooks', ':subscriptionId', 'test'],
    operation: 'webhooks.test',
    scope: 'webhooks:manage',
    successStatus: CREATED,
  },
  {
    method: 'GET',
    segments: ['webhooks', ':subscriptionId', 'deliveries'],
    operation: 'webhooks.deliveries',
    scope: 'webhooks:manage',
  },
  {
    method: 'GET',
    segments: ['webhooks', 'deliveries', ':deliveryId'],
    operation: 'webhooks.delivery',
    scope: 'webhooks:manage',
  },
  {
    method: 'POST',
    segments: ['webhooks', 'deliveries', ':deliveryId', 'redeliver'],
    operation: 'webhooks.redeliver',
    scope: 'webhooks:manage',
    successStatus: CREATED,
  },
  {
    method: 'POST',
    segments: ['webhooks', 'dispatch'],
    operation: 'webhooks.dispatch',
    scope: 'webhooks:manage',
  },
  {
    method: 'POST',
    segments: ['webhooks', 'fanout'],
    operation: 'webhooks.fanout',
    scope: 'webhooks:manage',
  },
];

export type RouteMatch =
  | { kind: 'matched'; spec: ApiRouteSpec; params: Record<string, string> }
  | { kind: 'method_not_allowed'; allowed: string[] }
  | { kind: 'not_found' };

/**
 * Split a full request path into the segments below `/api/v1`.
 * Returns null when the path is not under the versioned base (404 — a
 * different version's URL space is not this surface's concern).
 */
export function splitApiPath(path: string): string[] | null {
  if (typeof path !== 'string') return null;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (normalized !== API_BASE_PATH && !normalized.startsWith(`${API_BASE_PATH}/`)) return null;
  const rest = normalized.slice(API_BASE_PATH.length);
  return rest.split('/').filter((segment) => segment !== '');
}

function paramCount(segments: readonly string[]): number {
  let count = 0;
  for (const segment of segments) {
    if (segment.startsWith(':')) count += 1;
  }
  return count;
}

function matchSegments(
  routeSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> | null {
  if (routeSegments.length !== pathSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i += 1) {
    const routeSegment = routeSegments[i]!;
    const pathSegment = pathSegments[i]!;
    if (routeSegment.startsWith(':')) {
      params[routeSegment.slice(1)] = pathSegment;
    } else if (routeSegment !== pathSegment) {
      return null;
    }
  }
  return params;
}

/**
 * Match (method, path) against the v1 surface. When the path exists under
// another method, the result carries the allowed method list (405).
 */
export function matchApiRoute(method: string, pathSegments: readonly string[]): RouteMatch {
  const wanted = method.toUpperCase();
  let best: { spec: ApiRouteSpec; params: Record<string, string> } | null = null;
  const allowed = new Set<string>();
  for (const spec of API_ROUTES) {
    const params = matchSegments(spec.segments, pathSegments);
    if (params === null) continue;
    allowed.add(spec.method);
    if (spec.method !== wanted) continue;
    if (best === null || paramCount(spec.segments) < paramCount(best.spec.segments)) {
      best = { spec, params };
    }
  }
  if (best !== null) return { kind: 'matched', ...best };
  if (allowed.size > 0) return { kind: 'method_not_allowed', allowed: [...allowed].sort() };
  return { kind: 'not_found' };
}

/** The static discovery document served at `GET /api/v1` (no tenant data). */
export function buildDiscoveryDocument(): ApiDiscoveryDocument {
  const operations: ApiOperationDescriptor[] = API_ROUTES.map((spec) => ({
    method: spec.method,
    path: `${API_BASE_PATH}/${spec.segments.join('/')}`.replace(/\/$/, ''),
    operation: spec.operation,
    scope: spec.scope,
  }));
  return {
    version: API_VERSION,
    path: API_BASE_PATH,
    scopes: API_SCOPES,
    authorityClaims: API_KEY_AUTHORITY_CLAIMS,
    operations,
    webhooks: {
      eventTypes: 'any canonical event-type id, a dotted prefix wildcard (goal.*) or *',
      signature:
        'aurum-webhook-signature = hex(HMAC-SHA256(secret, `${aurum-webhook-timestamp}.${rawBody}`))',
      envelope: '{ id, version: 1, eventType, eventId, occurredAt, subscriptionId, payload }',
    },
  };
}
