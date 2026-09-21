// Developer / API / MCP Console (W067) — the surface's pure label/format
// layer.
//
// Everything here is a total function over the api module's CONTRACT
// vocabulary (capability scopes, key authority claims, key/subscription/
// delivery statuses, attempt outcomes) and the MCP tool surface's policy
// classes: the human copy the page, the client controls and the tests all
// share, so the vocabularies can never drift between them (the same
// discipline the /ai and marketplace labels apply).
//
// Journey L (plan §2): "Developer opens console → API keys/scopes →
// webhooks → MCP connection instructions → event/API activity →
// revoke/rotate" — this file owns the words; the honesty rules (a revoked
// key is retained evidence, a raw key is shown exactly once, webhook
// secrets live behind opaque secret-store references) ride along as the
// NOTE constants the page and tests quote verbatim.

import type { PillTone } from '../../lib/states';

// CLIENT-SAFETY (the shell's navigation.ts discipline): this module is
// imported by CLIENT components (components/controls.tsx), so it must stay
// free of server-only imports. `@/modules/api/contract` is therefore
// imported TYPE-ONLY (erased at compile time) and the two small runtime
// vocabularies it needs are declared HERE as the client-safe copies — the
// unit tests lock them to the contract's own lists so the two can never
// drift (exactly how navigation.ts mirrors the tower registry).

import type { ApiKeyAuthorityClaim, ApiScope } from '@/modules/api/contract';

/** The api contract's capability-scope vocabulary (client-safe local copy; test-locked). */
export const DEV_API_SCOPES: readonly ApiScope[] = [
  'goals:read',
  'missions:read',
  'missions:write',
  'epistemics:read',
  'knowledge:read',
  'evidence:read',
  'capabilities:read',
  'agents:read',
  'approvals:read',
  'approvals:write',
  'webhooks:manage',
  'api:administer',
];

/** The api contract's key authority-claim vocabulary (client-safe copy; test-locked). */
export const DEV_AUTHORITY_CLAIMS: readonly ApiKeyAuthorityClaim[] = [
  'api:administer',
  'actions:approve',
  'actions:administer',
  'agents:administer',
];

// ---------------------------------------------------------------------------
// Vocabulary labels (every domain value has human copy)
// ---------------------------------------------------------------------------

/** What one capability scope lets a key DO (label + one-line semantics). */
const SCOPE_COPY: Record<ApiScope, { label: string; explanation: string }> = {
  'goals:read': {
    label: 'Goals · read',
    explanation: 'List goals, their versions and one goal by id (GET /api/v1/goals…).',
  },
  'missions:read': {
    label: 'Missions · read',
    explanation: 'List learning missions and their versions (GET /api/v1/missions…).',
  },
  'missions:write': {
    label: 'Missions · write',
    explanation:
      'Request investigations: create missions, revise them, record completion or abandonment.',
  },
  'epistemics:read': {
    label: 'Unknowns & beliefs · read',
    explanation:
      'Inspect the epistemic state — unknowns, beliefs and claims (GET /unknowns, /beliefs).',
  },
  'knowledge:read': {
    label: 'Knowledge · read',
    explanation: 'Query company knowledge entries and their evidence (GET /api/v1/knowledge…).',
  },
  'evidence:read': {
    label: 'Evidence · read',
    explanation: 'Retrieve immutable observations and their lineage (GET /api/v1/observations…).',
  },
  'capabilities:read': {
    label: 'Capabilities · read',
    explanation: 'The capability graph and gap findings (GET /api/v1/capabilities[/gaps]).',
  },
  'agents:read': {
    label: 'Agents · read',
    explanation: 'Inspect the agent workforce, execution traces and attempts.',
  },
  'approvals:read': {
    label: 'Approvals · read',
    explanation: 'Read authority-gated action requests and their decisions.',
  },
  'approvals:write': {
    label: 'Approvals · write',
    explanation: 'Propose consequential actions and decide approval requests the key may decide.',
  },
  'webhooks:manage': {
    label: 'Webhooks · manage',
    explanation: 'Manage this tenant’s webhook subscriptions, tests and deliveries over HTTP.',
  },
  'api:administer': {
    label: 'API · administer',
    explanation: 'Manage the machine credentials themselves: create, list and revoke keys over HTTP.',
  },
};

export function scopeLabel(scope: string): string {
  return SCOPE_COPY[scope as ApiScope]?.label ?? scope;
}

export function scopeExplanation(scope: string): string {
  return SCOPE_COPY[scope as ApiScope]?.explanation ?? '';
}

/**
 * Authority claims a key may carry DOWNSTREAM (on top of its scopes): the
 * closed vocabulary from the contract — platform claims are deliberately
 * absent, which the page says out loud.
 */
const AUTHORITY_COPY: Record<ApiKeyAuthorityClaim, { label: string; explanation: string }> = {
  'api:administer': {
    label: 'api:administer',
    explanation: 'Lets the key mint, list and revoke other keys over the public HTTP API.',
  },
  'actions:approve': {
    label: 'actions:approve',
    explanation:
      'Lets the key decide the approval requests the actions module allows this principal to decide.',
  },
  'actions:administer': {
    label: 'actions:administer',
    explanation: 'Lets the key administer action requests (the actions module’s own claim gate).',
  },
  'agents:administer': {
    label: 'agents:administer',
    explanation: 'Lets the key manage agent lifecycle operations the agents module gates on this claim.',
  },
};

