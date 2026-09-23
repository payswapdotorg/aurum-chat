# Tech Lead Handoff — Aurum Production Completion & Journey Certification

**Repository:** `payswapdotorg/aurum-chat`  
**Baseline:** `ae4f191a64ab3a89a1ae4b7cefb0f35222269f24`  
**Architecture:** v2.1 — FROZEN  
**Maximum concurrency:** 3 workers  
**Canonical certification:** `spec/PRODUCTION-JOURNEY-CERTIFICATION-2026-09-23.md`

## Mission

Complete the remaining W077/W078 production work and obtain a formal W079 certification that Aurum's major user journeys are production-ready on the real hosted deployment.

The repository is not allowed to declare production readiness from local/preview evidence alone.

## Current repository truth

Verified current main head:

`ae4f191a64ab3a89a1ae4b7cefb0f35222269f24` — W078.

Delivered post-W070 work:

- W071 ✅
- W072 ✅
- W073 ✅
- W074 ✅
- W075 ✅
- W076 ✅
- W077 ✅ implementation/deployment instantiation, but production backend configuration is incomplete
- W078 ✅ proof harness/evidence, but hosted production result is currently blocked

Current W078 production evidence is **18 passed / 0 failed / 22 blocked / 0 skipped**. The blocker is not a test failure: production is refusing to serve without the required external PostgreSQL backend, and token-authenticated worker observability also requires the production worker token.

The artifact environment is already green at **39 passed / 0 failed / 0 blocked / 1 skipped** twice. That proves the release candidate can satisfy the matrix, but it is not production certification.

## Execution strategy

### Worker A — production backend/runtime closure

Own only W077 production infrastructure:

1. Provision/attach the external production PostgreSQL instance.
2. Provision/attach the production Redis/queue/lock backend.
3. Set environment-scoped secrets/configuration without committing values.
4. Set the worker authorization secret.
5. Run production migrations using the documented safe path.
6. Redeploy/promote the exact intended release candidate.
7. Verify `/api/health`, `/api/worker` and production environment separation.
8. Confirm quick-sign-in/demo credentials remain disabled in production.
9. Record deployment id, URL and commit SHA.

Do not modify domain semantics to accommodate provider limitations.

### Worker B — production browser certification

Own only W079 browser certification/evidence:

1. Reuse the W076 Playwright browser layer.
2. Extend the journey matrix where W076 does not yet prove learning, connections, BYOA and any remaining major capability.
3. Drive the live production URL through real UI interactions.
4. Run desktop and mobile journeys.
5. Capture transcripts/screenshots/errors.
6. Fail on real application console/network defects.
7. Produce the two consecutive same-revision certification runs.
8. Commit the complete W079 evidence tree.

No local/preview result may be substituted for production evidence.

### Worker C — release/security reconciliation

Own only cross-cutting release proof:

1. Verify tenant isolation and role boundaries on the hosted deployment.
2. Verify no production demo/quick-login shortcut is active.
3. Verify consequential approvals remain human-authorized.
4. Verify provider credentials do not enter screenshots/logs/evidence.
5. Verify W078 retry/idempotency/rollback evidence is linked into W079.
6. Reconcile any browser or deployment findings without changing frozen architecture.
7. Prepare the final certification checklist for Tech Lead sign-off.

## Wave gates

### Wave 1 — infrastructure closure

A: W077 production backend/runtime  
B: prepare W079 production matrix  
C: security/release preflight

**Gate:** do not begin final certification until production health is genuinely green and the external database/runtime are confirmed.

### Wave 2 — production journeys

A: production redeploy only if required by verified configuration changes  
B: full W079 browser matrix  
C: hosted security/release verification

**Gate:** no certification if any mandatory journey is blocked or failed.

### Wave 3 — deterministic certification

A: no new feature work; operational support only  
B: Run A then Run B against the exact same deployment revision  
C: reconcile evidence and independently verify the verdict

**Gate:** only 0 failed / 0 blocked / 0 flaky / 0 unexpected on both runs.

## Hard release gates

1. Real production PostgreSQL — no embedded DB.
2. Production Redis/queue/lock path — no local substitute.
3. Production worker token and observability.
4. Production health green.
5. Quick-sign-in/demo credentials OFF.
6. W079 J01-J15 pass.
7. Desktop and mobile browser evidence pass.
8. No critical console/network/application error.
9. Tenant isolation pass.
10. Chat-first continuity pass.
11. Approval/human-authority invariants pass.
12. Two same-deployment certification runs green.
13. Evidence committed and reproducible.

## Definition of done

The Tech Lead can close the release only with a committed W079 certification containing:

- exact production deployment identity;
- exact Git SHA;
- Run A and Run B machine-readable results;
- per-journey evidence;
- screenshots and browser error captures;
- health/worker/observability snapshots;
- rollback reference;
- final verdict **CERTIFIED READY**.

Anything less remains **BLOCKED** or **FAILED**.

## Source-of-truth hierarchy

1. repository code and committed tests;
2. live production behavior;
3. committed machine-generated evidence;
4. architecture/spec contracts;
5. GitHub issue prose.

Never reverse this order.
