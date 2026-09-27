// Cellular reachability surface (W104 — J18) — the view builders.
//
// Server-side composition of EXISTING module contracts only (lock 31/32:
// contracts, never persistence) — the discipline the intelligence,
// learning and connections surfaces follow. Two views:
//
//   buildCellularHomeView — the /cellular hub: the telecom sending
//     connections, the reach request feed (the durable intents with
//     their status — including the honest failed/provider_unavailable
//     environment state), and the routing/cost policy rows.
//   buildReachDetailView — one reach request: the immutable intent with
//     its policy snapshot and authority-gate reference, the append-only
//     attempt audit (each row the per-leg evidence), and the inbound
//     replies correlated to it.
//
// Honesty rules (the intelligence surface's discipline):
//   * a FAILING read renders an empty section plus a `degraded` note —
//     never fake emptiness, never a crash;
//   * a MISSING record throws the owning contract's not-found error for
//     the page to render its honest not-found state;
//   * the environment limit is reported EXACTLY as the module records
//     it (failed reaches carry failureCode provider_unavailable; the
//     attempt rows carry the honest "no transport wired" detail) —
//     never a faked delivery.
//
// Tenancy (ADR-0001): every builder takes the EXPLICIT TenantContext;
// another tenant's records read as missing (the contract's own
// `reach_not_found` — no existence leak).

import type { TenantContext } from '@/infra/tenant';
import {
  getCellularReach,
  listCellularAttempts,
  listCellularConnections,
  listCellularPolicies,
  listCellularReach,
  listCellularReplies,
} from '@/modules/cellular/contract';
import type {
  CellularAttempt,
  CellularConnection,
  CellularPolicy,
  CellularReach,
  CellularReachStatus,
  CellularReply,
  CellularVoiceFallbackMode,
} from '@/modules/cellular/contract';
import type { AttemptStatus } from './labels';

// ---------------------------------------------------------------------------
// Row shapes (serialized server → page; labels resolved at render)
// ---------------------------------------------------------------------------

/** How many reach rows the feed carries (the surface stays calm). */
export const HOME_ROW_LIMIT = 20;

/** One telecom sending connection. */
export interface CellularConnectionRow {
  id: string;
  provider: string;
  phoneNumber: string;
  providerAccountId: string;
  displayName: string | null;
  status: 'active' | 'disabled';
  updatedAt: string;
}

/** One reach request row of the feed. */
export interface ReachRow {
  id: string;
  kind: 'tell' | 'ask';
  /** The honest recipient classification (person or raw number). */
  recipientKind: string;
  phoneNumber: string;
  /** The message text, clipped for the feed. */
  text: string;
  status: CellularReachStatus;
  failureCode: string | null;
  smsAttemptsCount: number;
  voiceAttemptsCount: number;
  cycle: number;
  createdAt: string;
  updatedAt: string;
  href: string;
}

/** One routing/cost policy row. */
export interface PolicyRowView {
  id: string;
  /** 'tell' | 'ask', or null for the tenant-wide default row. */
  reachKind: string | null;
  voiceFallback: CellularVoiceFallbackMode;
  smsMaxAttempts: number;
  retryBackoffSeconds: number;
  maxSmsSegments: number;
  smsSegmentCostMinor: number;
  voicePerMinuteCostMinor: number;
  currency: string;
  maxCostPerReachMinor: number;
  note: string | null;
}

/** The /cellular hub view. */
export interface CellularHomeView {
  generatedAt: string;
  connections: CellularConnectionRow[];
  reach: ReachRow[];
  policies: PolicyRowView[];
  degraded: string[];
}

// ---------------------------------------------------------------------------
// buildCellularHomeView
// ---------------------------------------------------------------------------

async function safe<T>(family: string, degraded: string[], read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    degraded.push(family);
    return null;
  }
}

function clip(text: string, bound: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= bound ? flat : `${flat.slice(0, bound - 1)}…`;
}

