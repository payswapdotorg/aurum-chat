// Public domain types of the cross-platform module (W139 — Cross-Platform
// Aurum Product).
//
// THE PRODUCT DECISION (spec/work-items/WORK-ITEM-CATALOG.md §W139 +
// ARCHITECTURE-CHANGE-REQUEST-0003 "Cross-platform rule" + the frozen W131
// Group 4/5 vocabulary in spec/EXECUTION-PLATFORM-CONTRACTS-2026-10-04.md):
// Aurum is productized with Web as the CANONICAL client, Desktop (Tauri 2)
// as the POWER client and Mobile (Expo/React Native) as the FIELD client.
// This module is the CROSS-PLATFORM SEMANTIC CORE those clients consume:
//
//   1. CLIENT STATE AUTHORITY — one authoritative conversation/company
//      state model, served as typed, content-addressed projections
//      (CompanyStateProjectionRef: revision + digest bound) over the
//      EXISTING seams (conversations W029, goals W008, missions W011).
//      The read paths are CLIENT-AGNOSTIC: the platform kind of the
//      asking session is recorded for journey/evidence purposes and
//      NEVER participates in state computation — web, desktop and mobile
//      receive byte-identical projections (test-locked). No client holds
//      divergent authority: server-side state is authoritative, clients
//      are projections (the frozen W131 conclusion).
//   2. BACKGROUND-WORK INSPECTION EVERYWHERE — a typed feed over what
//      the system is doing across the seams (missions W011, agent-
//      exchange execution runs W136, execution-fabric leases W137),
//      readable by any client kind with IDENTICAL semantics.
//   3. PLATFORM-NATIVE CAPABILITIES AS ADAPTERS — a vendor-neutral
//      PlatformAdapter SPI (notifications, file access, window
//      management, share, camera); web/desktop/mobile implementations
//      live behind it. Removing every adapter changes NO domain contract
//      (the W137 vendor-removal clause, applied to client platforms).
//   4. CROSS-DEVICE HANDOFF WITH EVIDENCE — handoff sessions (a user's
//      working context: conversation focus, draft, navigation state)
//      handed from one device to another, recorded as APPEND-ONLY
//      evidence; resumption restores the exact working context and
//      re-projects the focus from CURRENT server state (the frozen
//      ContinuityHandoffSemantics literals; a stale client projection is
//      discarded and the discard itself is evidence).
//   5. THE PRODUCT SHELL READ MODEL — typed shell semantics (the W057
//      vocabulary: product areas, command search, notification entry,
//      context drawer, tenant/workspace switcher) so non-web clients
//      consume the SAME semantics. CONTRACT-LEVEL ONLY: no UI code
//      lives here — the web app remains the canonical renderer (the
//      module ruling, recorded in WORK-NOTES).
//
// WHAT THIS MODULE DELIBERATELY IS NOT: it is not a second state
// authority (every projection is derived from the owning modules'
// contracts at read time — this module persists only client sessions
// and handoff evidence, never domain truth); it is not a UI layer; it
// is not an execution, permission or approval authority (the W009
// actions matrix, W021 agents and the governed chains stay the
// authorities); and it holds no vendor identity in its TYPES (Tauri and
// Expo are product decisions recorded as adapter METADATA, never
// type-system citizens — the W131 law applied to client platforms).
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext;
// client sessions and handoff evidence are tenant-scoped rows, and
// cross-tenant access is indistinguishable from missing records at the
// service layer (uniform typed not-found, no existence leak).

// The frozen W131 client/continuity vocabulary — consumed VERBATIM,
// type-only (the execution module is the frozen source; drift there
// fails typecheck here, never runtime).
import type {
  ClientPlatformKind,
  ClientSessionState,
  CompanyStateProjectionRef,
  ContinuityConflict,
  ContinuityHandoffSemantics,
} from '@/modules/execution/contract';
// The conversations seam's read shapes — re-exported so the projection
// types are self-contained for non-web clients (the owning module stays
// the authority; these are its frozen public read shapes).
import type { Conversation, Message } from '@/modules/conversations/contract';

// ---------------------------------------------------------------------------
// Client sessions (the W131 SharedClientSession, persisted server-side)
// ---------------------------------------------------------------------------

/**
 * One registered client session — the server-issued identity of ONE
 * signed-in client instance (a browser tab, the desktop app, the mobile
 * app). Mirrors the frozen W131 `SharedClientSession` shape with the
 * additions a persisted session needs (device label, last-seen, revocation
 * audit). Sessions are NEVER client-minted: the server records them, and
 * a session's `state` is always DERIVED (revoked beats expired beats
 * active — never a stored string that could drift).
 */
