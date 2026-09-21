// Public types of the journey-proof module (W070 — Browser Journey,
// Accessibility & Discoverability Proof).
//
// The module is a VERIFICATION HARNESS, not a product surface: it owns no
// tables, exposes no HTTP surface, and adds no authority vocabulary. It
// turns the W070 acceptance list (spec/work-items/WORK-ITEM-CATALOG.md)
// into typed, machine-checkable proof obligations:
//
//   * the JOURNEY MATRIX — every acceptance journey as steps over real
//     product routes, on desktop AND mobile viewports, walked by the
//     W068 demo personas through the real surface code;
//   * the ROUTE CATALOG — every user-facing route of this repository
//     base (pages, the root redirect, the API surface), the single
//     source the link-graph proofs resolve against;
//   * the CAPABILITY DISCOVERABILITY MAP — every architecture module
//     (the frozen module map) mapped to the user routes and discovery
//     surfaces that expose it ("every architecture capability has a
//     discoverable user route");
//   * the ACCESSIBILITY RULE SET + HTML audit engine — the static,
//     tool-free accessibility proof over the real server-rendered HTML
//     and the shipped CSS (touch targets, active-state treatment).
//
// Everything here is PURE (no react/next/db imports — IMPLEMENTATION-
// STACK §2); the execution suites under tests/e2e/journeys/ drive the
// real app code and feed this module the evidence.

// ---------------------------------------------------------------------------
// Viewports and actors
// ---------------------------------------------------------------------------

/** The two viewports of the W070 acceptance ("desktop and mobile"). */
export type Viewport = 'desktop' | 'mobile';

/**
 * Who walks a journey. The four W068 personas cover the product roles;
 * `anonymous` and `fresh-manager` cover the first-run halves of Journey A
 * (an unauthenticated visitor, and a just-registered principal without a
 * company yet).
 */
export type JourneyActor =
  | 'manager'
  | 'employee'
  | 'developer'
  | 'platform-reviewer'
  | 'anonymous'
  | 'fresh-manager';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Which shell a route renders in. */
export type RouteArea = 'auth' | 'product' | 'management' | 'api';

/** What lives at a route. */
export type RouteKind = 'page' | 'root-redirect' | 'api';

/** The authentication contract of a page route. */
export type RouteAuth = 'required' | 'public' | 'self';

/** The five mobile bottom-nav areas (plan §3). */
export type MobileAreaId = 'chat' | 'today' | 'intelligence' | 'people' | 'more';

/**
 * One user-facing route of the product. `path` is a pattern with `:param`
 * segments (e.g. `/intelligence/goals/:goalId`); `file` is the repository
 * path of the route module — the proof that the route physically exists.
 */
export interface RouteSpec {
  path: string;
  kind: RouteKind;
  area: RouteArea;
  auth: RouteAuth;
  title: string;
  file: string;
  /**
   * The mobile bottom-nav area that reaches this route directly, or null
   * for drill-downs (reachable from an area page, a hub link, or the
   * command search, which the mobile top bar exposes as its search entry).
   */
  mobileArea: MobileAreaId | null;
}

// ---------------------------------------------------------------------------
// The journey matrix
// ---------------------------------------------------------------------------

/** How a journey step moves from the previous one. */
export type StepVia =
  | 'url' // direct entry / bookmark / email link
  | 'nav' // shell navigation (rail, bottom nav, tower nav)
  | 'link' // an in-content link on the previous page
  | 'command' // the ⌘K command search
  | 'api' // an API interaction the surface performs for the user
  | 'redirect'; // a server redirect

/** One step of a journey: where the user is, how they got there, what they must see. */
export interface JourneyStep {
  id: string;
  action: string;
  /** The route pattern this step lands on (must exist in the route catalog). */
  route: string;
  via: StepVia;
  /** The checkable expectation (what the page must surface for this step). */
  expect: string;
}

/** Whether an entry is a walkable journey or a proof audit. */
export type JourneyKind = 'journey' | 'audit';

/** The closed journey id set (one per W070 acceptance bullet). */
export type JourneyId =
  | 'first-run-onboarding'
  | 'manager-chat'
  | 'employee-chat'
  | 'goal-unknown-mission'
  | 'evidence-explainability'
  | 'recommendation-approval-outcome'
  | 'learning-contribution-reward'
  | 'connections'
  | 'byoa'
  | 'agent-recruitment'
  | 'marketplace'
  | 'developer-api-mcp'
  | 'mobile-navigation'
  | 'accessibility'
  | 'no-dead-ends'
  | 'capability-coverage';

/**
 * One entry of the W070 acceptance matrix. `acceptance` quotes the
 * acceptance bullet verbatim; `kind: 'audit'` entries are the proof
 * obligations that are not single walks (accessibility, dead ends,
 * capability coverage) — their steps enumerate the audit's checks.
 */
