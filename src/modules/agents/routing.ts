// Pure routing logic of the agents module (W035 — Agent Provider
// Registry): deterministic, explainable selection of WHICH tenant-registered
// runtime account serves one agent execution dispatch. No database, no
// clock reads, no network — everything here is a total, deterministic
// function of its arguments (the llm module's routing.ts discipline), which
// is exactly what "route execution without semantic provider coupling"
// demands: the router decides on NEUTRAL facts only (provider family,
// capability permission, authority ceiling, availability, tenant priority),
// never on provider-specific semantics — dialects live exclusively inside
// `adapters/` (lock 24), and the same canonical task contract executes
// unchanged through whichever account is chosen.
//
// The DISTINCT concerns (mirroring ARCHITECTURE.md §18's separation, which
// the frozen architecture applies to provider gateways generally) collapse
// into named checks, each with its own machine reason:
//   * provider family   — an account serves only its own runtime family:
//                          the agent DEFINITION pins the canonical provider
//                          (its opaque runtimeConfig is dialect-shaped), so
//                          accounts of other families are explicit
//                          'provider_mismatch' candidates, never silently
//                          considered;
//   * capability        — the account must PERMIT the capability the
//                          dispatch exercises (the tenant's own permission,
//                          distinct from the registry's support);
//   * policy (authority)— the account's §20 authority ceiling: an execution
//                          authorized above the ceiling never routes here
//                          (the authority matrix applies uniformly, §20);
//   * availability      — per-account outage state with expiry (cooldowns
//                          recorded by the dispatch path, manual overrides
//                          by operators);
//   * preference        — the account's priority (lower first); registry
//                          position NEVER participates (lock 30 mirrored).
//
// The routing decision is frozen onto the dispatch attempt as evidence
// (§24 auditability): every candidate considered, its eligibility verdict
// and machine reason, and the chosen account.

import type { AgentRuntimeCapability } from './registry';
import type { AgentRuntimeProvider, AuthorityLevelWord } from './policy';
import { AUTHORITY_LEVELS } from './policy';
import type {
  AgentRoutingCandidate,
  AgentRoutingCandidateSnapshot,
  AgentRoutingRejectionReason,
  AgentRoutingSnapshot,
} from './types';

export type {
  AgentRoutingCandidate,
  AgentRoutingCandidateSnapshot,
  AgentRoutingRejectionReason,
  AgentRoutingSnapshot,
} from './types';

// ---------------------------------------------------------------------------
// Inputs (plain data the service assembles from tenant state)
// ---------------------------------------------------------------------------

export type AgentRuntimeAccountStatus = 'active' | 'disabled';

/** The tenant-side account facts routing needs (a projection of AgentRuntimeAccount). */
export interface AgentRuntimeAccountForRouting {
  id: string;
  provider: AgentRuntimeProvider;
  status: AgentRuntimeAccountStatus;
  /** Which canonical capabilities the account permits (tenant permission). */
  capabilities: readonly AgentRuntimeCapability[];
  /** The §20 ceiling: dispatches authorized above it never route here. */
  maxAuthorityLevel: AuthorityLevelWord;
  /** Routing preference: lower first (deterministic tiebreaks below). */
  priority: number;
  createdAt: string;
}

/** The current availability facts for one account. */
export interface AgentRuntimeAvailabilityForRouting {
  state: 'available' | 'unavailable';
  /** When the unavailable state lapses; null = indefinite. */
  expiresAt: string | null;
}

export interface RouteAgentRuntimeDispatchInput {
  /** The runtime family the dispatch belongs to (the agent definition's canonical provider). */
  provider: AgentRuntimeProvider;
  /** The canonical capability the dispatch exercises. */
  capability: AgentRuntimeCapability;
  /** The §20 level the execution was authorized at (its highest requested scope). */
  authorityLevel: AuthorityLevelWord;
  /** The tenant's runtime accounts (ALL of them — the snapshot must show every rejection). */
  accounts: readonly AgentRuntimeAccountForRouting[];
  /** Current availability keyed by account id. */
  availability: ReadonlyMap<string, AgentRuntimeAvailabilityForRouting>;
  /** Evaluation instant — availability expiry only (never ordering). */
  at: Date;
}

