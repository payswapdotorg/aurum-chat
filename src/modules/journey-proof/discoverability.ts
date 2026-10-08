// The capability discoverability map (W070) — the proof material for
// "every architecture capability has a discoverable user route".
//
// Every module under src/modules (the frozen module map of
// MODULE-DEPENDENCY-MAP.md, plus the platform/harness modules this phase
// added) is mapped to the user-facing routes that expose it, and to the
// discovery surfaces a user reaches those routes from. The execution
// suite verifies, per entry:
//
//   1. the module folder exists (the architecture capability is real);
//   2. every mapped route exists in the route catalog;
//   3. every mapped route is discoverable through a REAL surface of this
//      base (rendered hub pages, the navigation registries, the command
//      search registry, the auth/public entries).
//
// Notes on honest mappings:
//   * platform-level modules (audit, events…) surface through governance
//     views rather than dedicated pages — their mapped routes are where
//     a user actually encounters the capability;
//   * the demo and journey-proof modules are VERIFICATION harnesses, not
//     product capabilities; they map to the surfaces that exercise them
//     and are marked 'platform' layer with an explicit note.

import type { CapabilityRoute } from './types';

/** The capability map, in frozen module-map layer order. */
export const CAPABILITY_ROUTES: readonly CapabilityRoute[] = [
  // --- L0 Foundation -------------------------------------------------------
  {
    module: 'auth',
    label: 'Authentication, sessions & tenant onboarding',
    layer: 'L0',
    routes: ['/signin', '/signup', '/onboarding', '/invite/:code'],
    surfaces: ['auth-entry', 'hub-link', 'command-search'],
    instrument: false,
    note: 'the unauthenticated entry flow itself; company/invitation management also lives on /onboarding',
  },
  {
    module: 'organizations',
    label: 'Tenants, workspaces & membership',
    layer: 'L0',
    routes: ['/onboarding'],
    surfaces: ['auth-entry', 'hub-link'],
    instrument: false,
    note: 'company creation/selection and the invite roster; the shell switcher reads it on every page',
  },
  {
    module: 'identity',
    label: 'Identity resolution & verification',
    layer: 'L0',
    routes: ['/connections'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'external identities are linked/verified in the connection hub’s identity mapping section',
  },
  {
    module: 'audit',
    label: 'Append-only audit trail',
    layer: 'L0',
    routes: ['/explain', '/developer'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'audit evidence surfaces through the explainability view and the developer console’s activity feed',
  },
  {
    module: 'events',
    label: 'The event envelope (correlation/causation)',
    layer: 'L0',
    routes: ['/developer'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'integration activity (the event feed) is the user-visible half of the envelope',
  },
  // --- L1 Reality / Evidence ------------------------------------------------
  {
    module: 'people',
    label: 'People & employees',
    layer: 'L1',
    routes: ['/people', '/connections'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search'],
    instrument: false,
    note: 'the People hub and the identity mapping of the connection hub',
  },
  {
    module: 'world',
    label: 'The world model (entities & relationships)',
    layer: 'L1',
    routes: ['/situation'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'the Situation surface renders the entity/relationship state of the company',
  },
  {
    module: 'observations',
    label: 'Immutable observations',
    layer: 'L1',
    routes: ['/evidence', '/explain'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'the Evidence surface lists them; the explainability view reconstructs decisions from them',
  },
  {
    module: 'sources',
    label: 'Source systems (BYO data)',
    layer: 'L1',
    routes: ['/connections'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the connection hub’s sources family (health, freshness, checkpoints)',
  },
  {
    module: 'destinations',
    label: 'Destinations (delivery targets)',
    layer: 'L1',
    routes: ['/connections'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the connection hub’s destinations family (delivery state)',
  },
  {
    module: 'integration-intelligence',
    label: 'Tool & System Inventory, connection recommendations & verification',
    layer: 'L1',
    routes: ['/connections'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the connection hub’s integration family (discovered systems, ranked read-only recommendations, verification state); the dedicated outcome-oriented UX arrives with the post-S002 waves (W091/W096)',
  },
  {
    module: 'connection-broker',
    label: 'Universal connections (OAuth, tokens, syncs, webhooks)',
    layer: 'L1',
    routes: ['/connections'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the connection hub’s broker-managed family (connect/revoke/refresh state, sync/webhook checkpoints, provider health) behind pluggable managed brokers (W082)',
  },
  {
    module: 'memory',
    label: 'Knowledge entries & transactive memory',
    layer: 'L1',
    routes: ['/learning', '/explain'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'contributed knowledge surfaces in the learning journey and the evidence views',
  },
  {
    module: 'freshness',
    label: 'Freshness policies & temporal revisions',
    layer: 'L1',
    routes: ['/explain', '/evidence'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'source reliability/freshness renders in the causal evidence view',
  },
  // --- L2 Epistemics / Direction ---------------------------------------------
  {
    module: 'epistemics',
    label: 'Claims, beliefs, unknowns & contradictions',
    layer: 'L2',
    routes: ['/intelligence', '/unknowns', '/intelligence/unknowns/:unknownId'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search', 'hub-link', 'chat-card'],
    instrument: false,
    note: 'the Intelligence workflow and the Unknowns surface; chat cards deep-link unknowns',
  },
  {
    module: 'goals',
    label: 'Business goals & desired states',
    layer: 'L2',
    routes: ['/intelligence', '/goals', '/intelligence/goals/:goalId'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search', 'hub-link', 'chat-card'],
    instrument: false,
    note: 'the goal chain is the Intelligence workflow’s entry step',
  },
  {
    module: 'attention',
    label: 'Goal-gap discovery',
    layer: 'L2',
    routes: ['/intelligence', '/today'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search', 'drill-down'],
    instrument: false,
    note: 'discovery findings land in the proactive briefing and Today',
  },
  {
    module: 'investigation',
    label: 'Investigations',
    layer: 'L2',
    routes: ['/explain'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'investigation spines are reconstructed in the explainability view',
  },
  {
    module: 'missions',
    label: 'Learning missions',
    layer: 'L2',
    routes: ['/intelligence', '/missions', '/intelligence/missions/:missionId', '/learning'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search', 'hub-link', 'chat-card'],
    instrument: false,
    note: 'the mission chain step and the learning surface’s mission views',
  },
  {
    module: 'knowledge-acquisition',
    label: 'Knowledge acquisition planning',
    layer: 'L2',
    routes: ['/learning', '/intelligence/missions/:missionId'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'acquisition trails (ask-person/source) render in the mission learning view',
  },
  {
    module: 'cognition',
    label: 'The canonical cognition loop',
    layer: 'L2',
    routes: ['/explain', '/today', '/chat'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search', 'hub-link'],
    instrument: false,
    note: 'executions are reconstructable in the explainability view; chat turns run the loop',
  },
  // --- L3 Organizational Intelligence ----------------------------------------
  {
    module: 'environment',
    label: 'Environment watch',
    layer: 'L3',
    routes: ['/situation', '/opportunities'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'watched external change flows into Situation and Opportunities',
  },
  {
    module: 'opportunities',
    label: 'Opportunities',
    layer: 'L3',
    routes: ['/opportunities', '/intelligence'],
    surfaces: ['hub-link', 'command-search', 'chat-card'],
    instrument: false,
    note: 'the Opportunities surface and the briefing’s proactive findings',
  },
  {
    module: 'presence',
    label: 'Presence & availability',
    layer: 'L3',
    routes: ['/today'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search'],
    instrument: false,
    note: 'presence state feeds the attention surfaces',
  },
  {
    module: 'processes',
    label: 'Process reconstruction & findings',
    layer: 'L3',
    routes: ['/processes'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'the Processes surface (effort and duplication findings)',
  },
  {
    module: 'capabilities',
    label: 'Capability supply & requirement',
    layer: 'L3',
    routes: ['/capabilities', '/interventions'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'the Capabilities surface; the interventions home shows the gaps',
  },
  {
    module: 'automation',
    label: 'Automation opportunities',
    layer: 'L3',
    routes: ['/automation'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'the Automation surface',
  },
  {
    module: 'workforce',
    label: 'Workforce intelligence',
    layer: 'L3',
    routes: ['/workforce', '/people'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the Workforce surface and the People hub',
  },
  {
    module: 'suppliers',
    label: 'Suppliers & vendor scoring',
    layer: 'L3',
    routes: ['/workforce', '/interventions'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'supply-side intelligence supports the workforce/intervention views',
  },
  // --- L4 Capability Workforce ------------------------------------------------
  {
    module: 'actions',
    label: 'The authority matrix & approvals',
    layer: 'L4',
    routes: ['/approvals', '/recommendations'],
    surfaces: ['hub-link', 'command-search', 'chat-card'],
    instrument: false,
    note: 'the human authority gate; chat cards deep-link approvals and the chat decides them inline',
  },
  {
    module: 'agents',
    label: 'Agents & agent teams',
    layer: 'L4',
    routes: ['/agents', '/interventions', '/interventions/agents/:agentId', '/interventions/teams/:teamId'],
    surfaces: ['hub-link', 'command-search', 'drill-down'],
    instrument: false,
    note: 'the Agents surface and the interventions lifecycle (retain/modify/terminate)',
  },
  {
    module: 'extensions',
    label: 'Extensions & their lifecycle',
    layer: 'L4',
    routes: ['/marketplace/installed', '/marketplace/installed/:extensionKey'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the installed-packages governance surface',
  },
  {
    module: 'marketplace',
    label: 'The governed package marketplace',
    layer: 'L4',
    routes: ['/marketplace', '/marketplace/package/:packageId', '/marketplace/developer'],
    surfaces: ['desktop-rail', 'command-search', 'public-entry', 'hub-link'],
    instrument: false,
    note: 'the public catalog, package detail and the developer console',
  },
  {
    module: 'agent-recruitment',
    label: 'Agent recruitment proposals',
    layer: 'L4',
    routes: ['/interventions', '/interventions/proposals/:proposalId'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'the recruitment journey lives in the interventions surface',
  },
  {
    module: 'agent-evaluation',
    label: 'Agent evaluation',
    layer: 'L4',
    routes: ['/interventions/agents/:agentId'],
    surfaces: ['drill-down'],
    instrument: false,
    note: 'evaluation rows render on the agent detail page',
  },
  {
    module: 'agent-teams',
    label: 'Agent teams & their outcomes',
    layer: 'L4',
    routes: ['/interventions/teams/:teamId', '/interventions'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'team topology, budget and outcomes render in the interventions surface',
  },
  // --- L5 Learning / Incentives -----------------------------------------------
  {
    module: 'learning',
    label: 'Company learning & outcomes',
    layer: 'L5',
    routes: ['/learning', '/intelligence'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'the learning surface (knowledge requests, company model state)',
  },
  {
    module: 'rewards',
    label: 'Contribution rewards',
    layer: 'L5',
    routes: ['/learning'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'reward status/history renders in the learning surface',
  },
  {
    module: 'contributions',
    label: 'Knowledge contributions',
    layer: 'L5',
    routes: ['/learning'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'contribution acknowledgement renders in the learning surface',
  },
  {
    module: 'outcomes',
    label: 'Intervention outcome learning',
    layer: 'L5',
    routes: ['/interventions', '/interventions/proposals/:proposalId'],
    surfaces: ['command-search', 'drill-down'],
    instrument: false,
    note: 'outcome tracking and learning render in the interventions surface',
  },
  // --- L6 Human Experience -----------------------------------------------------
  {
    module: 'conversations',
    label: 'Conversations (the chat channel)',
    layer: 'L6',
    routes: ['/chat'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search'],
    instrument: false,
    note: 'the conversation-first product surface',
  },
  {
    module: 'channels',
    label: 'Channel providers (WhatsApp, Slack…)',
    layer: 'L6',
    routes: ['/connections'],
    surfaces: ['desktop-rail', 'command-search', 'hub-link'],
    instrument: false,
    note: 'the connection hub’s channels family',
  },
  {
    module: 'notifications',
    label: 'Notification policies & delivery',
    layer: 'L6',
    routes: ['/chat', '/today'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search'],
    instrument: false,
    note: 'the global notification entry (bell) and the attention surfaces',
  },
  {
    module: 'briefings',
    label: 'Derived management briefings',
    layer: 'L6',
    routes: ['/intelligence', '/today'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search'],
    instrument: false,
    note: 'the proactive briefing (deliverable into chat)',
  },
  // --- L7 External Product Surfaces --------------------------------------------
  {
    module: 'llm',
    label: 'The LLM gateway & BYOA accounts',
    layer: 'L7',
    routes: ['/ai'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'the AI providers surface (accounts, routing, availability, cost, hot-swap)',
  },
  {
    module: 'provider-sdk',
    label: 'The provider adapter SDK & OSS technology registry',
    layer: 'L7',
    routes: ['/ai'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'the adapter SDK standard (lifecycle, conformance, hot-swap evidence) and the OSS technology registry behind the /ai provider surface; the registry review CLI is the Tech Lead surface (W089)',
  },
  {
    module: 'api',
    label: 'The public API (keys, scopes, webhooks)',
    layer: 'L7',
    routes: ['/developer', '/api/v1/*'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'the developer console; the bearer-authenticated public API itself',
  },
  {
    module: 'mcp',
    label: 'The MCP server',
    layer: 'L7',
    routes: ['/developer'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'the developer console’s MCP connection guide and tool catalog',
  },
  // --- Platform / harness & instrument modules (this phase) --------------------
  {
    module: 'quality',
    label: 'Aurum quality measurement (W055)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'a measurement instrument by design (W055: “metrics … do not become business truth”) — versioned, auditable metrics computed from the domain contracts; its exercise is the longitudinal benchmark suite (tests/longitudinal), not a product surface',
  },
  {
    module: 'simulator',
    label: 'The longitudinal company simulator (W056)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'the synthetic-company benchmark instrument (W056, LONGITUDINAL-BENCHMARK.md) — hidden ground truth may never leak into product surfaces, so it is exercised only by the benchmark suite',
  },
  {
    module: 'demo',
    label: 'The deterministic demo harness (W068)',
    layer: 'platform',
    routes: ['/signin'],
    surfaces: ['auth-entry'],
    instrument: true,
    note: 'a verification harness, not a product capability: its personas sign in through the real auth flow',
  },
  {
    module: 'journey-proof',
    label: 'The journey/accessibility/discoverability proof (W070)',
    layer: 'platform',
    routes: ['/chat'],
    surfaces: ['desktop-rail', 'mobile-nav', 'command-search'],
    instrument: true,
    note: 'this module — a verification harness over the real surface code, exercised by tests/e2e/journeys',
  },
  {
    module: 'deployment-smoke',
    label: 'The post-deployment smoke and operations proof (W078)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'a verification harness, not a product capability: it proves the HOSTED deployment over real HTTP (bun run smoke:dogfood) and owns no user-facing route',
  },
  {
    module: 'release-certification',
    label: 'The production journey certification and release gate (W079)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'a verification harness, not a product capability: it certifies the J01–J15 journey matrix against the hosted production deployment (two-run same-revision rule) and owns no user-facing route',
  },
  {
    module: 'workflow',
    label: 'The durable agent runtime (W080)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the Aurum-owned durable orchestration port (W080 — event triggers, schedules, waits, retries, human approvals, resumptions, idempotency, cancellation, long-running cognition) behind which orchestration providers sit; it owns no user-facing route and is exercised by its own vitest suite',
  },
  {
    module: 'execution',
    label: 'The execution platform contract surface (W131)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the W131 frozen contract vocabulary for interchangeable execution environments, durable task workers, browser/computer sessions, the shared client/runtime surface and cross-device continuity (types only — no service, no tables, no routes; environments are adapters, never authorities); W137/W139 build against it and it is exercised by its own vitest suite',
  },
  {
    module: 'meetings',
    label: 'The meeting intelligence gateway (W085)',
    layer: 'platform',
    routes: ['/meetings', '/meetings/:meetingId'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'W104 gave the capture gateway its user-visible path: the read-only meetings surface (/meetings + one meeting) composes the registry reads (meetings, sessions, participants, transcripts, artifacts, connections, access events), and the v1 public API mirrors the same contract reads under the meetings:read scope family (GET /api/v1/meetings…). The realtime companion UX (W086) builds on the same contract.',
  },
  {
    module: 'company-query',
    label: 'The company query plane (W126)',
    layer: 'platform',
    routes: ['/company'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'W126 gave the provider-independent query plane its user-visible path: the /company surface (the query box, claim-level provenance chips, the coverage-context panel with material blind spots, contradictions and unknowns) and the capability-shaped product API (POST /api/product/company/query) compose the world/epistemics/memory/observations/sources/channels/freshness/goals contracts; the optional LLM paragraph is presentation only and never authoritative.',
  },
  {
    module: 'realtime',
    label: 'The realtime voice and meeting companion gateway (W086)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the provider-neutral realtime session contracts (W086 — Aurum voice, two-way meeting participation, the Meeting Companion and telephony/SIP over a replaceable LiveKit transport adapter) that own consent/recording state, speaker attribution, the live transcript, spoken Aurum responses and the durable meeting artifact; it owns no user-facing route yet — the companion UX arrives with the meeting E2E journeys (W097) — and is exercised by its own vitest suite',
  },
  {
    module: 'agent-supervision',
    label: 'Persistent agent supervision and recovery (W098)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the supervision layer of the agent workforce (W098 — durable agent health, review schedules, budgets, waiting states, supervisor sessions, recovery and resumptions independent of worker lifetime) composed over the agents/agent-teams/agent-evaluation contracts; it owns no user-facing route yet — the supervision surface arrives with the management control surfaces — and is exercised by its own vitest suite',
  },
  {
    module: 'cellular',
    label: 'Cellular reachability and communication fallback (W087)',
    layer: 'platform',
    routes: ['/cellular', '/cellular/reach/:reachId'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'W104 gave the Reach Anyone gateway its user-visible path: the read-only cellular surface (/cellular + one reach request with its append-only attempt audit and replies), and the v1 public API mirrors the connection-management and reach-state reads under the cellular:read/cellular:write scope family (GET/POST /api/v1/cellular…). No transport is wired by default — deliveries surface the module-reported retryable provider_unavailable state, never a faked send; the outbound ask UX arrives with the conversation-side reach flows.',
  },
  {
    module: 'provider-billing',
    label: 'The Aurum provider billing gateway (W090)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the provider billing gateway (W090 — provider payment/usage/budgets/receipts abstracted behind Aurum; Aurum-mediated settlement with auditable receipts when terms permit; direct customer billing as the explicit fallback) composed over the actions/llm/workflow/provider-sdk contracts; it owns no user-facing route yet — the billing surface arrives with the user-friendly provider choice UX (W091) — and is exercised by its own vitest suite',
  },
  {
    module: 'capability-grants',
    label: 'The progressive capability grants gateway (W083)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the progressive authority layer over connected systems (W083 — the safe read-only start per broker connection, per-task write/action authority asked through the actions module\'s W009 gate with a human-readable reason and the exact missing scope, denials that stop the write, and visible, scoped, auditable, revocable grants) composed over the actions/integration-intelligence/connection-broker contracts; it owns no user-facing route yet — the grant and approval surface arrives with the integration journeys (W084/W096) — and is exercised by its own vitest suite',
  },
  {
    module: 'deep-actions',
    label: 'The deep action gateway and reconciliation (W084)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the deep action gateway (W084 — the discover→inspect→propose→authorize→execute→verify→reconcile pipeline that carries a multi-system task out of Aurum across external systems with evidence and outcome links, action-receipt and downstream-state verification, and reconciliation that detects mismatches and creates attention/evidence behind a provider-neutral transport port) composed over the actions/capability-grants/connection-broker/integration-intelligence/observations/epistemics/workflow contracts; it owns no user-facing route yet — the deep-action surface arrives with the integration E2E journeys (W096) — and is exercised by its own vitest suite',
  },
  {
    module: 'unified-identity',
    label: 'Unified cross-channel, meeting and telephony identity verification (W095)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the cross-modality identity-proof layer (W095 — one person stays one organizational identity across messaging, meetings, SMS, voice, realtime and Edge Connector paths) composed over the identity/people/meetings/realtime contracts: the modality-scoped identity registry for the paths beyond the identity module’s channel-provider vocabulary, the ambiguity ledger that keeps ambiguous matches external/unverified instead of auto-merging them, the unified resolution/profile surface, and the meetings/realtime participant unification passes; it owns no user-facing route yet — the identity-mapping UX it strengthens lives in the connection hub — and is exercised by its own vitest suite',
  },
  {
    module: 'vertical-kits',
    label: 'Vertical extension starter kits (W092)',
    layer: 'platform',
    routes: ['/marketplace', '/marketplace/kit/:kitKey', '/marketplace/installed'],
    surfaces: ['command-search', 'hub-link', 'drill-down', 'public-entry'],
    instrument: false,
    note: 'the vertical starter-kit layer (W092 — reusable specialist extension/agent starter kits and first deep integrations for system-of-record-heavy industries) with its user-visible marketplace path (W105, Journey J22): the two signed starter kits (legal case management, accounting ledger ERP) surface in the catalog\u2019s kits section (public browsing included) and drill into the kit detail page — the signed manifest digest, the deterministic verification posture plus the recorded runs, the required-capability inspection, the starter components (honestly \u2018defined\u2019, never claimed as deployed software), the vertical data-schema hints, the DEFERRED-ON-W088 integration readiness and the invocation ledger — while the installed view carries the tenant\u2019s kit installations with their own lifecycle states (register → verify → install → the W009 grant review → granted → active ⇄ suspended → removed; approval mints exactly the declared kit-scoped capability grants, removal revokes every one). Installs ride the module\u2019s OWN lifecycle — never the extension package flow — and core stays industry-independent: everything vertical lives inside the kits\u2019 versioned, digest-signed manifests',
  },
  {
    module: 'provider-preferences',
    label: 'User-friendly provider choice UX (W091)',
    layer: 'L7',
    routes: ['/ai/preferences', '/ai/preferences/advanced'],
    surfaces: ['hub-link', 'command-search'],
    instrument: false,
    note: 'the outcome-oriented provider-choice experience: what matters when Aurum uses AI (cost, privacy, quality, speed or organizational policy) — the member and company preferences, the plain-words “why this option?” records, and the authorization-gated advanced settings where technical identity and reversible provider pins live (W091)',
  },
  {
    module: 'edge-connector',
    label: 'The Aurum Edge Connector (W088)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the customer-controlled edge runtime boundary (W088 — a tenant-scoped, outbound-only connector that executes signed tenant-scoped job envelopes against private/on-prem APIs, MCP/OpenAPI services, databases, file shares and approved browser adapters, with local secret handling, a twice-checked capability allowlist, heartbeat health/version reporting, and results normalized onto the W084 deep-action transport shapes) composed over the deep-actions contract (its transport port) with the W082 credentialRef discipline passing straight through; it owns no user-facing route yet — the edge-management surface arrives with the integration E2E journeys (W096) — and is exercised by its own vitest suite plus the tenant-isolation sweep',
  },
  {
    module: 'computer-use',
    label: 'The browser and computer-use fallback (W093)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the governed last-resort browser executor (W093 — used only where APIs/MCP/native adapters are insufficient) composed over the deep-actions contract (the W084 reconciliation re-used verbatim for observed-state verification, evidence and attention — no second evidence model) with the W082 opaque-credentialRef discipline sharpened per task (browser profiles and credential stores are per tenant AND per task, materialized only inside the isolated session), a frozen step allowlist (URL/domain globs + permitted verbs, checked at creation, at dispatch and driver-side) and a step budget, disposable resumable sessions checkpointed on verified steps, and per-step screenshot/action-trace evidence; it owns no user-facing route yet — the fallback surface arrives with the integration E2E journeys (W096) — and is exercised by its own vitest suite plus the tenant-isolation sweep',
  },
  {
    module: 'migration',
    label: 'Migration and dual-run continuity (W094)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not a product capability: the migration and dual-run continuity layer (W094 — import history, preserve identifiers, synchronize during migration, compare legacy/Aurum results, support rollback and progressive retirement) composed over the integration-intelligence/connection-broker/deep-actions/vertical-kits contracts: the staged import rounds (snapshot → transform → staged → review → commit, every imported record an evidence-shaped row with full provenance and storage-level payload immutability), the external↔Aurum identifier map per source system with explicit cross-system-collision and ambiguous-match conflict records that are never auto-merged, the dual-run delta rounds and structured comparison reports that surface divergences using the W084 reconciliation semantics (never a second action pipeline — the module holds no write path to the incumbent), commit-time verification reads that compose the W084 DeepActionTransport port (edge-backed for private/on-prem incumbents through the edge-connector), sequestration rollback that quarantines without deleting, and the evidence-linked retirement checkpoints (dual-running → compare-clean → incumbent-read-only → incumbent-retired); it owns no user-facing route yet — the migration surface arrives with the customer-journey work — and is exercised by its own vitest suite plus the tenant-isolation sweep',
  },
  {
    module: 'coverage',
    label: 'Company coverage registry and measurement (W124/W125)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the provider-neutral, tenant-scoped coverage vocabulary and the DELIVERED (W125) derived measurement registry — CoverageSurface/CoverageSource/CoverageClaim/CoverageGap/CoverageSnapshot semantics per the approved company-coverage architecture, ten contract operations over five tenant-scoped append-only tables with a 55-test suite — that lets Aurum state what portion of the company it can see, how reliable that visibility is, what is missing and whether the missing visibility matters to current goals; coverage is a DERIVED view over existing state, never a second organizational truth store, and never carries credentials; the product surface arrives with W126 (/company) — until then the module is exercised as an instrument by its own vitest suite plus the tenant-isolation sweep (upgraded to a real two-tenant service proof at W125 integration)',
  },
  {
    module: 'provider-fabric',
    label: 'Provider fabric and user-selectable models (W124b/W132)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the canonical ProviderDefinition/ModelCatalogEntry/ModelDiscoveryState/ModelBinding/ProviderHealthState vocabulary (W124b TL-frozen, W132 implements) that lets users add providers — including custom providers over an existing supported wire protocol — discover or manually register models, and select/swap models without replacing the Aurum Agent Body; the fabric feeds the W034 LLM Gateway (which remains the only owner of provider/model execution and routing) and never carries credentials; the product surface extends /ai with W132; exercised by the provider-fabric module vitest suite plus the tenant-isolation sweep',
  },
  {
    module: 'context',
    label: 'Context fingerprints for conditioned strategy and organization (W124b/W134)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the ContextFingerprint vocabulary (W124b TL-frozen, W134 implements derivation) — season/time window, duration, staffing, staff experience, workload, capability availability, environment, budget/SLA/quality/risk/verification constraints and evidence-freshness expectations — that conditions information strategy (W134) and organizational selection (W135) on the CURRENT context rather than hardcoded industry rules; the product surface arrives with the W134 intelligence/learning view; exercised by the context module vitest suite plus the tenant-isolation sweep (upgraded to a real two-tenant service proof at WB2 integration)',
  },
  {
    module: 'agent-body',
    label: 'The persistent Aurum Agent Body and its model bindings (W133)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the persistent, model-agnostic side of the AGENT-BODY-LAB separation (W133) — role + five §1 policy descriptors (communication, information acquisition, company-context access, memory, escalation), permitted capabilities and opaque evidence/learning hooks on one side; append-only model-binding attachments (opaque fabric binding ids, verbatim policy checks, one-active-per-purpose, the swap path that never touches the body row) on the other. The body never invokes models (the W034 LLM Gateway stays the execution authority); composed journeys (W135/W136/W139) resolve the bindings at the composition boundary (WB2 wires the fresh-attachment existence check against the W132 fabric operational API); the management UX arrives with the W136 agent exchange; exercised by the agent-body module vitest suite plus the tenant-isolation sweep (registered at WB2 integration)',
  },
  {
    module: 'info-strategy',
    label: 'Goal/context-conditioned information strategy (W134)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: what to know, source choice, freshness/confidence targets, acquisition cost ceilings and escalation thresholds — recorded per (tenant, goal, context fingerprint) as versioned, immutable strategy documents whose learning loop (adjustStrategy) consumes outcome evidence, with THE CONTEXTUAL RULE forbidding any hardcoded per-industry/per-task strategy (content is always caller-supplied). References stay canonical: epistemics Unknowns, goals and coverage registries through their owning contracts; preferred sources and outcome evidence stay opaque by design; the product surface arrives with the intelligence/learning view; exercised by the info-strategy module vitest suite plus the tenant-isolation sweep (registered at WB2 integration)',
  },
  {
    module: 'org-lab',
    label: 'The Contextual Organizational Lab (W135)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the contextual organizational selection layer (W135) — the candidate registry (§4 compositions + §5 comparison sets with declared contextual applicability), the MECHANICAL contextually-conditioned search (twelve-axis fit report over a real W134 fingerprint; the same candidates under materially different contexts may rank a different candidate first — THE CONTEXTUAL RULE, divergence is data never code) and the §11 evidence object (recommendations retaining EVERY evaluated candidate incl. rejected ones with reasons, model-occupancy snapshots through the W133/W132 seams, outcome-calibration that modulates the live search). The Lab RECOMMENDS — nothing on this surface installs, recruits, executes or grants (W136/W137 own the follow-through, W141 the certification); exercised by the org-lab module vitest suite plus the tenant-isolation sweep (registered at WB2 integration)',
  },
  {
    module: 'agent-exchange',
    label: 'Agent exchange, execution plans and the cross-agent relay (W136)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the durable ORCHESTRATION PROJECTION (W136) linking goal → tasks → agent organization → handoffs → approvals → execution runs → results/outcomes — the execution plan spine (one atomic append per plan: the W008 goal link with version pin, the optional W134 fingerprint/strategy + W135 recommendation + W023 team conditioning links, the 1..64-task acyclic decomposition and the governed member references — agent-body refs readable+active (W133), tenant-agent refs readable+active (W021), marketplace package refs visible+INSTALLABLE (W028), recruitment provenance APPROVED (W022); tasks and members immutable from creation), the one-way active → completed | abandoned lifecycle, the append-only cross-agent relay handoffs carrying only the STRUCTURALLY MINIMAL context package (at most one goal-matched fingerprint reference + explicit evidence refs — acceptance law 2), the governed approvals freezing the W009 authority decision VERBATIM (the exchange records, never decides — a pending request refuses), and the append-only execution runs freezing the W021 execution\'s normalized status/result/cost VERBATIM (progress from a live execution, the result from a terminal one — acceptance law 3) with optional OPEN W040 outcome commitments. NO SECOND EXECUTION AUTHORITY (acceptance law 4, structural): nothing on this surface submits, dispatches, retries, cancels, installs, recruits or decides — the agents module stays the one execution authority, W137 owns execution environments, W138/W139/W140 compose the product surfaces and W141 certifies the end-to-end journey; exercised by the agent-exchange module vitest suite plus the tenant-isolation sweep (registered at W136 integration)',
  },
  {
    module: 'execution-fabric',
    label: 'Execution environments and the agent computer fabric (W137)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the execution ENVIRONMENT fabric (W137) — the vendor-neutral registry of immutable environment definitions (the frozen W131 kind + isolation + persistence shapes + required capability domains; a changed definition is a NEW definition under a NEW key, the one-way active → retired close), the lease state machine binding ONE definition to ONE W136 execution run (acquisition gated on the plan being readable and ACTIVE and the run recorded on it, all on the base connection before the mutation; the single legality definition in validation.ts mirrored by the storage guard; FOR-UPDATE staleness re-checks under the row lock) with prepare/takeover/handback/heartbeat/lost/recover/cancel/release/fail, and the append-only evidence tails (events, artifact handoffs by OPAQUE reference + digest, captured evidence with redaction applied by law, durable checkpoints with opaque cursors so replay never re-executes covered work). The three evaluated catalog paths — local container (deterministic simulation), browser (the W093/W110 BrowserDriver port), remote sandbox (E2B-equivalent behind an injectable transport) — sit behind the frozen adapter SPI; adapter wiring is in-memory registry state, never domain state, and VENDOR REMOVAL changes no domain contract (reads keep serving, prepare/recover refuse adapter_not_registered). NO SECOND EXECUTION AUTHORITY (structural): the fabric never drives a browser step plan (computer-use owns governed automation — the browser adapter only composes its driver port) and never decides an approval (the takeover\'s authorityActionRef is an opaque W009 reference, never a decision); W139/W140 compose the product surfaces and W141 certifies; exercised by the execution-fabric module vitest suite plus the tenant-isolation sweep (registered at Wave C integration)',
  },
  {
    module: 'emergent-roles',
    label: 'Emergent roles and marketplace publication (W138)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the EVIDENCE-BACKED EMERGENCE PROJECTION (W138) — the recurring-gap evidence aggregation (append-only gap records citing a REAL settled-MISSED W040 outcome, a REAL NEGATIVELY-calibrated W135 recommendation or a REAL FAILED W136 execution run through their owning contracts, one upstream record = one gap by partial unique index), the evidence-backed RoleProposal (tenant-unique slug, 2..16 DISTINCT gap citations as the recurrence floor, 1..16 typed W017 capability demands with [0,1] proficiency semantics, 1..8 alternatives each with its retained evaluation — nothing is ever discarded — and the structured rationale/whyNow/gapRecurrence evaluation; content immutable from creation), the one-way draft → under_review → approved | rejected | withdrawn → fulfilled lifecycle with the W009 authority system deciding and the module recording the frozen decision snapshot VERBATIM (a pending request refuses; one review per proposal, ever), the marketplace submission REQUEST linking an APPROVED proposal to a REAL W028 AgentPackage with identity/state FROZEN at record time (the governed publish chain belongs entirely to the marketplace and the platform — this module never advances a package state), and the activation RECORD citing a REAL APPROVED W022 acquisition. THE LAB AUTHORITY SEPARATION (structural, enforced twice — typed errors + storage triggers): the principal that recorded an org-lab-sourced proposal is REFUSED as the recorder of its submission (lab_cannot_self_publish) and its activation (lab_cannot_self_activate); W140 composes the closed-loop surface and W141 certifies; exercised by the emergent-roles module vitest suite plus the tenant-isolation sweep (registered at Wave C integration)',
  },
  {
    module: 'cross-platform',
    label: 'Cross-platform sessions, projections and device handoff (W139)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the CROSS-PLATFORM SEMANTIC CORE (W139) — the SEMANTIC CORE all three client kinds consume (web CANONICAL, desktop Tauri 2 the POWER client, mobile Expo/RN the FIELD client — vendor identity is METADATA only): the server-issued client-session registry (append-and-revoke only; identity columns frozen by storage trigger, a revoked session is retained evidence), the CLIENT-AGNOSTIC authoritative state projections (conversation state and company overview bound to content-addressed revision + digest refs RECOMPUTABLE by any client kind from the served projection alone), the background-work inspection feed (identical typed items for every client kind over the missions W011 / agent-exchange runs W136 / execution-fabric leases W137 seams, normalized phases + verbatim seam statuses), the platform-native capability ADAPTERS behind the frozen SPI (in-memory wiring, never domain state — vendor removal changes no domain contract), and the cross-device handoff spine with its APPEND-ONLY evidence trail (the working context frozen at open, moved VERBATIM between devices, resumption restores it EXACTLY while re-projecting from CURRENT server state — a stale client revision is discarded and the discard recorded, resolution server-state-wins; one-way closes; storage triggers reject any context mutation). NO SECOND STATE AUTHORITY (structural): the module persists only client sessions and handoff evidence — every state read is a live projection over the owning seams (conversations W029, goals W008, missions W011, agent-exchange W136, execution-fabric W137, notifications, organizations) and no operation here mints domain truth; the W057-shaped shell read model stays contract-level only (the web app remains the canonical renderer); W140 composes the closed-loop surface and W141 certifies; exercised by the cross-platform module vitest suite plus the tenant-isolation sweep (registered at Wave D integration)',
  },
  {
    module: 'closed-loop',
    label: 'The unified closed-loop learning record (W140)',
    layer: 'platform',
    routes: [],
    surfaces: [],
    instrument: true,
    note: 'domain infrastructure, not yet a product capability: the UNIFIED CLOSED-LOOP LEARNING spine (W140) — one longitudinal LOOP-CYCLE record per (tenant, goal) turn (append-and-close: identity columns immutable from creation by storage trigger, 1-based monotonic cycle numbers, the one-way open → closed transition freezing the longitudinal metrics exactly once — the deterministic observed score, the prediction-vs-outcome calibration error, the knowledge gap-closure rate and the reality-deviation recurrence against the previous closed cycle), citing REAL evidence from the connected seams gated readable on their owning contracts BEFORE the mutation (W136 execution runs, W137 fabric leases, W135 calibrated recommendations and the W008 goal metric — the REALITY class, the world differed from expectations; W125 material coverage gaps and W053 CompanyModel learning updates — the KNOWLEDGE class, our knowledge was wrong/insufficient) with the TWO DEVIATION CLASSES STRUCTURALLY DISTINCT (separate tables with class-specific columns and CHECKs, separate validators that reject each other\'s fields, separate read paths — a deviation can never migrate between classes), and the ADVISORY ranking signals as the only learning application (append-only, reviewable, addressed to the three ranking input channels — the W134 info-strategy goal-matched, the W135 org-lab candidate ranking, the W053 CompanyModel subject key — with authoritative:false MINTED at read, no storage column and no caller-suppliable field; a policy/settings/authority-shaped target is refused with the dedicated typed code policy_mutation_refused on both surfaces). NO SECOND LEARNING AUTHORITY (structural): the loop records learning but never applies it — no operation here mutates any seam\'s state, explicit policy stays authoritative over every learned prior, and future ranking changes only through these recorded signals consumed by the target seams\' own input channels; the trajectory and honest improvement-summary reads carry the cycle-over-cycle evidence (improved only when the last measured calibration error is strictly smaller than the first, insufficient_evidence never a fabricated improvement); W141 composes the certification surfaces; exercised by the closed-loop module vitest suite plus the tenant-isolation sweep (registered at Wave E integration)',
  },
];

const BY_MODULE: ReadonlyMap<string, CapabilityRoute> = new Map(
  CAPABILITY_ROUTES.map((capability) => [capability.module, capability]),
);

/** One capability entry by module name (throws — the map is closed). */
export function capabilityFor(module: string): CapabilityRoute {
  const entry = BY_MODULE.get(module);
  if (entry === undefined) {
    throw new Error(`module '${module}' has no capability-route entry`);
  }
  return entry;
}

/** Pure coverage evaluation: which entries reference routes missing from the known route set. */
export function capabilityRouteGaps(
  knownRoutes: readonly string[],
): { module: string; route: string }[] {
  const known = new Set(knownRoutes);
  const gaps: { module: string; route: string }[] = [];
  for (const capability of CAPABILITY_ROUTES) {
    for (const route of capability.routes) {
      if (!known.has(route)) {
        gaps.push({ module: capability.module, route });
      }
    }
  }
  return gaps;
}

/**
 * Evaluate mobile reachability for the drill-down routes: a route is
 * reachable when it is a direct bottom-nav area, or belongs to the
 * routes a hub/command registry exposes. Pure — the caller feeds the
 * REAL rendered hub links and command-registry destinations.
 */
export function evaluateMobileReachability(
  options: {
    mobileNavAreas: readonly string[];
    commandRegistryRoutes: readonly string[];
    hubRoutes: readonly string[];
  },
  routePaths: readonly string[],
): { route: string; reachable: boolean; via: 'mobile-nav' | 'command-search' | 'hub' | null }[] {
  const nav = new Set(options.mobileNavAreas);
  const command = new Set(options.commandRegistryRoutes);
  const hub = new Set(options.hubRoutes);
  return routePaths.map((route) => {
    if (nav.has(route)) return { route, reachable: true, via: 'mobile-nav' as const };
    if (command.has(route)) return { route, reachable: true, via: 'command-search' as const };
    if (hub.has(route)) return { route, reachable: true, via: 'hub' as const };
    return { route, reachable: false, via: null };
  });
}
