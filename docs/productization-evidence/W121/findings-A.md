# W121 adversarial audit findings — COPY INTEGRITY
Auditor: W121 (adversarial) · Base: main @ 65d8b8a · Date: 2026-09-30

## Summary

| Count | Severity |
|-------|----------|
| 32 | P0 — internal/dev content a customer should never see |
| 10 | P1 — broken/misleading/misrendered UX |
| 7 | P2 — rough edge, inconsistency, missing state |
| 3 | P3 — polish |
| **52** | **total** |

Verdict: the product's copy layer systematically leaks the build's internal planning
system into the browser. Work-item IDs (W002–W116), lock numbers, ADR/section
references, database names (PostgreSQL, `people.persons.id`), cookie flags (httpOnly),
module names (epistemics, cognition, contracts) and dev-seam instructions
(`?tenant=`, `?principal=`, `?authority=` in the development seam) render on every
shell (tower ×15, product ×~30, auth ×4, platform), in the chat answer drawer — the
core surface — and in error paths. Fourteen of the orchestrator's seeded findings were
confirmed at the exact strings and refined to precise file:line citations; the audit
then extended well beyond them (chat answers, notifications drawer, marketplace
developer gate, developer console, health reasons, quick-sign-in demo persona, and a
24-location "append-only" vocabulary class). Auth page bodies, page metadata, and most
hub copy are genuinely clean — the defects are concentrated in shells, footers,
notices, hints, and fallback/error copy, i.e. exactly the seams a feature-focused
author never re-reads.

## Index

| ID | Sev | Where (file:line) | Rendered excerpt |
|----|-----|-------------------|------------------|
| A-01 | P0 | (tower)/layout.tsx:38 | "Management surface W033 (lock 33/34)" |
| A-02 | P0 | (tower)/layout.tsx:76-77 | "PostgreSQL is domain truth · tenant-scoped reads · …" |
| A-03 | P0 | (product)/layout.tsx:55-56 | "Tenant-scoped reads · … · PostgreSQL is domain truth" |
| A-04 | P0 | (auth)/layout.tsx:22 | "Sessions are httpOnly · companies re-verify membership…" |
| A-05 | P0 | (tower)/risks/page.tsx:73 | "source: epistemics — … (lock 12)" |
| A-06 | P0 | (tower)/automation/page.tsx:51 | "W016 findings — evidence-cited" |
| A-07 | P0 | (tower)/lib/views/automation.ts:114 | "AutomationOpportunity records (W018 …) are not delivered at this base…" |
| A-08 | P0 | (tower)/lib/views/workforce.ts:120-121 | "Workforce intelligence (W019 …) is not delivered… contract gap for the architect." |
| A-09 | P0 | (tower)/lib/views/workforce.ts:106-107 | "…pass ?principal=<member uuid>" |
| A-10 | P0 | (tower)/components/view-ui.tsx:168 | "…module contracts, and every contract call carries an explicit TenantContext…" |
| A-11 | P0 | (product)/connections/lib/views.ts:556 | "Authentication lands with W058 — … (documented dev seam)." |
| A-12 | P0 | (product)/connections/lib/views.ts:557 | "…fail explicitly with provider_unavailable until infrastructure wires them." |
| A-13 | P0 | (product)/connections/page.tsx:220 | "Freshness is the canonical W006 classification…" |
| A-14 | P0 | (product)/connections/page.tsx:292 | "Freshness (W006)" |
| A-15 | P0 | (product)/connections/page.tsx:392 | "…the append-only outbound ledger…" |
| A-16 | P0 | (product)/connections/page.tsx:548 | "…never become pseudo-employees (lock 15)." |
| A-17 | P0 | (product)/connections/layout.tsx:45-46 | "Connection health is derived from contract state — PostgreSQL is domain truth" |
| A-18 | P0 | (product)/connections/lib/health.ts:180 | "…classification is unknown (W006)." |
| A-19 | P0 | (product)/marketplace/developer/page.tsx:62-70 | "Add one with ?authority=marketplace:submit in the development seam — … (W058)." |
| A-20 | P0 | (product)/developer/lib/labels.ts:301-302 | "…capability call (locks 31/32)." |
| A-21 | P0 | (product)/developer/page.tsx:526 | "…tenant-scoped, permission-checked and audited (locks 32)." |
| A-22 | P0 | (product)/chat/lib/answers.ts (13 lines) | "Goal (W008 record — …)", "(lock 12)", "(W013)"… |
| A-23 | P0 | (tower)/today/page.tsx:233 | "…(ADR-0017)." |
| A-24 | P0 | (product)/intelligence/goals/[goalId]/page.tsx:148 | "Unprompted goal-gap discovery (ADR-0017): …" |
| A-25 | P0 | (product)/explain/page.tsx:119 | "The explainability promise the architecture freezes (§24):" |
| A-26 | P0 | (tower)/agents/page.tsx:40-45 | "…Recruitment, teams and lifecycle evaluation are later work items." |
| A-27 | P0 | (product)/marketplace/lib/kits.ts:127 | "…the W009 authority gate holds the kit…" |
| A-28 | P0 | (product)/components/notification-entry.tsx:56 | "notifications module (W031 contract read)" |
| A-29 | P0 | (product)/connections/page.tsx:730 | "people.persons.id — …" |
| A-30 | P0 | (auth)/components/quick-sign-in.tsx:74 | "One tap signs you in as a seeded demo persona — …" |
| A-31 | P0 | 9 locations (tower) | "epistemics", "cognition traces", "cognitive executions", "Live cognition" |
| A-32 | P0 | 24 locations (9 surfaces) | "append-only" architecture vocabulary |
| B-01 | P1 | 10+ locations | raw module errors / "request failed (HTTP 500)" |
| B-02 | P1 | 3 tower pages | roadmap language in descriptions |
| B-03 | P1 | connections ×2 | "identity contract exposes no tenant-wide listing/enumeration" |
| B-04 | P1 | connections/page.tsx:170,288 | "provider_unavailable", "cursor null" |
| B-05 | P1 | (tower)/workforce/page.tsx:52,124 | bare UUID member rows; "member principal required" |
| B-06 | P1 | (tower)/approvals/page.tsx:47-54 | "actions:approve authority claim … the actions contract checks…" |
| B-07 | P1 | marketplace kit/package ×4 | "STORED bytes", "actions contract", "PENDING_REVIEW → APPROVED" |
| B-08 | P1 | (product)/cellular/page.tsx:158 | "No tenant policy rows — the built-in floor governs" |
| B-09 | P1 | (product)/components/states.tsx:175-192 | dead NotScoped: "?tenant=<tenant uuid>" instructions |
| B-10 | P1 | (product)/connections/layout.tsx:33 | "Composed from domain contracts — never a second source of truth" |
| C-01 | P2 | 9 locations | "tenant" architecture-speak in copy |
| C-02 | P2 | 8 locations | "claim", "(uuid)", "opaque" jargon in form hints |
| C-03 | P2 | ~20 locations | bare record IDs in row foots |
| C-04 | P2 | risks:129-130, capabilities:93-94 | snake_case enum legend labels |
| C-05 | P2 | platform waitlist-views.tsx:90 | "by principal <uuid8>" |
| C-06 | P2 | (tower)/agents/page.tsx:115-119 | raw execution errorCode column |
| C-07 | P2 | recommendations:70, approvals:94 | "routed via <internal enum>" |
| D-01 | P3 | 31 pages | missing per-page <title> metadata |
| D-02 | P3 | 3 locations | "never authoritative source state" taglines |
| D-03 | P3 | 4 locations | engine-model adjectives ("asynchronous, resumable", "first-class") |

