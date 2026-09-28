# W112 — Recertification Completion Record

**Date:** 2026-09-28 (13:10 UTC)
**Purpose:** closes the two external blockers recorded in `CERTIFICATION.md` §4.

## The blockers, and how they cleared

| Blocker (as recorded 2026-09-28 08:48 UTC) | How it cleared |
| --- | --- |
| 1. Vercel deploy quota exhausted (reset 2026-09-29T08:33:53Z) | The rolling window freed slots sooner: a production deploy of `main` succeeded at **2026-09-28T12:28:35.809Z** → `dpl_B53sTKNRvcXCMYSafQ3XEboagD4a`, READY, serving the final tree. |
| 2. Rotated WORKER_TOKEN effective only on the next deployment | That next deployment is `dpl_B53sTKNRvcXCMYSafQ3XEboagD4a`: the rotated token (retrieved via the Vercel env API) authenticates against the live `/api/worker` seam — **HTTP 200** (probed 12:34 UTC). |

## The two-run same-revision recertification (the W106 program)

Both runs executed against the same deployment revision and agree on identity:

| | Run A | Run B |
| --- | --- | --- |
| Deployment | `dpl_B53sTKNRvcXCMYSafQ3XEboagD4a` | `dpl_B53sTKNRvcXCMYSafQ3XEboagD4a` |
| Commit | `1b7ba4b11e0ff3995b60d1229fa9584de47c35a4` | `1b7ba4b11e0ff3995b60d1229fa9584de47c35a4` |
| Summary | **22 passed · 0 failed · 0 blocked · 0 flaky · 0 unexpected** | **22 passed · 0 failed · 0 blocked · 0 flaky · 0 unexpected** |
| Finished | 12:48:36 UTC | 13:05:47 UTC |

- Run A evidence: `../W106/production-run-a/` (g1.deployment-identity PASS · g3.w078-rerun 27/0/0 + 13 demo-check skips (inapplicable on production) · g3.browser-matrix **22/22 green**, real production auth, zero-violation record)
- Run B evidence: `../W106/production-run-b/` (same shape)
- **Finalizer verdict (2026-09-28T13:10:20.382Z): `CERTIFIED READY`** — `../W106/final-verdict.json`

## Production state after the recert

- `/api/health`: ok · production · migrations **138** · census **258/258**, missing []
- The **W113 harmonized design is live** in production (served CSS carries `#d9952a` aurum gold, `#fdfaf6` warm cream, `#241e19` deep ink, Fraunces + Geist)
- The `LIVEKIT_*` env vars are present in this deployment (the W109 live wiring reports wired from this build onward — the deployment-scoped live probe becomes possible)

## Scope note

This record closes the W112 §4 blocker trail. The capability matrix in `CERTIFICATION.md` §2 remains the
honest per-capability classification for `dpl_GxApj6s3CECE`; the classifications attach to deployment
identity by design and are not retroactively rewritten for the new deployment. The capability frontier
items recorded there (carrier credentials, Neon egress, browser-driver production wiring, kit-edge
production invocation) remain the recorded frontiers.