export interface ClientSession {
  id: string;
  tenantId: string;
  /** The signed-in principal this session acts as (ADR-0001 context). */
  principalId: string;
  /** The frozen W131 platform kind — web (canonical), desktop, mobile. */
  platform: ClientPlatformKind;
  /** Human-facing device label ('MacBook Pro — Tauri', 'iPhone 15', …). */
  deviceLabel: string | null;
  /** ISO 8601 — service clock at registration. */
  issuedAt: string;
  /** ISO 8601 — service clock at the last session-acting call. */
  lastSeenAt: string;
  /** ISO 8601 — optional absolute expiry (null = until revoked). */
  expiresAt: string | null;
  /** ISO 8601 — set by the one-way revocation transition. */
  revokedAt: string | null;
  /** DERIVED, never stored: revoked > expired > active. */
  state: ClientSessionState;
}

/** Input shape of `registerClientSession`. */
export interface RegisterClientSessionInput {
  platform: ClientPlatformKind;
  deviceLabel?: string | null;
  /** Strict ISO 8601, must be in the future at registration. */
  expiresAt?: string | null;
}

/** Query shape of `listClientSessions`. */
export interface ListClientSessionsQuery {
  platform?: ClientPlatformKind;
  state?: ClientSessionState;
  /** 1..500, default 50. */
  limit?: number;
}

/** Input shape of `revokeClientSession` (the one-way transition). */
export interface RevokeClientSessionInput {
  clientSessionId: string;
}

// ---------------------------------------------------------------------------
// The authoritative state projections (client-agnostic reads)
// ---------------------------------------------------------------------------

/** The projection kinds this module serves (frozen vocabulary of this contract). */
export type StateProjectionKind =
  | 'conversation-state'
  | 'company-overview'
  | 'mission-state'
  | 'background-work-state'
  | 'product-shell';

/** Frozen source of truth for {@link StateProjectionKind}. */
export const STATE_PROJECTION_KINDS: readonly StateProjectionKind[] = [
  'conversation-state',
  'company-overview',
  'mission-state',
  'background-work-state',
  'product-shell',
] as const;

/**
 * The authoritative conversation state, served identically to any client
 * kind: the conversations seam's own `Conversation` + the requested
 * message window, bound to a content-addressed projection ref (revision =
 * the thread's message count — monotonic under appends; digest = sha256
 * over the canonical serialization of the SERVED projection).
 */
export interface ConversationStateProjection {
  projectionRef: CompanyStateProjectionRef;
  conversation: Conversation;
  messages: Message[];
}

/** One goal summary in the company overview (the goals seam W008, verbatim fields). */
export interface CompanyGoalSummary {
  goalId: string;
  title: string;
  status: string;
  priority: string;
  version: number;
  updatedAt: string;
}

/** One mission summary in the company overview (the missions seam W011). */
export interface CompanyMissionSummary {
  missionId: string;
  title: string;
  status: string;
  urgency: string;
  version: number;
  updatedAt: string;
}

/**
 * The authoritative company overview: the tenant's current goals and
 * missions as compact typed summaries, bound to a content-addressed
 * projection ref (revision = served goal + mission count; digest = sha256
 * over the canonical serialization). The SAME shape reaches web, desktop
 * and mobile — there is no per-platform state.
 */
export interface CompanyOverviewProjection {
  projectionRef: CompanyStateProjectionRef;
  goals: CompanyGoalSummary[];
  missions: CompanyMissionSummary[];
}

/** Query shape of `readConversationState`. */
export interface ReadConversationStateQuery {
  conversationId: string;
  /** 1..500, default 50 — the message window served (newest last, chronological). */
  messageLimit?: number;
}

/** Query shape of `readCompanyOverview`. */
export interface ReadCompanyOverviewQuery {
  /** 1..500, default 50. */
  goalLimit?: number;
  /** 1..500, default 50. */
  missionLimit?: number;
}

// ---------------------------------------------------------------------------
// The background-work feed (inspection everywhere)
// ---------------------------------------------------------------------------

/** Which seam one background-work item comes from. */
export type BackgroundWorkSeam = 'mission' | 'execution-run' | 'fabric-lease';

/** Frozen source of truth for {@link BackgroundWorkSeam}. */
export const BACKGROUND_WORK_SEAMS: readonly BackgroundWorkSeam[] = [
  'mission',
  'execution-run',
  'fabric-lease',
] as const;

