// Developer / API / MCP Console (W067) — the view builders.
//
// Server-side composition of the api module's CONTRACT only (locks 31/32:
// capabilities, never raw persistence) plus the W039 MCP surface's own
// registry/config (the connection instructions ARE the capability surface
// of the stdio server — importing it is composition, not a second source
// of truth):
//
//   * API KEYS        — the tenant's machine credentials (never the raw
//                       values; only sha-256 hashes persist at all);
//   * SCOPE VISIBILITY — the v1 route table (API_ROUTES via the contract's
//                       discovery document): every operation and the scope
//                       it requires, grouped by capability family;
//   * WEBHOOKS        — subscriptions + the append-only delivery/attempt
//                       evidence trail;
//   * MCP CONNECTION  — the launch recipe (env names from the W039 config
//                       exports, so they cannot drift) and the live tool
//                       catalog with each tool's policy posture;
//   * INTEGRATION EVENTS — the api.operation / mcp.tool_invoked audit feed
//                       read through the events contract.
//
// Honesty rules (the /ai discipline): a FAILING read renders an empty
// section plus a `degraded` note — never fake emptiness, never a crash.
// The keys read is additionally gated on the 'api:administer' authority:
// without it the section renders its view-only notice (a member's missing
// authority is a state, not a degradation).
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's keys, subscriptions, deliveries and events are
// indistinguishable from missing ones (the contract's uniform not-found —
// no existence leak).

import { now } from '@/infra/clock';
import type { TenantContext } from '@/infra/tenant';
import {
  API_AUDIT_EVENT_TYPE,
  API_SCOPES,
  getApiWebhookTransport,
  listApiKeys,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  buildDiscoveryDocument,
} from '@/modules/api/contract';
import type {
  ApiKey,
  ApiOperationDescriptor,
  WebhookDelivery,
  WebhookSubscription,
} from '@/modules/api/contract';
import { listEvents } from '@/modules/events/contract';
import type { Event } from '@/modules/events/contract';
import { MCP_AUDIT_EVENT_TYPE } from '@/mcp/audit';
import { MCP_AUTHORITY_ENV, MCP_PRINCIPAL_ID_ENV, MCP_TENANT_ID_ENV } from '@/mcp/config';
import { AURUM_MCP_TOOLS } from '@/mcp/registry';
import { ACTIVITY_ROW_LIMIT, DELIVERY_ROW_LIMIT } from './labels';

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page/client; labels resolve at render)
// ---------------------------------------------------------------------------

/** One v1 public operation, verbatim from the route table. */
export interface OperationRow extends ApiOperationDescriptor {
  /** The capability family the operation's scope belongs to. */
  family: string;
}

/** One scope family: the scope, its operations, and its human copy hook. */
export interface ScopeFamilyRow {
  scope: string;
  operations: OperationRow[];
}

/** One MCP tool of the stdio server, composed for rendering. */
export interface McpToolRow {
  name: string;
  title: string;
  description: string;
  policyKind: 'read' | 'gate' | 'claim';
  readOnlyHint: boolean;
}

/** The launch recipe of one MCP server process (the connection instructions). */
export interface McpConnectionGuide {
  /** Environment variable names (verbatim from the W039 config module). */
  envNames: {
    tenantId: string;
    principalId: string;
    authority: string;
  };
  /** The documented launch command (package.json: `bun run mcp`). */
  launchCommand: string;
  /** The transport the server speaks. */
  transport: 'stdio';
}

/** One immutable integration event (API operation or MCP tool invocation). */
export interface ActivityRow {
  id: string;
  /** 'api.operation' | 'mcp.tool_invoked' (kept raw for labels). */
  type: string;
  occurredAt: string;
  /** API: the operation id; MCP: the tool name. */
  operation: string;
  /** API: `METHOD path → status`; MCP: the invocation outcome. */
  detail: string;
  /** API: the acting key id; MCP: null. */
  keyId: string | null;
  correlationId: string;
}