export function authorityClaimLabel(claim: string): string {
  return AUTHORITY_COPY[claim as ApiKeyAuthorityClaim]?.label ?? claim;
}

export function authorityClaimExplanation(claim: string): string {
  return AUTHORITY_COPY[claim as ApiKeyAuthorityClaim]?.explanation ?? '';
}

// ---------------------------------------------------------------------------
// Status labels + tones (color never carries meaning alone)
// ---------------------------------------------------------------------------

export function keyStatusLabel(status: string): string {
  return status === 'active' ? 'Active' : status === 'revoked' ? 'Revoked' : status;
}

export function keyStatusTone(status: string): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

export function subscriptionStatusLabel(status: string): string {
  return status === 'active' ? 'Receiving' : status === 'deactivated' ? 'Deactivated' : status;
}

export function subscriptionStatusTone(status: string): PillTone {
  return status === 'active' ? 'positive' : 'neutral';
}

export function deliveryStatusLabel(status: string): string {
  return status === 'delivered'
    ? 'Delivered'
    : status === 'failed'
      ? 'Failed'
      : status === 'pending'
        ? 'Pending'
        : status;
}

export function deliveryStatusTone(status: string): PillTone {
  return status === 'delivered' ? 'positive' : status === 'failed' ? 'error' : 'warning';
}

export function attemptOutcomeLabel(outcome: string): string {
  return outcome === 'succeeded'
    ? 'succeeded'
    : outcome === 'terminal_failure'
      ? 'rejected (terminal)'
      : outcome === 'transient_failure'
        ? 'retrying (transient)'
        : outcome;
}

export function attemptOutcomeTone(outcome: string): PillTone {
  return outcome === 'succeeded' ? 'positive' : outcome === 'terminal_failure' ? 'error' : 'warning';
}

/** One MCP tool's policy class, in developer words. */
export function mcpPolicyLabel(policy: string): string {
  return policy === 'read'
    ? 'Read · policy-matrix'
    : policy === 'gate'
      ? 'Gated · approval flow'
      : policy === 'claim'
        ? 'Claim-gated'
        : policy;
}

export function mcpPolicyTone(policy: string): PillTone {
  return policy === 'read' ? 'info' : 'warning';
}

/** An integration event family (the developer activity feed). */
export function activityFamilyLabel(type: string): string {
  return type === 'api.operation' ? 'API' : type === 'mcp.tool_invoked' ? 'MCP' : type;
}

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

/** Compact age: "3m ago", "2h ago", "5d ago" — falls back to the timestamp. */
export function ageLabel(iso: string, nowIso: string): string {
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now)) return iso;
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return iso.slice(0, 10);
}

/**
 * Mask a raw key for display: keep the `aurum_` prefix and the last four
 * characters — enough for a developer to tell two keys apart, never enough
 * to use one. The full raw value only ever renders in the one-time reveal.
 */
export function maskKey(rawKey: string): string {
  if (rawKey.length <= 10) return rawKey;
  return `${rawKey.slice(0, 6)}…${rawKey.slice(-4)}`;
}

/** Short id form for compact evidence rows (<code> blocks). */
export function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

// ---------------------------------------------------------------------------
// The notes the page quotes verbatim (tested, so the words are the product)
// ---------------------------------------------------------------------------

export const KEY_SHOWN_ONCE_NOTE =
  'The raw key is shown exactly once, here. Aurum persists only its SHA-256 hash — it cannot be shown again, and nobody (including Aurum) can recover it. Store it now.';

export const KEY_MANAGEMENT_CLAIM_NOTE =
  "Creating, listing and revoking keys requires the 'api:administer' authority claim (owners and admins carry it; members read the vocabulary but manage nothing).";

export const SECRET_REF_NOTE =
  'Webhook signing secrets never enter Aurum as values: give the opaque secret-store reference, and the delivery transport resolves it. HMAC-SHA256 signs `${timestamp}.${rawBody}` into the aurum-webhook-signature header.';

export const NO_RAW_PERSISTENCE_NOTE =
  'The public API exposes capabilities, never tables: every operation is a named, versioned, tenant-scoped, permission-checked and audited capability call (locks 31/32).';

export const REVOKE_NOTE =
  'Revoking a key keeps the record and its audit history — evidence is immutable; the credential simply stops authenticating.';

export const ROTATION_NOTE =
  'Rotating issues a fresh key carrying the same grant (principal, scopes, authority) and immediately revokes the old one. The new raw key is shown once.';

export const MCP_STDIO_NOTE =
  'The MCP server speaks stdio and binds to ONE tenant principal: the operator hosting the process supplies the tenant and principal ids (and optional authority claims) as environment variables — there is no ambient tenant.';

export const WEBHOOK_ENVELOPE_NOTE =
  'Every delivery POSTs one frozen envelope — { id, version: 1, eventType, eventId, occurredAt, subscriptionId, payload } — byte-stable across retries so signatures stay verifiable.';

export const ACTIVITY_NOTE =
  'Every authenticated public-API operation appends one immutable api.operation event; every MCP tool invocation appends one mcp.tool_invoked event. This feed is that audit trail, newest first.';

/** Suggested event-type patterns for the webhook form's hint. */
export const EVENT_TYPE_EXAMPLES = ['goal.created', 'goal.*', 'api.operation', '*'] as const;

/** How many deliveries the console renders (the surface stays calm). */
export const DELIVERY_ROW_LIMIT = 20;

/** How many integration events the activity feed renders. */
export const ACTIVITY_ROW_LIMIT = 30;
