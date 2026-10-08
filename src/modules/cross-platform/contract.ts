// ============================================================================
// cross-platform — the ONLY public surface of the cross-platform module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W139 — Cross-Platform Aurum Product (spec/work-items/WORK-ITEM-CATALOG.md
// §W139; ARCHITECTURE-CHANGE-REQUEST-0003 "Cross-platform rule"; the frozen
// W131 Group 4/5 vocabulary): Web is the CANONICAL client, Desktop (Tauri 2)
// the POWER client, Mobile (Expo/React Native) the FIELD client — and this
// contract is the SEMANTIC CORE all three consume.
//
//   CLIENT SESSIONS
//   registerClientSession   — record one server-issued client-session
//      identity (web/desktop/mobile; never client-minted).
//   getClientSession        — tenant-scoped read (derived state).
//   listClientSessions      — filtered list, newest-issued first.
//   revokeClientSession     — the one-way active → revoked transition
//      (FOR UPDATE staleness re-check).
//
//   AUTHORITATIVE STATE (client-agnostic — identical for every client kind)
//   readConversationState   — the conversations seam's own records, bound
//      to a content-addressed projection ref (revision + digest).
//   readCompanyOverview     — current goals + missions as compact typed
//      summaries, content-addressed.
//
//   BACKGROUND-WORK INSPECTION (everywhere, identical semantics)
//   listBackgroundWork      — the typed feed across the seams (missions
//      W011, agent-exchange execution runs W136, execution-fabric leases
//      W137), normalized phases + verbatim seam statuses.
//   getBackgroundWorkItem   — one item by seam + ref (typed not-found).
//
//   PLATFORM-NATIVE CAPABILITIES (adapters, never authorities)
//   registerPlatformAdapter / unregisterPlatformAdapter — the in-memory
//      runtime wiring (one registration per platform kind; removal is
//      the neutrality proof — no domain contract changes).
//   listPlatformAdapters / probePlatformCapabilities — honest descriptors.
//   invokePlatformCapability — one vendor-neutral capability call through
//      the registered adapter (explicit refusal when unsupported; typed
//      failure when the vendor path throws).
//
//   CROSS-DEVICE HANDOFF (evidence, append-only)
//   openHandoffSession      — freeze the working context (focus + draft +
//      navigation) on the opening device + first evidence.
//   recordHandoff           — move the session to the receiving device
//      (verbatim context; 'handoff-recorded' evidence).
//   resumeHandoff           — restore the EXACT working context on the
//      receiving device, re-projected from CURRENT server state; a stale
//      client revision is discarded and the discard recorded.
//   closeHandoffSession     — the one-way open → closed transition
//      (FOR UPDATE staleness re-check).
//   getHandoffSession / listHandoffSessions — the spine, tenant-scoped.
//   listHandoffEvidence     — the append-only trail, timeline order.
//
//   THE PRODUCT SHELL READ MODEL (W057 semantics, contract-level only)
//   readShellModel          — nav areas, command search, notification
//      entry, context drawer, tenant/workspace switcher — ONE typed
//      projection for every client kind. The web app remains the
//      CANONICAL renderer (the module ruling); no UI code lives here.
//
// There is deliberately NO operation that mints domain truth: no
// conversation/message write (conversations W029 owns that), no goal or
// mission write (W008/W011), no execution (W021/W136), no notification
// creation (the notifications module), no tenant/workspace mutation (the
// organizations module) and NO local client authority of any kind — a
// client's offline queue holds pending projections of intent only (the
// frozen W131 offline admission negatives; the server decides). The
// storage layer enforces the same discipline with triggers: the handoff
// evidence trail rejects UPDATE/DELETE/TRUNCATE, the working context is
// immutable from creation, and both lifecycles are one-way.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's client
// sessions or handoff state (including evidence trails) is reported as
// `session_not_found` / `handoff_not_found` — no existence leak.
// ============================================================================

// Client sessions.
export {
  getClientSession,
  listClientSessions,
  registerClientSession,
  revokeClientSession,
} from './service';

// Authoritative state projections (client-agnostic).
export { readCompanyOverview, readConversationState } from './service';

// Background-work inspection.
export { getBackgroundWorkItem, listBackgroundWork } from './service';

// Platform-native capability adapters.
export {
  invokePlatformCapability,
  listPlatformAdapters,
  probePlatformCapabilities,
  registerPlatformAdapter,
  unregisterPlatformAdapter,
} from './service';

// Cross-device handoff.
export {
  closeHandoffSession,
  getHandoffSession,
  listHandoffEvidence,
  listHandoffSessions,
  openHandoffSession,
  recordHandoff,
  resumeHandoff,
} from './service';

