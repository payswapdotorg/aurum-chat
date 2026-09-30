# W123 RE-AUDIT — final adversarial verification of production

Re-auditor: TL (orchestrator), acting as a real user through the replay browser.
Date: 2026-09-30, 12:59–13:40 UTC. Production: aurum-chat-livid.vercel.app.

Deployment under audit: `dpl_EfPvdfZs8XpvedsFxZwudvz32Jwi` (tree of `b4b13a5` ==
merge `81643b0`: the W123 repair + TL straggler fixes). The middleware gate fix
(`c5b4c15`) was commit-pending behind the Vercel free-tier daily deploy quota at
audit time — see "Pending" below.

## Method

Same harness class as the W120 sweep (CDP-driven Chrome, real navigation,
console/page-error accumulation, per-surface screenshot) plus a full
rendered-text harvest per surface: `document.body.innerText` captured on every
page and scanned against 23 development-artifact patterns (work-item IDs,
lock refs, module names, dev seams, raw enums/error codes, doc citations,
internal type names, planner vocabulary, …). The scan whitelist covers exactly
two sanctioned remains: the literal public-API scope keys (`epistemics:read`
et al.) and the marketplace permission-model lines ("tenant-scoped state
(authority level OBSERVE)" / "tenant-scoped — bounded by the declared quota").

Phases: anonymous (landing/signup/signin/waitlist-redirect/404), authenticated
(14 tower + 12 product + 3 sub-pages = 29 surfaces), mobile 390×844, and the
chat golden path (real composer turn → answer → "Why this answer?" drawer).

## Results

| Phase | Surfaces | Console errors | Jargon findings |
|-------|----------|----------------|-----------------|
| Anonymous (true signed-out) | 5 | 0 | 0 |
| Authenticated | 29 | 0 | 3 → all fixed & re-verified live |
| Mobile 390×844 | 3 | 0 (2 benign CSS-preload warnings) | 0 |
| Chat golden path | turn + drawer | 0 | 0 |

Baseline for comparison (W121 TL audit, same method): leak clusters on every
tower surface, every product surface, the chat answer drawer, and error paths —
"Management surface W033 (lock 33/34)" on all 15 tower surfaces, plus 43 more
confirmed findings.

### Verified fixed (live, spot-asserted)

- **A-01** tower header: "Management briefing — assembled live from your
  company's records" — the W033 string is gone everywhere (0 pattern hits).
- **A-02/A-03** shell footers calmed ("Findings cite their evidence ·
  consequential actions need your approval").
- **A-04** auth footer: "Sign-in sessions are securely stored · company
  membership is re-checked on every request".
- **A-22** answer drawer: the real composer turn's evidence drawer renders
  zero dev-artifact strings; answer copy honest for an empty company.
- **B-TL-01** branded 404 ("This page doesn't exist" + "Back to Aurum") —
  verified for signed-in users; anonymous hits of unknown paths are gated to
  `/signin?next=…` by the W058 middleware and see the branded 404 after
  sign-in (designed gate behavior, unchanged by W123).
- **D-01** per-page titles live ("Sign in — Aurum", "Create your account —
  Aurum", …).
- Anonymous `/platform/waitlist` → `/signin?next=%2Fplatform%2Fwaitlist` (guard
  intact); signed-in non-admin → `/chat` (guard intact).

### Straggler findings (this re-audit) — fixed in `81643b0` (PR #131)

1. `/more` "Unknown is first-class" (planner vocabulary) → "Unknowns carry
   weight".
2. `/ai` no-provider notice leaked the raw `provider_unavailable` code and the
   internal `setLlmTransport` function name → "AI providers are not connected
   in this environment…".
3. `/interventions` "the §14 chain" doc citation → "a fixed chain".
4. (source-found, same class) chat-types why-line "first-class work" → "real
   work"; developer-console "webhook transport is wired" notices (3 locations)
   → "Webhook sending is not connected…".

All four verified live post-deploy: positive phrases present, artifact phrases
absent, on the production URL.

### New defect found by the re-audit (fixed in `c5b4c15`, PR #132 — deploy pending)

The W058 middleware matcher intercepted the W123 public metadata files:
`/robots.txt` and `/icon.svg` returned 307 → `/signin?next=…` for crawlers and
anonymous browsers (favicon.ico was already excluded). Fixed by excluding both
paths in the matcher. **Pending the Vercel daily-quota window reset** —
`w123_deploy_watch.py` arms the deploy + live verification.

### Quota-window note

The Vercel free tier hit its 100-deployments/day ceiling during this closeout
(heavy preview churn from the day's worker branches). Production was moved to
the final tree by alias-assignment of the webhook-built deployment (identical
tree); a fresh production build of `c5b4c15`+ follows when the window resets,
watched automatically.

## Verdict

**PRODUCTION-GRADE on the copy surface**: zero development artifacts found in
any rendered user text across 37 harvested surfaces + the chat golden path,
zero console/page errors, all guards and honest-degradation paths intact. The
single open item is the robots.txt/icon.svg gate deploy, which is code-fixed,
merged, and under automated deploy watch.

## Artifacts

- Screenshots: `docs/productization-evidence/W123/screens/` (44 JPEGs)
- Harvested rendered text per surface: `texts-anon.json`, `texts-auth.json`,
  `texts-mobile.json` (replay station: `scripts/logs/w123-reaudit/`)
- Harness: `scripts/w123_reaudit.py` (replay station)
