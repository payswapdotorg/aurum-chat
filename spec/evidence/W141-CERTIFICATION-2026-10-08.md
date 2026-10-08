# W141 — End-to-End + Cross-Platform Certification Record

**Certified:** 2026-10-08 (the midnight-deadline shift)
**Owner:** resident TL (Z.ai Code), per spec/W141-CERTIFICATION-PLAN-2026-10-04.md
**Release commit:** `cf25d83` (main; merge of the W141 certification suite into `e4f4258`)
**Production deployment:** `dpl_4mFvfntmAE4UwFvopH6cUR3tMdeW` — https://aurum-chat-livid.vercel.app (Vercel project `aurum-chat`, production branch `main`)
**Deployment SHA:** `cf25d834` (verified via the Vercel API `meta.githubCommitSha`)

## 1. Scope

W141 is the proof layer over W124–W140, not a new implementation. This record binds the
certification demonstration suite, the full gate battery, and the production deployment
to the exact SHA above, per the POST-W123 doctrine (production certification binds to
the exact deployment ID/SHA; main advancing beyond this SHA does not re-certify).

## 2. Gate battery (all against the release tree)

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0, zero errors |
| `bun run arch` | pass — module files 797 / app+mcp 337 / tables 296 |
| `bun run lint` | exit 0, zero errors |
| Full test battery (directory-chunked) | **6155 passed / 17 skipped / 0 failed** across 308 files (incl. the W140 close-out battery at e4f4258) + the W141 suite 38/38 |
| Tenant-isolation suite | 244/244 (39 files, manifest v13, incl. closed-loop sweep) |
| e2e journeys | 206/206 (14 files) + certification 38/38 |
| `bun run build` (production build gate) | clean — full route table rendered, zero errors |
| Production health (deployed) | `/api/health` 200: db ok, **migrations 151, table census 305/305, missing [] extra []**, all components ok |

**Known flake disclosure:** one transient failure in battery chunk `modules a-f` on first
run at the Wave E promote (green on immediate re-run, and green in two subsequent full
runs). Classified flake, not a regression; no action taken beyond disclosure.

## 3. The six mandatory demonstrations

Executed by `tests/e2e/certification/w141-demonstrations.test.ts` (38 proofs, hermetic
embedded PGlite, zero network), results artifact `test-output/w141-results.json`
(runId `2026-10-08T14:51:26.963Z`), template
`tests/e2e/certification/w141-expected-results.json`.

| # | Demonstration | Classification | Verdict | Evidence |
|---|---|---|---|---|
| D1 | Provider/model swap (connect → models → select → work → switch → same body continues) | **FIXTURE (two-path)** — the LIVE OpenRouter upgrade path exists in shape (custom `openai-compatible` provider definition) but a second real provider account was not connected at certification time | DELIVERED | two providers through the real W132 discovery seam; auditable binding supersession with distinct providerPaths; the SAME agent-body byte-for-byte across the swap; two real W021 executions with identical domain outcomes |
| D2 | Ride journey ("Book me a ride" → Ride Agent → completion → PaySwap Agent → payment) | **FIXTURE** (machinery end-to-end; live ride/pay providers out of scope — no credentials) | DELIVERED | marketplace packages walked to INSTALLABLE through the real W028 chain; requester→ride→pay→requester handoffs; run freezes VERBATIM; outcome measured+settled; plan completed |
| D3 | Construction journey (context → strategy → Lab → recruitment → execution → relay → evidence → deviation → Aurum) | **FIXTURE context + REAL Lab selection** | DELIVERED | real `searchOrganizations` selection (fit 1 vs honest 1/9); recommendation with retained rejected alternative; W022 approved recruitment; site/person/system relay (3 handoffs); W140 cycle citing the run as a REALITY deviation (0.9 vs 0.4); policy-safe ranking signal (`authoritative:false`); cycle closed |
| D4 | Context variation (same subject, altered season/duration/staffing/experience → different organizations) | **FIXTURE** | DELIVERED | spring vs fall fingerprints; the Lab selects DIFFERENT organizations both ways; twelve-axis evidence explains why |
| D5 | Emergent role proposal → marketplace submission boundary | **FIXTURE** | DELIVERED | recurring gap (2 missed windows) → LAB-origin RoleProposal → governed W009 review → both refusal paths typed (`lab_cannot_self_publish`, `lab_cannot_self_activate`) → governed submission REQUEST + activation against the APPROVED W022 acquisition |
| D6 | Cross-platform continuity (same work across Web/Desktop/Mobile) | **FIXTURE clients + REAL server-issued state** | DELIVERED | web/desktop/mobile sessions; conversation-state, company-overview and background-work reads byte-identical everywhere; evidenced handoff web→desktop→mobile with exact-state resumptions and the full 6-event append-only trail |

Zero production findings (five first-run failures were test-side calibration, fixed
within the suite's ownership).

## 4. Production deployment record

- First attempt `dpl_J3QTBRZGxFEmkmaQF8HP44T4bUEk` (e4f4258) **FAILED — content drift
  REFUSED**: the `_migrations` ledger had `emergent-roles/001` recorded against the
  pre-repair content (a work-branch preview deployment applied the original file at
  07:12Z; the W138-D2 repair changed it afterward).
- **Deliberate reconciliation (recorded per the refusal's own instruction):** all five
  emergent-roles tables verified EMPTY (0 rows each), then dropped; the drifted ledger
  row deleted. The redeploy re-applied the repaired migration plus the then-pending
  `cross-platform/001` and `closed-loop/001` cleanly.
- Certified deployment `dpl_4mFvfntmAE4UwFvopH6cUR3tMdeW`: READY, health 200, census
  305/305 exact, migrations 151. The production alias `aurum-chat-livid.vercel.app`
  serves this deployment (verified).
- `/` serves 307 (auth redirect — expected for an unauthenticated smoke request).

## 5. Honest deviations & environment-blocked items

- D1 LIVE upgrade: requires a second real provider account connectable at certification
  time; the OpenRouter credential was held but a single account does not satisfy the
  two-provider LIVE bar — classified FIXTURE (two-path), per the completion law.
- Real Tauri 2 / Expo client binaries: not buildable in the certification sandbox —
  the W139 semantic core + adapter SPI is the certified surface; binaries are
  documented next steps (WORK-NOTES limitation register).
- Real Playwright/Chromium + E2B remote-sandbox execution of the W137 adapters: the
  certified surface is the adapter contracts + deterministic doubles; real-driver
  evaluation documented as next steps.
- Live ride/payment providers (D2): no credentials — FIXTURE classification stands.
- The J01–J22 browser matrix machinery (W079/W101/W106 `cert:production`) was not
  re-run in this pass; W141's demonstrations + the e2e journey battery (206/206) are
  the certified proof surface for this record.

## 6. Program state at certification

Roadmap W000–W140 delivered and promoted through main `cf25d83` (Waves A–E + the
W136 integration pass + W139 + W140 + their registrations). Tenant-isolation manifest
v13, health census 305, discoverability instruments 28, schema-reconciliation pins
current. Full battery 6155/17/0 (+38 certification proofs).
