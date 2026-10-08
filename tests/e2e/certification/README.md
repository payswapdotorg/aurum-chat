# W141 — the certification demonstration suite

The proof layer over W124-W140 (spec/W141-CERTIFICATION-PLAN-2026-10-04.md).
One file, six describe blocks, one per mandatory demonstration, every block
titled with its demonstration id and its LIVE/FIXTURE classification per the
completion law.

## The six demonstrations

| id  | demonstration                                                                                                                              | classification |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| D1  | Provider/model swap — provider A → models appear → select → work continues → provider B → the SAME body continues                           | FIXTURE, two-path (known provider + custom `openai-compatible` provider — the OpenRouter LIVE shape exercised as a fixture; no second real credential exists at certification time) |
| D2  | Ride journey — "Book me a ride" → plan → Ride Agent (marketplace package) → completion → PaySwap Agent → payment → result                     | FIXTURE, end-to-end machinery (live ride/pay providers out of scope — no credentials) |
| D3  | Construction journey — goal → fingerprint → info strategy → Lab selection → recruitment → execution → site/person/system relay → evidence → deviation → learning record | FIXTURE context + REAL Lab selection (the org-lab deterministic search is real) |
| D4  | Context variation — the SAME construction subject under altered season/duration/staffing/experience fixtures → the Lab selects DIFFERENT organizations | FIXTURE (context-diversity proof shapes; the selection rule is real) |
| D5  | Emergent role proposal → marketplace submission boundary — publication/install/activation stay governed; the Lab cannot self-publish/self-activate (both refusal paths exercised) | FIXTURE |
| D6  | Cross-platform continuity — the same active work across web/desktop/mobile client sessions; identical authoritative state; background work inspectable everywhere; evidenced handoff | FIXTURE clients |

## How to run

```bash
bunx vitest run tests/e2e/certification
```

The suite is HERMETIC: embedded PostgreSQL (PGlite, `:memory:`) through the db
port — no network, no browsers, no harness transactions (every fixture is
built through the REAL public contracts; the two in-process fakes are the
sanctioned W021 runtime transport and the W132 discovery transport seams).
Expect ~8s and 38 green tests.

## Where the results land

Each demonstration closes by registering a machine-readable verdict; the
`afterAll` writes the record to **`test-output/w141-results.json`** (created
at run time — the committed file from a run is that run's record, with the
run's exact timestamp in `runId`). The committed EXPECTED-RESULTS template is
`w141-expected-results.json` beside this file. The suite is bound to the
certification base commit `e4f4258` (recorded in the artifact).

The production-deployment binding (Vercel deployment id + SHA) is the TL's
evidence record — this hermetic suite proves the machinery; the TL binds it
to the deployment in the certification record.

## Honesty rules (binding)

- Fixture evidence never becomes a live claim — every demonstration's
  classification names FIXTURE explicitly, and the suite's own gate test
  asserts every classification matches `FIXTURE`.
- An undelivered demonstration is recorded `pending` in the artifact — never
  silently dropped.
- No production code is touched by this suite (ownership:
  `tests/e2e/certification/**` + the results artifact only).