---

## P0 findings

### A-01 Tower header meta names the internal work item and locks
- Where: `src/app/(tower)/layout.tsx:38`
- Rendered string: "Management surface W033 (lock 33/34)"
- User sees it: every Management Control Tower surface — header meta, top right (all 15: /today /goals /situation /unknowns /missions /risks /opportunities /capabilities /processes /automation /workforce /agents /evidence /recommendations /approvals)
- Why not production grade: a customer's executives see the builder's internal work-item ID and lock numbering in the chrome of every management page — exactly the operator's named example of a forbidden leak.
- Proposed replacement: "Management briefing — assembled live from your company's records"

### A-02 Tower footer states the database and architecture doctrine
- Where: `src/app/(tower)/layout.tsx:76-77`
- Rendered string: "PostgreSQL is domain truth · tenant-scoped reads · policy-gated actions · append-only evidence"
- User sees it: footer of all 15 tower surfaces
- Why not production grade: names the database engine and internal architecture rules ("tenant-scoped", "append-only") to non-technical executives on every page.
- Proposed replacement: "Every finding cites its evidence · changes are recorded, never rewritten"

### A-03 Product shell footer states the database and architecture doctrine
- Where: `src/app/(product)/layout.tsx:55-56`
- Rendered string: "Tenant-scoped reads · evidence-backed findings · approval-gated actions · PostgreSQL is domain truth"
- User sees it: footer of every product surface (~30 pages, including the anonymous-visible marketplace catalog)
- Why not production grade: same class as A-02 on the employee app's every page, including surfaces anonymous prospects browse.
- Proposed replacement: "Findings cite their evidence · consequential actions need your approval"

### A-04 Auth footer leaks the cookie implementation flag
- Where: `src/app/(auth)/layout.tsx:22`
- Rendered string: "Sessions are httpOnly · companies re-verify membership on every request"
- User sees it: sticky footer of /signin, /signup, /onboarding, /invite/<code> — the very first screen a customer sees
- Why not production grade: "httpOnly" is a cookie attribute, meaningless and alarming to non-technical sign-up visitors.
- Proposed replacement: "Sign-in sessions are securely stored · company membership is re-checked on every request"

### A-05 Risks card meta cites the epistemics module and lock 12
- Where: `src/app/(tower)/risks/page.tsx:73`
- Rendered string: "source: epistemics — conflicting evidence is retained (lock 12)"
- User sees it: /risks — "Open contradictions" card meta
- Why not production grade: internal module name plus a lock number presented as the source of a management card.
- Proposed replacement: "source: evidence analysis — conflicting evidence is kept, not merged"

### A-06 Automation card meta cites work item W016
- Where: `src/app/(tower)/automation/page.tsx:51`
- Rendered string: "W016 findings — evidence-cited"
- User sees it: /automation — "Automation candidates" card meta
- Why not production grade: a bare internal work-item ID as the card's provenance label.
- Proposed replacement: "Process findings — each cites its evidence"

### A-07 Automation notice discloses the unshipped W018 module in dev-speak
- Where: `src/app/(tower)/lib/views/automation.ts:114` (rendered at `(tower)/automation/page.tsx:39-41`)
- Rendered string: "AutomationOpportunity records (W018 — candidate solution types, expected ROI, outcome measurement) are not delivered at this base; these are the W016 process findings they are built from, with their evidence."
- User sees it: /automation — top-of-page notice on every visit
- Why not production grade: names an internal record type, two work-item IDs, and "not delivered at this base" — roadmap shorthand for the dev team.
- Proposed replacement: "Today this page shows where work is manual, duplicated, or slow — each finding cites its evidence. Estimated savings and solution options for each candidate are coming."