export interface AgentRoutingDecision {
  /** The frozen evidence of every candidate considered and why. */
  snapshot: AgentRoutingSnapshot;
  /** Eligible candidates in deterministic routing order (best first). */
  orderedEligible: AgentRoutingCandidate[];
}

// ---------------------------------------------------------------------------
// Availability (effective state — an expired cooldown reads as available)
// ---------------------------------------------------------------------------

/** Is the account effectively unavailable at `at`? */
export function isEffectivelyUnavailable(
  availability: AgentRuntimeAvailabilityForRouting | undefined,
  at: Date,
): boolean {
  if (availability === undefined) return false;
  if (availability.state !== 'unavailable') return false;
  if (availability.expiresAt === null) return true;
  return Date.parse(availability.expiresAt) > at.getTime();
}

// ---------------------------------------------------------------------------
// The deterministic router
// ---------------------------------------------------------------------------

/**
 * Route one dispatch over the tenant's runtime accounts. Every account the
 * tenant registered is recorded as a candidate with an eligibility verdict
 * and a machine reason (foreign-family accounts as 'provider_mismatch');
 * eligible accounts are ordered by (priority ASC, createdAt ASC, id ASC) —
 * fully deterministic, no registry position, no randomness, no clock (the
 * `at` argument only evaluates availability expiry).
 */
export function routeAgentRuntimeDispatch(input: RouteAgentRuntimeDispatchInput): AgentRoutingDecision {
  const candidates: AgentRoutingCandidateSnapshot[] = [];
  const eligible: Array<{ candidate: AgentRoutingCandidate; account: AgentRuntimeAccountForRouting }> = [];

  for (const account of input.accounts) {
    const reason = rejectionReasonFor(input, account);
    const snapshot: AgentRoutingCandidateSnapshot = {
      accountId: account.id,
      provider: account.provider,
      eligible: reason === null,
      reason,
    };
    candidates.push(snapshot);
    if (reason === null) {
      eligible.push({ candidate: { accountId: account.id, provider: account.provider }, account });
    }
  }

  eligible.sort((left, right) => {
    if (left.account.priority !== right.account.priority) {
      return left.account.priority - right.account.priority;
    }
    if (left.account.createdAt !== right.account.createdAt) {
      return left.account.createdAt < right.account.createdAt ? -1 : 1;
    }
    return left.candidate.accountId < right.candidate.accountId ? -1 : 1;
  });

  const orderedEligible = eligible.map((entry) => entry.candidate);
  const chosen = orderedEligible[0] ?? null;
  return {
    snapshot: {
      routed: chosen !== null,
      provider: input.provider,
      candidates,
      chosen,
    },
    orderedEligible,
  };
}

/** The first rejection reason that applies to one account, or null when eligible. */
function rejectionReasonFor(
  input: RouteAgentRuntimeDispatchInput,
  account: AgentRuntimeAccountForRouting,
): AgentRoutingRejectionReason | null {
  // The runtime family is a semantic binding of the agent DEFINITION (its
  // opaque runtimeConfig is dialect-shaped); routing never crosses it.
  if (account.provider !== input.provider) return 'provider_mismatch';
  if (account.status !== 'active') return 'account_disabled';
  if (!(account.capabilities as readonly string[]).includes(input.capability)) {
    return 'capability_not_permitted';
  }
  if (AUTHORITY_LEVELS.indexOf(input.authorityLevel) > AUTHORITY_LEVELS.indexOf(account.maxAuthorityLevel)) {
    return 'authority_exceeds_account_policy';
  }
  if (isEffectivelyUnavailable(input.availability.get(account.id), input.at)) {
    return 'unavailable';
  }
  return null;
}
