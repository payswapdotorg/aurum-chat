# W123 REPAIR LOG — production-grade copy hardening

Repair worker: W123 · Branch: `fix/w123-production-copy` (base: `main` @ `65d8b8a`)
Dossiers treated: `audit/w121-copy` → `docs/productization-evidence/W121/findings-A.md`
(52 findings: A-01…A-32, B-01…B-10, C-01…C-07, D-01…D-03) plus the orchestrator's
journey-robustness findings B-TL-01…B-TL-03 (B-TL-04 verified-clean, not re-hunted).

Method: string-level surgery only. No layouts, styles, routes, redirects, status
codes, permissions or data flows were changed. The only code-adjacent additions are
display-level helpers that map known failure codes / execution error codes to calm
sentences (`src/app/lib/calm-errors.ts`, `describeErrorCode` in the agents page) —
messages only, behavior identical. Code comments, test fixtures and
`/api/health` diagnostics were left untouched by design.

## Disposition — findings A (P0)

| ID | Status | What changed | Where |
|----|--------|--------------|-------|
| A-01 | fixed | "Management surface W033 (lock 33/34)" → "Management briefing — assembled live from your company's records" | (tower)/layout.tsx:39 |
| A-02 | fixed | Footer doctrine → "Every finding cites its evidence · changes are recorded, never rewritten" | (tower)/layout.tsx:77-79 |
| A-03 | fixed | Footer doctrine → "Findings cite their evidence · consequential actions need your approval" | (product)/layout.tsx:54-56 |
| A-04 | fixed | → "Sign-in sessions are securely stored · company membership is re-checked on every request" | (auth)/layout.tsx:22 |
| A-05 | fixed | → "source: evidence analysis — conflicting evidence is kept, not merged" | (tower)/risks/page.tsx:81 |
| A-06 | fixed | → "Process findings — each cites its evidence" | (tower)/automation/page.tsx:57 |
| A-07 | fixed | → "Today this page shows where work is manual, duplicated, or slow — each finding cites its evidence. Estimated savings and solution options for each candidate are coming." | (tower)/lib/views/automation.ts:114 |
| A-08 | fixed | Both notices → facts-only sentence + "A full employee directory is coming; for now, people appear as they are recorded in company data." | (tower)/lib/views/workforce.ts:120-121 |
| A-09 | fixed | → "The member list is available to company admins. Ask an admin if you need the roster." | (tower)/lib/views/workforce.ts:107 |
| A-10 | fixed | NotScoped description → "This view needs a company. Sign in and choose your company to continue." | (tower)/components/view-ui.tsx:168 |
| A-11 | fixed | W058 dev-seam notice deleted entirely (authentication shipped) | (product)/connections/lib/views.ts:555 (removed) |
| A-12 | fixed | → "Deliveries are off by default: sending, polling and verification codes will report a clear failure until your provider connection is activated." | (product)/connections/lib/views.ts:556 |
| A-13 | fixed | → "Systems Aurum pulls your company's evidence from. Each source shows how fresh its data is and where the next check resumes; reconnecting renews its authorization." | (product)/connections/page.tsx:228 |
| A-14 | fixed | "Freshness (W006)" → "Freshness" | (product)/connections/page.tsx:302 |
| A-15 | fixed | → "Systems Aurum delivers authorized findings to. Every delivery is recorded permanently: pending ones wait for export approval, failed ones retry, and re-delivery sends a new approved delivery. Reconnecting renews authorization." | (product)/connections/page.tsx:402 |
| A-16 | fixed | → "…unverified accounts stay external and are never treated as employees." | (product)/connections/page.tsx:560 |
| A-17 | fixed | → "Connection health is computed from live connector state — your source systems remain the record of truth" (footer first span also calmed: "credentials stay sealed — Aurum never displays them · providers stay isolated") | (product)/connections/layout.tsx:40-47 |
| A-18 | fixed | → "No freshness policy is set for this source, so its status shows as unknown." | (product)/connections/lib/health.ts:180 |
| A-19 | fixed | → "You need permission to use the developer console. Ask a company admin for publisher, builder, or platform-review access — the sections below will unlock with it." | (product)/marketplace/developer/page.tsx:62-66 |
| A-20 | fixed | → "The public API exposes capabilities, never raw tables: every operation is a named, versioned, permission-checked and audited call." | (product)/developer/lib/labels.ts:301-302 |
| A-21 | fixed | → "…Every tool call carries this context — permission-checked and audited." | (product)/developer/page.tsx:523-526 |
| A-22 | fixed | All 13 answer-drawer subtitles de-parenthesized (e.g. "Goal — set by management; Aurum tracks progress", "Evidence — the immutable record every answer rests on", "Pending action request — waiting for a human decision"); the drawer bullet "recorded cognition execution" → "recorded analysis"; "(lock 12)" removed at :856 | (product)/chat/lib/answers.ts:230, 264, 305, 319, 341, 387, 442, 477, 490, 549, 590, 634, 854-856 |
| A-23 | fixed | → "Aurum proposes new questions from your active goals and their evidence." | (tower)/today/page.tsx:249 |
| A-24 | fixed | → "Aurum proposes new questions where this goal's evidence falls short — only the material gaps become unknowns." | (product)/intelligence/goals/[goalId]/page.tsx:148 |
| A-25 | fixed | → "What this view guarantees:" | (product)/explain/page.tsx:119 |
| A-26 | fixed | → "Agent registration requires admin permission, and every run passes the approval gates its permissions require. Recruiting, teams and evaluation tools are planned." | (tower)/agents/page.tsx:57-60 |
| A-27 | fixed | → "Installed, awaiting approval — an authorized approver (not the requester) must approve or reject the kit's access grant." (the rejected/removed states in the same switch were also calmed: "your company's policy", "final", "retained permanently") | (product)/marketplace/lib/kits.ts:127,129,137 |
| A-28 | fixed | → "Aurum notifications" | (product)/components/notification-entry.tsx:56 |
| A-29 | fixed | → "Pick the person you created below if none exists yet (requires admin permission)." (label "Person id (uuid)" → "Person") | (product)/connections/page.tsx:742-744 |
| A-30 | fixed | → "One tap signs you in as a demo user with that role's permissions." (the NODE_ENV gate logic is untouched) | (auth)/components/quick-sign-in.tsx:73-75 |
| A-31 | fixed | All 9 locations: "cognition traces"/"cognitive executions" → "analysis runs", "epistemics" → "evidence analysis", "Live cognition" → "Live analysis", "Live cognitive executions" → "Live analysis runs", stage meta → "from the analysis stage", findings hint → "Findings come from Aurum's analysis of your company's evidence." Same-class stragglers also fixed: chat mode line "cognition trace" → "recorded analysis" (message-parts.tsx:237), missions blurb "cognitive loop" → "the analysis" (missions/[missionId]:281), degraded-family label 'cognition' → 'analysis' (intelligence/lib/views.ts) | risks:47,48,52; today:82,186,193,215,217; opportunities:47,55; + stragglers above |
| A-32 | fixed | All 24 dossier locations + same-class stragglers: "append-only" → "permanent"/"recorded permanently"/"permanently retained"/"full attempt history" across tower, connections, marketplace (kit/package/installed/developer), ai, explain (+ explain/lib/labels.ts:262), interventions teams, platform waitlist/layout, cellular reach. Honesty guarantees preserved in plain words ("never rewritten", "drift appears as a new run, never a rewrite") | commits 45600b7…9e7fe53; sweep-verified: zero rendered "append-only" remains |