export interface JourneySpec {
  id: JourneyId;
  /** The plan §2 letter ('A'–'L'), 'M' for the mobile-navigation entry, '·' for audits. */
  ref: string;
  kind: JourneyKind;
  title: string;
  acceptance: string;
  actors: readonly JourneyActor[];
  viewports: readonly Viewport[];
  steps: readonly JourneyStep[];
}

// ---------------------------------------------------------------------------
// Capability discoverability
// ---------------------------------------------------------------------------

/** Where a route is discoverable from (the discovery surfaces of the shell). */
export type DiscoverableSurface =
  | 'desktop-rail' // the product rail (desktop)
  | 'mobile-nav' // the mobile bottom nav
  | 'command-search' // ⌘K (every viewport, incl. the mobile top-bar search)
  | 'hub-link' // a page that indexes it (More, Intelligence, People…)
  | 'drill-down' // an in-content link from a related surface
  | 'chat-card' // an Aurum chat action card
  | 'auth-entry' // the unauthenticated entry flow itself
  | 'public-entry'; // reachable without a session (marketplace catalog)

/** One architecture capability and its user-facing discovery map. */
export interface CapabilityRoute {
  /** The module folder under src/modules — the architecture capability. */
  module: string;
  label: string;
  /** The frozen module map layer (MODULE-DEPENDENCY-MAP.md). */
  layer: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7' | 'platform';
  /**
   * Route patterns (must exist in the route catalog). Empty ONLY for
   * `instrument` entries (verification instruments with no user surface
   * by design — see the note).
   */
  routes: readonly string[];
  /** Where those routes are discoverable from. */
  surfaces: readonly DiscoverableSurface[];
  /**
   * True when the capability is a verification/measurement instrument
   * (W055 quality, W056 simulator, the W068 demo harness, this module)
   * rather than a product capability — its exercise is the proof suites,
   * by design; the plan §8 gate applies to product capabilities.
   */
  instrument: boolean;
  note: string;
}

// ---------------------------------------------------------------------------
// The accessibility rule set
// ---------------------------------------------------------------------------

/** One rule of the accessibility proof. */
export interface A11yRule {
  id: A11yRuleId;
  description: string;
  /** Where the rule applies. */
  scope: 'document' | 'chrome' | 'content' | 'css';
}

/** The closed rule id set (static, tool-free checks over real rendered HTML/CSS). */
export type A11yRuleId =
  | 'document-lang'
  | 'landmark-main'
  | 'landmark-navigation'
  | 'skip-link'
  | 'single-h1'
  | 'heading-order'
  | 'img-alt'
  | 'button-name'
  | 'link-name'
  | 'no-positive-tabindex'
  | 'input-label'
  | 'table-caption'
  | 'touch-target'
  | 'nav-aria-current';

/** One violation the audit found. */
export interface A11yViolation {
  rule: A11yRuleId;
  /** What was audited (page route or css file). */
  subject: string;
  detail: string;
}

/** Options that scope the HTML audit to what a page is expected to carry. */
export interface A11yAuditOptions {
  /** The route being audited (for violation subjects). */
  subject: string;
  /** The page renders inside a shell with skip link + landmarks (default true). */
  chrome: boolean;
  /** The document root (<html>) is part of the render (default true). */
  fullDocument: boolean;
  /**
   * The shell carries NAVIGATION landmarks (default: same as `chrome`).
   * Auth pages are deliberately chrome-free (the quiet entry pattern,
   * plan §3): they must carry the skip link and the main landmark, but
   * there is no navigation to landmark.
   */
  navigation?: boolean;
}

// ---------------------------------------------------------------------------
// The link graph (dead ends, broken links, mobile reachability)
// ---------------------------------------------------------------------------

/** One extracted in-document link. */
export interface LinkInfo {
  href: string;
  /** The href resolved against the page's own route (absolute path). */
  resolved: string;
  accessibleName: string;
}

/** A page's contribution to the no-dead-end proof. */
export interface PageLinkProof {
  route: string;
  /** In-app links found in the page content (nav chrome excluded by caller if needed). */
  links: LinkInfo[];
  /** Links that do not resolve to any catalog route (broken → dead end). */
  broken: LinkInfo[];
  /** Onward in-app links distinct from the page's own route. */
  onward: LinkInfo[];
}

/** The mobile reachability verdict for one route. */
export interface MobileReachability {
  route: string;
  reachable: boolean;
  via: 'mobile-nav' | 'command-search' | 'hub' | null;
}

// ---------------------------------------------------------------------------
// The proof report
// ---------------------------------------------------------------------------

/** The outcome of one executed journey (assembled by the e2e suites). */
export interface JourneyProofResult {
  journeyId: JourneyId;
  viewport: Viewport | 'both';
  actor: JourneyActor | 'multi';
  passed: boolean;
  /** Which step failed (null when passed). */
  failedStep: string | null;
  detail: string | null;
}

/** The assembled W070 proof report (the acceptance artifact). */
export interface JourneyProofReport {
  results: readonly JourneyProofResult[];
  pagesAudited: readonly string[];
  capabilitiesCovered: readonly string[];
}