/**
 * The cross-client activity phase — the ONE normalization layer over the
 * seams' native status vocabularies. The native status is ALWAYS preserved
 * verbatim on the item (`seamStatus`); the phase is what every client
 * kind renders identically.
 *
 * Mapping (frozen, test-locked):
 *   mission W011    : active → in-flight; completed → succeeded;
 *                     abandoned → cancelled;
 *   execution run   : awaiting_approval → awaiting-decision; queued →
 *   W136 (W021      : in-flight; succeeded → succeeded; failed → failed;
 *   vocabulary)     : refused → failed; cancelled → cancelled;
 *   fabric lease    : preparing/live → in-flight; suspended → suspended;
 *   W137            : lost → lost; released → succeeded; cancelled →
 *                     cancelled; failed → failed.
 */
export type BackgroundWorkPhase =
  | 'in-flight'
  | 'awaiting-decision'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'suspended'
  | 'lost';

/** Frozen source of truth for {@link BackgroundWorkPhase}. */
export const BACKGROUND_WORK_PHASES: readonly BackgroundWorkPhase[] = [
  'in-flight',
  'awaiting-decision',
  'succeeded',
  'failed',
  'cancelled',
  'suspended',
  'lost',
] as const;

/**
 * One thing the system is doing, projected for inspection on any client.
 * `workId` is the OPAQUE id of the owning record (never re-interpreted
 * here); `parentRef` names the owning plan (runs) or environment
 * definition (leases) when one exists.
 */
export interface BackgroundWorkItem {
  /** The owning record's id (mission id, execution-run id, lease id). */
  workId: string;
  seam: BackgroundWorkSeam;
  tenantId: string;
  title: string;
  phase: BackgroundWorkPhase;
  /** The seam's native status vocabulary, VERBATIM (never re-minted). */
  seamStatus: string;
  /** Owning plan id (execution-run) or definition id (fabric-lease); null for missions. */
  parentRef: string | null;
  /** ISO 8601 — when the owning record was created. */
  recordedAt: string;
  /** ISO 8601 — the owning record's latest activity stamp. */
  updatedAt: string;
}

/** Query shape of `listBackgroundWork`. */
export interface ListBackgroundWorkQuery {
  seam?: BackgroundWorkSeam;
  phase?: BackgroundWorkPhase;
  /** 1..500, default 50 — applies AFTER the seam/phase filters. */
  limit?: number;
}

/** Input shape of `getBackgroundWorkItem`. */
export interface GetBackgroundWorkItemInput {
  seam: BackgroundWorkSeam;
  workRef: string;
}

// ---------------------------------------------------------------------------
// The platform-native capability adapter SPI
// ---------------------------------------------------------------------------

/**
 * The platform-native capability domains — VENDOR-NEUTRAL by law (the
 * W131 law applied to client platforms): no 'tauri', 'expo', 'web-notification'
 * or any vendor/product name is a type-system citizen. Vendors appear ONLY
 * in PlatformVendorMetadata on the adapter's descriptor.
 */
export type PlatformCapabilityDomain =
  | 'notifications'
  | 'file-access'
  | 'window-management'
  | 'share'
  | 'camera';

/** Frozen source of truth for {@link PlatformCapabilityDomain}. */
export const PLATFORM_CAPABILITY_DOMAINS: readonly PlatformCapabilityDomain[] = [
  'notifications',
  'file-access',
  'window-management',
  'share',
  'camera',
] as const;

/**
 * One declared capability. A declaration is NOT a permission: it states
 * what the adapter CAN do; authorization stays with the actions module
 * (W009) and tenant policy. An adapter that cannot serve a domain
 * declares `supported: false` (the honest-descriptor law).
 */
export interface PlatformCapabilityDeclaration {
  domain: PlatformCapabilityDomain;
  supported: boolean;
  /** Optional non-sensitive note (never credentials — the W131 discipline). */
  note?: string | null;
}

/**
 * Vendor identity as METADATA — the ONLY place a vendor or product name
 * may appear (Tauri 2 on desktop, Expo/React Native on mobile are product
 * decisions recorded here, never types).
 */
export interface PlatformVendorMetadata {
  vendorName: string;
  vendorProduct: string;
  vendorAdapterVersion: string;
}

/** The health states of a platform adapter (mirrors the W131 adapter health). */
export type PlatformAdapterHealth = 'available' | 'degraded' | 'unavailable';

