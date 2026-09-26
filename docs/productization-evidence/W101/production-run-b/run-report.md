# W101 production journey certification — Run B

- **Target:** https://aurum-chat-livid.vercel.app
- **Deployment:** `dpl_ERGp4se2zC49sTr81YhLEYNMkqYD` @ `8ddd0df1bca25f60f1bf94b181aad664b3b29e23` (created 2026-09-26T17:20:32.587Z)
- **Run:** 2026-09-26T18:24:39.524Z → 2026-09-26T18:27:21.786Z
- **Command:** `bun run cert:production -- --target https://aurum-chat-livid.vercel.app --run b --program w101 --deployment-id dpl_ERGp4se2zC49sTr81YhLEYNMkqYD --expect-commit 8ddd0df1bca25f60f1bf94b181aad664b3b29e23 --deployment-created 2026-09-26T17:20:32.587Z --worker-token-file <redacted> --vercel-token-file <redacted>`
- **Evidence:** `docs/productization-evidence/W101/production-run-b`

## Infrastructure gates (G1/G3)

| Verdict | Gate | Observation |
| --- | --- | --- |
| ✅ `PASS` | `matrix.consistency` | all 22 journeys declared; W101 mandates 22 (J01, J02, J03, J04, J05, J06, J07, J08, J09, J10, J11, J12, J13, J14, J15, J16, J17, J18, J19, J20, J21, J22) |
| ✅ `PASS` | `g1.health` | /api/health status ok · environment production · db postgres (130 migrations) · queue/cache/lock redis · 0 refusals · 0 warnings |
| ✅ `PASS` | `g1.quick-sign-in-off` | POST /api/auth/quick-sign-in answered 404 — the quick-access panel is off in the production runtime |
| ✅ `PASS` | `g1.worker-authorization` | the seam is fail-closed (401 no/bad token) and the valid token reads the snapshot (environment production, queue depth 0) |
| ✅ `PASS` | `g1.deployment-identity` | the live production deployment is dpl_ERGp4se2zC49sTr81YhLEYNMkqYD @ 8ddd0df1bca25f60f1bf94b181aad664b3b29e23 (READY, created 2026-09-26T17:20:32.587Z) |
| ✅ `PASS` | `rollback.evidence` | the seams' recorded state a rollback preserves: environment production · db postgres (130 migrations) · worker production (queue depth 0); the known-good rollback target is dpl_GuQSNP9nj3eDT4Lc38Y2EhLgWsF5 @ 850b85bb9a05a78636e15d5cb6614d40fd872a77 (READY); the runbook (docs/DEPLOYMENT.md §12) and the W078 operations evidence tree are linked, not restated |
| ✅ `PASS` | `g3.w078-rerun` | 27 passed · 0 failed · 0 blocked · 13 skipped (the seeded demo checks are inapplicable on production — the demo gate keeps the production runtime demo-free by design) |
| ✅ `PASS` | `g3.browser-matrix` | 22/22 browser tests green across 22 journey-context pairs — real production auth, zero-violation record attached |

## Repository gates (G2)

