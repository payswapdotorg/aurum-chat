# W136 — Agent Exchange + Execution Plan + Cross-Agent Relay · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W136 (dependencies:
W021-W028, W035, W063, W125-W135 — the consumed seams listed below, all
consumed, none modified). Design contract: `spec/ARCHITECTURE.md` §1 (the
specialist-executor premise — "specialist agents, agent teams and software
extensions recruited or installed under policy"), §16 (the agent gateway's
normalized `result/evidence/cost/outcome` contract), §24 (the reconstruction
chain `… → recommendation → approval → execution → result → outcome →
learning` and "audit records are append-only"), ADR-0001 (tenancy).

> "Make Aurum a governed interface to specialist execution agents. Persist
>  a durable orchestration projection linking goal, tasks, agent
>  organization, handoffs, approvals, execution runs, results and
>  outcomes."
> Acceptance: "recruitment uses Marketplace/Agent Recruitment; context
>  routing is minimal and evidence-linked; progress/results return
>  through normalized agent contracts; no second execution authority."

Delivery history (honest): D1 delivered layers 1-4 (types + errors +
migration + validation, cfe0b38), layers 5-6 (service + contract, c204903)
and layer 7a (the unit proofs, 21/21, 757255c — the member-key-distinctness
guard was ADDED to validation.ts after the unit proof caught the gap), then
died at the reporting deadline mid-layer-7b; the TL banked the in-progress
service suite unverified (78c3a75). D2 (this delivery) verified the banked
suite green, re-ran every gate at the tip and wrote these notes. All commits
are LOCAL ONLY — no GitHub PAT exists on this box; the TL owns the push.

## What was built (file map)

Everything lives in `src/modules/agent-exchange/**` — nothing else in the
repository was touched.

