// Pure lifecycle-policy logic of the agent-evaluation module (W024).
// No database, no context, no time — everything here is a total,
// deterministic function of its arguments (the actions module's
// matrix.ts / the agents module's policy.ts discipline), which is
// exactly what "lifecycle changes follow policy" demands of the routing
// layer: the same change, gate outcome and current status always yield
// the same next state, with no LLM, clock, randomness or hidden state in
// the path.
//
// Three concerns live here, deliberately pure:
//
//  1. VOCABULARIES — the §15 tail (retain / modify / terminate), the
//     decision lifecycle states and their terminal/live partition
//     (lock 36), and the replacement-option kinds.
//  2. ROUTING — which changes pass through the W009 authority matrix
//     (terminate — the §20-listed consequential action, kind
//     'agent-termination' at level EXECUTE) and which are recorded
//     management decisions (retain / modify); and the deterministic
//     status a gate outcome maps onto at decision time.
//  3. CLAIMS — the agents module's 'agents:administer' claim gates every
//     lifecycle decision (measuring is open to tenant members; deciding
//     the workforce is management's).

// (No imports: this file is pure by design — see the header. The §20
// level word is mirrored locally because importing another module's
// internals would be a cross-module violation; the vocabulary is frozen
// by ARCHITECTURE.md §20 and pinned by tests.)

/** The lifecycle changes W024 owns — the §15 EVALUATED tail, verbatim. */
export const AGENT_LIFECYCLE_CHANGES = ['retain', 'modify', 'terminate'] as const;

export type AgentLifecycleChangeWord = (typeof AGENT_LIFECYCLE_CHANGES)[number];

export function isAgentLifecycleChange(value: unknown): value is AgentLifecycleChangeWord {
  return (
    typeof value === 'string' &&
    (AGENT_LIFECYCLE_CHANGES as readonly string[]).includes(value)
  );
}

/**
 * The decision lifecycle states. `awaiting_approval` and `approved` are
 * live (resumable — lock 36); the rest are terminal history:
 *  * `recorded`         — a retain/modify decision (evidence, terminal
 *    from birth — nothing further moves);
 *  * `awaiting_approval`— a terminate decision sitting in the W009 gate;
 *  * `approved`         — a terminate decision the matrix allowed; the
 *    termination is authorized but not yet applied;
 *  * `applied`          — the termination was applied; terminal;
 *  * `refused`          — the matrix forbade it or a human rejected it;
 *    terminal, recorded as evidence.
 */
export const AGENT_DECISION_STATUSES = [
  'recorded',
  'awaiting_approval',
  'approved',
  'applied',
  'refused',
] as const;

export type AgentDecisionStatusWord = (typeof AGENT_DECISION_STATUSES)[number];

export function isAgentDecisionStatus(value: unknown): value is AgentDecisionStatusWord {
  return (
    typeof value === 'string' &&
    (AGENT_DECISION_STATUSES as readonly string[]).includes(value)
  );
}

/** The terminal (non-resumable) decision states — history from then on. */
export const AGENT_DECISION_TERMINAL_STATUSES = [
  'recorded',
  'applied',
  'refused',
] as const;

export function isTerminalDecisionStatus(status: AgentDecisionStatusWord): boolean {
  return (AGENT_DECISION_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** The replacement-option kinds (the compared alternatives — see types.ts). */
export const AGENT_REPLACEMENT_KINDS = [
  'retain',
  'modify',
  'train',
  'reassign',
  'hire',
  'automate',
  'recruit',
  'install',
  'eliminate',
] as const;

export type AgentReplacementKindWord = (typeof AGENT_REPLACEMENT_KINDS)[number];

export function isAgentReplacementKind(value: unknown): value is AgentReplacementKindWord {
  return (
    typeof value === 'string' &&
    (AGENT_REPLACEMENT_KINDS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Routing (which changes the authority matrix gates)
// ---------------------------------------------------------------------------

/**
 * The W009 action kind of the agent-termination gate — a
 * CANONICAL_ACTION_KIND (ARCHITECTURE.md §20: the matrix "applies
 * uniformly to ... agent recruitment, agent termination ...").
 */
export const AGENT_TERMINATION_ACTION_KIND = 'agent-termination';

/** The §20 level a termination is authorized at: the consequential one. */
export const AGENT_TERMINATION_AUTHORITY_LEVEL = 'EXECUTE';

/**
 * Does this lifecycle change pass through the W009 authority matrix?
 * Only TERMINATE does: §20 names agent termination as a matrix-governed
 * consequential action (lock 23: "Agent recruitment and termination obey
 * policy/approval"), while RETAIN changes nothing and MODIFY's actual
 * mutation is applied through the agents module's own claim-gated
 * management controls ('agents:administer', W021). The decision EVIDENCE
 * is recorded for all three either way.
 */
export function isMatrixGated(change: AgentLifecycleChangeWord): boolean {
  return change === 'terminate';
}

/** The gate outcome triple, as the actions module surfaces it. */
export type GateOutcome = 'allowed' | 'approval_required' | 'forbidden';

/**
 * The decision status a terminate submission maps onto at decision time
 * (deterministic — the agents module's submission routing, applied to
 * the lifecycle tail):
 *  * `allowed`           → 'approved'   (policy auto-approval; applying
 *    is the settle step);
 *  * `approval_required` → 'awaiting_approval' (a human decides through
 *    the actions module; the settle pump resolves it);
 *  * `forbidden`         → 'refused'    (terminal, recorded as evidence).
 */
export function statusForGateOutcome(outcome: GateOutcome): AgentDecisionStatusWord {
  switch (outcome) {
    case 'allowed':
      return 'approved';
    case 'approval_required':
      return 'awaiting_approval';
    case 'forbidden':
      return 'refused';
  }
}

// ---------------------------------------------------------------------------
// Claims (the management gate — the agents module's discipline)
// ---------------------------------------------------------------------------

/** Authority claim that manages the tenant's agent workforce (W021's). */
export const AGENTS_AUTHORITY_ADMINISTER = 'agents:administer';

/** May these authority claims decide the tenant's agent lifecycle? */
export function canDecideAgentLifecycle(authorityClaims: readonly string[]): boolean {
  return authorityClaims.includes(AGENTS_AUTHORITY_ADMINISTER);
}