### A-08 Workforce notices disclose unshipped W019 and an internal "contract gap"
- Where: `src/app/(tower)/lib/views/workforce.ts:120-121` (rendered at `(tower)/workforce/page.tsx:40-44`)
- Rendered strings: "Workforce intelligence (W019 — workload, fit, performance signals with alternative explanations) is not delivered at this base; this surface presents facts only, no assessments." and "The people contract (W002) exposes no employee roster listing — reported as a contract gap for the architect."
- User sees it: /workforce — top-of-page notices
- Why not production grade: work-item IDs, module-record language, and a message literally addressed to "the architect" shown to managers.
- Proposed replacement: "This page lists facts only — who supplies which skills, and each person's role. It does not judge workload, fit, or performance." and "A full employee directory is coming; for now, people appear as they are recorded in company data."

### A-09 Workforce degraded state instructs users to pass a dev-seam query parameter
- Where: `src/app/(tower)/lib/views/workforce.ts:106-107` (rendered at `(tower)/workforce/page.tsx:141`)
- Rendered string: "tenant membership is readable only by a member principal — pass ?principal=<member uuid>"
- User sees it: /workforce — "Tenant membership" card, empty-state hint when the roster read is refused
- Why not production grade: tells an end user to hand-edit the URL with an internal scoping parameter that was removed from the product (W058).
- Proposed replacement: "The member list is available to company admins. Ask an admin if you need the roster."

### A-10 Tower not-scoped fallback describes module contracts and TenantContext
- Where: `src/app/(tower)/components/view-ui.tsx:168`
- Rendered string: "The Control Tower reads tenant-scoped state through module contracts, and every contract call carries an explicit TenantContext (no ambient global)."
- User sees it: all 15 tower pages' declared fallback (`if (!resolution.ok) return <NotScoped …/>`); with the current session resolver this state is unreachable (pages redirect instead), but the copy ships in the bundle one refactor away from users.
- Why not production grade: architecture internals ("module contracts", "TenantContext", "ambient global") as the explanation a stuck user would read.
- Proposed replacement: "This view needs a company. Sign in and choose your company to continue."

### A-11 Connections notice explains a pre-authentication dev seam that no longer exists
- Where: `src/app/(product)/connections/lib/views.ts:556` (rendered at `connections/page.tsx:112-116`)
- Rendered string: "Authentication lands with W058 — until then this surface resolves its tenant context from explicit headers/query parameters (documented dev seam)."
- User sees it: /connections — top-of-page notices, every visit
- Why not production grade: stale internal roadmap note ("Authentication lands with W058 — until then…") describing a header/query-parameter seam that the code itself says was removed; pure build-log narration in the UI.
- Proposed replacement: delete the notice entirely (authentication already shipped).

### A-12 Connections notice leaks an internal error code and infrastructure TODO
- Where: `src/app/(product)/connections/lib/views.ts:557` (rendered at `connections/page.tsx:112-116`)
- Rendered string: "No channel/source/destination transports are wired by default (provider isolation): polls, outbound sends and challenge deliveries fail explicitly with provider_unavailable until infrastructure wires them."
- User sees it: /connections — top-of-page notices, every visit
- Why not production grade: internal error enum (`provider_unavailable`), "wired", and "until infrastructure wires them" — an ops note rendered to customers.
- Proposed replacement: "Deliveries are off by default: sending, polling and verification codes will report a clear failure until your provider connection is activated."

### A-13 Sources description cites "the canonical W006 classification" and the opaque cursor
- Where: `src/app/(product)/connections/page.tsx:220`
- Rendered string: "Inbound connectors the tenant ingests evidence from (polling or webhooks). Freshness is the canonical W006 classification; the checkpoint is the opaque cursor the next poll resumes from. Re-registering a source is its re-authorization path."
- User sees it: /connections#sources — "Source systems" section description
- Why not production grade: work-item ID plus cursor/polling internals in the section's lead sentence.
- Proposed replacement: "Systems Aurum pulls your company's evidence from. Each source shows how fresh its data is and where the next check resumes; reconnecting renews its authorization."

### A-14 Detail row labeled with the internal work item
- Where: `src/app/(product)/connections/page.tsx:292`
- Rendered string: "Freshness (W006)"
- User sees it: /connections — per-source "Checkpoint, freshness & controls" detail grid row label
- Why not production grade: a work-item ID inside a settings label.
- Proposed replacement: "Freshness"

### A-15 Destinations description names the append-only ledger and authority gate
- Where: `src/app/(product)/connections/page.tsx:392`
- Rendered string: "Outbound connectors Aurum publishes authorized findings to. Delivery state is the append-only outbound ledger: pending deliveries wait for the data-export authority gate (or a wired transport); failed deliveries retry; replay re-delivers as a new gated delivery. Re-registering a destination is its re-authorization path."
- User sees it: /connections#destinations — "Destinations" section description
- Why not production grade: ledger/append-only/gate/transport vocabulary describing simple export state.
- Proposed replacement: "Systems Aurum delivers authorized findings to. Every delivery is recorded permanently: pending ones wait for export approval, failed ones retry, and re-delivery sends a new approved delivery. Reconnecting renews authorization."

### A-16 Identity description ends with a lock number
- Where: `src/app/(product)/connections/page.tsx:548`
- Rendered string: "…linking attaches a verified identity to a person — unverified accounts stay external and never become pseudo-employees (lock 15)."
- User sees it: /connections#identities — "Identity & verification" section description
- Why not production grade: an internal lock number appended to a customer-facing safety promise.
- Proposed replacement: "…linking attaches a verified identity to a person — unverified accounts stay external and are never treated as employees."

### A-17 Connections footer states the database as domain truth
- Where: `src/app/(product)/connections/layout.tsx:45-46`
- Rendered string: "Connection health is derived from contract state — PostgreSQL is domain truth"
- User sees it: /connections — sticky footer
- Why not production grade: database engine name plus "contract state" in a footer guarantee.
- Proposed replacement: "Connection health is computed from live connector state — your source systems remain the record of truth"

