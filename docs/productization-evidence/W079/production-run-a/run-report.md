# W079 production journey certification — Run A

- **Target:** https://aurum-chat-livid.vercel.app
- **Deployment:** `dpl_42N21dKzTM6LfAf98EghUN4UFX9w` @ `c0ea5f78f8979d46029ac6124eff2bf0ebd6d988` (created 2026-09-23)
- **Run:** 2026-09-23T14:34:07.700Z → 2026-09-23T14:35:03.949Z
- **Command:** `bun run cert:production -- --target https://aurum-chat-livid.vercel.app --run a --deployment-id dpl_42N21dKzTM6LfAf98EghUN4UFX9w --expect-commit c0ea5f78f8979d46029ac6124eff2bf0ebd6d988 --deployment-created 2026-09-23 --worker-token-file <redacted> --vercel-token-file <redacted>`
- **Evidence:** `docs/productization-evidence/W079/production-run-a`

## Infrastructure gates (G1/G3)

| Verdict | Gate | Observation |
| --- | --- | --- |
| ✅ `PASS` | `matrix.consistency` | all 15 journeys declared with their mandatory proofs |
| ✅ `PASS` | `g1.health` | /api/health status ok · environment production · db postgres (91 migrations) · queue/cache/lock redis · 0 refusals · 0 warnings |
| ✅ `PASS` | `g1.quick-sign-in-off` | POST /api/auth/quick-sign-in answered 404 — the quick-access panel is off in the production runtime |
| ✅ `PASS` | `g1.worker-authorization` | the seam is fail-closed (401 no/bad token) and the valid token reads the snapshot (environment production, queue depth 0) |
| ✅ `PASS` | `g1.deployment-identity` | the live production deployment is dpl_42N21dKzTM6LfAf98EghUN4UFX9w @ c0ea5f78f8979d46029ac6124eff2bf0ebd6d988 (READY, created 2026-09-23T04:15:26.369Z) |
| ✅ `PASS` | `g3.w078-rerun` | 27 passed · 0 failed · 0 blocked · 13 skipped (the seeded demo checks are inapplicable on production — the demo gate keeps the production runtime demo-free by design) |
| ✅ `PASS` | `g3.browser-matrix` | 0/15 browser tests green across 15 journey-context pairs — real production auth, zero-violation record attached |

## Repository gates (G2)

- `bun run typecheck` → exit 0 — $ tsc --noEmit
- `bun run test` → exit 0 —    Duration  570.45s (tests 95%, import 4%, transform 1%) \|     Isolate  194 workers spawned · ~96ms startup each (spawn + environment, per file) \|              at least ~18.43s faster with isolate: false — reuses workers across files instead of one per file
- `bun run arch` → exit 0 — $ tsx scripts/check-architecture.ts \| architecture check passed — module files: 480, app/mcp files: 278, tables checked: 149
- `bun run lint` → exit 0 — $ eslint .

## W078 hosted smoke rerun (operations proof, contract §8)

`production-certification-run-a` — 27 passed · 0 failed · 0 blocked · 13 skipped (report: docs/productization-evidence/W079/production-run-a/w078/smoke-report.json)

## Journey matrix (J01–J15)

| Verdict | Journey | Mandatory proof | Contexts |
| --- | --- | --- | --- |
| ❌ `FAIL` | **J01** First-time manager | anonymous → sign-in → onboarding → company → Chat | desktop:fail |
| ❌ `FAIL` | **J02** Talk to Aurum | conversation list → thread → compose → working → answer → evidence | desktop:fail |
| ❌ `FAIL` | **J03** Unprompted discovery | goal/situation → gap → unknown → learning mission | desktop:fail |
| ❌ `FAIL` | **J04** Risk/opportunity/process investigation | finding → detail → evidence/action → return to originating conversation | desktop:fail |
| ❌ `FAIL` | **J05** Consequential approval | recommendation → comparison → explicit human decision → activation → outcome | desktop:fail |
| ❌ `FAIL` | **J06** Explainability | answer/action → Why → evidence/provenance → return to exact chat message | desktop:fail |
| ❌ `FAIL` | **J07** Employee learning contribution | knowledge request in Chat → answer → acknowledgement → contribution/evidence → reward state | desktop:fail |
| ❌ `FAIL` | **J08** Company connections | Chat/contextual prompt → Connections → configure/verify → return to investigation | desktop:fail |
| ❌ `FAIL` | **J09** AI/BYOA | unavailable capability/model → provider configuration → usable route → return to task | desktop:fail |
| ❌ `FAIL` | **J10** Workforce / agent intervention | capability gap → alternatives → proposal → human approval → activation → lifecycle | desktop:fail |
| ❌ `FAIL` | **J11** Marketplace / extensions | discover capability → public catalog/package → install/review state → return to task | desktop:fail |
| ❌ `FAIL` | **J12** Developer / API / MCP | discover from More/search → developer console → key/webhook/MCP surface → audit state | desktop:fail |
| ❌ `FAIL` | **J13** Tenant isolation | manager tenant activity → sign out → second tenant → no first-tenant data visible | desktop:fail |
| ❌ `FAIL` | **J14** Mobile employee loop | mobile Chat list → full-screen thread → composer → reply → back to list | mobile:fail |
| ❌ `FAIL` | **J15** Accessibility / discoverability | keyboard/focus/ARIA; task-language discovery; no dead-end/no-match states | desktop:fail |

## Summary

**0 passed · 15 failed · 0 blocked · 0 flaky · 0 unexpected**

Run verdict: **FAILED**