## Disposition — findings B (P1)

| ID | Status | What changed | Where |
|----|--------|--------------|-------|
| B-01 | fixed | New display-only mapper `calmFailureText` (src/app/lib/calm-errors.ts): known codes → calm sentences ("You need admin permission to do that.", "That code didn't match — check it and try again.", "This request was already decided.", …), `_not_found` → "We couldn't find that record — it may have been removed.", internal-sounding module messages (TenantContext/field names/claim strings) → generic line, quiet domain messages pass through, fallback "Something went wrong. Please try again, or contact support if it keeps happening." Wired into connections interaction.tsx, tower decision-form.tsx, chat-workspace.tsx (6 fetch sites + catch fallbacks). Statuses, error codes and control flow unchanged — messages only | (product)/connections/components/interaction.tsx:53-54,76-81; (tower)/approvals/decision-form.tsx:55-68; (product)/chat/components/chat-workspace.tsx:389-393,453,465-469,509,553,596 + catch fallbacks |
| B-02 | fixed | Surface descriptions de-roadmapped: "Each opportunity cites its evidence and affected goals." / "— the evidence automation candidates are built from." / "The loop records risk findings with their evidence and affected goals." | opportunities:42, automation:42, risks:56 |
| B-03 | fixed | Both locations → "Identities appear as people message your connected channels. Use this lookup to find accounts outside that window." (views.ts notice keeps the discovery-window detail) | connections/page.tsx:589-592; lib/views.ts:557 |
| B-04 | fixed | "not wired (sends fail provider_unavailable)" → "not connected yet — messages cannot be sent" (detail row key "Delivery transport" → "Sending", 'wired' → 'connected'); "start of history (cursor null)" → "start of history"; health reason → "Sending is not connected yet — outbound messages and verification codes will not go out until it is." (unit test updated to the new copy) | connections/page.tsx:171-173,298; lib/health.ts:87 |
| B-05 | fixed | Stat hint → "admin access required"; bare-UUID row titles → calm "Team member" placeholder with the role badge and a labeled short id ("id 3f2a…") in the foot — no data invented; card/stat renamed "Company membership" / "Company members" | (tower)/workforce/page.tsx:37,50-53,115,124-138 |
| B-06 | fixed | → "Decisions need an owner or admin role. Ask an admin to promote you, or let another approver decide." (empty-state hint and the self-decide disabled reason also calmed; "principal 3f2a…" decision-trail label → "approver 3f2a…") | (tower)/approvals/page.tsx:48-51,66,100,117 |
| B-07 | fixed | "STORED bytes" note → "Checks re-run against the exact bytes that were published — any later change is caught and recorded."; grant-decision note → "The approval is recorded by a person, not the vendor — decisions are permanent."; "PENDING_REVIEW → APPROVED or REJECTED…" → "Review moves a version from waiting to approved or rejected; rejection is final for that version. The decision is recorded permanently." Same-class stragglers calmed: "SUBMITTED → PENDING_REVIEW…" note, "PUBLISHED → INSTALLABLE…" note, and the api.ts raw-state message | kit/[kitKey]:459,519; package/[packageId]:396,434; labels.ts:444; lib/api.ts:450 |
| B-08 | fixed | → "No custom policy set — the built-in defaults apply" (hint → "…every reach uses the built-in defaults…") | (product)/cellular/page.tsx:158-159 |
| B-09 | fixed-differently | The NotScoped component in (product)/components/states.tsx was confirmed dead (zero importers across the app, zero test references) — deleted entirely per the dossier's delete option, so both the dev-seam instructions and the dead code are gone. The live connections NotScoped (hub-ui.tsx) was already seam-free | (product)/components/states.tsx (component removed) |
| B-10 | fixed | → "Assembled live from your connected systems — always current" | (product)/connections/layout.tsx:33 |

