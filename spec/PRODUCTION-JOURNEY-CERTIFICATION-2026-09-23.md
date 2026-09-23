# W079 — Production Journey Certification & Release Gate

**Status:** CANONICAL POST-W078 RELEASE-CERTIFICATION WORK ITEM  
**Date:** 2026-09-23  
**Repository:** `payswapdotorg/aurum-chat`  
**Frozen architecture:** v2.1  
**Baseline:** `ae4f191a64ab3a89a1ae4b7cefb0f35222269f24`  
**Maximum concurrency:** 3 workers

## 1. Purpose

W079 is the final release gate for Aurum's user journeys.

W076 proves the application in a local running browser. W078 proves the hosted deployment contract and currently reports an honest production block because the external production backends are not provisioned/configured.

W079 closes the remaining gap by proving, from outside the application, that the **current production deployment** supports the complete user journey matrix with:

- real production authentication;
- real external PostgreSQL;
- real execution/cache/lock infrastructure;
- real worker authorization;
- real browser interaction on desktop and mobile;
- real tenant isolation;
- real Chat-first continuity across management surfaces;
- zero blocked journey checks;
- zero failed or flaky journeys;
- machine-generated evidence tied to the exact deployment revision.

A green local or preview run does **not** satisfy W079.

## 2. Non-negotiable release rule

The production journey certification verdict is:

- **CERTIFIED READY** only when every mandatory gate is PASS;
- **BLOCKED** when any mandatory gate is BLOCKED;
- **FAILED** when the deployed system violates a contract or journey assertion.

Do not convert a BLOCKED result to PASS by weakening an assertion, enabling demo shortcuts, filtering real application failures, or substituting preview evidence.

## 3. Production target identity

Every certification run must record:

1. production hostname;
2. Vercel deployment id;
3. deployed commit SHA;
4. deployment creation time;
5. certification timestamp;
6. environment label reported by the application;
7. database backend class reported by health;
8. worker/runtime configuration state;
9. exact command and arguments used;
10. GitHub repository state used to interpret the result.

The certification report must fail if the target is not the expected production deployment.

## 4. Mandatory infrastructure gates

### G1 — Production runtime is genuinely production

PASS requires:

- `/api/health` returns healthy;
- environment is explicitly `production`;
- PostgreSQL is external and reachable;
- the application is not using the embedded filesystem database;
- migrations are applied;
- Redis/queue/lock backend is healthy when required by the runtime;
- `WORKER_TOKEN` exists and worker authorization works;
- production quick-sign-in/demo credentials remain OFF;
- storage/email integrations used by the claimed journeys are configured;
- no secret value is written into journey evidence.

### G2 — Release invariants

Run and record:

`bun run typecheck`  
`bun run test`  
`bun run arch`  
`bun run lint`

Also require the deployment/release checks already enforced by W078.

### G3 — Browser proof uses the hosted production URL

The browser runner must:

- use Chromium/Playwright against the live production hostname;
- use real rendered UI interactions;
- perform authentication through the real production auth flow;
- capture console, page-error, request-failure and HTTP >=400 events;
- capture screenshots at decisive checkpoints;
- capture a per-journey transcript;
- run both desktop (1280x800) and mobile touch (390x844) contexts;
- use no API/token shortcuts to bypass user-visible flows;
- use no seeded production demo tenant or quick-login backdoor.

Any explicitly tolerated browser noise must be narrowly predeclared and mechanically distinguishable from application failures.

## 5. Mandatory user journey matrix

The certification suite must exercise these journeys end to end.