/** Frozen source of truth for {@link PlatformAdapterHealth}. */
export const PLATFORM_ADAPTER_HEALTH_STATES: readonly PlatformAdapterHealth[] = [
  'available',
  'degraded',
  'unavailable',
] as const;

/**
 * The adapter's self-description — non-sensitive strings only. Probed,
 * never assumed: the service refuses a capability explicitly when the
 * descriptor declares it unsupported.
 */
export interface PlatformAdapterDescriptor {
  adapterId: string;
  platform: ClientPlatformKind;
  displayName: string;
  vendor: PlatformVendorMetadata;
  capabilities: PlatformCapabilityDeclaration[];
  health: PlatformAdapterHealth;
}

/** One capability invocation request (vendor-neutral; `input` is plain JSON). */
export interface PlatformCapabilityRequest {
  domain: PlatformCapabilityDomain;
  /** Vendor-neutral payload — any plain JSON value the adapter interprets. */
  input: unknown;
}

/** One served capability invocation (the receipt handed back to the client). */
export interface PlatformCapabilityReceipt {
  adapterId: string;
  domain: PlatformCapabilityDomain;
  /** ISO 8601 — service clock at serve time. */
  servedAt: string;
  /** Vendor-neutral result payload (plain JSON). */
  output: unknown;
}

/**
 * THE PLATFORM ADAPTER SPI — one registration per client platform kind.
 * `probe` answers the honest descriptor; `invoke` serves one capability
 * call and THROWS on vendor-path failure (the service maps that to a
 * typed error — never a fabricated success). Adapters hold NO domain
 * state: they are runtime doubles behind the seam, exactly like the
 * W137 execution-environment adapters.
 */
export interface PlatformAdapter {
  adapterId: string;
  platform: ClientPlatformKind;
  probe(): Promise<PlatformAdapterDescriptor>;
  invoke(request: PlatformCapabilityRequest): Promise<PlatformCapabilityReceipt>;
}

/** Query shape of `probePlatformCapabilities` / `listPlatformAdapters`. */
export interface PlatformAdapterQuery {
  platform?: ClientPlatformKind;
}

/** Input shape of `invokePlatformCapability`. */
export interface InvokePlatformCapabilityInput {
  platform: ClientPlatformKind;
  domain: PlatformCapabilityDomain;
  /** Vendor-neutral payload — any plain JSON value (≤ 256 KiB canonicalized). */
  input: unknown;
}

// ---------------------------------------------------------------------------
// Cross-device handoff (sessions + append-only evidence)
// ---------------------------------------------------------------------------

/** What a handoff session's working context is focused on. */
export type HandoffFocusKind = 'conversation' | 'background-work' | 'mission';

/** Frozen source of truth for {@link HandoffFocusKind}. */
export const HANDOFF_FOCUS_KINDS: readonly HandoffFocusKind[] = [
  'conversation',
  'background-work',
  'mission',
] as const;

/**
 * The W057 navigation state, typed — the SAME seven product areas the
 * web shell renders (the app stays the canonical renderer; this is the
 * contract-level mirror non-web clients consume).
 */
export type ProductAreaId =
  | 'chat'
  | 'today'
  | 'intelligence'
  | 'people'
  | 'connections'
  | 'marketplace'
  | 'more';

/** Frozen source of truth for {@link ProductAreaId}. */
export const PRODUCT_AREA_IDS: readonly ProductAreaId[] = [
  'chat',
  'today',
  'intelligence',
  'people',
  'connections',
  'marketplace',
  'more',
] as const;

/**
 * One navigation position in the product shell: the area, an optional
 * management-mode drill-down (the tower surface slugs), and the optional
 * contextual focus inside the area (a conversation id, a mission id, a
 * work-item ref…).
 */
export interface ShellNavigationState {
  area: ProductAreaId;
  /** The tower drill-down surface slug when in management mode. */
  towerSurface?: string | null;
  /** The contextual focus ref inside the area (opaque). */
  focusRef?: string | null;
}

/**
 * The user's working context — the unit of cross-device handoff. The
 * context is FROZEN at session open (the storage trigger rejects context
 * mutations); handoffs move it between devices VERBATIM and resumption
 * restores it EXACTLY while re-projecting the focus from current server
 * state.
 */