- `bunx tsc --noEmit` → exit 0 — exit=0 — fresh execution at the exact 8ddd0df checkout (HEAD=8ddd0df1bca25f60f1bf94b181aad664b3b29e23, W101 Run B gate). Clean: 0 errors.
- `serialized chunked vitest run --maxWorkers=1, 8 chunks x ~33 files, fresh full pass for Run B (station-hygiene law: maxWorkers=2 OOM-killed on the 4GB box; serialization clears the embedded-PG hookTimeout flake class in-pass)` → exit 0 — G2 tests gate — FRESH single serialized pass at the exact 8ddd0df tree for W101 Run B (log chunked-suite-8ddd0df-run-b.log, 18:07-18:22 UTC, all 8 chunk exits 0): 259 tracked test files (browser matrix excluded — G3 runs it). Chunk results: 1) 33/33 files, 771/771; 2) 31 passed + 2 env-gated skips, 617 passed + 6 skipped; 3) 33/33, 852; 4) 33/33, 837; 5) 33/33, 853; 6) 33/33, 692; 7) 33/33, 596; 8) 28/28, 221. NET: 257 files passed + 2 file-level env-gated skips (real-Redis/real-Postgres URL sea
- `bunx tsx scripts/check-architecture.ts` → exit 0 — architecture check passed — module files: 667, app/mcp files: 288, tables checked: 248 — fresh execution at the exact 8ddd0df checkout (W101 Run B gate; identical counts to Run A — same tree).
- `bunx eslint .` → exit 0 — exit=0 — fresh execution at the exact 8ddd0df checkout (W101 Run B gate). Clean: 0 problems (scratch probes remain outside the repo workdir at /home/z/w101-scratch).

## W078 hosted smoke rerun (operations proof, contract §8)

`production-certification-run-b` — 27 passed · 0 failed · 0 blocked · 13 skipped (report: docs/productization-evidence/W101/production-run-b/w078/smoke-report.json)

## Journey matrix (J01–J22)

| Verdict | Journey | Mandatory proof | Contexts |
| --- | --- | --- | --- |
| ✅ `PASS` | **J01** First-time manager | anonymous → sign-in → onboarding → company → Chat | desktop:pass |
| ✅ `PASS` | **J02** Talk to Aurum | conversation list → thread → compose → working → answer → evidence | desktop:pass |
| ✅ `PASS` | **J03** Unprompted discovery | goal/situation → gap → unknown → learning mission | desktop:pass |
| ✅ `PASS` | **J04** Risk/opportunity/process investigation | finding → detail → evidence/action → return to originating conversation | desktop:pass |
| ✅ `PASS` | **J05** Consequential approval | recommendation → comparison → explicit human decision → activation → outcome | desktop:pass |
| ✅ `PASS` | **J06** Explainability | answer/action → Why → evidence/provenance → return to exact chat message | desktop:pass |
| ✅ `PASS` | **J07** Employee learning contribution | knowledge request in Chat → answer → acknowledgement → contribution/evidence → reward state | desktop:pass |
| ✅ `PASS` | **J08** Company connections | Chat/contextual prompt → Connections → configure/verify → return to investigation | desktop:pass |
| ✅ `PASS` | **J09** AI/BYOA | unavailable capability/model → provider configuration → usable route → return to task | desktop:pass |
| ✅ `PASS` | **J10** Workforce / agent intervention | capability gap → alternatives → proposal → human approval → activation → lifecycle | desktop:pass |
| ✅ `PASS` | **J11** Marketplace / extensions | discover capability → public catalog/package → install/review state → return to task | desktop:pass |
| ✅ `PASS` | **J12** Developer / API / MCP | discover from More/search → developer console → key/webhook/MCP surface → audit state | desktop:pass |
| ✅ `PASS` | **J13** Tenant isolation | manager tenant activity → sign out → second tenant → no first-tenant data visible | desktop:pass |
| ✅ `PASS` | **J14** Mobile employee loop | mobile Chat list → full-screen thread → composer → reply → back to list | mobile:pass |
| ✅ `PASS` | **J15** Accessibility / discoverability | keyboard/focus/ARIA; task-language discovery; no dead-end/no-match states | desktop:pass |
| ⛔ `BLOCKED` | **J16** Cross-channel communication | connection hub channel surfaces + the v1 public API channel surfaces, real production auth | desktop:blocked |
| ⛔ `BLOCKED` | **J17** Meetings | the meetings surface via the v1 API — the meeting-intelligence contract’s user-visible path | desktop:blocked |
| ⛔ `BLOCKED` | **J18** Cellular reachability | the cellular surface via the v1 API — the SMS/voice contract’s user-visible path; environment limits recorded as the module reports them | desktop:blocked |
| ✅ `PASS` | **J19** Integrations | the full connection surface — connections hub UI (channels, sources, destinations, identities) + integration capabilities; the human approval gate | desktop:pass |
| ✅ `PASS` | **J20** Provider choice + billing | /ai/preferences outcome preferences + explanations; /ai/preferences/advanced authorization-gated; provider/billing surfaces | desktop:pass |
| ✅ `PASS` | **J21** Durable cognition | learning/contributions surfaces + the v1 missions surface — the company-learning journey | desktop:pass |
| ⛔ `BLOCKED` | **J22** Specialist execution | the marketplace + installed-kit surfaces — the W092 vertical kits’ user-visible path | desktop:blocked |

## Summary

**18 passed · 0 failed · 4 blocked · 0 flaky · 0 unexpected**

Run verdict: **BLOCKED**