| ID | User journey | Mandatory proof |
| --- | --- | --- |
| J01 | First-time manager | anonymous → sign-in → onboarding → company → Chat |
| J02 | Talk to Aurum | conversation list → thread → compose → working → answer → evidence |
| J03 | Unprompted discovery | goal/situation → gap → unknown → learning mission |
| J04 | Risk/opportunity/process investigation | finding → detail → evidence/action → return to originating conversation |
| J05 | Consequential approval | recommendation → comparison → explicit human decision → activation → outcome |
| J06 | Explainability | answer/action → Why → evidence/provenance → return to exact chat message |
| J07 | Employee learning contribution | knowledge request in Chat → answer → acknowledgement → contribution/evidence → reward state |
| J08 | Company connections | Chat/contextual prompt → Connections → configure/verify → return to investigation |
| J09 | AI/BYOA | unavailable capability/model → provider configuration → usable route → return to task |
| J10 | Workforce / agent intervention | capability gap → alternatives → proposal → human approval → activation → lifecycle |
| J11 | Marketplace / extensions | discover capability → public catalog/package → install/review state → return to task |
| J12 | Developer / API / MCP | discover from More/search → developer console → key/webhook/MCP surface → audit state |
| J13 | Tenant isolation | manager tenant activity → sign out → second tenant → no first-tenant data visible |
| J14 | Mobile employee loop | mobile Chat list → full-screen thread → composer → reply → back to list |
| J15 | Accessibility / discoverability | keyboard/focus/ARIA; task-language discovery; no dead-end/no-match states |

The matrix must include at least one **cross-surface return-to-Chat assertion** for every journey that leaves Chat.

## 6. Journey-level production assertions

Every journey must prove all of the following where applicable:

- authenticated state is established through the normal UI;
- the current tenant/company is explicit and stable;
- the expected surface is reachable without internal module knowledge;
- every action produces the expected visible state change;
- no dead button or dead-end page is encountered;
- consequential actions retain evidence/context;
- approval remains human-authorized;
- the conversation is preserved across drill-downs;
- return links land on the originating conversation/message when specified;
- failures are honest and recoverable;
- mobile uses a one-pane-at-a-time conversation model;
- touch targets remain >=44px;
- no application console/network error is hidden by an overly broad filter.

## 7. Two-run certification requirement

The production certification must be executed twice against the **same deployed revision**:

### Run A — full certification

Required verdict:

**0 failed · 0 blocked · 0 flaky · 0 unexpected**

### Run B — deterministic rerun

Immediately repeat the same production matrix against the same deployment revision.

Required verdict:

**0 failed · 0 blocked · 0 flaky · 0 unexpected**

The two reports must agree on the journey matrix and deployment identity.

A second run against a newly deployed revision does not count as the deterministic rerun.

## 8. Operations proof carried into certification

W079 must retain W078 evidence for:

- duplicate/idempotent execution;
- deterministic dead-letter/not-found handling;
- retry policy/attempt limits;
- health/readiness;
- worker observability;
- queue counters;
- migration/redeploy determinism;
- rollback target/runbook;
- environment separation.

The production certification report must link these records rather than restating them as unsupported claims.

## 9. Evidence package

Commit:

`docs/productization-evidence/W079/`

with at minimum:

- `W079-PRODUCTION-JOURNEY-CERTIFICATION.md`
- `production-run-a/`
  - machine-readable run result;
  - journey transcripts;
  - screenshots;
  - browser error captures;
- `production-run-b/`
  - same evidence structure;
- deployment identity manifest;
- command/config manifest;
- final certification verdict.

Evidence must be generated by the same execution that produced the pass/fail verdict.

## 10. Tech Lead acceptance checklist

The Tech Lead may sign W079 only after:

- W077 production infrastructure is actually healthy;
- W078 hosted full smoke is green with zero blocked;
- W076 browser journey code is reused, extended where necessary, and run against production;
- all J01-J15 are green on desktop/mobile as applicable;
- the full two-run requirement is green;
- no known critical production defect remains;
- the exact deployment SHA is recorded;
- the final evidence tree is committed;
- the certification verdict is independently reproducible from the documented commands.

The Tech Lead must not certify readiness from screenshots, manual clicking, issue comments, worker prose, or preview-only evidence.

## 11. Final release verdict template

Use exactly one of:

**CERTIFIED READY**  
All mandatory production gates PASS. The certified deployment, commit SHA and evidence tree are recorded.

**BLOCKED**  
At least one mandatory external precondition is missing. Name the exact blocker and the gate it prevents.

**FAILED**  
The deployed system violates a journey, security, reliability or architecture contract. Name the first reproducible failure and retain the failing evidence.

## 12. Remaining work at handoff

At the W079 handoff baseline:

- W071-W076 are delivered;
- W078 is delivered as a proof harness but its live production run is blocked;
- the Vercel production project exists;
- the remaining release dependency is external production backend provisioning/configuration and then full production browser certification.

Do not close W077/W078 or mark W079 complete until the hosted production evidence itself is green.