### A-18 Source health reason cites W006
- Where: `src/app/(product)/connections/lib/health.ts:180`
- Rendered string: "No freshness policy resolves for this source — classification is unknown (W006)."
- User sees it: /connections — per-source health reasons list (rendered via HealthReasons, hub-ui.tsx:174-196)
- Why not production grade: work-item ID inside a per-row status explanation.
- Proposed replacement: "No freshness policy is set for this source, so its status shows as unknown."

### A-19 Marketplace developer gate instructs users to use the development seam
- Where: `src/app/(product)/marketplace/developer/page.tsx:62-70`
- Rendered string: "The developer surface needs one of the authority claims marketplace:submit (publish), extensions:administer (build) or marketplace:administer (platform review). Add one with ?authority=marketplace:submit in the development seam — claims arrive with the authentication experience (W058). The review queue and forms below stay honest about what your scope can do."
- User sees it: /marketplace/developer — rendered for any signed-in user who lacks those claims (`view.usable` is authority-gated, marketplace/lib/views.ts:456)
- Why not production grade: the worst leak in the app — it tells a customer to append `?authority=…` "in the development seam", cites W058, and describes the permission model's internals.
- Proposed replacement: "You need permission to use the developer console. Ask a company admin for publisher, builder, or platform-review access — the sections below will unlock with it."

### A-20 Developer console note cites locks 31/32
- Where: `src/app/(product)/developer/lib/labels.ts:301-302` (rendered at `developer/page.tsx:374`)
- Rendered string: "The public API exposes capabilities, never tables: every operation is a named, versioned, tenant-scoped, permission-checked and audited capability call (locks 31/32)."
- User sees it: /developer — "Public API" panel notes
- Why not production grade: internal lock references appended to a security promise (on a developer-facing page, which makes it no less a leak of planning artifacts).
- Proposed replacement: "The public API exposes capabilities, never raw tables: every operation is permission-checked and recorded in the audit trail."

### A-21 MCP guide cites locks 32
- Where: `src/app/(product)/developer/page.tsx:526`
- Rendered string: "Startup is fail-closed: the configured principal must be a member of the configured tenant before the transport serves. Every tool call carries this explicit context — tenant-scoped, permission-checked and audited (locks 32)."
- User sees it: /developer — "MCP connection" step 2 explanation
- Why not production grade: lock reference in setup instructions.
- Proposed replacement: "…Every tool call carries this context — permission-checked and audited."