/** The /developer page's whole view (one build, every family degraded-safe). */
export interface DeveloperView {
  generatedAt: string;
  /** True when the session's authority carries 'api:administer' (key management gate). */
  canAdministerKeys: boolean;
  /** True when a webhook delivery transport is wired in this process. */
  transportWired: boolean;
  /** The tenant's api keys (empty for members without the administer claim). */
  keys: ApiKey[];
  /** The v1 surface grouped by capability scope (scope visibility). */
  scopeFamilies: ScopeFamilyRow[];
  /** The tenant's webhook subscriptions. */
  subscriptions: WebhookSubscription[];
  /** Recent webhook deliveries, newest first (append-only evidence). */
  deliveries: WebhookDelivery[];
  /** The MCP connection instructions + the live tool catalog. */
  mcp: McpConnectionGuide;
  mcpTools: McpToolRow[];
  /** Recent integration events (api.operation + mcp.tool_invoked), newest first. */
  activity: ActivityRow[];
  /** Which read families failed (honest degradation, never silence). */
  degraded: string[];
}

// ---------------------------------------------------------------------------
// Pure composition helpers
// ---------------------------------------------------------------------------

/**
 * Group the v1 route table by capability scope. Pure, over contract data
 * only: every operation appears exactly once; scopes with no operations
 * (none today — webhooks:manage and api:administer have their own routes)
 * would still render, so vocabulary and table can never disagree silently.
 */
export function buildScopeFamilies(operations: readonly ApiOperationDescriptor[]): ScopeFamilyRow[] {
  const families = new Map<string, OperationRow[]>();
  for (const operation of operations) {
    const scope = operation.scope ?? '(unauthenticated)';
    const row: OperationRow = { ...operation, family: scope };
    const bucket = families.get(scope);
    if (bucket === undefined) families.set(scope, [row]);
    else bucket.push(row);
  }
  // Render in contract-vocabulary order (API_SCOPES), unauthenticated first.
  const ordered: ScopeFamilyRow[] = [];
  const unauthenticated = families.get('(unauthenticated)');
  if (unauthenticated !== undefined) {
    ordered.push({ scope: '(unauthenticated)', operations: unauthenticated });
  }
  for (const scope of API_SCOPES) {
    const bucket = families.get(scope);
    if (bucket !== undefined) ordered.push({ scope, operations: bucket });
  }
  return ordered;
}

/** The MCP connection instructions (env names verbatim from the W039 config). */
export function buildMcpConnectionGuide(): McpConnectionGuide {
  return {
    envNames: {
      tenantId: MCP_TENANT_ID_ENV,
      principalId: MCP_PRINCIPAL_ID_ENV,
      authority: MCP_AUTHORITY_ENV,
    },
    launchCommand: 'bun run mcp',
    transport: 'stdio',
  };
}

/** The MCP tool catalog, composed from the live registry (order = tools/list). */
export function buildMcpToolRows(): McpToolRow[] {
  return AURUM_MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    policyKind: tool.policy.kind,
    readOnlyHint: tool.annotations.readOnlyHint === true,
  }));
}

/** The one-line summary of one api.operation audit event. */
function apiOperationDetail(payload: Record<string, unknown> | null | undefined): string {
  if (payload === null || payload === undefined) return 'no payload recorded';
  const method = typeof payload['method'] === 'string' ? payload['method'] : '?';
  const path = typeof payload['path'] === 'string' ? payload['path'] : '?';
  const status = typeof payload['status'] === 'number' ? payload['status'] : '?';
  return `${method} ${path} → ${status}`;
}

/** The one-line summary of one mcp.tool_invoked audit event. */
function mcpInvocationDetail(payload: Record<string, unknown> | null | undefined): string {
  if (payload === null || payload === undefined) return 'no payload recorded';
  const outcome = typeof payload['outcome'] === 'string' ? payload['outcome'] : 'unknown outcome';
  const error = payload['error'];
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = String((error as { code: unknown }).code);
    return `${outcome} · ${code}`;
  }
  return outcome;
}