// The product shell read model.
export { readShellModel } from './service';

export { CrossPlatformError } from './errors';
export type { CrossPlatformErrorCode } from './errors';

// The validation surface (guards, limits, vocabularies + the canonical
// serialization/digest clients use to verify served projections).
export {
  BACKGROUND_WORK_PHASES,
  BACKGROUND_WORK_SEAMS,
  CLIENT_SESSION_STATES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MESSAGE_LIMIT,
  HANDOFF_EVIDENCE_KINDS,
  HANDOFF_FOCUS_KINDS,
  MAX_CAPABILITY_INPUT_BYTES,
  MAX_DEVICE_LABEL_CHARS,
  MAX_DRAFT_CHARS,
  MAX_FOCUS_REF_CHARS,
  MAX_LIST_LIMIT,
  MAX_MESSAGE_LIMIT,
  MAX_NAVIGATION_FOCUS_CHARS,
  MAX_TOWER_SURFACE_CHARS,
  PLATFORM_CAPABILITY_DOMAINS,
  PLATFORM_KINDS,
  PRODUCT_AREA_IDS,
  TOWER_SURFACE_SLUGS,
  assertCrossPlatformTenantContext,
  canonicalJson,
  digestOf,
  isBackgroundWorkPhase,
  isBackgroundWorkSeam,
  isCapabilityDomain,
  isClientSessionState,
  isHandoffEvidenceKind,
  isHandoffFocusKind,
  isPlatformKind,
  isProductAreaId,
  isTowerSurfaceSlug,
  isUuid,
} from './validation';

// The deterministic platform adapter doubles (web/desktop/mobile) — the
// sanctioned implementations of the adapter SPI, exported for wiring and
// proofs exactly like the W137 execution adapters.
export { createWebPlatformAdapter } from './adapters/web-adapter';
export type { WebPlatformAdapter, WebPlatformAdapterOptions, WebPlatformAdapterState } from './adapters/web-adapter';
export { createDesktopPlatformAdapter } from './adapters/desktop-adapter';
export type {
  DesktopPlatformAdapter,
  DesktopPlatformAdapterOptions,
  DesktopPlatformAdapterState,
} from './adapters/desktop-adapter';
export { createMobilePlatformAdapter } from './adapters/mobile-adapter';
export type {
  MobilePlatformAdapter,
  MobilePlatformAdapterOptions,
  MobilePlatformAdapterState,
} from './adapters/mobile-adapter';

export type {
  // Client sessions
  ClientSession,
  ListClientSessionsQuery,
  RegisterClientSessionInput,
  RevokeClientSessionInput,
  // Authoritative state projections
  CompanyGoalSummary,
  CompanyMissionSummary,
  CompanyOverviewProjection,
  ConversationStateProjection,
  ReadCompanyOverviewQuery,
  ReadConversationStateQuery,
  StateProjectionKind,
  // Background-work inspection
  BackgroundWorkItem,
  BackgroundWorkPhase,
  BackgroundWorkSeam,
  GetBackgroundWorkItemInput,
  ListBackgroundWorkQuery,
  // Platform-native capability adapters
  PlatformAdapter,
  PlatformAdapterDescriptor,
  PlatformAdapterHealth,
  PlatformCapabilityDeclaration,
  PlatformCapabilityDomain,
  PlatformCapabilityReceipt,
  PlatformCapabilityRequest,
  PlatformVendorMetadata,
  // Cross-device handoff
  CloseHandoffSessionInput,
  ContinuityConflictResolution,
  GetHandoffSessionQuery,
  HandoffEvidence,
  HandoffEvidenceKind,
  HandoffFocusKind,
  HandoffResumption,
  HandoffSession,
  HandoffWorkingContext,
  ListHandoffEvidenceQuery,
  ListHandoffSessionsQuery,
  OpenHandoffSessionInput,
  RecordHandoffInput,
  ResumeHandoffInput,
  ShellNavigationState,
  // The product shell read model
  ProductAreaId,
  ProductShellModel,
  ReadShellModelQuery,
  ShellArea,
  ShellCommandEntry,
  ShellCommandTargetKind,
  ShellContextDrawer,
  ShellNotificationEntry,
  ShellTenantSwitcher,
  ShellWorkspaceRef,
} from './types';

// The frozen W131 client/continuity vocabulary (ClientPlatformKind,
// ClientSessionState, CompanyStateProjectionRef, ContinuityConflict,
// ContinuityHandoffSemantics) and the conversations seam's read shapes
// (Conversation, Message) are re-exported THROUGH ./types — the single
// re-export point, so this contract has no duplicate export paths.
