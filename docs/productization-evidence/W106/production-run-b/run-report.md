# W106 production journey certification — Run B

- **Target:** https://aurum-chat-livid.vercel.app
- **Deployment:** `dpl_BCtojsKXWqF3qsEmczyHfUxaauGJ` @ `625a133e22904972394b6e418f2a3b2c9cda676a` (created 2026-09-27)
- **Run:** 2026-09-27T02:58:53.118Z → 2026-09-27T03:01:51.159Z
- **Command:** `bun run cert:production -- --target https://aurum-chat-livid.vercel.app --run b --program w106 --deployment-id dpl_BCtojsKXWqF3qsEmczyHfUxaauGJ --expect-commit 625a133e22904972394b6e418f2a3b2c9cda676a --deployment-created 2026-09-27 --worker-token-file <redacted> --vercel-token-file <redacted>`
- **Evidence:** `docs/productization-evidence/W106/production-run-b`

## Infrastructure gates (G1/G3)

| Verdict | Gate | Observation |
| --- | --- | --- |
| ✅ `PASS` | `matrix.consistency` | all 22 journeys declared; W106 mandates 22 (J01, J02, J03, J04, J05, J06, J07, J08, J09, J10, J11, J12, J13, J14, J15, J16, J17, J18, J19, J20, J21, J22) |
| ✅ `PASS` | `g1.health` | /api/health status ok · environment production · db postgres (136 migrations) · queue/cache/lock redis · 0 refusals · 0 warnings |
| ✅ `PASS` | `g1.quick-sign-in-off` | POST /api/auth/quick-sign-in answered 404 — the quick-access panel is off in the production runtime |
| ✅ `PASS` | `g1.worker-authorization` | the seam is fail-closed (401 no/bad token) and the valid token reads the snapshot (environment production, queue depth 0) |
| ✅ `PASS` | `g1.deployment-identity` | the live production deployment is dpl_BCtojsKXWqF3qsEmczyHfUxaauGJ @ 625a133e22904972394b6e418f2a3b2c9cda676a (READY, created 2026-09-27T00:16:35.425Z) |
| ✅ `PASS` | `rollback.evidence` | the seams' recorded state a rollback preserves: environment production · db postgres (136 migrations) · worker production (queue depth 0); the known-good rollback target is dpl_2J55BXJ139c4bbgv89psJGpDT3by @ 0c0a29dd5b13fdbc0f2a3a270bc326d164b4ce33 (READY); the runbook (docs/DEPLOYMENT.md §12) and the W078 operations evidence tree are linked, not restated |
| ✅ `PASS` | `g3.w078-rerun` | 27 passed · 0 failed · 0 blocked · 13 skipped (the seeded demo checks are inapplicable on production — the demo gate keeps the production runtime demo-free by design) |
| ✅ `PASS` | `g3.browser-matrix` | 22/22 browser tests green across 22 journey-context pairs — real production auth, zero-violation record attached |

## Repository gates (G2)

- `bun run typecheck` → exit 0 — tsc --noEmit — no output, exit 0 (clean typecheck over the delivered W106 tree, including the 004 reconciliation migration, the aligned schema-reconciliation test and the J19 four-surface roster alignment)
- `bun run test` → exit 0 — 5591 passed · 0 failed · 6 skipped across 268 test files — executed per-file in 7 chunks against the delivered W106 tree INCLUDING the 004 reconciliation migration and the aligned schema-reconciliation counts (batch runner adapted from scripts/run-suite-chunked.sh, output /tmp/w106-suite: the single-window run exceeds the sandbox command limit on 2 CPUs — batch summaries 847/727/950/1079/856/812/320 passed, 0 failed)
- `bun run arch` → exit 0 — architecture check passed — module files: 669, app/mcp files: 305, tables checked: 248
- `bun run lint` → exit 0 — eslint . — no output, exit 0 (clean lint over the delivered W106 tree, including the 004 reconciliation migration, the aligned schema-reconciliation test and the J19 four-surface roster alignment)

## W078 hosted smoke rerun (operations proof, contract §8)

`production-certification-run-b` — 27 passed · 0 failed · 0 blocked · 13 skipped (report: docs/productization-evidence/W106/production-run-b/w078/smoke-report.json)

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
| ✅ `PASS` | **J16** Cross-channel communication | connection hub channel surfaces + the v1 public API channel surfaces, real production auth | desktop:pass |
| ✅ `PASS` | **J17** Meetings | the meetings surface via the v1 API — the meeting-intelligence contract’s user-visible path | desktop:pass |
| ✅ `PASS` | **J18** Cellular reachability | the cellular surface via the v1 API — the SMS/voice contract’s user-visible path; environment limits recorded as the module reports them | desktop:pass |
| ✅ `PASS` | **J19** Integrations | the full connection surface — connections hub UI (channels, sources, destinations, identities) + integration capabilities; the human approval gate | desktop:pass |
| ✅ `PASS` | **J20** Provider choice + billing | /ai/preferences outcome preferences + explanations; /ai/preferences/advanced authorization-gated; provider/billing surfaces | desktop:pass |
| ✅ `PASS` | **J21** Durable cognition | learning/contributions surfaces + the v1 missions surface — the company-learning journey | desktop:pass |
| ✅ `PASS` | **J22** Specialist execution | the marketplace + installed-kit surfaces — the W092 vertical kits’ user-visible path | desktop:pass |

## Summary

**22 passed · 0 failed · 0 blocked · 0 flaky · 0 unexpected**

Run verdict: **CERTIFIED READY**