function payloadOf(event: Event): Record<string, unknown> | null {
  if (typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)) {
    return event.payload as Record<string, unknown>;
  }
  return null;
}

/** Map one audit event onto its console row (API and MCP shapes). */
export function activityRowOf(event: Event): ActivityRow {
  const payload = payloadOf(event);
  if (event.type === MCP_AUDIT_EVENT_TYPE) {
    return {
      id: event.id,
      type: event.type,
      occurredAt: event.occurredAt,
      operation: typeof payload?.['tool'] === 'string' ? payload['tool'] : 'unknown tool',
      detail: mcpInvocationDetail(payload),
      keyId: null,
      correlationId: event.correlationId,
    };
  }
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    operation: typeof payload?.['operation'] === 'string' ? payload['operation'] : 'unknown operation',
    detail: apiOperationDetail(payload),
    keyId: typeof payload?.['keyId'] === 'string' ? payload['keyId'] : null,
    correlationId: event.correlationId,
  };
}

/**
 * Merge the API and MCP audit feeds into one newest-first timeline. Pure:
 * sequence is the events module's canonical per-tenant order, so ties in
 * `occurredAt` (common in tests) still deterministically keep the
 * higher-sequence event first.
 */
export function mergeActivityRows(
  apiEvents: readonly Event[],
  mcpEvents: readonly Event[],
  limit: number,
): ActivityRow[] {
  const rows = [...apiEvents, ...mcpEvents]
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const occurred = right.event.occurredAt.localeCompare(left.event.occurredAt);
      if (occurred !== 0) return occurred;
      return right.event.sequence - left.event.sequence;
    })
    .map(({ event }) => activityRowOf(event));
  return rows.slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// buildDeveloperView
// ---------------------------------------------------------------------------

/** One bounded failed read → an empty section + a degraded note. */
async function safe<T>(family: string, degraded: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

/**
 * Build the whole developer-console view for one tenant: keys (when the
 * session may administer them), the scope/route table, webhook
 * subscriptions + delivery evidence, the MCP connection instructions with
 * the live tool catalog, and the integration audit feed.
 */
export async function buildDeveloperView(ctx: TenantContext): Promise<DeveloperView> {
  const degraded: string[] = [];
  const canAdministerKeys = ctx.authority.includes('api:administer');

  // The keys read is authority-gated by the CONTRACT itself; a member
  // without the claim gets the view-only state, not a degraded error.
  const keys = canAdministerKeys
    ? ((await safe('keys', degraded, () => listApiKeys(ctx))) ?? [])
    : [];

  const [subscriptions, deliveries, apiEvents, mcpEvents] = await Promise.all([
    safe('subscriptions', degraded, () => listWebhookSubscriptions(ctx)),
    safe('deliveries', degraded, () =>
      listWebhookDeliveries(ctx, { limit: DELIVERY_ROW_LIMIT }),
    ),
    safe('activity-api', degraded, () =>
      listEvents(ctx, { type: API_AUDIT_EVENT_TYPE, order: 'desc', limit: ACTIVITY_ROW_LIMIT }),
    ),
    safe('activity-mcp', degraded, () =>
      listEvents(ctx, { type: MCP_AUDIT_EVENT_TYPE, order: 'desc', limit: ACTIVITY_ROW_LIMIT }),
    ),
  ]);

  return {
    generatedAt: now().toISOString(),
    canAdministerKeys,
    transportWired: getApiWebhookTransport() !== null,
    keys,
    scopeFamilies: buildScopeFamilies(buildDiscoveryDocument().operations),
    subscriptions: subscriptions ?? [],
    deliveries: deliveries ?? [],
    mcp: buildMcpConnectionGuide(),
    mcpTools: buildMcpToolRows(),
    activity: mergeActivityRows(apiEvents ?? [], mcpEvents ?? [], ACTIVITY_ROW_LIMIT),
    degraded: [...new Set(degraded)],
  };
}