| File | Role |
| --- | --- |
| `types.ts` (460L) | The domain shapes: `ContextPackage`/`ContextPackageInput` (the STRUCTURALLY minimal routed context — at most one fingerprint ref + explicit evidence refs + a note; there is no field through which a company model or an unbounded context blob could travel), `ExchangeMember`/`PlanTask`/`ExecutionPlan` (the spine: goal link + §11-style version pin, the optional W134/W135/W023 conditioning links, the immutable decomposition and organization), `RelayHandoff`, `ApprovalDecisionSnapshot` + `PlanApproval`, `ExecutionRun` (the normalized W021 freeze + the OPEN outcome link), and the read/query shapes. `ExchangeMemberKind` is the org-lab §5 set consumed as a frozen alias (`OrgNodeKind`) — W136 composes W135, it never redefines it. |
| `migrations/001-agent-exchange.sql` (375L) | Six tenant-scoped tables: `execution_plans` (the pointer; ONLY legal UPDATE is the one-way active → completed\|abandoned transition with exact-once stamps + the retained lifecycle note; every identity/content column immutable; DELETE/TRUNCATE forbidden), `execution_plan_tasks` and `execution_plan_members` (immutable from creation — triggers reject UPDATE/DELETE/TRUNCATE), and `execution_plan_handoffs` / `execution_plan_approvals` / `execution_plan_runs` (append-only evidence — triggers reject UPDATE/DELETE/TRUNCATE, §24). Cross-module references are opaque forward references, deliberately NOT foreign keys (the house discipline). |
| `errors.ts` (142L) | 32 typed codes (see the file's vocabulary table): the input family (`invalid_context` … `invalid_run_input`), the uniform not-found family (`plan_not_found`, `task_not_found`, `member_not_found`, `goal_not_found`, `fingerprint_not_found`, `strategy_not_found`, `recommendation_not_found`, `team_not_found`, `body_ref_not_found`, `agent_ref_not_found`, `marketplace_ref_not_found`, `recruitment_ref_not_found`, `execution_not_found`, `approval_not_found`, `invalid_outcome_ref` — cross-tenant access indistinguishable from missing, no existence leak), and the governance family (`plan_already_terminal`, `plan_not_active`, `fingerprint_goal_mismatch`, `fingerprint_plan_mismatch`, `recommendation_goal_mismatch`, `body_ref_inactive`, `agent_ref_inactive`, `recruitment_not_approved`, `execution_agent_mismatch`, `approval_not_decided`). |
| `validation.ts` (777L) | Pure guards (no database, no clock, no TenantContext reads — the org-lab discipline): the mirrored + compiler-pinned vocabularies (the §5 member kinds, the W021 execution statuses, `satisfies`-pinned so drift fails typecheck), the field bounds (objective/note/reason/title/detail/role/ref/label/evidence-ref limits, 1..64 tasks, 0..32 members, ≤16 evidence refs, ≤16 dependencies), the exported `taskGraphProblem` — THE SINGLE deterministic decomposition-legality definition (distinct keys, no self-dependency, no unknown dependency, no duplicate dependency entries, ACYCLIC via iterative DFS) — the per-kind member-ref rules (ref REQUIRED + uuid for agent-body / tenant-agent / marketplace kinds; optional + opaque for human-capability / external-specialist), member-key distinctness, assignee-must-name-a-declared-member, the ContextPackage bounds, the handoff two-DIFFERENT-members law, and every transition/approval/run/query validator. |
| `service.ts` (1282L) | The eleven public operations (see contract.ts). TRANSACTION DISCIPLINE (the W134 law, binding): EVERY cross-module read (goals, context, info-strategy, org-lab, agent-teams, agent-body, agents, marketplace, agent-recruitment, actions, learning) runs on the base connection BEFORE the mutation — `createExecutionPlan` gates every link first, then ONE transaction appends pointer + every task row + every member row; `completeExecutionPlan`/`abandonExecutionPlan` re-check the one-way transition under a FOR UPDATE row lock (the staleness re-check); `recordHandoff`/`recordApproval`/`recordExecutionRun` gate everything, then a SINGLE atomic append. Tenant-scoped loaders with uniform typed not-founds; deterministic read orders (plans newest-first; tasks by position; members by member_key; evidence tails by recorded_at ASC, id ASC). |
| `contract.ts` (208L) | The ONLY public surface (rule (b)): the eleven operations, `AgentExchangeError` + codes, the guards/vocabularies/limits, `taskGraphProblem` exported for verification, the domain types, and the frozen cross-module vocabularies (`AgentExecutionStatus`, `OrgNodeKind`) re-exported TYPE-ONLY through their owning contracts. |
| `tests/agent-exchange-unit.test.ts` (435L) | 21 pure proofs over validation (no database). |
| `tests/agent-exchange-service.test.ts` (1576L) | 30 embedded-PGlite integration proofs over the REAL service with REAL cross-module fixtures through thirteen owning contracts (the harness NEVER opens its own transaction — the W134 deadlock class cannot occur). |

## The core acceptance, test-locked

**"No second execution authority"** — the structural law, proven three ways:

- the public-surface tripwire: the contract exports NO execution,
  installation, recruitment or authority primitive (no
  `submitAgentExecution`/`runAgentExecution`/`cancelAgentExecution`/
  `setAgentTransport`/`registerAgent`/`updateAgent`/`installPackage`/
  `decideApproval`/`authorizeAction`) and every declared operation is a
  record/transition/read function — a regression that smuggles an
  execution verb onto the surface fails this test;
- the storage law: UPDATE/DELETE/TRUNCATE on handoffs, approvals and
  runs are rejected by triggers outright (probed with direct SQL);
  tasks and members are immutable; the plan's only legal UPDATE is the
  one-way terminal transition and DELETE reads `lifecycle-managed`;
- the no-side-effect law: a run for a nonexistent W021 execution is
  refused with `execution_not_found` and NOTHING appended (the evidence
  tail length is asserted unchanged).

The other three clauses, equally test-locked:

- **"Recruitment uses Marketplace/Agent Recruitment"** — a member
  citing recruitment provenance references a REAL W022 proposal walked
  through `createRecruitmentProposal → requestRecruitmentApproval →
  decideApproval(approve) → settleRecruitmentProposal` (an
  awaiting-decision proposal refuses with `recruitment_not_approved`;
  a foreign id refuses uniformly with `recruitment_ref_not_found`);
  a marketplace member references a REAL W028 package walked through
  `submitPackage → runAutomatedVerification → reviewPackage(approve) →
  publishPackage → makePackageInstallable` — a PUBLISHED-not-INSTALLABLE
  package, a foreign vendor's invisible draft and a missing id ALL
  refuse with the same uniform `marketplace_ref_not_found` (locks
  26/27: publication never implies the right to join an organization;
  no existence leak). The governed plan round-trip carries every
  composed link (goal + version pin, fingerprint, strategy,
  recommendation, team, all four member kinds).
- **"Context routing is minimal and evidence-linked"** — handoffs and
  runs carry EXACTLY the ContextPackage (one fingerprint ref + explicit
  evidence refs + note, round-tripped verbatim); an absent fingerprint
  is legal (minimal is the law — evidence-only routing); a fingerprint
  of ANOTHER goal refuses (`fingerprint_goal_mismatch`); a divergent
  fingerprint of the SAME goal refuses against a conditioned plan
  (`fingerprint_plan_mismatch`); unknown tasks/members and self-
  handoffs refuse with their typed codes.
- **"Progress/results return through normalized agent contracts"** — a
  run references a REAL W021 execution submitted through the agents
  contract: the LIVE (queued) execution records PROGRESS and the
  TERMINAL (succeeded) execution records the RESULT, and both freezes
  are asserted VERBATIM against a fresh `getAgentExecution` read
  (status, result summary, cost, attempts, completion time — no
  transformation, no re-derivation); assignee governance refuses an
  execution belonging to a different agent than the task's declared
  tenant-agent slot (`execution_agent_mismatch`); the outcome link
  accepts OPEN learning outcomes only (`invalid_outcome_ref` for
  settled or foreign ids — the commitment BEFORE realization).

## Design decisions & rulings honored

1. **The exchange is a PROJECTION, not an authority.** Nothing here
   submits, dispatches, retries, cancels, installs, recruits or decides.
   The agents module (W021) stays the one execution authority,
   Marketplace (W028) and Agent Recruitment (W022) own acquisition,
   the actions matrix (W009) owns authority decisions, W137 owns
   execution environments and W141 certifies the journey. Every
   cross-module import on the write path is a READ (existence, state,
   snapshot); every mutation touches only this module's tables.
2. **The relay handoffs are append-only evidence (§24).** What context
   traveled between which members for which task, when — recorded once,
   never rewritten. Storage triggers reject UPDATE/DELETE/TRUNCATE;
   the same law covers approvals and runs.
3. **Governed approvals record FROZEN W009 decisions.** The action
   request must be TERMINAL at record time; the decision snapshot
   (status approved/rejected, kind, level, requester, requestedAt,
   decidedAt) is consumed VERBATIM from the actions contract. A
   still-pending request refuses (`approval_not_decided`) — this
   surface never decides, anticipates or rewords an authority outcome.
   A REJECTION is exactly as retainable as an approval (both are
   evidence). The snapshot is re-read fresh at record time, never the
   caller's possibly-stale authorization-time return.
4. **Execution runs REFERENCE, never execute, W021.** The run freezes
   the execution's normalized state at record time; the canonical
   result payload stays owned by the agents module (§16). Progress and
   results arrive through the same normalized contract — a live
   execution records progress, a terminal one records the result. The
   freeze never retro-updates (append-only observation law): observing
   later progress means recording a new run.
5. **The MINIMAL ContextPackage law is STRUCTURAL.** At most one
   context-fingerprint reference (validated readable, goal-matched to
   the plan's goal, and — when the plan itself is conditioned on a
   fingerprint — the SAME one) plus explicit bounded evidence refs.
   There is no field, column or code path through which the company
   model, a conversation history or an unbounded context blob could
   travel. An absent fingerprint is legal: the minimal package may be
   evidence-only.
6. **`taskGraphProblem` is the single definition of a legal
   decomposition.** Exported from validation.ts, consumed by
   `validateCreateExecutionPlanInput`, unit-proven for DAG legality,
   duplicate keys, self-dependency, unknown dependencies, duplicate
   dependency entries and cycles (direct and indirect, iterative DFS —
   no recursion-depth trap on a 64-task graph).
7. **Tasks and members are IMMUTABLE from creation** (a changed
   decomposition is a NEW plan — the house "changed proposal" law);
   only the plan's one-way active → completed|abandoned lifecycle
   moves, each terminal stamping its column EXACTLY ONCE and setting
   the retained lifecycle note (completion note / abandonment reason).
   The transition re-checks under FOR UPDATE: a racing transition that
   committed first owns the terminal state.
8. **TRANSACTION DISCIPLINE (the W134 lesson, binding).** PGlite is
   single-connection; every cross-module gate runs on the base
   connection BEFORE the mutation, then ONE transaction whose
   statements touch only this module's tables (the create append), a
   lock-and-stamp transaction (the lifecycle transitions) or a single
   atomic INSERT (the evidence appends — the registerCandidate
   precedent). The test harness honors the same law.
9. **The plan-ACTIVE check for handoffs/runs is deliberately
   pre-statement, not under a lock** (documented judgment call,
   reversible at TL discretion): a run or handoff landing in the
   instant a concurrent abandonment commits is still HONEST evidence
   about a real execution/relay — the lifecycle law governs the
   projection's spine, not the append-only evidence tail. The
   completed/abandoned plan refuses further relay and run observations
   (`plan_not_active`), but nothing already recorded is rewritten.
10. **Assignee governance:** when a task's slot names a tenant-agent
    member, the referenced execution must belong to THAT agent — runs
    serve the organization the plan declared, not arbitrary agents
    (`execution_agent_mismatch`).
11. **The goal version pin (§11-style).** `goalVersion` is the goal's
    current version snapshotted at creation; the goal's own later
    revisions do not rewrite the projection (reconstructability), and
    the evidence tail serves the plan's lifecycle, not the goal's.
12. **Vocabulary mirroring, compiler-pinned.** The §5 member-kind set
    and the W021 execution-status union are mirrored as local
    constants and pinned with `satisfies` — drift in an owning module
    fails TYPECHECK here, never runtime. contract.ts re-exports both
    TYPE-ONLY through their owning contracts.
13. **Member-key distinctness** was added to validation after the unit
    proof caught the gap (the honest sequence preserved in 757255c) —
    the proof suite drove the guard, not the other way around.

## The seam consumption map (what this module reads, and where)

All cross-module imports target contracts only (rule (b), enforced by the
architecture gate; arch pass 763/337/278). Nothing is re-derived; everything
consumed is consumed verbatim.

| Seam (owner) | Contract symbols consumed | Where in `service.ts` | How the integration tests exercise it |
| --- | --- | --- | --- |
| goals (W008) | `getGoal`, `GoalsError` | `requireActiveGoal` — createExecutionPlan: the subject goal must be readable and ACTIVE; its current `version` is snapshotted as the plan's revision pin | real `createGoal` fixtures; an ARCHIVED goal (via `reviseGoal`) proves the unavailable-state mapping to `goal_not_found` |
| context (W134) | `getFingerprint`, `ContextError` | `requireFingerprintForGoal` — createExecutionPlan (the plan's own conditioning) AND `requireRoutedContext` (every handoff + run): the fingerprint must be readable AND derived FOR the subject goal (else `fingerprint_goal_mismatch`); when the plan is conditioned, the routed fingerprint must BE it (else `fingerprint_plan_mismatch`) | real `deriveFingerprint` fixtures: spring observations, materially different winter observations (the divergent same-goal fingerprint) and an other-goal fingerprint |
| info-strategy (W134) | `getStrategy`, `InfoStrategyError` | `requireStrategy` — the optional strategy link validated readable at write time, opaque afterwards | a real `defineStrategy` conditioned on the fixture goal + fingerprint (chained through a real `recordUnknown`); `strategy_not_found` + the positive link round-trip |
| org-lab (W135) | `getRecommendation`, `OrgLabError`; type-only `OrgNodeKind` | `requireRecommendationForGoal` — the optional recommendation link (the organization evidence) must be readable AND recorded for the SAME goal (else `recommendation_goal_mismatch`) | a real `registerCandidate` ×2 + `recordRecommendation` fixture with expected outcomes; `recommendation_not_found` + the goal-mismatch refusal |
| agent-teams (W023) | `getTeam`, `AgentTeamsError` | `requireActiveTeam` — the optional team link must be readable and ACTIVE | a real `createTeam` → `activateTeam` chain (under a permissive `setAuthorityPolicy`); a DRAFT team proves `team_not_found` |
| agent-body (W133) | `getAgentBody`, `AgentBodyError` | `validateMemberRefs` (agent-body kind) — the ref must be readable + ACTIVE (a fresh organization references live bodies) | a real `createAgentBody`; `retireAgentBody` proves `body_ref_inactive`; a foreign id proves `body_ref_not_found` |
| agents (W021) | `getAgent`, `getAgentExecution`, `AgentsError` | `validateMemberRefs` (tenant-agent kind: readable + active) and `requireAgentExecution` (runs: readable; the normalized status/summary/cost/attempts/completion frozen VERBATIM); type-only `AgentExecutionStatus` re-exported | real `registerAgent` / `updateAgent(disabled)` / `submitAgentExecution` / `runAgentExecution` through the in-process fake transport (`setAgentTransport` — the sanctioned wiring seam; no real provider contacted); `agent_ref_not_found`/`agent_ref_inactive`, `execution_not_found`, `execution_agent_mismatch`, and the VERBATIM freeze assertions against a fresh `getAgentExecution` read |
| marketplace (W028) | `getPackage`, `MarketplaceError` | `validateMemberRefs` (marketplace-agent-package / marketplace-extension-package kinds) — the ref must be visible to this tenant AND INSTALLABLE (locks 26/27); anything else reads uniformly `marketplace_ref_not_found`, no existence leak | a real vendor/tenant pair walking `submitPackage → runAutomatedVerification → reviewPackage(approve) → publishPackage → makePackageInstallable`; a PUBLISHED-only package, a foreign invisible draft and a missing id all refuse uniformly |
| agent-recruitment (W022) | `getRecruitmentProposal`, `AgentRecruitmentError` | `validateMemberRefs` (every member's `recruitmentProposalId`, when cited) — the proposal must be readable AND APPROVED (acceptance law 1: the exchange records organizations formed through real approved acquisitions only) | a real `createRecruitmentProposal → requestRecruitmentApproval → decideApproval(approve) → settleRecruitmentProposal` chain (chained through real `registerCapability` + `registerRequirement` gap fixtures); an awaiting-decision proposal proves `recruitment_not_approved`, a foreign id `recruitment_ref_not_found` |
| actions (W009) | `getActionRequest`, `ActionsError` | `requireTerminalActionRequest` — the request must be readable and TERMINAL; the frozen decision snapshot is consumed VERBATIM (a still-pending request refuses `approval_not_decided`) | real `authorizeAction` + `decideApproval` chains — one approved, one REJECTED (retained evidence), one deliberately left pending; the snapshot asserted against a fresh `getActionRequest` read |
| learning (W040) | `getOutcome`, `LearningError` | `requireOpenOutcome` — a run's optional outcome link must be readable and OPEN at record time (the commitment BEFORE realization, the W054 prediction-hygiene discipline inherited from org-lab) | real `defineOutcome` → `recordMeasurement` → `settleOutcome` chains; a settled outcome and a foreign id both prove the uniform `invalid_outcome_ref` |
| epistemics (W004) | — (indirect) | not read by the service; the strategy fixture transitively owns Unknown validation | the tests' strategy fixtures register real Unknowns because `defineStrategy` demands one |
| capabilities (W017) | — (indirect) | not read by the service; the recruitment fixtures transitively own capability-gap validation | the tests' W022 fixtures register real capability + requirement gaps because the recruitment path demands one |

## Honest-limitations register (for TL integration)

1. **The FOR UPDATE staleness re-checks in complete/abandon are
   structurally present but not CONCURRENTLY provable on this box**
   (PGlite is single-connection — the same class as the W134/W135
   limitation): a racing transition cannot be interleaved with the row
   lock held; the sequential second call fails at the pre-transaction
   uniform check (`plan_already_terminal`) before the lock re-check is
   reached. What IS proven: the one-way transition, the exact-once
   stamps, the retained lifecycle note, the terminal refusal and the
   post-terminal `plan_not_active` refusals.
2. **Sweeps / registrations / census for the six new tables are
   TL-owned** (the W125/W135 precedent — outside this worker's strict
   ownership): the tenant-isolation manifest and schema-pinned census
   registrations for `execution_plans`, `execution_plan_tasks`,
   `execution_plan_members`, `execution_plan_handoffs`,
   `execution_plan_approvals` and `execution_plan_runs` await the TL
   integration pass. The arch gate's table count moved 272 → 278 with
   W136's six tables (the migration is auto-discovered; the count is
   honest). The two-tenant isolation proofs live in this module's own
   suite in the meantime.
3. **Assignee governance covers tenant-agent slots only.** When a
   task's assignee names a marketplace-package or agent-body member,
   the run's execution is not execution-side matched to that member —
   the marketplace package's runtime agent identity is a
   marketplace/agents composition concern (W138/W141 own the
   end-to-end certification). The `agentId` is still denormalized from
   the execution and recorded on every run.
4. **A run's freeze never updates.** Observing later progress of the
   same execution means recording a NEW run (the append-only
   observation law). Downstream consumers composing a live progress
   view (W140) must list-and-fold the evidence tail, not expect a
   mutable progress record. Deliberate; flagged for the W140 seam.
5. **Human-capability and external-specialist member refs stay
   OPAQUE** (the W135 §5 ruling carried forward): their registries own
   the verification points; the exchange records the reference.
   Cross-module existence validation for those kinds is a
   composition-boundary decision.
6. **The vocabulary mirrors in `validation.ts`**
   (`EXCHANGE_MEMBER_KINDS`, `AGENT_EXECUTION_STATUSES`,
   `REF_REQUIRED_MEMBER_KINDS`) are manual reconciliation points if the
   owning contracts ever extend — compiler-pinned via `satisfies`, so
   drift fails typecheck, not runtime.
7. **No authority-claim gating on exchange operations** (the
   org-lab/agent-body precedent): recording plans/handoffs/runs is
   claim-free for any explicit TenantContext member; authorization
   wiring belongs to app composition, not the storage layer.
8. **No app-layer UX** — no routes, screens or MCP surface ship with
   this module; app composition owns them.
9. **The full repository suite is deliberately NOT run by this
   worker** — the TL owns the integration battery (the W135 precedent).

## Test inventory (51 proofs, all green)

Integration (30, embedded PGlite, env pinned before imports,
`runMigrations`, `closeDb`; the harness NEVER opens a transaction):
governed-organization round-trip with every composed link + the
§11-style version pin · unapproved + foreign recruitment provenance
refused · marketplace below-INSTALLABLE refused uniformly ×3 (locks
26/27) · **THE MINIMAL PACKAGE** (verbatim round-trip, evidence-only
routing, other-goal fingerprint refused, divergent same-goal
fingerprint refused, unknown task/member + self-handoff refusals) ·
**THE VERBATIM FREEZES** (live-queued PROGRESS and terminal-succeeded
RESULT, both asserted against fresh `getAgentExecution` reads) ·
evidence-timeline listing with task filter · assignee governance ·
nonexistent execution refused with NOTHING appended · settled + foreign
outcome links refused · **THE SURFACE TRIPWIRE** (no execution
primitive exported; all eleven ops present) · storage-level
append-only on handoffs/runs/approvals (UPDATE/DELETE/TRUNCATE) ·
tasks/members immutability + plan content unrewritable + DELETE
`lifecycle-managed` · pending approval refused · APPROVED decision
frozen verbatim · REJECTED decision retained · unknown
request/plan/task refusals · approvals intact after trigger probes ·
one-way complete (stamp once, refuse re-complete/re-abandon, refuse
relay + runs after terminal) · abandonment with retained reason ·
plan listing (newest-first, counts, status/goal filters) · typed
goal-side error paths (missing/archived goal, foreign/other-goal
fingerprint, foreign strategy) · typed organization-side error paths
(foreign/mismatched recommendation, foreign + DRAFT team, foreign +
retired body, foreign + disabled agent) · plan-side uniform not-founds
+ the empty-filtered-list law · the positive strategy-link round-trip ·
**TWO-TENANT ISOLATION** (same-shaped plans coexist, foreign reads
not-found, foreign list views empty, no evidence-tail leakage).

Unit (21, pure — no database): the mirrored vocabularies + their
guards + the TenantContext assertion · `taskGraphProblem` (legal DAG,
duplicate keys, self-dependency, unknown dependency, duplicate
dependency entry, cycles direct and indirect) ·
`validateCreateExecutionPlanInput` (round-trip + normalization, goal
uuid + objective bounds, task-count + key-grammar bounds, illegal
graph refused at plan level, per-kind member-ref rules incl. the
opaque human/external case, member bounds + key distinctness, assignee
+ provenance rules) · the ContextPackage bounds (evidence-ref count,
duplicates, fingerprint uuid-or-null) · the handoff two-member law ·
transition/approval/query validators (limit bounds, status
vocabulary, plan-scoped shapes).

## Gates (run from the worktree root, exact commands and outputs)

- `timeout 300 bun run typecheck` — exit 0, zero errors
- `timeout 120 bun run arch` — exit 0, "architecture check passed —
  module files: 763, app/mcp files: 337, tables checked: 278"
- `timeout 240 bun run lint` — exit 0, zero errors
- `timeout 590 bunx vitest run src/modules/agent-exchange` — exit 0,
  2 files, **51/51 passed** (30 service + 21 unit), 0 unhandled errors

The full repository suite is deliberately NOT run — the TL owns the
integration battery. All W136 commits are local to
`work/w136-agent-exchange` (cfe0b38 → c204903 → 757255c → 78c3a75 →
this note's commit); the push waits on the operator's PAT re-provision.
