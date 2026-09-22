# W078 post-deployment smoke report — deployment-artifact-preview

- **Target:** http://localhost:3130
- **Profile:** full
- **Run:** 2026-09-22T18:14:00.573Z → 2026-09-22T18:14:02.185Z (1.6s)
- **Expected environment:** preview
- **Observed health:** ok (HTTP 200, env 'preview', db embedded)
- **Summary:** 39 passed · 0 failed · 0 blocked · 1 skipped (40 checks)

## sign-in/onboarding works on the hosted deployment

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `routing.onboarding-gate` | observed as specified |
| PASS | `routing.signin-renders` | observed as specified |
| PASS | `auth.signup` | observed as specified |
| PASS | `auth.session-no-company` | observed as specified |
| PASS | `auth.chat-gated-pre-onboarding` | observed as specified |
| PASS | `auth.onboarding-company` | observed as specified |
| PASS | `auth.signout` | observed as specified |

## Chat is the primary root experience

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `routing.root-anonymous-gate` | observed as specified |
| PASS | `routing.chat-anonymous-gate` | observed as specified |
| PASS | `routing.root-authenticated-chat` | observed as specified |
| PASS | `chat.state-fresh` | observed as specified |
| PASS | `chat.turn` | observed as specified |
| PASS | `chat.thread-persists` | observed as specified |

## seeded demo journeys work

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `seeded.persona-signin` | observed as specified |
| PASS | `seeded.conversation-list` | observed as specified |
| PASS | `seeded.thread` | observed as specified |
| PASS | `seeded.attention-turn` | observed as specified |
| PASS | `seeded.approval-decided` | observed as specified |

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
| PASS | `worker.dead-letter-invalid` | observed as specified |
| PASS | `worker.idle-pull` | observed as specified |
| PASS | `worker.duplicate-acknowledged` | observed as specified |
| PASS | `worker.not-found-consumed` | observed as specified |

## health endpoint is green

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `health.contract` | observed as specified |
| PASS | `health.green` | observed as specified |
| SKIP | `health.honest-refusal` | nothing to refuse — the target reports a serving database (no production refusal state to observe) |

## queue depth and worker metrics are inspectable

| Verdict | Check | Observation |
| --- | --- | --- |
| PASS | `observability.worker-snapshot` | observed as specified |
| PASS | `observability.metrics-advance` | observed as specified |
| PASS | `observability.surfaces-agree` | observed as specified |

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
| PASS | `health.environment-label` | the target reports 'preview' |
| PASS | `env.quick-signin-availability` | observed as specified |
| PASS | `env.demo-gate-refuses-production` | observed as specified |
| PASS | `env.matrix-documented` | observed as specified |

