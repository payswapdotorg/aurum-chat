# Aurum Chat — Tech Lead Handoff Summary
Date: 2026-09-18
Repository: `payswapdotorg/aurum-chat`
Architecture: v2.1 FROZEN
Current main at handoff revision: d7a4e911c196ba4f9fe17b05bf9d5d6881c592e0

## Canonical implementation plan

The authoritative product-surface/deployment work breakdown is:

`spec/PRODUCT-SURFACE-DEPLOYMENT-PLAN.md`

It contains the complete journey simulation, UX direction, W057-W070 definitions, dependency graph, three-worker waves, deployment architecture and final acceptance gates.

This file is intentionally only the concise handoff wrapper. It must not become a competing work plan.

## Repository truth

Verified against the live repository before handoff:

- W001-W056 have non-reverted delivery commits in `main`.
- The implementation contains the 43 current domain modules and the Management Control Tower.
- The current UI has 15 management routes:
  Today, Goals, Situation, Unknowns, Missions, Risks, Opportunities,
  Capabilities, Processes, Automation, Workforce, Agents, Evidence,
  Recommendations and Approvals.
- `/` redirects to `/today`.
- There is no `/chat` route or employee-facing conversation UI.
- There is no production auth/session implementation under `src/modules/auth/**`.
- Current tower tenant scope is an explicit development seam using query parameters.
- There is no `scripts/worker.ts`, despite the implementation-stack contract describing a long-running cognition worker.
- There is no `vercel.json`, `.vercel/project.json` or GitHub deployment workflow.
- No verifiable `aurum-chat` project/deployment is present in the currently connected Vercel teams.

## Major journey simulation

### A. First-time manager
**Current:** BLOCKED.
Root leads to the tower; there is no auth, workspace onboarding, invitation flow or integration setup.

### B. Talk to the Aurum employee
**Current:** BLOCKED.
Conversation persistence exists, but there is no chat UI, conversation list or composer.

### C. Unprompted unknown discovery
**Current:** PARTIAL.
W051/W052/W053 and Today/Unknowns/Missions exist, but the goal → gap → unknown → mission → evidence chain is not connected by contextual navigation.

### D. Risk/opportunity/process investigation
**Current:** PARTIAL.
The underlying surfaces exist but behave mainly as isolated reports/lists instead of a guided evidence → goal → recommendation journey.

### E. Consequential approval
**Current:** PARTIAL / CONTROL PRIMITIVE WORKS.
Approvals has a real decision form and policy gate, but the manager must leave the conversational/intelligence context.

### F. Employee knowledge contribution
**Current:** BACKEND-CAPABLE, PRODUCT-INVISIBLE.
Contribution/reward/channel primitives exist, but employees have no UX for targeted questions, answers, contribution acknowledgement or reward status.

### G. Connect company systems/channels
**Current:** BLOCKED.
Channel/source/destination modules and adapters exist; there is no connection hub.

### H. BYOA / AI routing
**Current:** BACKEND-CAPABLE, PRODUCT-INVISIBLE.
LLM gateway and hot-swap proof exist; there is no tenant-facing provider console.

### I. Agent lifecycle
**Current:** PARTIAL.
Agent/recruitment/team/evaluation primitives exist; the end-to-end capability-gap → alternatives → proposal → approval → outcome flow is not surfaced.

### J. Marketplace/extensions
**Current:** BLOCKED FROM NORMAL UI.
Runtime, builder and marketplace governance exist; no user/developer marketplace or builder surface exists.

### K. Explainability/audit
**Current:** BACKEND-CAPABLE, PRODUCT-INVISIBLE.
Evidence/audit proof exists; users lack one causal explainability surface.

### L. Developer API/MCP
**Current:** BACKEND-CAPABLE, PRODUCT-INVISIBLE.
API/MCP exist; there is no developer console.

## Product direction locked for this phase

Use two connected modes:

