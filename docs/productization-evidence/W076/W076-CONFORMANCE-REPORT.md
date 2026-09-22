# W076 — Real Browser Journey & Visual Conformance — Evidence & Conformance Report

**Work item:** W076 (post-W070 hardening, frozen plan §5)
**Branch:** `work/w076-browser-journey`
**Cloned-from HEAD:** `70713d6506374642b637dccf818f19286b59a1be`
**The one command:** `bun run browser:journeys`

---

## 1. What this suite is

The W070 journey proof drives the real page components through an SSR
harness and the real API handler libraries in-process. W076 adds the layer
that proof could not provide: **a REAL headless Chromium, driven through
the user journeys of the running application** — sign-in through the real
`/signin` quick-access panel (no token injection, no API shortcuts), real
clicks/taps on the rendered UI, real console/network capture, and
programmatic visual assertions of the frozen UX contract:

> **ShareNet-dominant visual direction + WhatsApp-like interface and
> interaction model.**

The W070 SSR suite (`tests/e2e/journeys/**`) is untouched and still green
(baseline 4153 passed / 6 skipped at the time of delivery). The browser
layer ADDS to it; it does not replace or weaken it.

## 2. The harness

| Piece | Path | Role |
| --- | --- | --- |
| Playwright config | `playwright.config.ts` | desktop 1280×800 + mobile 390×844/touch projects, both on the sandbox **chromium**; 1 worker, 0 retries (a retry would launder a real defect) |
| Launch glue | `scripts/browser-server.ts` | dedicated port 3105 (`W076_PORT` overridable), stale-server recovery, health-wait on `/api/health`, deterministic process-group teardown; manual CLI (`bun scripts/browser-server.ts start\|stop`) |
| Global setup | `tests/browser/global-setup.ts` | kills stale server → resets `.data` → re-seeds the deterministic W068 demo world (`bun run seed:demo`) → wipes the evidence tree (this run's artifacts only) → starts `next dev` → health-wait → pre-warms the dev compiler → returns the teardown |
| Journey fixture | `tests/browser/fixtures.ts` | one real page per test with console/pageerror/requestfailed/HTTP-4xx/5xx collectors attached from the first navigation; journey transcripts; the screenshot archiver; the zero-violation assertion (in-test AND at fixture teardown — no journey can end dirty) |
| Personas | `tests/browser/helpers/personas.ts` | sign-in through the REAL quick-access panel (names from the demo module's public manifest contract — no drift possible); sign-out through the real `/more` affordance |
| Visual assertions | `tests/browser/helpers/visual.ts` | DOM structure, `getComputedStyle`, bounding-box relations — programmatic, no pixel-diff flakiness |
| Interaction safety | `tests/browser/helpers/interact.ts` | bounded observe-and-retry for the dev-runtime hydration race (see §7) |
| Violation capture | `tests/browser/helpers/errors.ts` | the documented noise filter (§6) |

Determinism: every run reseeds the demo world (fresh ids — journeys must
DISCOVER ids through the UI, never hardcode them), waits on health,
explicit selectors and observable state — no fixed sleep exceeds 500ms
(none are used at all; every wait is on real state).

## 3. The journey inventory (9 spec files, 35 journeys)

**Desktop (1280×800) — 27 journeys**

| Spec | Journeys |
| --- | --- |
| `onboarding-desktop.spec.ts` | anonymous root → sign-in gate; dead invitation link is an honest page with a way forward (no dead ends); the quick-access panel lists the 4 seeded personas; one tap signs the manager in and the first screen is the messenger (starter grid, Aurum identity, ShareNet shell, dominance, two panes, sticky footer); the composer is keyboard-first |
| `chat-core-loop-desktop.spec.ts` | the seeded thread with WhatsApp-like fidelity (bubble geometry, tints, compact timestamps, day separator, delivery state, evidence-backed answer); a composer turn through the REAL workflow (optimistic bubble → working indicator `data-working` → reply with W072 contextual cards, citations, Why-this-answer); a pending approval decided INLINE from the conversation (Journey E chat-first); the explainability drill-down and the W072 return link back to the exact message (`:target` deep link); new-chat affordance + conversation search |
| `intelligence-chain-desktop.spec.ts` | the briefing → goal → unknown → mission chain walked through the page's own links (down AND back up); the employee persona sees the same chain |
| `discovery-desktop.spec.ts` | the `/more` hub grouped by user intent (W075 registry — never module taxonomy); command search task language + no-match suggestions (no dead end) + Escape discipline; the public marketplace catalog (anonymous) and its package page; the developer console discoverable from More (Journey L); the mobile chrome present-but-hidden at desktop width |
| `interventions-desktop.spec.ts` | the interventions home (capability gap, live agent, proposal); the recruitment proposal (compared alternatives, waiting at the human gate); the live agent page (budget/permissions/lifecycle, links onward); the tower Approvals surface with the decision trail (management mode keeps its own shell) |
| `tenant-isolation-desktop.spec.ts` | manager (Meridian Roasters) sees Meridian data → signs out through the real affordance → platform reviewer (Aurum Platform Review) sees NONE of it: empty conversation list (honest empty state), no Meridian goal — data isolation visible in the UI across tenants |
| `accessibility-desktop.spec.ts` | keyboard walk from the skip link (Tab stops focusable elements, every stop carries the visible 2px green focus ring); skip-link activation jumps to `#product-main`; the messenger's ARIA landmark structure in the real DOM (labeled regions, `role=log` timeline, one `h1`, accessible names); the command-search dialog's Escape + focus-return discipline |

**Mobile (390×844, touch) — 8 journeys**

| Spec | Journeys |
| --- | --- |
| `chat-mobile.spec.ts` | the conversation list is the mobile home with the touch chrome (top bar + five-area bottom nav, 44px+ targets); tapping a conversation opens a FULL-SCREEN thread (`data-mobile-view=list⇄thread`, one pane at a time) with back navigation and mobile bubble fidelity; a composer turn runs the real workflow on mobile; the back affordance returns to the list |
| `navigation-mobile.spec.ts` | the five bottom-nav areas with short labels and `aria-current` active treatment; the More hub reachable on mobile and its cards navigate; management mode (Today) keeps the tower shell; command search from the top bar (44px+ target) with Escape |

## 4. The evidence tree (this run only — wiped at every setup)

```
docs/productization-evidence/W076/
  screens/          33 full-page PNGs, taken by the journeys at the decisive
                    moments (messenger first screen, seeded thread with
                    bubbles+composer, reply with contextual cards, inline
                    approval, explainability trace, /more hub, command
                    search, marketplace catalog+package, developer console,
                    intelligence briefing/goal/unknown/mission, interventions
                    home/proposal/agent/tower approvals, tenant isolation
                    (both tenants), keyboard focus ring, ARIA landmarks,
                    mobile chat list/thread/composer round-trip, mobile
                    bottom nav/tower shell)
  transcripts/      35 JSON journey transcripts (every named step + URL)
  errors/           35 JSON error captures — 0 violations recorded across
                    all 35 journeys
  journey-results.json   the Playwright run report (35 expected / 0
                          unexpected / 0 flaky)
  W076-CONFORMANCE-REPORT.md   this report
```

The screenshots come from the same execution as the assertions (the
fixture's `shot()` runs inside each test, after the assertions it
documents). The evidence tree is wiped by the global setup on every run —
recycled or fabricated evidence is structurally impossible.

## 5. The visual conformance contract (how the frozen rule is encoded)

All assertions are programmatic (DOM structure / `getComputedStyle` /
bounding boxes) — no pixel-diff flakiness; screenshots are for human
review.

**ShareNet-dominant shell (asserted):**
- the shell canvas computes to the warm off-white `rgb(249,248,247)`
  (`--bg: #f9f8f7`);
- no gradient chrome: sampled surfaces (shell, rail, bubbles, composer)
  carry `background-image: none`;
- no glassmorphism: `backdrop-filter: none` on the same surfaces;
- management chrome stays visually secondary (rail < 30% of main width)
  while the messenger occupies > 85% of the main landmark.

**WhatsApp-like conversation (asserted):**
- one messenger window, two panes; conversation list is a first-class pane
  (330px + thread, equal heights);
- the Aurum contact identity header (avatar/name/"On duty ·
  evidence-backed" presence);
- member bubbles right-aligned (hugging the timeline's right edge) with
  the accent tint `rgb(217,238,228)`; Aurum bubbles left-aligned on the
  neutral surface `rgb(252,252,251)` — speaker legible from position +
  color together; spatial separation of the two speakers (> 8% of the
  timeline width, proportional — 1280px desktop and 390px mobile both
  hold);
- rounded bubbles (> 8px radius) with the run-tail rhythm;
- compact timestamps inside every bubble (`HH:MM`, computed size ≤ 12px)
  with delivery/read state on member bubbles;
- day separators (centered quiet pills);
- unread/new-activity badges (pill, "New"/"Unread" word — color never
  carries meaning alone);
- compact composer row (textarea + send affordance side by side; send
  enables with content, stays quiet otherwise);
- working/typing state (the indicator row + `data-working` thread status
  while the workflow runs — pinned inside the in-flight request window);
- new-conversation affordance + conversation search/filter;
- mobile: one pane at a time (`data-mobile-view`), list → thread
  full-screen transition, back navigation, 44px+ touch targets.

**No WhatsApp branding/colors/logos** — none exist in the repo (the app's
palette is its own ShareNet tokens; the accent is the calm teal-green
`#5cb28f`, asserted through computed styles and the focus-ring color).

## 6. The documented console/network noise filter

Zero console errors, zero uncaught page errors, zero failed requests and
zero HTTP ≥ 400 responses were recorded across all 35 journeys (see
`errors/*.json`). Three narrowly-scoped filters were applied, each
browser-side noise rather than application behavior:

1. **favicon 404s** — the app ships no favicon asset; the browser's
   automatic `/favicon.ico` request 404s in the dev runtime.
2. **`net::ERR_ABORTED`** — in-flight requests cancelled by
   navigation/close (browser bookkeeping; real failures still surface as
   HTTP ≥ 400, other requestfailed error texts, console and pageerror
   events).
3. **Chromium's password-manager `caret-color` hydration warning** — the
   browser intermittently injects
   `style="caret-color:transparent"` into auth-form inputs before React
   hydrates (known Chromium behavior — vercel/next.js#47973; the repo
   contains no `caret-color` anywhere). The filter matches ONLY a
   hydration warning whose diff is that injected attribute; every other
   hydration mismatch fails the journey.

## 7. The genuine defect the journeys exposed (surgically fixed)

**Finding (failing evidence first):** the anonymous
`the marketplace catalog is public and its packages drill down` journey
recorded `401 Unauthorized` from `/api/product/shell` and the
corresponding browser console errors on the PUBLIC `/marketplace` page —
every anonymous visitor of the public catalog produced console errors.

**Root cause:** the product shell's `ShellStateProvider` client-fetches
`/api/product/shell` on mount for every product page — including the
public marketplace, where no session exists.

**Fix (≤ 20 lines each, `src/app/(product)/components/shell-state-context.tsx`
+ `src/app/(product)/layout.tsx`):** the product layout resolves the
session read-only (no gating change) and passes
`authenticated={session.status === 'authenticated'}`; for unauthenticated
sessions the provider never issues the fetch and the chrome renders the
honest "no company" quiet state. After the fix the anonymous public-page
journey records zero violations; all existing vitest suites remain green.

## 8. Acceptance checklist (frozen plan §5)

| Acceptance bullet | Result | Evidence |
| --- | --- | --- |
| actual browser automation, not only SSR rendering | **PASS** | Playwright 1.57 on the sandbox chromium (headless), desktop + touch-mobile contexts, driving the dev server on :3105; 35 journeys |
| no console errors in major journeys | **PASS** | 0 violations across all 35 journeys (`errors/*.json`); the three browser-side noise filters are documented in §6 |
| no dead-end pages | **PASS** | dead invite code renders the honest page with Sign in / Create an account; no-match command search offers task-language suggestions; every tower page carries the 15-surface nav; the explain drill-down carries the return link |
| chat visually passes the WhatsApp-like fidelity checklist | **PASS** | §5 encodes the checklist programmatically; all assertions green on desktop AND mobile |
| mobile chat is first-class | **PASS** | full-screen list→thread transition, back navigation, composer round-trip on the real workflow, 44px+ targets |

Harness-requirement conformance: dedicated port with health-wait and
deterministic teardown (§2); seeded personas through the real UI (§2);
collectors on every page (§2); full-page PNGs at the decisive moments
(§4); programmatic visual assertions (§5); two personas across tenants
with isolation visible in the UI (§3 tenant-isolation); one command (§1);
determinism — fresh reseed per run, no fixed sleeps.

## 9. Gate results (verbatim)

```
$ bun install --frozen-lockfile
Checked 297 installs across 372 packages (no changes) [99.00ms]

$ bun run typecheck
$ tsc --noEmit
(clean)

$ bun run lint
$ eslint .
(clean)

$ bun run arch
$ tsx scripts/check-architecture.ts
architecture check passed — module files: 456, app/mcp files: 269, tables checked: 149

$ bun run test
$ vitest run
 Test Files  177 passed | 2 skipped (179)
      Tests  4153 passed | 6 skipped (4159)
(baseline preserved exactly — the browser suite is registered out of
vitest via the vitest.config.ts exclude; vitest 5 silently ignores the
legacy `testMatch`, which would otherwise have collected the Playwright
*.spec.ts files)

$ bun run browser:journeys
35 passed — 0 failed, 0 flaky (playwright json: expected 35, unexpected 0,
flaky 0); evidence written to docs/productization-evidence/W076/
```

## 10. Reproducing

```bash
bun install --frozen-lockfile
bun run browser:journeys          # the one command
# (~6 minutes: reset+seed ≈ 40s, server boot + pre-warm ≈ 60s, 35 journeys)
```

Every run is self-contained: it resets and reseeds the demo world, wipes
the evidence tree, launches the app on port 3105, runs all journeys, and
tears the server down. The evidence in `docs/productization-evidence/W076/`
is always exactly the last run's.
