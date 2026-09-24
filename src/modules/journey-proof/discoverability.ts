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