export interface HandoffWorkingContext {
  focusKind: HandoffFocusKind;
  /** Opaque ref of the focus (conversation id, mission id, work id). */
  focusRef: string;
  /** Required iff focusKind = 'background-work' (the seam that owns the work id). */
  focusSeam?: BackgroundWorkSeam;
  /** The verbatim draft text the user was composing (null = none). */
  draft: string | null;
  navigation: ShellNavigationState;
}

/**
 * One handoff session — the spine. The spine's context is immutable; the
 * lifecycle is one-way open → closed; `activeClientSessionId` tracks
 * which device holds the session (moved by handoff/resumption);
 * `anchorRevision` is the count of evidence events (the client's
 * seen-cursor over the evidence trail).
 */
export interface HandoffSession {
  id: string;
  tenantId: string;
  /** The principal that opened the session (handoffs stay same-principal). */
  principalId: string;
  /** The frozen working context (immutable from creation). */
  context: HandoffWorkingContext;
  /** The client session that opened the session. */
  originClientSessionId: string;
  /** The client session currently holding the session (moved by handoff/resume). */
  activeClientSessionId: string;
  /** Where the session is currently open (the acting session's platform). */
  openOnPlatform: ClientPlatformKind;
  /** Lifecycle: open → closed, one-way. */
  status: 'open' | 'closed';
  /** Count of evidence events (monotonic per session). */
  anchorRevision: number;
  /** ISO 8601 — service clock at open. */
  openedAt: string;
  /** ISO 8601 — service clock at the last evidence event. */
  lastActiveAt: string;
  closedAt: string | null;
}

/** Input shape of `openHandoffSession`. */
export interface OpenHandoffSessionInput {
  clientSessionId: string;
  context: HandoffWorkingContext;
}

/** Input shape of `recordHandoff`. */
export interface RecordHandoffInput {
  handoffSessionId: string;
  /** The RECEIVING client session (a different device, same principal). */
  toClientSessionId: string;
}

/** Input shape of `resumeHandoff`. */
export interface ResumeHandoffInput {
  handoffSessionId: string;
  /** The resuming client session (the receiving device). */
  clientSessionId: string;
  /**
   * The focus-projection revision the client last saw. When it differs
   * from the current server revision the client held a STALE projection:
   * the discard is recorded as evidence (the frozen single-member
   * resolution 'server-state-wins').
   */
  clientRevision?: number;
}

/** Input shape of `closeHandoffSession` (the one-way transition). */
export interface CloseHandoffSessionInput {
  handoffSessionId: string;
}

/** Query shape of `listHandoffSessions`. */
export interface ListHandoffSessionsQuery {
  status?: 'open' | 'closed';
  focusKind?: HandoffFocusKind;
  platform?: ClientPlatformKind;
  /** 1..500, default 50. */
  limit?: number;
}

/** Query shape of `getHandoffSession`. */
export interface GetHandoffSessionQuery {
  handoffSessionId: string;
}

/** The evidence trail's event kinds (append-only). */
export type HandoffEvidenceKind =
  | 'session-opened'
  | 'handoff-recorded'
  | 'resumed'
  | 'conflict-discarded'
  | 'session-closed';

/** Frozen source of truth for {@link HandoffEvidenceKind}. */
export const HANDOFF_EVIDENCE_KINDS: readonly HandoffEvidenceKind[] = [
  'session-opened',
  'handoff-recorded',
  'resumed',
  'conflict-discarded',
  'session-closed',
] as const;

/**
 * One append-only evidence event on a handoff session — the inspectable
 * trail proving what moved where, when, with which context snapshot and
 * which server projection it was bound to. UPDATE/DELETE are rejected by
 * storage triggers.
 */
export interface HandoffEvidence {
  id: string;
  tenantId: string;
  handoffSessionId: string;
  kind: HandoffEvidenceKind;
  /** The acting principal (system-captured from the TenantContext). */
  actor: string;
  /** The acting client session (null for service-initiated closes). */
  clientSessionId: string | null;
  fromPlatform: ClientPlatformKind | null;
  toPlatform: ClientPlatformKind | null;
  /** The working context as it stood at this event (verbatim snapshot). */
  contextSnapshot: HandoffWorkingContext | null;
  /** The server projection the event bound (revision), when applicable. */
  projectionRevision: number | null;
  /** The server projection the event bound (digest), when applicable. */
  projectionDigest: string | null;
  /** conflict-discarded only: the stale client revision that was discarded. */
  discardedClientRevision: number | null;
  /** conflict-discarded only: the frozen single-member resolution. */
  resolution: ContinuityConflictResolution | null;
  /** ISO 8601 — service clock at record time. */
  recordedAt: string;
}