export async function buildCellularHomeView(ctx: TenantContext): Promise<CellularHomeView> {
  const degraded: string[] = [];

  const [connections, reach, policies] = await Promise.all([
    safe('cellular-connections', degraded, () => listCellularConnections(ctx, {})),
    safe('reach', degraded, () => listCellularReach(ctx, { limit: HOME_ROW_LIMIT })),
    safe('policies', degraded, () => listCellularPolicies(ctx, {})),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    connections: (connections ?? []).map(toConnectionRow),
    reach: (reach ?? []).map(toReachRow),
    policies: (policies ?? []).map(toPolicyRow),
    degraded: [...new Set(degraded)],
  };
}

function toConnectionRow(connection: CellularConnection): CellularConnectionRow {
  return {
    id: connection.id,
    provider: connection.provider,
    phoneNumber: connection.phoneNumber,
    providerAccountId: connection.providerAccountId,
    displayName: connection.displayName,
    status: connection.status,
    updatedAt: connection.updatedAt,
  };
}

function toReachRow(reach: CellularReach): ReachRow {
  return {
    id: reach.id,
    kind: reach.kind,
    recipientKind: reach.recipientKind,
    phoneNumber: reach.phoneNumber,
    text: clip(reach.text, 90),
    status: reach.status,
    failureCode: reach.failureCode,
    smsAttemptsCount: reach.smsAttemptsCount,
    voiceAttemptsCount: reach.voiceAttemptsCount,
    cycle: reach.cycle,
    createdAt: reach.createdAt,
    updatedAt: reach.updatedAt,
    href: `/cellular/reach/${reach.id}`,
  };
}

function toPolicyRow(policy: CellularPolicy): PolicyRowView {
  return {
    id: policy.id,
    reachKind: policy.reachKind,
    voiceFallback: policy.voiceFallback,
    smsMaxAttempts: policy.smsMaxAttempts,
    retryBackoffSeconds: policy.retryBackoffSeconds,
    maxSmsSegments: policy.maxSmsSegments,
    smsSegmentCostMinor: policy.smsSegmentCostMinor,
    voicePerMinuteCostMinor: policy.voicePerMinuteCostMinor,
    currency: policy.currency,
    maxCostPerReachMinor: policy.maxCostPerReachMinor,
    note: policy.note,
  };
}

// ---------------------------------------------------------------------------
// buildReachDetailView
// ---------------------------------------------------------------------------

/** One attempt of the append-only audit, verbatim from the contract. */
export interface AttemptRowView {
  id: string;
  attemptNo: number;
  cycle: number;
  leg: 'sms' | 'voice';
  gateStatus: string;
  provider: string;
  connectionId: string | null;
  fromNumber: string | null;
  toNumber: string;
  text: string;
  segments: number | null;
  costMinor: number;
  status: AttemptStatus;
  detail: string | null;
  attemptedAt: string;
  receiptAt: string | null;
}

/** One inbound reply correlated to the reach. */
export interface ReplyRowView {
  id: string;
  channel: string;
  fromNumber: string;
  text: string;
  createdAt: string;
  conversationId: string | null;
}

/** The /cellular/reach/[reachId] detail view. */
export interface ReachDetailView {
  reach: CellularReach;
  attempts: AttemptRowView[];
  replies: ReplyRowView[];
  degraded: string[];
}

export async function buildReachDetailView(
  ctx: TenantContext,
  reachId: string,
): Promise<ReachDetailView> {
  const degraded: string[] = [];

  // A missing/foreign reach throws reach_not_found — the page's honest
  // not-found state (uniform discipline, no existence leak).
  const reach = await getCellularReach(ctx, { reachRequestId: reachId });

  const [attempts, replies] = await Promise.all([
    safe('attempts', degraded, () => listCellularAttempts(ctx, { reachRequestId: reachId })),
    safe('replies', degraded, () => listCellularReplies(ctx, { reachRequestId: reachId })),
  ]);

  return {
    reach,
    attempts: (attempts ?? []).map(toAttemptRow),
    replies: (replies ?? []).map(toReplyRow),
    degraded: [...new Set(degraded)],
  };
}

function toAttemptRow(attempt: CellularAttempt): AttemptRowView {
  return {
    id: attempt.id,
    attemptNo: attempt.attemptNo,
    cycle: attempt.cycle,
    leg: attempt.leg,
    gateStatus: attempt.gateStatus,
    provider: attempt.provider,
    connectionId: attempt.connectionId,
    fromNumber: attempt.fromNumber,
    toNumber: attempt.toNumber,
    text: attempt.text,
    segments: attempt.segments,
    costMinor: attempt.costMinor,
    status: attempt.status,
    detail: attempt.detail,
    attemptedAt: attempt.attemptedAt,
    receiptAt: attempt.receiptAt,
  };
}

function toReplyRow(reply: CellularReply): ReplyRowView {
  return {
    id: reply.id,
    channel: reply.channel,
    fromNumber: reply.fromNumber,
    text: reply.text,
    createdAt: reply.createdAt,
    conversationId: reply.conversationId,
  };
}