1. **Aurum Chat — primary product**
   - WhatsApp-like conversation list + message thread + composer;
   - Aurum behaves like a persistent organizational employee;
   - findings, evidence, missions, recommendations and approvals render as contextual cards;
   - desktop gets a right-side context drawer;
   - mobile gets full-screen conversation-first navigation.

2. **Management Control Tower — management mode**
   - retain the existing 15 canonical surfaces;
   - transform them into drill-down destinations from chat, Today and context cards.

### ShareNet-dominant visual direction

Use `pectoraux/ShareNet` and the ShareNet Conformance UI as the primary visual/interaction reference. ShareNet should define most of Aurum's visual language.

Adopt its warm off-white canvas, soft graphite typography, restrained neutral palette, subtle teal/green semantic accents, generous whitespace, slim desktop navigation, mobile header + bottom navigation, clear active-state treatment, subtle borders/status pills, progressive disclosure, calm loading/empty/error states, restrained motion and accessible focus treatment.

Do **not** make gold/amber the dominant Aurum palette. Aurum branding stays subtle and secondary to the ShareNet-inspired visual system.

Keep Aurum's WhatsApp-like conversation density, message behavior and employee semantics, but let the visual language predominantly feel like ShareNet. Do not copy ShareNet's product semantics or information architecture.

## Worker orchestration

Maximum 3 concurrent workers.

Canonical waves are in `spec/PRODUCT-SURFACE-DEPLOYMENT-PLAN.md`:

- Wave 1: W057 / W058 / W069
- Wave 2: W060 / W059 / W066
- Wave 3: W061 / W062 / W063
- Wave 4: W064 / W065 / W067
- Wave 5: W068 / W070 + Tech Lead integration/reconciliation

Every worker must:
1. inspect the live repo first;
2. verify dependencies directly;
3. read the architecture lock and its bounded work item;
4. avoid redefining frozen domain architecture;
5. add/update tests;
6. run typecheck, test, architecture gate and lint;
7. run the relevant browser journey proof;
8. report exact commit and reproducible evidence.

## Free-tier dogfood deployment target

The repo is **not currently verified as deployed** to the connected Vercel account.

Target stack:

- **Vercel Hobby** — Next.js web/API, preview CI/CD and initial dogfood hosting.
- **Neon Free** — authoritative PostgreSQL.
- **Upstash Redis Free** — cache/locks/short-lived queue state only.
- **Vercel Workflows** — durable cognition orchestration.
- **Vercel Queues** — durable async delivery where queue semantics are actually needed.
- **Vercel Blob Hobby** — large evidence/document/extension artifacts.
- **Resend Free** — transactional email/invitations.
- **GitHub Actions** — CI and browser conformance.

The implementation must remain provider-neutral. Production domain state remains PostgreSQL; Redis/Queues/Workflows are execution infrastructure, never organizational truth.

## Critical runtime seam

The architecture references `scripts/worker.ts`, but that file is absent.

The deployment phase must replace that missing process with a repository-owned durable execution adapter using Vercel Workflows/Queues without changing the W013 CognitionExecution contract.

Proof required:
- resume after interruption;
- bounded stage processing;
- persisted progress;
- retry;
- duplicate-delivery idempotency;
- approval/input suspension and resume;
- audit/correlation preserved;
- no infrastructure component becomes business truth.

## Final acceptance

Aurum is not considered product-complete merely because W001-W056 are implemented.

The next release gate is:

```
W001-W056 domain intelligence
        +
W057-W070 employee-first product surface
        +
authenticated tenant UX
        +
durable hosted execution
        +
browser journey/accessibility proof
        +
deployment/operations proof
        =
handoff-ready Aurum
```

Final acceptance must prove every major architectural capability is discoverable through the product or intentionally exposed through API/MCP; no major journey is a dead end; policy, tenant, provider and human-approval invariants remain intact.

## Tracking

Primary handoff issue: GitHub issue #67 — “Tech Lead Handoff — Aurum Chat UX, Discoverability, Auth & Free-Tier Deployment”.
