# W101 production journey certification — Run A

- **Target:** https://aurum-chat-livid.vercel.app
- **Deployment:** `dpl_GyA2kEBgUmpwwRKPYwN4pnDv9wTT` @ `a2db98a25b5ff9756fa849d3e196a80bafba1104` (created 2026-09-26T12:52:52.665Z)
- **Run:** 2026-09-26T15:38:48.463Z → 2026-09-26T15:41:07.671Z
- **Command:** `bun run cert:production -- --target https://aurum-chat-livid.vercel.app --run a --program w101 --deployment-id dpl_GyA2kEBgUmpwwRKPYwN4pnDv9wTT --expect-commit a2db98a25b5ff9756fa849d3e196a80bafba1104 --deployment-created 2026-09-26T12:52:52.665Z --worker-token-file <redacted> --vercel-token-file <redacted>`
- **Evidence:** `docs/productization-evidence/W101/production-run-a`

## Infrastructure gates (G1/G3)

| Verdict | Gate | Observation |
| --- | --- | --- |
| ✅ `PASS` | `matrix.consistency` | all 22 journeys declared; W101 mandates 22 (J01, J02, J03, J04, J05, J06, J07, J08, J09, J10, J11, J12, J13, J14, J15, J16, J17, J18, J19, J20, J21, J22) |
| ✅ `PASS` | `g1.health` | /api/health status ok · environment production · db postgres (127 migrations) · queue/cache/lock redis · 0 refusals · 0 warnings |
| ✅ `PASS` | `g1.quick-sign-in-off` | POST /api/auth/quick-sign-in answered 404 — the quick-access panel is off in the production runtime |
| ✅ `PASS` | `g1.worker-authorization` | the seam is fail-closed (401 no/bad token) and the valid token reads the snapshot (environment production, queue depth 0) |
| ✅ `PASS` | `g1.deployment-identity` | the live production deployment is dpl_GyA2kEBgUmpwwRKPYwN4pnDv9wTT @ a2db98a25b5ff9756fa849d3e196a80bafba1104 (READY, created 2026-09-26T12:52:52.665Z) |
| ✅ `PASS` | `rollback.evidence` | the seams' recorded state a rollback preserves: environment production · db postgres (127 migrations) · worker production (queue depth 0); the known-good rollback target is dpl_6L2yDPtyNH2g8LBfCwmsUZfU7yBH @ 73d00ecbabc9402dde8374671d18108a2958d2e0 (READY); the runbook (docs/DEPLOYMENT.md §12) and the W078 operations evidence tree are linked, not restated |
| ✅ `PASS` | `g3.w078-rerun` | 27 passed · 0 failed · 0 blocked · 13 skipped (the seeded demo checks are inapplicable on production — the demo gate keeps the production runtime demo-free by design) |
| ❌ `FAIL` | `g3.browser-matrix` | 1 browser journey(s) captured console/network violations: j20-outcome-preferences-the-authorizat-desktop:desktop(3) |

## Repository gates (G2)

- `bun run typecheck` → exit 0 — tsc --noEmit — clean (0 errors) on the W101 delivery tree
- `bun run test` → exit 0 — 5439 passed · 0 failed · 6 skipped (env-conditional: worker-realpostgres ×2, worker-realredis ×3, redis-rest ×1) — executed per-file in 9 chunks on the 2-CPU sandbox (the full suite exceeds the runner's single-command window); every chunk green on the final W101 delivery tree
- `bun run arch` → exit 0 — architecture check passed — module files: 667, app/mcp files: 288, tables checked: 248
- `bun run lint` → exit 0 — eslint . — clean (0 problems) on the W101 delivery tree

## W078 hosted smoke rerun (operations proof, contract §8)

`production-certification-run-a` — 27 passed · 0 failed · 0 blocked · 13 skipped (report: docs/productization-evidence/W101/production-run-a/w078/smoke-report.json)

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
| ❌ `FAIL` | **J20** Provider choice + billing | /ai/preferences outcome preferences + explanations; /ai/preferences/advanced authorization-gated; provider/billing surfaces | desktop:fail |
| ✅ `PASS` | **J21** Durable cognition | learning/contributions surfaces + the v1 missions surface — the company-learning journey | desktop:pass |
| ⛔ `BLOCKED` | **J22** Specialist execution | the marketplace + installed-kit surfaces — the W092 vertical kits’ user-visible path | desktop:blocked |

## Summary

**17 passed · 2 failed · 4 blocked · 0 flaky · 0 unexpected**

Run verdict: **FAILED**
