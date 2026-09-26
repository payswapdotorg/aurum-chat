# W100 — Longitudinal S003 Conversion Benchmark · Raw Results

The machine-readable result artifacts emitted by
`tests/longitudinal/s003-conversion.benchmark.test.ts` (work item **W100 —
Longitudinal S003 Conversion Benchmark**, `spec/work-items/WORK-ITEM-CATALOG.md`).
The suite re-emits this tree on every run; the artifacts are **byte-stable**
(recursively sorted keys, no uuids, no timestamps), so identical seeds produce
byte-identical artifacts — verified by re-running the suite and diffing.

## Tree

```
results/s003/
├── summary.json                 # headline aggregates, per-industry and per-firm rollups, honest findings
├── legal/                       # the four legal firms (W092 kit: legal-case-management)
│   ├── solo.json  ├── small.json  ├── mid.json  └── large.json
├── accounting/                  # the four accounting firms (W092 kit: accounting-ledger-erp)
│   ├── solo.json  ├── small.json  ├── mid.json  └── large.json
├── logistics/                   # the four logistics firms (KIT-LESS control industry)
│   └── solo/small/mid/large.json
└── quality/                     # the deep firms' raw W055 quality payloads + attribution conversions
    ├── legal.json  ├── accounting.json  └── logistics.json
```

Every artifact carries the same `schema` header: `schemaVersion`, `benchmarkId`
(`aurum:w100-s003-conversion-benchmark`), `workItem`, `generatedBy`, `model`,
`determinism`, the **metric definitions of record** (`metricDefinitions`), the
published `effortWeights` (`automaticAction: 1`, `humanApproval: 10`,
`humanRoundReview: 15` modeled action-minutes) and the documented manual
integration protocol (`manualProtocol`).

## The firm matrix

12 firms = 3 industries × 4 sizes, one reproducible seed each:

| industry   | kit                              | sizes (incumbent systems)                            |
|------------|----------------------------------|------------------------------------------------------|
| legal      | `legal-case-management` (W092)   | solo 1 · small 2 · mid 3 · large 4 systems           |
| accounting | `accounting-ledger-erp` (W092)   | solo 1 · small 2 · mid 3 · large 4 systems           |
| logistics  | **none** (kit-less control)      | solo 1 · small 2 · mid 3 · large 4 systems           |

The **mid-size firm of each industry is the deep firm**: it additionally runs
the full simulator month loop as EXPERIENCED (24 months, recorded CompanyModel
learning), CONTROL (24 months, no learning) and COLD-START (a fresh tenant per
checkpoint) — the W056 attribution trio — and its raw W055 quality payloads are
in `quality/<industry>.json`.

## Per-firm artifact shape

`<industry>/<size>.json` contains, per firm:

- `firm` — seed, industry, size, seeded name, incumbent systems (roles, W081
  capability classes), primary system of record;
- `baselineAdoptionVerifiedEmpty` — the BASELINE state was verified EMPTY by
  module reads (kit installations, connected systems, meeting sessions,
  cellular reaches, supervisions all absent), not assumed;
- `matureAdoption` — the module-derived adoption snapshot the MATURE
  evaluation ran on: active kit grants, connected systems with their
  read-only floors and granted writes, meeting/cellular channel liveness,
  active supervised agents;
- `checkpoints[]` — for months 1, 3, 6, 12 and 24: the seeded scenario keys
  and, for BOTH variants, the raw conversion measurement:
  - `aurumPrimaryFraction` — measurement 1 (entry routed to Aurum);
  - `aurumOnlyFraction` — measurement 2 (whole workflow inside Aurum);
  - `meanSwitchesPerScenario` — measurement 3 (adjacent-tool changes);
  - `routings[]` — the **raw per-scenario, per-step routing trace**: each
    step's resolved `tool` (`aurum` or the incumbent system role) and, for
    Aurum routings, the recorded surface that authorized it (`basis`:
    `core-intelligence-loop`, `kit-grant:<capability>`,
    `connection:<system>:<capability>:floor|granted`,
    `meeting-channel-live`, `cellular-channel-live`,
    `agent-supervision-active`).
- `effort` — measurement 4: the MODELED baseline (the documented 9-step
  manual per-integration protocol × N systems) vs the MEASURED S003 path
  (`s003.ops[]` — every W096 discover→recommend→approve→connect→verify→map
  and W084 observe→request-scope→execute→reconcile chain op this benchmark
  actually executed, plus the W094 migration import, each priced by the
  published weights; `byPhase` aggregates);
- `trust` — measurement 5: the 6-action automation portfolio's outcomes for
  both variants, each action with its module-evidenced verdict
  (`invocation:allowed|denied:<basis>`, `supervised-execution:succeeded`).

## Quality artifact shape

`quality/<industry>.json` contains, per deep firm:

- `conversion` — the attribution evidence: the experienced instance's
  conversion PRE-adoption (learning, empty adoption — equals the baseline),
  and the mature conversion of the experienced, control and cold-start
  instances (all byte-identical — conversion is adoption-driven);
- `quality.experienced|control|cold[]` — for every checkpoint, the raw W055
  payload objects of the three work-order families:
  `recommendationCalibration`, `realizedValue`, `evidenceQuality`, exactly as
  the quality module computed them.

## The five measurements — definitions of record

1. **AURUM-PRIMARY willingness** — the fraction of the firm's scenarios at a
   checkpoint whose FIRST step routes to Aurum. A step routes to Aurum when
   the surface that serves it is one Aurum holds: the S002 core intelligence
   loop, an active W092 kit grant, a connected system's W083 read-only floor
   or grant, a live W085 meeting channel, a live W087 cellular channel, or an
   active W098 supervised agent.
2. **AURUM-ONLY willingness** — the fraction of scenarios whose EVERY step
   routes to Aurum (no context exit to any incumbent tool).
3. **CONTEXT-SWITCHING** — the expected number of tool switches per scenario:
   adjacent step pairs served by different tools (Aurum or a specific
   incumbent system/work surface). Exits AND re-entries both count.
4. **INTEGRATION SETUP EFFORT** — modeled action-minutes to connect the
   firm's incumbent systems and import their history. Baseline: the
   documented manual per-integration protocol (MODELED, labeled as such —
   9 weighted steps per system). S003: the chain the benchmark MEASURED
   (module-contract calls actually executed), priced by the same published
   weights.
5. **TRUST and REALIZED VALUE** — trust: the fraction of the firm's frozen
   6-action automation portfolio executed by Aurum and completed without
   human rollback (module-derived from the invocation ledger, active grants,
   active supervision, delivered executions; one write-scope denial per firm
   is the designed honest sub-1.0 factor). Realized value: the W055 families
   (recommendation calibration, intervention realized-vs-expected, evidence
   quality) on the matured surface.

## Honesty notes

- The same seeded scenario sets are evaluated on both sides of every
  comparison (the scenario is a pure function of seed × checkpoint; only the
  module-recorded adoption state differs).
- The baseline is not a strawman: S002 already routes investigation-first
  workflows through Aurum (baseline aurum-primary ≈ 0.12–0.16).
- Physical/offline steps (courier, mail, stamped archives) never convert.
- Size effects are preserved: solo firms hold one incumbent system, so steps
  referencing absent systems stay incumbent even in the mature state.
- The kit-less logistics industry converts entries through the
  industry-independent levers but completes fewer full workflows than both
  kit verticals — the honest measure of what the vertical kits add.
- Every provider seam (directory source, broker, verification probes,
  deep-action transport, kit edge, carrier, agent runtime) rides a
  deterministic in-suite double — no live provider participates anywhere
  (environment-dependent: see the delivery report).