## Disposition — findings C (P2)

| ID | Status | What changed | Where |
|----|--------|--------------|-------|
| C-01 | fixed | All 9 dossier locations "tenant" → "your company"/"company" (channels + sources descriptions, unknowns knowledge-debt, marketplace registry, cellular telecom accounts, workforce membership, lookup-miss, both freshness-policy reasons). Same-class stragglers also calmed: connections layout footer, kits.ts "tenant policy", cellular/meetings transport notes, developer/marketplace claim notes | connections/page.tsx:123,228; unknowns:39; marketplace/page.tsx:104; cellular/page.tsx:114; workforce:37,50,115; connections/lib/views.ts:541; lib/health.ts:167,174 |
| C-02 | fixed | All listed hints: "requires the identity:attest/link claim" → "(requires admin permission)" (3×); "Person id (uuid)" → "Person"; "person record unavailable — opaque id" → "person record unavailable"; "Opaque secret-store reference — never a credential value." → "A reference to the stored secret — never the secret itself." (2×); interaction.tsx connect hint → "A reference to your company's stored secret — never the secret itself."; developer key note → "requires an admin role"; SECRET_REF_NOTE de-opaqued | connections/page.tsx:374,532,659,727,742-744,773; interaction.tsx:335-338; developer/lib/labels.ts:295-299 |
| C-03 | fixed | Every bare mono UUID row-foot labeled and shortened to the 8-char form, consistent with the surfaces' existing labeled citations: "run / record / request / mission / unknown / belief / goal / capability / agent / connection / source / destination / identity … {id8}". Already-labeled ids (e.g. "Latest delivery id") left untouched | risks:69-71,91-93; today:113-115,148-150,169-171,199-201,226-228,255-257; situation:104-106,152-154; unknowns:69-71,91-93; missions:92-94,115-117,132-134; goals:108-110; capabilities:115-117; opportunities:71-73,116-118; agents:101-103; approvals:88-90,152-154; recommendations:71-73; connections:156-158,269-271,433-435,670-672 |
| C-04 | fixed | "level_shortfall" / "capacity_shortfall" badges → "level shortfall" / "capacity shortfall" (both surfaces) | risks:139-140; capabilities:99-100 |
| C-05 | fixed-differently | "· by principal {uuid8}" → "· by an admin". The dossier suggested showing the admin's email, but the view model carries only the deciding admin's principal id — fetching an email would be a data-read change (forbidden by the no-behavior boundary). The calm placeholder keeps the audit fact ("decided · by an admin") without internal jargon or a bare UUID | (platform)/platform/waitlist/components/waitlist-views.tsx:88-90 |
| C-06 | fixed | Raw errorCode column → `describeErrorCode()` display mapper: known codes → short sentences ("provider unavailable — nothing was sent", "could not reach the runtime", "a required approval was rejected", …); unknown codes fall back to underscore-spaced words. Display only | (tower)/agents/page.tsx:28-43,141 |
| C-07 | fixed | "routed via {resolvedVia}" clause removed from both surfaces (the dossier's "omit the clause" option); related routing-speak calmed: recommendations empty-state "the matrix routes it" → "for your approval", chat drawer "Gate outcome: {outcome} (via {resolvedVia})" → plain outcome sentences | recommendations:51,68-74; approvals:88-91; chat/lib/answers.ts:628-633 |

## Disposition — findings D (P3)

| ID | Status | What changed | Where |
|----|--------|--------------|-------|
| D-01 | fixed | All 31 pages now export per-page metadata following the audited pattern: 15 tower pages "X — Management Tower — Aurum", /signin /signup /onboarding /invite, waitlist desk, connections, 6 marketplace pages, /more, /more/password, /people, and the (product) root redirect — each with a calm description | 31 files (commit 1f0cdb1) |
| D-02 | fixed | All 3 taglines in plain words: header meta "Summaries of your records — the source systems remain the record of truth"; footer "Management briefings summarize your company's records — the source systems remain the record of truth."; drawer footer "Context summarizes your records — …" (both branches) | (tower)/layout.tsx:36-38,73-75; (product)/components/context-drawer.tsx:58-62 |
| D-03 | fixed | "explicit, asynchronous, resumable" → "Aurum is not running any analysis right now."; "Unknown is first-class: …" → "An unknown is a question plus the consequence of not knowing."; "A gap without consequence is not first-class — these all have one." → "Every unknown here has a stated consequence."; "First-class learning missions" → "Learning missions…" ("terminal by design" → "final by design"). Same-class stragglers: unknowns/missions detail pages, learning hint, chat-types card label | today:160,193; unknowns:53,77,96; missions:34,46; missions/[missionId]:281; learning:368; chat-types:616 |

## Disposition — orchestrator findings B-TL

| ID | Status | What changed | Where |
|----|--------|--------------|-------|
| B-TL-01 | fixed | Created branded not-found.tsx: cream canvas (#fdfaf6), ink text, gold rounded-square "A" mark, calm "This page doesn't exist — it may have moved", "Back to Aurum" link to /; metadata title "Page not found — Aurum" | src/app/not-found.tsx (new) |
| B-TL-02 | fixed | Created error.tsx (client; calm message + "Try again" → reset()) and global-error.tsx (client; minimal branded shell rendering its own html/body + retry). No logging logic — display only | src/app/error.tsx, src/app/global-error.tsx (new) |
| B-TL-03 | fixed | Created icon.svg (rounded square, gold #d9952a background, cream #fdfaf6 "A" — the tower-mark aesthetic) and robots.ts (allow all — standard SaaS policy). No OG image attempted | src/app/icon.svg, src/app/robots.ts (new) |
| B-TL-04 | n/a | Verified-clean by the orchestrator — not re-hunted | — |

## Tests updated (copy only — behavior assertions preserved)

- `(product)/connections/tests/connections-unit.test.ts:78` + `connections-integration.test.ts:380` — transport-reason phrases
- `(tower)/tests/tower-unit.test.ts:44` — context-resolution detail no longer pinned to internal header copy (asserts a non-empty detail; all failure-code assertions unchanged); now-unused import removed
- `(product)/cellular/tests/cellular-unit.test.ts:97-102` — transport-note phrases
- `(product)/meetings/tests/meetings-unit.test.ts:110-115` — capture-transport-note phrases
- `(product)/tests/marketplace-unit.test.ts:309-323` — blocked-reason phrases (canInstall / state-machine assertions unchanged)
- `(product)/tests/marketplace-kits-unit.test.ts:171-173,265` — blocked-reason phrases (permission booleans unchanged)
- `(product)/tests/marketplace-integration.test.ts:641` — blocked-reason phrase (canInstall assertion unchanged)
- `(platform)/tests/platform-waitlist-unit.test.ts:159-164` — decided-row meta now asserts "by an admin" (the bare UUID prefix is intentionally no longer rendered; status/date/note/read-only assertions unchanged)
- `(product)/developer/tests/developer-unit.test.ts:147-154` — key-management and secret-ref note phrases
- Test-internal describe labels and fixtures referencing old vocabulary were deliberately left (dev-facing, never rendered)

## Gate results

| Gate | Result |
|------|--------|
| `bun install` | PASS — 297 packages, no lockfile drift |
| `bun run typecheck` | PASS — `tsc --noEmit` clean |
| `bun run lint` | PASS — `eslint .` clean |
| `bun run test` | PASS — full vitest suite green (288 test files; 5,815 tests; 0 failed, 23 skipped; executed in 3 shards of the same `vitest run` command because the suite exceeds the sandbox's 10-minute foreground window; every shard green after the five copy-assertion updates listed below) |
| Self-audit sweep (W0xx / \(lock / PostgreSQL / httpOnly / TenantContext / epistemics / dev seam / contract gap / not delivered at this base — src/app, comments excluded) | PASS — zero rendered prose hits. Remaining matches are dev-facing comments, code identifiers (type imports, module paths), or the literal public-API scope keys (`epistemics:read` et al.) which the developer console must display verbatim |

## Intentional remains (with reasons)

1. `epistemics:read` and the other `DEV_API_SCOPES` keys in (product)/developer/lib/labels.ts — these are the literal capability-scope identifiers of the public API, shown inside `<code>` beside calm labels ("Unknowns & beliefs · read"). Renaming them would misrepresent the API's real vocabulary to integrating developers.
2. MCP setup instructions referencing real configuration values (env var names, `<tenant uuid>` placeholders) in /developer — genuine setup documentation, not planning artifacts; the dossier's only finding there (A-21) is fixed.
3. Comments, file headers, test describe-labels/fixtures and /api/health diagnostics carrying W0xx references — explicitly out of scope per the repair rules.
4. `resolveTowerContext` failure details were calmed (dev-seam wording removed) although the path is unreachable from user traffic — belt-and-braces for the sweep; the unit test's copy assertion was updated accordingly.