/** The frozen single-member conflict resolution (W131 Group 5). */
export type ContinuityConflictResolution = 'server-state-wins';

/** Query shape of `listHandoffEvidence`. */
export interface ListHandoffEvidenceQuery {
  handoffSessionId: string;
  kind?: HandoffEvidenceKind;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * What `resumeHandoff` returns: the session, the restored working context
 * (VERBATIM), the frozen handoff semantics literals, the fresh
 * re-projection of the focus from current server state, and the recorded
 * conflict when the client's projection was stale (null otherwise).
 */
export interface HandoffResumption {
  session: HandoffSession;
  restoredContext: HandoffWorkingContext;
  semantics: ContinuityHandoffSemantics;
  reprojection: CompanyStateProjectionRef;
  conflict: ContinuityConflict | null;
}

// ---------------------------------------------------------------------------
// The product shell read model (W057 semantics, contract-level only)
// ---------------------------------------------------------------------------

/** One product area in the shell navigation (the W057 registry, mirrored). */
export interface ShellArea {
  areaId: ProductAreaId;
  /** The canonical web route — the CANONICAL renderer's addressing. */
  href: string;
  label: string;
  /** Short label for constrained surfaces (the mobile bottom nav). */
  shortLabel: string;
  tagline: string;
  /** Product mode vs management mode (the tower drill-down). */
  mode: 'product' | 'management';
}

/** What a shell command entry targets. */
export type ShellCommandTargetKind =
  | 'area'
  | 'tower-surface'
  | 'notification-entry'
  | 'context-drawer'
  | 'tenant-switcher';

/** Frozen source of truth for {@link ShellCommandTargetKind}. */
export const SHELL_COMMAND_TARGET_KINDS: readonly ShellCommandTargetKind[] = [
  'area',
  'tower-surface',
  'notification-entry',
  'context-drawer',
  'tenant-switcher',
] as const;

/** One command-search entry (typed; the same list on every client kind). */
export interface ShellCommandEntry {
  commandId: string;
  label: string;
  keywords: string[];
  target: {
    kind: ShellCommandTargetKind;
    /** The area id / surface slug; null for the entry-point targets. */
    ref: string | null;
  };
}

/** The notification entry's state (derived from the notifications seam). */
export interface ShellNotificationEntry {
  /** Notifications currently demanding attention (pending/escalating/escalated). */
  attentionCount: number;
  latestSubject: string | null;
  /** ISO 8601 — the latest attention notification's creation stamp. */
  latestAt: string | null;
}

/** The context drawer's descriptor (the current contextual focus). */
export interface ShellContextDrawer {
  focusKind: HandoffFocusKind | 'none';
  focusRef: string | null;
  /** One-line summary of the focus's current server state. */
  summary: string | null;
}

/** One workspace reference in the tenant/workspace switcher. */
export interface ShellWorkspaceRef {
  workspaceId: string;
  label: string;
}

/** The tenant/workspace switcher's state (the organizations seam). */
export interface ShellTenantSwitcher {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  workspaces: ShellWorkspaceRef[];
}

/**
 * The product shell read model — ONE typed projection carrying the W057
 * shell semantics to any client kind. The web app remains the CANONICAL
 * renderer of these semantics (the module ruling); desktop and mobile
 * consume the SAME model. Platform identity never changes its content
 * (test-locked — identical through web/desktop/mobile sessions).
 */
export interface ProductShellModel {
  projectionRef: CompanyStateProjectionRef;
  areas: ShellArea[];
  commandSearch: ShellCommandEntry[];
  notificationEntry: ShellNotificationEntry;
  contextDrawer: ShellContextDrawer;
  tenantSwitcher: ShellTenantSwitcher;
}

/** Query shape of `readShellModel`. */
export interface ReadShellModelQuery {
  /** The contextual focus the drawer describes (omit for 'none'). */
  focus?: {
    focusKind: HandoffFocusKind;
    focusRef: string;
    focusSeam?: BackgroundWorkSeam;
  };
}

// ---------------------------------------------------------------------------
// Re-exports (the frozen W131 vocabulary this contract builds on —
// re-exported so consumers need exactly one import surface)
// ---------------------------------------------------------------------------

export type {
  ClientPlatformKind,
  ClientSessionState,
  CompanyStateProjectionRef,
  ContinuityConflict,
  ContinuityHandoffSemantics,
} from '@/modules/execution/contract';
export type { Conversation, Message } from '@/modules/conversations/contract';
