# W140 — Unified Closed-Loop Learning · WORK NOTES

Work item: `spec/work-items/WORK-ITEM-CATALOG.md` §W140 (dependencies:
W128-W139 — the consumed seams listed below, all consumed, none
modified). Design contract: `spec/ARCHITECTURE.md` §24 ("audit records
are append-only from the domain perspective"), W128's frozen
reality-vs-knowledge deviation distinction (made structural here),
the W134 transaction discipline (base-connection reads before the one
mutation transaction on single-connection PGlite), ADR-0016 (the
CompanyModel is "derived from evidence, outcomes and validated
interactions" — lock 14: explicit policy stays authoritative over
every learned signal) and ADR-0001 (tenancy).

> "Connect coverage/query, goal deviation, information strategy,
>  organization selection, execution outcomes and CompanyModel learning
>  into one longitudinal loop."
> Acceptance: "reality deviation and knowledge deviation remain distinct;
>  learning changes future ranking without silently overriding policy;
>  longitudinal evidence shows measurable improvement."

Delivery history (honest): D1 delivered layers 1-3 across three
commits — 6e25802 (types + errors + migration + validation), 48b125c
(service + contract), 5d72fa8 (unit proofs, 17/17). f715db2 was a
TL-banked in-progress unit-test edit (dead D1 window); D2's 37989d4
verified and completed it (one `noUncheckedIndexedAccess` repair).
078cf48 was the TL-banked service suite — **written but NEVER RUN**
(the dead D2 window closed before any gate touched it). D3 (this
delivery) ran all four gates on the banked state and REPAIRED it —
unlike the W136-W139 finishers, this banked suite was NOT intact:
one PRODUCTION defect and four test-side defects surfaced (the full
register is in "The D3 repair" below); 15df7c3 landed them green
(41/41), and this notes file is the module's final deliverable.

## What was built (file map)

Everything lives in `src/modules/closed-loop/**` — nothing else in
the repository was touched by the W140 chain.

| File | Role |
| --- | --- |
| `types.ts` (397L) | The domain shapes: `RealityDeviation`/`KnowledgeDeviation` and their INPUT twins (structurally distinct — the reality input carries `expected`/`observed` and optionally `planId`; the knowledge input carries `severity` and optionally `snapshotId`; each forbids the other's fields), the `LoopCycle` longitudinal record (goal-scoped, 1-based per-(tenant, goal) cycle numbers, append-and-close spine, `metrics: null` while open), `LoopCycleMetrics` (the frozen-at-close quartet + the two counts), the policy-safe `RankingSignal` (`authoritative: false` — a literal type, never caller-suppliable), the trajectory/summary read shapes and the four-value `ImprovementVerdict`. |
| `migrations/001-closed-loop.sql` (248L) | Four tenant-scoped tables: `loop_cycles` (the spine — identity columns immutable from creation, the ONLY legal UPDATE is the one-way open → closed transition, frozen metrics written exactly at the close; the table CHECK pins the open row to zero counts and null metrics, and the closed row to stamped close provenance), `loop_reality_deviations` and `loop_knowledge_deviations` (the two deviation classes as SEPARATE tables — law 1 — with class-specific columns: `expected/observed/magnitude/plan_ref` vs `severity/snapshot_ref`, `plan_ref` present exactly on `execution_run` citations and `snapshot_ref` exactly on `coverage_gap` citations, both enforced by table CHECKs), and `loop_ranking_signals` (the advisory learning applications). All three child tables reject UPDATE/DELETE/TRUNCATE outright through BEFORE triggers (§24 append-only). Cross-module references are opaque forward references, deliberately NOT foreign keys (the house discipline). |
| `errors.ts` (98L) | 20 typed codes: the input family (`invalid_context` … `invalid_query`), the uniform not-found family (`cycle_not_found`, `goal_not_found`, `run_not_found`, `lease_not_found`, `gap_not_found`, `learning_update_not_found`, `strategy_not_found`, `candidate_not_found`, `recommendation_not_found` — cross-tenant access indistinguishable from missing, no existence leak), the lifecycle family (`cycle_not_open`, `cycle_already_closed`, `goal_not_active`, `strategy_goal_mismatch`) and **`policy_mutation_refused`** — the typed boundary of the policy-authority law. |
| `validation.ts` (697L) | Pure guards + THE DETERMINISTIC LOOP MATH (both unit-testable without a database): the class-specific deviation validators (each rejects the other class's excess keys explicitly — the structural non-interchangeability), the signal validator with the policy-surface refusal (every `POLICY_SURFACE_WORDS` target refused with `policy_mutation_refused` BEFORE anything is recorded, on the mutation surface; the same refusal on `listRankingSignals`' targetSeam — the query surface), the CompanyModel subject-key guard (`isCompanyModelSubjectKey`, delegating the kind to the LEARNING contract's own `isCompanyModelSubjectKind` — consumed, never re-derived), and the exported single-definition math: `applyRankingSignals` (fold `direction · magnitude · SIGNAL_STEP` in recorded order, clamped, 4 decimals), `calibrationErrorOf`, `observedScoreOf`, `gapClosureRateOf`, `deviationRecurrenceOf`, `improvementVerdictOf`, `magnitudeOf`, `deriveSignalDirection`, `deriveSignalMagnitude`, `round4`. |
| `service.ts` (976L) | The eight domain operations. TRANSACTION DISCIPLINE (the W134 law, binding): every cross-module evidence gate and every own-table metric computation runs on the BASE connection BEFORE the mutation; each mutation is ONE transaction touching only this module's tables, with a FOR UPDATE staleness re-check inside (racing closes/signal-appends own the terminal state). `recordLoopCycle` gates the subject goal ACTIVE + every citation readable on its owning seam, then mints the cycle number (MAX+1 inside the transaction, unique-index backstop) and appends the spine + both classes. `applyRankingSignal` gates the cycle OPEN + the three target channels (info-strategy goal-matched, org-lab candidate readable, CompanyModel subject key vocabulary-valid), then appends under FOR UPDATE — minting `authoritative: false`. `closeLoopCycle` computes the deterministic metrics first, then re-checks open under FOR UPDATE and freezes them exactly once. The reads: deep cycle view, newest-first lists, the signal review surface, the closed-only ascending trajectory and the honest improvement summary. |
| `contract.ts` (196L) | The ONLY public surface (rule (b)): the 8 domain operations, `ClosedLoopError` + codes, the guards/vocabularies/limits, the deterministic math exported for verification (the service consumes, never re-derives), and the domain types. NO seam mutation, NO policy mutation, NO learning primitive — the unit tripwire source-scans both files. |
| `tests/closed-loop-unit.test.ts` (462L) | 17 pure proofs: 6 over the deterministic math, 4 over the deviation-class distinction, 5 over the policy-authority law, 2 structural no-mutation tripwires (the service's seam imports source-scanned against a read-only allowlist; the contract scanned for mutation-shaped exports). |
| `tests/closed-loop-service.test.ts` (1706L) | 24 embedded-PGlite integration proofs over the REAL service with REAL cross-module fixtures — every seam walked through its owning contract (goal → context fingerprint → epistemics unknown → info-strategy → org-lab candidate + calibrated recommendation over TWO evaluated candidates → W136 plan → W021 execution (fake in-process transport, the sanctioned wiring seam) → recorded run → W137 fabric lease (deterministic local-container adapter) → W125 snapshot with material gaps → W053 CompanyModel learning updates with provenance). Five dedicated tenants (learn/control/err/isoA/isoB) keep every count deterministic; the harness NEVER opens its own transaction (the W134 deadlock class cannot occur). |

## The acceptance, test-locked (all three clauses)

- **REALITY AND KNOWLEDGE DEVIATIONS REMAIN DISTINCT (clause 1)** —
  the distinction is STRUCTURAL at four layers, each locked: distinct
  TypeScript input interfaces whose validators reject each other's
  fields (unit: "a reality deviation requires expected/observed and
  the class-legal source shape", "a knowledge deviation requires
  severity and the class-legal source shape", "THE CLASS LOCK: neither
  deviation shape satisfies the other class validator"); distinct
  storage tables with class-specific columns and presence CHECKs
  (service SQL probes + the migration itself); distinct read paths
  (`cycle.realityDeviations` vs `cycle.knowledgeDeviations`, deep-view
  asserted in "records a cycle citing REAL evidence from every seam,
  in the two distinct classes"); and the service-boundary class lock
  — a deviation shaped as the OTHER class refuses with
  `invalid_deviation_input` and NOTHING appended (service: "THE CLASS
  LOCK at the service boundary: the other class shape refuses with
  NOTHING appended"). The reality class cites the four world seams
  (W136 runs plan-scoped, W137 leases, W135 calibrated recommendations,
  the goal's own metric — the goal-metric citation cites the subject
  goal's own id, validated equal); the knowledge class cites the two
  knowing seams (W125 material gaps snapshot-scoped, W053 CompanyModel
  learning updates).
- **LEARNING CHANGES FUTURE RANKING WITHOUT SILENTLY OVERRIDING
  POLICY (clause 2)** — every learning application is an explicit,
  recorded, reviewable `RankingSignal` with `authoritative: false`
  MINTED (service: "records signals on all three ranking input
  channels, authoritative:false MINTED" — the value is a literal type
  with no input path; the storage row has no such column at all);
  policy/settings/authority-shaped targets are refused with the
  dedicated typed code on BOTH surfaces (service: "refuses
  policy/settings/authority-shaped targets on BOTH surfaces, nothing
  appended"; unit: "policy/settings/authority-shaped targets are
  refused with the dedicated typed code" — every one of the six
  `POLICY_SURFACE_WORDS`); recording signals leaves the target seams'
  own state VERBATIM untouched — the strategy's content/version, the
  candidate record and the CompanyModel ranking are asserted
  byte-identical before/after, and no learning update is minted
  (service: "RECORDING SIGNALS NEVER TOUCHES THE TARGET SEAMS (no
  silent override)"); the CompanyModel's ranking changes ONLY through
  its own recorded channel — an explicit learning update with
  rationale moves the future ranking (0.78 → 0.275 through model
  version 2) while the loop's signal to the same target stays advisory,
  and explicit policy stays authoritative over every learned prior
  (a policy-excluded kind ranks last no matter how reliable it learned
  to be — service: "the CompanyModel ranking changes ONLY through its
  own recorded channel, policy authoritative"); structurally, the unit
  tripwires prove the service imports only the seven seams' READ
  operations and the contract exports no seam/policy mutation.
- **LONGITUDINAL EVIDENCE SHOWS MEASURABLE IMPROVEMENT (clause 3)** —
  a deterministic four-cycle loop around one goal: each cycle's
  prediction is the fold of all RECORDED signals through the exported
  `applyRankingSignals` (the same single definition the service
  consumes — never re-derived in the harness), and the frozen
  calibration errors shrink STRICTLY cycle-over-cycle
  (0.3 → 0.225 → 0.1687 → 0.1266) while a CONTROL loop over the same
  world WITHOUT signals stays flat (0.3 throughout) — service: "runs
  the four-cycle learning loop: recorded signals adjust every next
  prediction" + "runs the control loop over the same world WITHOUT
  signals: flat"; the trajectory carries the closed cycles' frozen
  series ascending and the summary states the honest verdicts
  ('improved' vs 'flat', 'insufficient_evidence' for unmeasured
  trajectories — never a fabricated improvement; unit:
  "improvementVerdictOf never fabricates improvement"); the
  deterministic math itself is unit-locked (6 proofs: fold order +
  clamp at the boundary, honest null semantics for unmeasured cycles,
  gap-closure/recurrence asymmetry, verdict rules); the one-way close
  freezes the metrics exactly once under FOR UPDATE and refuses the
  second close (service: "freezes the deterministic metrics exactly
  once and refuses the second close" + "the unmeasured cycle stays
  honestly unmeasured (nulls, never defaults)").

## Design decisions & rulings honored

1. **The deviation distinction is four-layer structural, not
   cosmetic.** Two input validators that reject each other's fields,
   two tables with class-specific columns and presence CHECKs
   (`plan_ref` exactly on `execution_run`, `snapshot_ref` exactly on
   `coverage_gap`), two read paths, two typed vocabularies. A
   deviation cannot migrate between classes, be recorded as the other
   class, or be read through the other class's path — conflating them
   would destroy the loop's honest semantics (a wrong world needs
   ACTING differently; a wrong map needs LEARNING differently —
   W128's distinction, types.ts header).
2. **The goal-metric self-citation rule.** A `goal_metric` reality
   deviation cites THE LOOP GOAL'S OWN id — validation enforces the
   equality with the cycle's subject goal (the one citation whose
   referent is already gated by `gateSubjectGoal`; service.ts marks
   it "gated above").
3. **The normalized-score boundary.** Every deviation's
   `expected`/`observed` (reality) and `severity` (knowledge) is the
   loop's normalized [0,1] summary of the cited evidence — the
   CITATION is gated readable on the owning seam, but the scores are
   caller-supplied summaries. The seam gates prove existence and
   scoping; the numbers are the recording operator's honest
   normalization (the types.ts ruling, stated verbatim in
   `RealityDeviationInput`'s doc).
4. **`authoritative: false` is minted at READ time, not stored.** The
   signals table has no authority column; `mapSignal` and the
   apply-return mint the literal `false`. There is no code path —
   input, storage or read — that could ever surface `true`. The
   policy-authority law is thereby not a convention but an
   impossibility (the W041/W053 mint precedent, ADR-0016 lock 14).
5. **The policy refusal exists on BOTH surfaces.** A
   policy/settings/authority-shaped target is refused with
   `policy_mutation_refused` in `validateApplyRankingSignalInput`
   (before anything is recorded) AND in
   `validateListRankingSignalsQuery` — even QUERYING signals as if a
   policy surface were a ranking channel is refused, so no read path
   normalizes the confusion (test-locked on both).
6. **Signals attach only to OPEN cycles** (`cycle_not_open`): a
   signal is derived from a LIVE cycle's evidence; once the cycle
   closes its evidence is frozen history. The FOR UPDATE re-check
   inside the transaction owns the racing-close case.
7. **The spine is append-and-close with zero-count opens.** The
   migration CHECK pins an open row to `reality_count = 0,
   knowledge_count = 0` and all-null metrics; the counts and metrics
   are written EXACTLY at the one-way close (identity columns
   immutable from creation; closed is terminal; frozen metrics
   immutable once closed — all four storage-guard branches
   SQL-probed). The D3 production repair (below) was exactly here:
   the INSERT must stamp the zero counts the CHECK demands.
8. **The deterministic math is exported pure and singly-defined.**
   `applyRankingSignals` folds `direction · magnitude · SIGNAL_STEP
   (0.25)` in recorded order, clamped to [0,1], rounded to 4 decimals
   — bounded convergence, never a jump to an extreme; the service and
   the tests consume the SAME export (the outcomes/learning
   discipline). The frozen constants in the improvement proofs are
   the ACTUAL IEEE-754 outputs of this fold (see the repair register:
   0.425 − 0.05625 is 0.36874999…, frozen as 0.3687).
9. **Honest null semantics everywhere.** An unmeasured cycle (no
   reality deviations) keeps `observedScore`/`calibrationError` null —
   never a defaulted 0; `gapClosureRate` is null when the previous
   closed cycle held no knowledge deviations ("nothing to close —
   absence stated, not defaulted"); `deviationRecurrence` is null when
   there was no previous closed cycle; the verdict needs ≥2 MEASURED
   points or it is `insufficient_evidence`.
10. **Closure looks back, recurrence looks forward.**
    `gapClosureRate = 1 − (previous knowledge sources recurring this
    cycle / previous count)` — the KNOWLEDGE question "did what we
    fixed stay fixed?"; `deviationRecurrence = (this cycle's reality
    sources that already deviated last cycle / this cycle's count)` —
    the REALITY question "are we hitting the same wall?" The two
    denominators differ deliberately (unit-locked:
    "gapClosureRateOf and deviationRecurrenceOf compare consecutive
    cycles honestly").
11. **Predictions commit before realization** (the W054
    prediction-hygiene discipline): `predictedScore` is frozen at
    record time, BEFORE the cycle's evidence is closed — a cycle
    cannot retrofit its prediction to its outcome.
12. **The cycle number is minted inside the transaction** (MAX+1 per
    (tenant, goal), unique index `loop_cycles_tenant_goal_number_unique`
    as the backstop) — monotonic, 1-based, per-goal; the numbering
    test also proves the honest EMPTY cycle (no deviations at all).
13. **Every evidence gate runs on the BASE connection BEFORE the
    mutation transaction** (the W134 law for single-connection
    PGlite): goals ACTIVE, runs plan-scoped, leases readable,
    recommendations readable, gaps snapshot-scoped, learning updates
    listed — then ONE transaction per mutation touching only
    loop-owned tables. The harness never opens its own transaction.
14. **Cross-module references stay opaque** — no foreign keys to the
    seams' tables (the house discipline; the schema-boundary sweep's
    expectation), all citations gated at the service layer through the
    owning contracts.
15. **Uniform not-found discipline.** A foreign or missing anything —
    cycle, goal, run, lease, gap, learning update, strategy,
    candidate, recommendation — reads as its mapped typed not-found
    code with no existence leak (ADR-0001; test-locked in the error
    and isolation suites).

## The seam consumption map (what this module reads, and where)

All cross-module imports target contracts only (rule (b), enforced by
the architecture gate; arch pass 797/337/296). Nothing is re-derived;
everything consumed is consumed verbatim. **The CompanyModel learning
seam lives in `src/modules/learning/` (W053)** — the learning module
OWNS the CompanyModel (assertion versions, `recordLearningUpdate`,
`listLearningUpdates`, `rankCandidates`, `defineOutcome`, the subject
vocabulary `isCompanyModelSubjectKind`/`deriveSubjectKey`); there is
no separate company-model module. Verified in the code: the
closed-loop service imports `listLearningUpdates` from
`@/modules/learning/contract` (evidence gate), validation imports
`isCompanyModelSubjectKind` from the same contract (subject-key
guard), and the tests build REAL CompanyModel fixtures through
`recordLearningUpdate`/`rankCandidates`/`defineOutcome`.

| Seam (owner) | Contract symbols consumed | Where | How the integration tests exercise it |
| --- | --- | --- | --- |
| goals (W008) | `getGoal`, `GoalsError`; type-only `Goal` | `gateSubjectGoal` (ACTIVE check + version snapshot) | REAL `createGoal` fixtures; an archived goal proves `goal_not_active`; a foreign goal proves `goal_not_found` |
| context (W134) · epistemics (W004) | — (fixture-only) | not read at runtime by the service | the harness derives the REAL fingerprint and records the REAL unknown so the info-strategy and org-lab fixtures are legitimate |
| info-strategy (W134) | `getStrategy`, `InfoStrategyError`; type-only `InfoStrategy` | signal targets (goal-matched with the cycle's goal) | REAL `defineStrategy` over the REAL unknown; the strategy's content/version asserted VERBATIM unchanged across signal recording; a cross-goal strategy proves `strategy_goal_mismatch` |
| org-lab (W135) | `getRecommendation`, `getCandidate`, `OrgLabError`; type-only `OrgCandidate`/`OrgRecommendation` | reality evidence gate (calibrated recommendations) + signal targets (candidates) | REAL `registerCandidate` ×2 (the 2..32 evaluation floor) + `recordRecommendation` with one recommended + one rejected-with-reasons candidate + `defineOutcome` linkage; the candidate record asserted unchanged across signal recording |
| agents (W021) | — (fixture-only, through the sanctioned wiring seams) | not read at runtime by the service | REAL `registerAgent` + `setAgentTransport` (the in-process fake transport) + `submitAgentExecution` — the W136 runs cite REAL normalized executions |
| agent-exchange (W136) | `listExecutionRuns`, `AgentExchangeError`; type-only `ExecutionPlan`/`ExecutionRun` | reality evidence gate (runs, plan-scoped) | REAL `createExecutionPlan` + `recordExecutionRun` over the W021 execution; a real run on a DIFFERENT plan proves `run_not_found`; a foreign-tenant run is refused through the seam's own scoping |
| execution-fabric (W137) | `getFabricLease`, `ExecutionFabricError`; type-only `FabricLease` | reality evidence gate (leases) | REAL `registerEnvironmentDefinition` + `acquireFabricLease` over the W136 run, through the fabric's own deterministic local-container adapter (`registerExecutionAdapter(createLocalContainerAdapter())` — module wiring, never domain state) |
| coverage (W125) | `listGaps`, `CoverageError`; type-only `CoverageGap`/`CoverageSnapshot` | knowledge evidence gate (material gaps, snapshot-scoped) | REAL surfaces + sources + stale/fresh claims → `evaluateSnapshot` → `listGaps`; two snapshots with DIFFERENT material gaps drive the improvement scenario's gap-closure series |
| learning (W053) — **the CompanyModel owner** | `listLearningUpdates`, `isCompanyModelSubjectKind`, `LearningError` | knowledge evidence gate (learning updates) + the CompanyModel subject-key vocabulary for signal targets | REAL `recordLearningUpdate` with provenance-citing evidence (ADR-0016) as the fixture prior; a REAL revision (model version 2) proves the ranking changes ONLY through the CompanyModel's own recorded channel; `rankCandidates` asserts the learned prior, its blend, and the policy-excluded override; a cold-subject signal target validates through the vocabulary guard |

## The D3 repair (the banked suite was NOT intact — the honest register)

The TL-banked 078cf48 service suite had never been run. Running it
surfaced one PRODUCTION defect and four test-side defects, all repaired
in 15df7c3:

1. **PRODUCTION (service.ts, within ownership): the `loop_cycles`
   INSERT omitted `reality_count`/`knowledge_count`.** The migration
   declares both NOT NULL and the open-state CHECK pins them to 0 —
   so EVERY `recordLoopCycle` failed at the storage boundary
   (`null value in column "reality_count" … violates not-null
   constraint`) and the whole suite skipped. Fixed by stamping `0, 0`
   at creation (the open row's law); the close UPDATE already wrote
   the real counts. Typecheck/arch/lint could never catch a SQL
   column omission — only running the suite could (the exact class
   of defect the banked-unverified state risks).
2. **Test: the org-lab fixture passed ONE evaluated candidate** under
   org-lab's 2..32 evaluation floor (`candidates must hold 2..32
   evaluations`). Fixed with a second registered candidate, rejected
   with a retained reason — which also makes the org_calibration
   evidence a real comparison, never a single-option rubber stamp.
3. **Test: two learning-update fixtures cited no provenance**
   (`evidence: []`, `outcomeId: null`) — ADR-0016's learnability rule
   refuses an assertion that cites nothing. Both now cite the REAL
   ops-tickets freshness observation (the snapshot id) as provenance.
4. **Test: the frozen fold constants were pencil-and-paper decimals**
   (0.3688/0.1688) where the ACTUAL IEEE-754 fold freezes 0.3687/
   0.1687 (0.425 − 0.05625 = 0.36874999… → `round4` → 0.3687). The
   constants now pin the real outputs of the exported single
   definition — the fold is the authority, not idealized arithmetic.
5. **Test: the improvement loops retained the OPEN cycle snapshots**
   (`recordLoopCycle` returns) for the frozen-metrics assertions
   (metrics are null while open), and the summary delta pinned the
   unrounded difference. Both loops now retain the CLOSED reads, and
   the delta pins `round4(0.3 − 0.1266) = 0.1734`.

(The cascades — trajectory/summary/list counts and one storage-law
probe hitting an open row — all resolved with the root fixes; no
further defects hid behind them. The D2-layer fix 37989d4 — the
import-scanner's `[0]?.trim() ?? ''` — was verified green again by
proxy: the tripwire test is one of the 17.)

## Honest-limitations register (for TL integration)

1. **The FOR UPDATE staleness re-checks (apply-signal, close) are
   structurally present but not CONCURRENTLY provable on this box**
   (PGlite is single-connection — the same class as the W134-W139
   limitation): a racing close cannot be interleaved with the row lock
   held; the sequential second call fails at the pre-transaction check
   before the lock re-check is reached. What IS proven: the one-way
   transition, the exactly-once freeze, `cycle_already_closed` and
   `cycle_not_open` with NOTHING appended.
2. **The measurable-improvement test form is deterministic fixtures
   vs control, not a statistical A/B.** The "control" is the SAME
   world (same goal, same observed 0.2, same deviation shape) run
   without signals; the improvement proven is the deterministic
   fold's contraction (0.3 → 0.1266), locked to the exported math.
   No randomized trial, no noise model, no real-world outcome data —
   the clause's "longitudinal evidence" is the frozen
   cycle-over-cycle series the module itself records; live-world
   calibration is W141's certification surface.
3. **The loop RECORDS learning; it does not APPLY it to the seams.**
   `applyRankingSignal` appends an advisory, reviewable record. The
   next cycle's prediction adjustment is the CALLER's fold through
   the exported `applyRankingSignals`; no operation here mutates any
   seam's ranking state (that is the clause-2 law, and the tripwires
   enforce it). Composition (W141) owns wiring the fold into live
   prediction surfaces.
4. **Registrations are TL-owned** (the W125-W139 precedent — outside
   this worker's strict ownership): the health census pin
   (301 → 305 for `loop_cycles`, `loop_reality_deviations`,
   `loop_knowledge_deviations`, `loop_ranking_signals`), the
   schema-reconciliation count pins, the discoverability/journey-proof
   instrument registration and the tenant-isolation manifest entry
   await the TL integration pass. The arch gate's table count moved
   292 → 296 with W140's four tables (the migration is auto-discovered
   by the arch script; the count is honest — but the health census,
   at 301, does NOT yet include them until the TL registers).
5. **The goal-metric citation is gated for existence/activity only.**
   The goals seam exposes no numeric metric read to gate the
   expected/observed values against — the normalized scores are the
   recording operator's summary (ruling 3 above). The same honesty
   applies to every deviation's expected/observed/severity: the
   CITATION is real and gated; the NUMBERS are caller-normalized.
6. **Evidence gates are bounded by the seams' read windows**
   (`limit: 200` on run and learning-update listings): a citation
   older than the window reads as not-found even if it exists deeper
   in history — composition-time reads should widen or page (the
   W137 500-run question's sibling).
7. **No authority-claim gating on module operations** (the
   org-lab/fabric/cross-platform precedent): any explicit
   TenantContext member can record cycles, apply signals and close;
   principals are system-captured, authorization wiring belongs to
   app composition.
8. **The signal-target vocabulary is deliberately narrow**: exactly
   the three ranking input channels; the org-lab target is a
   CANDIDATE (not a recommendation — signals tune the ranking input,
   not a past outcome); the info-strategy target must be goal-matched
   with the cycle's goal. Anything policy/settings/authority-shaped
   is refused on both surfaces.
9. **Two fixture-side wiring seams are in-process module state, never
   domain state** (test-only): the W021 fake transport and the W137
   local-container adapter registration — both the sanctioned seams
   of their owning modules; no network, no process, no filesystem.

## Test inventory (41 proofs, all green)

`tests/closed-loop-unit.test.ts` — 17 proofs:
- the deterministic loop math (6): `magnitudeOf` at 4 decimals;
  `applyRankingSignals` fold order + clamp at the boundary;
  `calibrationErrorOf`/`observedScoreOf` honest measurement;
  `deriveSignalDirection`/`deriveSignalMagnitude` conversion;
  `gapClosureRateOf`/`deviationRecurrenceOf` consecutive-cycle
  comparison; `improvementVerdictOf` never fabricates improvement.
- the deviation-class distinction (4): reality shape + class-legal
  source; knowledge shape + class-legal source; THE CLASS LOCK
  (neither shape satisfies the other validator); both classes
  validated together.
- the policy-authority law (5): the three-channel vocabulary; every
  policy word refused with `policy_mutation_refused`; legal signal
  input validates + malformed refusals; CompanyModel subject keys
  through the learning contract vocabulary; explicit TenantContext
  asserted.
- the structural no-mutation tripwires (2): the service's seam
  imports are reads only (source-scanned against the per-seam
  allowlist); the contract exports no policy/seam mutation.

`tests/closed-loop-service.test.ts` — 24 proofs:
- recordLoopCycle, the record + classes (3): full-evidence cycle in
  both distinct classes; THE CLASS LOCK at the service boundary
  (nothing appended on refusal); 1-based per-(tenant, goal) numbering
  + the honest empty cycle.
- recordLoopCycle, the seam evidence gates (3): run citations must
  resolve on the plan; missing leases/recommendations/gaps/learning
  updates refused uniformly; missing + archived subject goals
  refused.
- applyRankingSignal, the policy-safe application (5): all three
  channels, `authoritative: false` minted; policy words refused on
  BOTH surfaces; target mismatches + unknown targets with mapped
  codes; seams untouched (no silent override); the CompanyModel
  changes only through its own recorded channel, policy
  authoritative.
- closeLoopCycle (3): metrics frozen exactly once + second close
  refused; unmeasured stays null; missing cycles + malformed queries
  uniform.
- the longitudinal measurable improvement (5): the four-cycle
  learning loop (predictions adjust via the recorded-signal fold,
  errors shrink strictly); the control loop flat; the closed-only
  ascending trajectory; the honest summary verdicts; the filtered
  newest-first lists.
- tenant isolation (3): foreign cycles uniformly not-found + scoped
  lists; foreign evidence refused through the seams' own scoping;
  same-shaped loops with independent numbering and closings.
- the storage laws, direct SQL probes (2): the three evidence tables
  append-only (UPDATE/DELETE/TRUNCATE rejected); the cycle spine
  append-and-close (identity immutable, one-way, frozen).

## Gates (run from the worktree root, exact commands and outputs)

Run by this finisher TWICE at the same content (once at 15df7c3
before the notes existed — the repair commit's recorded gates — and
once with these notes in place; identical results; the .md touches
nothing the gates count):

- `timeout 300 bun run typecheck` — exit 0, zero errors (`tsc --noEmit`)
- `timeout 120 bun run arch` — exit 0, "architecture check passed —
  module files: 797, app/mcp files: 337, tables checked: 296"
- `timeout 240 bun run lint` — exit 0, zero errors (`eslint .`)
- `timeout 590 bunx vitest run src/modules/closed-loop` — exit 0,
  2 files, **41/41 passed** (24 service, 5742ms + 17 unit, 10ms),
  0 failed, 0 skipped, duration 7.90s

The full repository suite is deliberately NOT run — the TL owns the
integration battery. The W140 chain is `6e25802` (D1 layer 1) →
`48b125c` (D1 layer 2) → `5d72fa8` (D1 layer 3, unit proofs) →
`f715db2` (TL-banked partial) → `37989d4` (D2 verification + repair,
unit 17/17) → `078cf48` (TL-banked UNVERIFIED service suite) →
`15df7c3` (D3 verification + repair, 41/41) → this notes commit on
`work/w140-closed-loop`; pushed to origin by this finisher.

## Wave E integration pass (2026-10-08, task WE-INT on work/we-integration)

This section is APPENDED by the integration-pass worker (append-only;
the record above is history). It records what THIS pass closed against
the honest-limitations register, following the WD-INT precedent (the
dated append in the cross-platform WORK-NOTES, commits 14e22bb →
033b6ae → 7496e9c → d56e677 on work/wd-integration).

**Limitation #4 — CLOSED.** The deferred integration-tier registrations
for the four tables (`loop_cycles`, `loop_reality_deviations`,
`loop_knowledge_deviations`, `loop_ranking_signals`) are delivered:

1. **Tenant-isolation sweep** — `tests/tenant-isolation/closed-loop-sweep.test.ts`
   (manifest v12 → v13): a REAL two-tenant service proof in the
   WB2/W136/WC/WD-INT house style. Tenant A walks three cycles around
   one REAL goal through the public contract — two closed with the
   frozen longitudinal metrics (0.2375/0.2625 then 0.35/0.15, gap
   closure 1, recurrence 1) and one still open — each citing REAL
   evidence from every connected seam (a W136 execution run walked
   goal → plan → W021 execution → recorded run, a W137 fabric lease, a
   W135 calibrated recommendation over the two-candidate floor, the
   goal's own metric; a W125 material coverage gap snapshot-scoped and
   a W053 CompanyModel learning update with provenance), with signals
   on all three ranking input channels (info-strategy goal-matched,
   org-lab candidate, CompanyModel subject key, `authoritative:false`
   minted). Tenant B sees none of it: empty-list invisibility on every
   query path (`listLoopCycles` / `listRankingSignals` unfiltered AND
   filtered by A's goal/cycle ids; empty trajectory + the honest
   `insufficient_evidence` summary over A's goal), uniform
   `cycle_not_found` on the deep read, the one-way close and the
   signal append (foreign ≡ missing over open AND closed cycles
   alike), the mapped `goal_not_found` / `run_not_found` /
   `lease_not_found` / `recommendation_not_found` / `gap_not_found` /
   `learning_update_not_found` stolen-evidence composition refusals
   (B cannot even open a cycle over A's goal or cite A's evidence),
   the `strategy_not_found` / `candidate_not_found` signal-target
   refusals through B's OWN open cycle, and the same goal title +
   rationale/note strings + frozen metrics coexisting per tenant with
   INDEPENDENT 1-based cycle numbering (B's first cycle is 1 although
   A is already at 3). PASSED ON THE FIRST RUN (no repairs).
2. **Discoverability registration** — the module joined
   `src/modules/journey-proof/discoverability.ts` as a platform
   instrument (domain infrastructure with a delivered service + four
   tables, no user-facing routes of its own yet; it leaves the
   instrument list when W141 lands the certification surfaces, the
   meetings/cellular precedent). The e2e instrument-list pin moved
   27 → 28 declared harnesses (the discoverability e2e had been
   FAILING on the integrated branch until this registration — the
   module-scan tripwire demanded the entry).
3. **Health census** — `EXPECTED_TABLE_CENSUS` 301 → 305 with the
   four table names added to `EXPECTED_TABLE_NAMES`, verified against
   the health suite's fresh fully-migrated embedded db (the census
   test re-migrates and asserts).
4. **Schema-reconciliation pins** — 147 → 148 applied / 150 → 151
   discovered / 150 → 151 skipped (`closed-loop/001`, the four-table
   first migration).
5. **Schema-boundary sweep — no allowlist additions required**: the
   migration's only UNIQUE namespace is
   `loop_cycles_tenant_goal_number_unique` on (tenant_id, goal_id,
   cycle_number) — tenant-leading by construction; there are no
   foreign keys at all (opaque forward references are the house
   discipline), and every table carries NOT NULL uuid tenant_id — the
   sweep passed unchanged inside the green tenant-isolation directory
   run.

**Honest new table counts at the pass tip:** the arch gate reads
**797 module files / 337 app/mcp files / 296 tables checked** on the
integrated branch (W140's four tables moved the count 292 → 296
pre-merge; unchanged by this pass — it adds no tables); the health
census 301 → 305; the schema-reconciliation pins
147/150/150 → 148/151/151. The arch-count-vs-census difference is the
migrations-ledger convention (the census counts the `_migrations`
ledger and any non-module tables the arch script does not).

**Still open after this pass** (unchanged from the register above):
#1 (the FOR UPDATE staleness re-checks not concurrently provable on
single-connection PGlite), #2 (the deterministic fixture-vs-control
improvement form — live-world calibration is W141's), #3 (the loop
records learning, does not apply it to the seams — composition owns
the wiring), #5 (goal-metric and deviation scores are
caller-normalized; only the citations are gated), #6 (the bounded
200-read evidence windows), #7 (no authority-claim gating), #8 (the
deliberately narrow three-channel signal-target vocabulary), and #9
(the in-process fixture wiring seams).

**Pass gates (worktree /home/z/aurum-weint, branch work/we-integration,
base integration/wave-e @ 632b061 — the post-W140 merge point):**
`timeout 300 bun run typecheck` → exit 0, zero errors · `timeout 120
bun run arch` → exit 0, "architecture check passed — module files:
797, app/mcp files: 337, tables checked: 296" · `timeout 240 bun run
lint` → exit 0, zero errors · `timeout 590 bunx vitest run
tests/tenant-isolation` → exit 0, 39 files, **244/244 passed**
(234.41s; was 38/243 at the pass base) · `timeout 300 bunx vitest run
tests/e2e/journeys/discoverability.e2e.test.ts
tests/e2e/platform/schema-reconciliation.test.ts src/app/api/health`
→ exit 0, 3 files, **45/45 passed** (discoverability 12 + schema-
reconciliation 27 + health 6) · `timeout 590 bunx vitest run
src/modules/closed-loop` → exit 0, 2 files, **41/41 passed** (24
service, 5687ms + 17 unit, 10ms). The pass chain is a9d9546 (the
sweep + manifest v13) → 88ea659 (the discoverability registration +
pin) → 5dfe244 (the census + schema pins) → this notes commit, all
pushed to origin/work/we-integration. One transient infra note: the
first `bun run typecheck` attempt of the pass was SIGKILLed ~30s in
by the box's memory pressure (the resident next-server holds ~1.3GB
of the 4GB) — a clean re-run and every later run exited 0 with zero
errors; no code change was involved.
