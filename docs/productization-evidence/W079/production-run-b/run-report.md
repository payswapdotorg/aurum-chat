# W079 production journey certification — Run B

- **Target:** https://aurum-chat-livid.vercel.app
- **Deployment:** `dpl_42N21dKzTM6LfAf98EghUN4UFX9w` @ `c0ea5f78f8979d46029ac6124eff2bf0ebd6d988` (created 2026-09-23T04:15:26.369Z)
- **Run:** 2026-09-23T16:21:30.223Z → 2026-09-23T16:23:05.553Z
- **Command:** `bun run cert:production -- --target https://aurum-chat-livid.vercel.app --run b --deployment-id dpl_42N21dKzTM6LfAf98EghUN4UFX9w --expect-commit c0ea5f78f8979d46029ac6124eff2bf0ebd6d988 --deployment-created 2026-09-23T04:15:26.369Z --worker-token-file <redacted> --vercel-token-file <redacted>`
- **Evidence:** `docs/productization-evidence/W079/production-run-b`

## Infrastructure gates (G1/G3)

| Verdict | Gate | Observation |
| --- | --- | --- |
| ✅ `PASS` | `matrix.consistency` | all 15 journeys declared with their mandatory proofs |
| ✅ `PASS` | `g1.health` | /api/health status ok · environment production · db postgres (91 migrations) · queue/cache/lock redis · 0 refusals · 0 warnings |
| ✅ `PASS` | `g1.quick-sign-in-off` | POST /api/auth/quick-sign-in answered 404 — the quick-access panel is off in the production runtime |
| ✅ `PASS` | `g1.worker-authorization` | the seam is fail-closed (401 no/bad token) and the valid token reads the snapshot (environment production, queue depth 0) |
| ✅ `PASS` | `g1.deployment-identity` | the live production deployment is dpl_42N21dKzTM6LfAf98EghUN4UFX9w @ c0ea5f78f8979d46029ac6124eff2bf0ebd6d988 (READY, created 2026-09-23T04:15:26.369Z) |
| ✅ `PASS` | `g3.w078-rerun` | 27 passed · 0 failed · 0 blocked · 13 skipped (the seeded demo checks are inapplicable on production — the demo gate keeps the production runtime demo-free by design) |
| ✅ `PASS` | `g3.browser-matrix` | 15/15 browser tests green across 15 journey-context pairs — real production auth, zero-violation record attached |

## Repository gates (G2)

- `bun run typecheck` → exit 0 — $ tsc --noEmit
- `bun run test` → exit 0 —   digest: 'NEXT_REDIRECT;replace;/onboarding;307;' } fatal: not a git repository (or any of the parent directories): .git fatal: not a git repository (or any of the parent directories): .git fatal: not a git repository (or any of the parent directories): .git fatal: not a git repository (or any of the parent directories): .git
- `bun run arch` → exit 0 — architecture check passed — module files: 480, app/mcp files: 278, tables checked: 149 $ tsx scripts/check-architecture.ts
- `bun run lint` → exit 0 — $ eslint .

## W078 hosted smoke rerun (operations proof, contract §8)

`production-certification-run-b` — 27 passed · 0 failed · 0 blocked · 13 skipped (report: docs/productization-evidence/W079/production-run-b/w078/smoke-report.json)

## Journey matrix (J01–J15)

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

## Summary

**15 passed · 0 failed · 0 blocked · 0 flaky · 0 unexpected**

Run verdict: **CERTIFIED READY**
