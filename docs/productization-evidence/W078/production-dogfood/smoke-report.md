# W078 post-deployment smoke report — production-dogfood

- **Target:** https://aurum-chat-livid.vercel.app
- **Profile:** full
- **Run:** 2026-09-22T18:12:23.062Z → 2026-09-22T18:12:27.852Z (4.8s)
- **Expected environment:** production
- **Observed health:** error (HTTP 503, env 'production', db embedded)
- **Summary:** 18 passed · 0 failed · 22 blocked · 0 skipped (40 checks)

## sign-in/onboarding works on the hosted deployment

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `routing.onboarding-gate` | observed as specified |
| PASS | `routing.signin-renders` | observed as specified |
| BLOCKED | `auth.signup` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `auth.session-no-company` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `auth.chat-gated-pre-onboarding` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `auth.onboarding-company` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `auth.signout` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |

## Chat is the primary root experience

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `routing.root-anonymous-gate` | observed as specified |
| PASS | `routing.chat-anonymous-gate` | observed as specified |
| BLOCKED | `routing.root-authenticated-chat` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `chat.state-fresh` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `chat.turn` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `chat.thread-persists` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |

## seeded demo journeys work

| Verdict | Check | Observation |
| --- | --- | --- |
| BLOCKED | `seeded.persona-signin` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `seeded.conversation-list` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `seeded.thread` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `seeded.attention-turn` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `seeded.approval-decided` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |

## browser journeys pass on production dogfood

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `routing.static-assets` | observed as specified |
| PASS | `browser.suite-registered` | observed as specified |

## worker/workflow retry and duplicate semantics are observed

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `worker.retry-policy-surface` | observed as specified |
| PASS | `worker.seam-auth-fail-closed` | observed as specified |
| BLOCKED | `worker.duplicate-acknowledged` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `worker.dead-letter-invalid` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `worker.not-found-consumed` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `worker.idle-pull` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |

## health endpoint is green

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `health.contract` | observed as specified |
| BLOCKED | `health.green` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| PASS | `health.honest-refusal` | observed as specified |

## queue depth and worker metrics are inspectable

| Verdict | Check | Observation |
| --- | --- | --- |
| BLOCKED | `observability.worker-snapshot` | Provide the worker seam token (--worker-token / AURUM_SMOKE_WORKER_TOKEN) — the value lives in the Vercel project environment (WORKER_TOKEN) |
| BLOCKED | `observability.metrics-advance` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |
| BLOCKED | `observability.surfaces-agree` | the hosted database is not ready — /api/health reports status 'error' (ENOENT: no such file or directory, mkdir '.data'). Complete the documented operator step (docs/DEPLOYMENT.md §11 "Open provider gaps": attach the Neon PostgreSQL database to the Vercel project and set DATABASE_URL for the target environment), then re-run this smoke command |

## deployment rollback is documented

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `release.rollback-runbook` | observed as specified |
| PASS | `release.known-good-deployment` | observed as specified |
| PASS | `release.ci-gates` | observed as specified |
| PASS | `release.deployment-config` | observed as specified |

## environment separation is verified

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `health.environment-label` | the target reports 'production' |
| PASS | `env.quick-signin-availability` | observed as specified |
| PASS | `env.demo-gate-refuses-production` | observed as specified |
| PASS | `env.matrix-documented` | observed as specified |