### A-22 Chat answer drawer subtitles carry work-item IDs and lock numbers
- Where: `src/app/(product)/chat/lib/answers.ts:230, 264, 305, 319, 341, 387, 442, 477, 490, 549, 590, 634, 856` (rendered via `chat-workspace.tsx:632-638` → context drawer subtitle/sections, `components/sheet.tsx:106-107`)
- Rendered strings (selection): "Goal (W008 record — management defines direction; Aurum evaluates progress)" (230); "First-class unknown (W007) — a consequential question, not a TODO" (264); "Learning mission (W011) — goal-driven, budget-bounded" (305); "Two pieces of evidence disagree — both are retained (lock 12)" (319); "Retained contradiction (W007) — conflicting evidence is never discarded" (341); "Capability gap (W017) — supply and demand, with alternatives" (387); "Capability (W017) — what the company can do today, supply and demand" (442); "Observations are immutable (W004) — this record cannot be edited…" (477); "Evidence (W004) — the immutable observation record every answer rests on" (490); "Analysis finding recorded on a cognition trace (W013) — derived intelligence" (549); "Routed action request (W009) — consequential actions pass the human gate" (590); "Pending action request (W009) — the human authority gate" (634); "…conflicting evidence is kept, never discarded (lock 12)." (856)
- User sees it: /chat — the "Why this?" drawer on answer cards in the conversation timeline (the product's core surface)
- Why not production grade: thirteen distinct answer explanations carry internal IDs (W002–W013 class), lock numbers, and even the word "TODO" into the primary user experience.
- Proposed replacement: keep the plain-language half of each string and delete the parenthetical: e.g. "Goal — set by management; Aurum tracks progress", "Unknown — a consequential question, not a to-do list", "Learning mission — goal-driven, budget-bounded", "Two pieces of evidence disagree — both are kept", "Capability gap — supply and demand, with alternatives", "Evidence — the immutable record every answer rests on", "Analysis finding — derived intelligence", "Action request — consequential actions pass the human gate".

### A-23 Today empty-state hint cites ADR-0017
- Where: `src/app/(tower)/today/page.tsx:233`
- Rendered string: "Unprompted unknown discovery derives candidates from active goals and their evidence (ADR-0017)."
- User sees it: /today — "Latest goal-gap discovery pass" card empty state
- Why not production grade: an architecture-decision-record reference in a management briefing.
- Proposed replacement: "Aurum proposes new questions from your active goals and their evidence."

### A-24 Goal chain blurb cites ADR-0017
- Where: `src/app/(product)/intelligence/goals/[goalId]/page.tsx:148`
- Rendered string: "Unprompted goal-gap discovery (ADR-0017): material gaps between this goal and its evidence, decided through the materiality gate."
- User sees it: /intelligence/goals/<id> — discovery panel blurb
- Why not production grade: ADR citation plus "materiality gate" internals in a workflow page.
- Proposed replacement: "Aurum proposes new questions where this goal's evidence falls short — only the material gaps become unknowns."

### A-25 Explain page cites an architecture-document section
- Where: `src/app/(product)/explain/page.tsx:119`
- Rendered string: "The explainability promise the architecture freezes (§24):"
- User sees it: /explain — "What this view is" panel blurb
- Why not production grade: "(§24)" is a section number of an internal design document rendered as product copy.
- Proposed replacement: "What this view guarantees:"

### A-26 Agents notice says features are "later work items"
- Where: `src/app/(tower)/agents/page.tsx:40-45`
- Rendered string: "Agent definitions are registered under the agents:administer authority claim; every execution routes through the actions authority matrix at the level its permission scopes imply. Recruitment, teams and lifecycle evaluation are later work items."
- User sees it: /agents — top-of-page notice
- Why not production grade: "later work items" is the backlog speaking; "authority claim/matrix" is the internal permission model.
- Proposed replacement: "Agent registration requires admin permission, and every run passes the approval gates its permissions require. Recruiting, teams and evaluation tools are planned."

### A-27 Kit status note cites the W009 authority gate
- Where: `src/app/(product)/marketplace/lib/kits.ts:127`
- Rendered string: "Installed but the grant review is waiting for a human decision — the W009 authority gate holds the kit until an authorized principal (not the requester) approves or rejects it."
- User sees it: /marketplace/kit/<key> and /marketplace/installed — kit lifecycle status explanations
- Why not production grade: work-item ID and "principal" in a status message a buyer reads.
- Proposed replacement: "Installed, awaiting approval — an authorized approver (not the requester) must approve or reject the kit's access grant."

### A-28 Notification drawer source line names the module and work item
- Where: `src/app/(product)/components/notification-entry.tsx:56` (rendered via `components/context-drawer.tsx:61`)
- Rendered string: "notifications module (W031 contract read)"
- User sees it: product shell — the bell → notification "Details" drawer, footer line ("Source: notifications module (W031 contract read) · derived intelligence, never authoritative source state.")
- Why not production grade: module name + work-item ID + "contract read" as the source attribution of a notification.
- Proposed replacement: "Source: Aurum notifications"

### A-29 Identity-link form hint shows a database table.column reference
- Where: `src/app/(product)/connections/page.tsx:730`
- Rendered string: "people.persons.id — create a person record below if none exists yet (requires the identity:link claim)."
- User sees it: /connections#identities — "Link to person" form field hint
- Why not production grade: `people.persons.id` is a schema path; no customer should ever see table.column names in a form hint.
- Proposed replacement: "Pick the person you created below (requires admin permission)."

### A-30 Quick-access panel announces the seeded demo persona (non-production runtimes)
- Where: `src/app/(auth)/components/quick-sign-in.tsx:74`
- Rendered string: "One tap signs you in as a seeded demo persona — each enters through the real auth flow with the permissions of their role."
- User sees it: /signin — quick-access panel; renders only when NODE_ENV ≠ production (gate at `(auth)/lib/api.ts:228-233`), i.e. on preview/staging deployments customers can be shown
- Why not production grade: "seeded demo persona" is harness vocabulary; any non-prod share of this app leaks it on the first screen.
- Proposed replacement: "One tap signs you in as a demo user with that role's permissions."

### A-31 Internal module names rendered as stat hints and card metas (tower)
- Where: `src/app/(tower)/risks/page.tsx:41, 42, 46`; `src/app/(tower)/today/page.tsx:76, 174, 201, 203`; `src/app/(tower)/opportunities/page.tsx:41, 49`
- Rendered strings: "cognition traces" (risks:41, opportunities:41, today:203); "epistemics" (risks:42); "source: cognitive executions (risk/opportunity/capability stage)" (risks:46, opportunities:49); "Live cognition" stat label (today:76); "Live cognitive executions" card title (today:174); "from the risk/opportunity/capability stage" (today:201)
- User sees it: stat-tile hints and card metas across /risks, /today, /opportunities
- Why not production grade: "epistemics" and "cognition" are internal module names; pipeline-stage phrasing is build vocabulary, not management language.
- Proposed replacement: "evidence analysis" for epistemics; "analysis runs" for cognition traces/cognitive executions; "Live analysis" for Live cognition; "from the analysis stage" for the stage meta.

### A-32 "Append-only" architecture vocabulary rendered as product copy (class)
- Where (24 rendered locations across 9 surfaces): `src/app/(tower)/layout.tsx:77`; `(tower)/approvals/page.tsx:44, 137`; `(product)/connections/page.tsx:392`; `(product)/marketplace/kit/[kitKey]/page.tsx:252, 362, 453, 513, 592`; `(product)/marketplace/package/[packageId]/page.tsx:233, 390`; `(product)/marketplace/installed/[extensionKey]/page.tsx:268`; `(product)/marketplace/developer/page.tsx:135`; `(product)/ai/page.tsx:464, 509`; `(product)/explain/page.tsx:94`; `(product)/explain/[kind]/[id]/page.tsx:563, 743`; `(product)/interventions/teams/[teamId]/page.tsx:239, 277`; `(platform)/platform/waitlist/components/waitlist-views.tsx:149`; `(platform)/layout.tsx:45`; `(product)/cellular/reach/[reachId]/page.tsx:41, 136`
- Rendered strings (selection): "the decision trail is append-only — decisions can never be rewritten" (approvals:44); "terminal — append-only history" (approvals:137); "append-only evidence (drift appears as a new run, never a rewrite)" (kit:252); "PENDING_REVIEW → APPROVED or REJECTED. The decision is append-only evidence…" (package:390); "Every recorded deployment of the default install, append-only." (installed:268); "The audit trail — decisions are terminal and append-only." (waitlist:149); "…the append-only attempt audit and any replies." (cellular reach:41 — also the page's meta description)
- User sees it: blurbs, notes, metas and footers across tower, marketplace, AI, explain, interventions, platform and cellular surfaces
- Why not production grade: "append-only" is storage-engine vocabulary from the lens's forbidden list; most sentences already carry the plain-language version ("never rewritten"), so the term is pure leakage.
- Proposed replacement: replace the term wherever it appears with "permanent"/"recorded, never rewritten" — e.g. "decisions are recorded permanently and can never be rewritten"; "deployment history is permanent"; "the full attempt history".

## P1 findings

### B-01 Raw module errors and HTTP statuses render as user-facing error text
- Where: `src/app/(product)/connections/components/interaction.tsx:53-55, 78`; `src/app/(tower)/approvals/decision-form.tsx:59-61, 65`; `src/app/(product)/chat/components/chat-workspace.tsx:394, 407, 455, 467, 508, 516, 550`; error mapping that passes module messages through: `(product)/connections/lib/api.ts:160-174`, `(tower)/lib/api.ts:176-191`, `(product)/chat/lib/chat-api.ts:58-77`
- Rendered strings (examples of what reaches users): `request failed (HTTP 500)`, `decision failed (HTTP 400)`, `send failed (HTTP 500)` — plus raw module messages such as "TenantContext.tenantId must be a non-empty string" (identity/access.ts:24) and "this operation requires the 'identity:attest' authority claim" (identity/access.ts:38) which surface verbatim via `failure?.message ?? failure?.error`
- User sees it: /connections action status lines, tower Approvals decide errors, /chat send/answer/decision failures
- Why not production grade: internal validation messages and HTTP jargon are shown with no user-language mapping and no recovery guidance.
- Proposed replacement: map known codes to calm text ("That didn't go through — please try again", "You need admin permission to do that") and fall back to "Something went wrong. Please try again, or contact support if it keeps happening." with a retry affordance.

### B-02 Surface descriptions narrate unshipped modules
- Where: `src/app/(tower)/opportunities/page.tsx:36`; `src/app/(tower)/automation/page.tsx:36`; `src/app/(tower)/risks/page.tsx:50`
- Rendered strings: "First-class opportunity objects (estimated value, confidence, required capabilities) arrive with the opportunity engine." (opportunities:36); "…the evidence the automation module builds opportunity records from." (automation:36); "…first-class risk objects arrive with the environment/opportunity modules." (risks:50)
- User sees it: surface header descriptions on /opportunities, /automation, /risks
- Why not production grade: descriptions sell features that do not exist and use internal model names ("first-class", "modules").
- Proposed replacement: "…each opportunity cites its evidence and affected goals." / "…the evidence automation candidates are built from." / "…risk findings with their evidence and affected goals."

### B-03 "Contract gap" language in identity guidance
- Where: `src/app/(product)/connections/page.tsx:583-586`; `src/app/(product)/connections/lib/views.ts:558`
- Rendered strings: "The identity contract exposes no tenant-wide listing — identities surface from recent channel activity; use this lookup for accounts outside that window." (583-586); "…the identity contract exposes no tenant-wide enumeration, so use the provider+account lookup…" (558)
- User sees it: /connections#identities — lookup field hint, and the top-of-page notices
- Why not production grade: "identity contract" and "enumeration" are module-internals phrasing of a simple product limitation.
- Proposed replacement: "Identities appear as people message your connected channels. Use this lookup to find accounts outside that window."

### B-04 Raw internal codes and null-state text in connection details
- Where: `src/app/(product)/connections/page.tsx:170, 288`; `src/app/(product)/connections/lib/health.ts:87`
- Rendered strings: "not wired (sends fail provider_unavailable)" (170); "start of history (cursor null)" (288); "No delivery transport wired — outbound messages and verification codes cannot leave (they fail with provider_unavailable)." (health:87)
- User sees it: /connections — channel detail grid "Delivery transport" value; source detail "Current checkpoint" value; channel health reasons
- Why not production grade: internal error enums and a literal `null` shown as settings values.
- Proposed replacement: "not connected yet — messages cannot be sent"; "start of history"; "Sending is not connected yet — outbound messages and verification codes will not go out until it is."

### B-05 Workforce member list renders bare UUIDs and "principal" jargon
- Where: `src/app/(tower)/workforce/page.tsx:52, 124`
- Rendered strings: "member principal required" (52 — stat hint); row titles are raw `<span className="mono">{member.principalId}</span>` UUIDs (124)
- User sees it: /workforce — stat tile hint and "Tenant membership" card rows
- Why not production grade: a people list whose every row is an unlabeled UUID is unusable for a manager; "principal" is auth internals.
- Proposed replacement: show names/emails when available (or "Member list available to admins"), and change the hint to "admin access required".

### B-06 Approvals permission notice explains the claim model and "actions contract"
- Where: `src/app/(tower)/approvals/page.tsx:47-54`
- Rendered string: "Deciding requires the actions:approve authority claim, which the session derives from your verified company role (owner or admin). Your current role carries it neither way — a company admin can invite or promote you, or another approver decides. The actions contract checks the claim itself; the tower never bypasses it."
- User sees it: /approvals — notice shown to any non-approver
- Why not production grade: permission-model internals ("authority claim", "the actions contract checks", "the tower never bypasses it") instead of a plain roles message.
- Proposed replacement: "Decisions need an owner or admin role. Ask an admin to promote you, or let another approver decide."

### B-07 Marketplace blurbs leak persistence vocabulary and raw enums
- Where: `src/app/(product)/marketplace/kit/[kitKey]/page.tsx:453, 513`; `src/app/(product)/marketplace/package/[packageId]/page.tsx:390`
- Rendered strings: "Append-only: the deterministic checks re-examine the STORED bytes (the digest is re-derived — an edited row fails loudly)." (453); "The human decision behind the authority gate — separation of duties is enforced by the actions contract; the decision is append-only evidence." (513); "PENDING_REVIEW → APPROVED or REJECTED. The decision is append-only evidence; rejection is terminal for this version." (390)
- User sees it: kit/package detail — checks, review and grant panels
- Why not production grade: "STORED bytes", "row", "digest", "actions contract", and uppercase state enums are pipeline internals.
- Proposed replacement: "Checks re-run against the exact bytes that were published — any later change is caught and recorded." / "The approval is recorded by a person, not the vendor — decisions are permanent." / "Review moves a version from waiting to approved or rejected; rejection is final for that version."

### B-08 Cellular policy card speaks of database rows
- Where: `src/app/(product)/cellular/page.tsx:158`
- Rendered string: "No tenant policy rows — the built-in floor governs"
- User sees it: /cellular — routing/cost policy panel empty state
- Why not production grade: "policy rows" is a table-scan term; "built-in floor" is internal defaulting language.
- Proposed replacement: "No custom policy set — the built-in defaults apply"

### B-09 Dead NotScoped copy in the product shell instructs `?tenant=` URL surgery
- Where: `src/app/(product)/components/states.tsx:175-192`
- Rendered string: "Aurum reads tenant-scoped state through module contracts, and every contract call carries an explicit TenantContext — there is no ambient global and no cross-company view." plus "…Example: append ?tenant=<tenant uuid> to the URL. Signed-in company selection arrives with the authentication experience; until then the shell resolves its scope from explicit query parameters (?tenant=, optional ?principal=, optional ?authority= claims, optional ?workspace=)."
- User sees it: currently none — the component is exported but never imported (verified against every states.tsx import site); it ships in the bundle one import away from every product page
- Why not production grade: the pre-auth dev-seam instructions ("append ?tenant=") that W058 removed, preserved as live-shipped copy.
- Proposed replacement: "Choose your company to continue — sign in and pick the company you want to work in."

### B-10 Connections header meta narrates composition internals
- Where: `src/app/(product)/connections/layout.tsx:33`
- Rendered string: "Composed from domain contracts — never a second source of truth"
- User sees it: /connections — header meta under the title
- Why not production grade: "domain contracts" and "second source of truth" are architecture-review vocabulary.
- Proposed replacement: "Assembled live from your connected systems — always current"

## P2 findings

### C-01 "tenant" architecture-speak in otherwise customer-facing copy
- Where: `src/app/(product)/connections/page.tsx:123, 220`; `(tower)/unknowns/page.tsx:33`; `(product)/marketplace/page.tsx:104`; `(product)/cellular/page.tsx:114`; `(tower)/workforce/page.tsx:115`; `(product)/connections/lib/views.ts:541`; `(product)/connections/lib/health.ts:167, 174`
- Rendered strings (selection): "The tenant's sending endpoints…" (123); "Inbound connectors the tenant ingests evidence from…" (220); "the tenant's knowledge debt" (33); "Your tenant registry…" (104); "The tenant-owned telecom accounts…" (114); "Evidence stream is stale against the tenant freshness policy." (167/174); "No identity found for that provider account in this tenant." (541)
- User sees it: section descriptions across connections, unknowns, marketplace, cellular, workforce
- Why not production grade: the rest of the product says "company"/"workspace"; "tenant" is multi-tenancy jargon that executives don't use.
- Proposed replacement: "your company" — e.g. "Your company's sending endpoints…", "your company's knowledge debt", "your company's installed extensions".

### C-02 Authorization "claim"/"uuid"/"opaque" jargon in form hints
- Where: `src/app/(product)/connections/page.tsx:713, 728, 730, 759, 647, 364, 520`; `src/app/(product)/connections/components/interaction.tsx:323-335`; `src/app/(product)/developer/lib/labels.ts:295-296`
- Rendered strings: "…(requires the identity:attest claim)." (713, 759); "Person id (uuid)" (728); "…(requires the identity:link claim)." (730); "(person record unavailable — opaque id)" (647); "Opaque secret-store reference — never a credential value." (364, 520); "Opaque reference to the tenant's secret-store entry — never a credential value." (interaction:332-335); "…requires the 'api:administer' authority claim…" (labels:295-296)
- User sees it: /connections identity forms and re-authorize forms; /developer key notes
- Why not production grade: permission strings, type names and "opaque" storage vocabulary in field hints.
- Proposed replacement: "(requires admin permission)"; "Person"; "person record unavailable"; "A reference to the stored secret — never the secret itself"; "Managing keys requires an admin role."

### C-03 Bare record IDs rendered without labels in row foots
- Where (representative): `src/app/(tower)/risks/page.tsx:66, 87`; `(tower)/today/page.tsx:113, 146, 165, 193, 218, 245`; `(tower)/situation/page.tsx:104, 150`; `(tower)/unknowns/page.tsx:69, 89`; `(tower)/missions/page.tsx:92, 115, 132`; `(tower)/goals/page.tsx:108`; `(tower)/capabilities/page.tsx:115`; `(tower)/opportunities/page.tsx:71, 114`; `(tower)/agents/page.tsx:86`; `(tower)/approvals/page.tsx:92, 156`; `(product)/connections/page.tsx:156, 267, 429, 664`
- Rendered strings: `<span className="mono">{finding.executionId}</span>`, `{contradiction.id}`, `{member.principalId}`, `{card.connection?.id}` … — raw UUIDs with no caption
- User sees it: every tower list row and connections row footer
- Why not production grade: unlabeled internal identifiers clutter management views (labeled citations like "evidence: …" are defensible provenance; the bare ones are noise).
- Proposed replacement: label them ("request 3f2a…") or move behind the existing disclosure controls.

### C-04 Legend rows render snake_case enum values
- Where: `src/app/(tower)/risks/page.tsx:129-130`; `src/app/(tower)/capabilities/page.tsx:93-94`
- Rendered strings: "level_shortfall best supply below required level · capacity_shortfall declared capacity below required" (129-130); same two labels at capabilities:93-94
- User sees it: /risks and /capabilities — "Gap legend" rows
- Why not production grade: raw status enums with underscores, inconsistent with StatusBadge which spaces them (view-ui.tsx:98).
- Proposed replacement: "level shortfall — best supply below required level · capacity shortfall — declared capacity below required"

### C-05 Platform desk shows "principal" and a UUID fragment as the decision-maker
- Where: `src/app/(platform)/platform/waitlist/components/waitlist-views.tsx:90`
- Rendered string: " · by principal ${request.decidedBy.slice(0, 8)}"
- User sees it: /platform/waitlist — decided rows' meta line
- Why not production grade: "principal" + truncated UUID instead of the admin's name/email.
- Proposed replacement: " · by <admin email>" (the desk already knows the reviewer).

### C-06 Agents executions table shows a raw error-code column
- Where: `src/app/(tower)/agents/page.tsx:115-119`
- Rendered string: `<span className="mono">{execution.errorCode}</span>` beside the status pill
- User sees it: /agents — "Recent executions" table
- Why not production grade: internal error enums (e.g. provider_unavailable) with no explanation.
- Proposed replacement: map codes to short sentences ("provider unavailable — nothing was sent") or omit with a status icon + tooltip.

### C-07 Approval rows expose the internal routing enum
- Where: `src/app/(tower)/recommendations/page.tsx:70`; `src/app/(tower)/approvals/page.tsx:94`
- Rendered string: "routed via {item.evaluation.resolvedVia}" (values like `policy`/`default`)
- User sees it: /recommendations and /approvals pending rows
- Why not production grade: which internal rule engine branch routed the request is dev detail.
- Proposed replacement: "decided by policy" or omit the clause.

## P3 findings

### D-01 31 pages ship without per-page titles
- Where: all 15 tower pages, /signin, /signup, /onboarding, /invite/[code], /connections, /marketplace (all 6 pages), /more, /more/password, /people, /platform/waitlist, /(product) root redirect page
- User sees it: browser tab / history / bookmarks show only the root "Aurum" for every one of these surfaces
- Why not production grade: every page that does export metadata does it well — this is a consistency gap, not a leak.
- Proposed replacement: add the same pattern the audited pages use ("Risks — Management Tower — Aurum", etc.).

### D-02 "…never authoritative source state" taglines
- Where: `src/app/(tower)/layout.tsx:36, 72-73`; `src/app/(product)/components/context-drawer.tsx:60`
- Rendered strings: "Derived intelligence — never authoritative source state" (36); "Management briefings are derived intelligence, not authoritative source state." (72-73); "Context is derived intelligence — never authoritative source state." (drawer:60)
- User sees it: tower header meta/footer, context drawer footer
- Why not production grade: the idea is right but "authoritative source state" is architecture-speak for "check the source system".
- Proposed replacement: "Summaries of your records — the source systems remain the record of truth"

### D-03 Engine-model adjectives and "first-class" phrasing
- Where: `src/app/(tower)/today/page.tsx:181, 156`; `(tower)/unknowns/page.tsx:47`; `(tower)/missions/page.tsx:40`
- Rendered strings: "The intelligence loop is idle: explicit, asynchronous, resumable." (181); "Unknown is first-class: a question plus the consequence of not knowing." (156); "A gap without consequence is not first-class — these all have one." (47); "First-class learning missions…" (40)
- User sees it: empty states and descriptions on /today, /unknowns, /missions
- Why not production grade: data-modeling adjectives ("first-class", "asynchronous, resumable") that mean nothing to managers.
- Proposed replacement: "Aurum is not running any analysis right now." / "Every unknown here has a stated consequence." / "Learning missions: …"

## Verified-clean areas

So the repair crew does not re-hunt:

- **Page metadata**: every `export const metadata` audited (root, /chat, /learning, /intelligence + chain pages, /developer, /meetings + detail, /explain + detail, /ai, /ai/preferences, /ai/preferences/advanced, /interventions ×4, /cellular ×2). Titles and descriptions are customer-appropriate; no internal codenames, no scaffold names. (Only D-01's missing titles.)
- **Auth page bodies**: /signin, /signup, /onboarding, /invite/<code> copy is clean and well-written (invite-expiry, mismatch and waitlist states included). Only the shared footer (A-04) and the gated quick-access panel (A-30) leak.
- **Platform waitlist desk** (/platform/waitlist + waitlist-views): decision notices, empty states and blurbs are calm and clean, except C-05 and the A-32 footer instance.
- **Chat chrome**: composer placeholders, aria-labels, timeline copy, "Why this?" affordances, delivery-status copy (chat-format.ts), learning/intervention card link labels — clean. The leaks are in the answer payload (A-22), not the chrome.
- **Hub pages**: /more (account, accessibility, "What Aurum is"), /people, /learning, /meetings, /cellular (except B-08/C-01), /intelligence home and chain pages (except A-24), marketplace catalog main copy — clean.
- **Shared primitives**: states.tsx StatusPill/EmptyState/ErrorState/Loading/Working patterns, hub-ui Pill/HealthPill/StatusPill, tower nav.tsx — clean.
- **Comments**: ~100 files carry W0xx/lock references in comments and file headers; per audit rule 2 these are dev-facing and are NOT findings. tests/ directories and /api/health's JSON diagnostics (W102/W116 strings) are likewise out of the user-visible lens.
- **No other leak classes found**: no TODO/FIXME strings rendered, no lorem, no scaffold/codename text, no "Z.ai"/"Vercel" mentions in user copy, no console output surfaced in UI.
