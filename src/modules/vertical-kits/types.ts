// Public domain types of the vertical-kits module (W092 — Vertical
// Extension Starter Kits).
//
// W092 owns the KIT layer of the specialist-capability story:
// "Create reusable specialist extension/agent starter kits and first deep
//  integrations for system-of-record-heavy industries without moving
//  vertical semantics into Aurum core."
//
// WHAT A KIT IS. A vertical kit is a versioned, signed-manifest package
// of specialist extension definitions and agent definitions for ONE
// vertical (a system-of-record-heavy industry), carrying its own
// capability declarations and vertical data-schema hints. EVERYTHING
// vertical lives inside the kit manifest — core modules stay
// industry-independent (the work item's hard boundary). A kit is:
//
//   * VERSIONED   — release semvers, strictly increasing per kit key (the
//     extensions module's manifest discipline: a changed declaration is a
//     NEW version, never an edit);
//   * SIGNED      — every stored version carries the sha-256 digest of
//     the canonical JSON serialization of its frozen manifest, computed
//     at registration; the digest is the manifest's integrity signature,
//     and verification re-derives it over the STORED bytes (a row edited
//     outside the service fails the manifest-integrity check — drift is
//     visible as a new failed run, never as a rewrite);
//   * INSTALLABLE — through the tenant install lifecycle (below);
//   * PERMISSION-SCOPED — the kit declares required capabilities; install
//     routes the tenant's grant review through the actions module's
//     authority gate (W009, kind 'vertical-kit-deployment' × EXECUTE —
//     the capability-grants pattern, kit-scoped: approval mints exactly
//     the declared scope, rejection mints nothing);
//   * AUDITABLE  — every install/review/activate/suspend/resume/remove
//     and every minted/revoked grant is an append-only event, and every
//     capability invocation verdict (allowed or denied) is an
//     append-only ledger row;
//   * REMOVABLE  — removal revokes every grant the kit holds (no
//     orphaned authority) while the audit trail is retained.
//
// THE INSTALL LIFECYCLE (the extensions-registry + marketplace
// publication patterns, deliberately not a forked second lifecycle
// model — see lifecycle.ts for the named transitions):
//
//   registry side:  registerKitVersion (immutable, strictly increasing)
//                   → runKitVerification (append-only deterministic
//                     static checks; install requires VERIFIED)
//   install side:   installKit (W009 gate routed) →
//                     'pending-review' ─ awaiting the human grant review
//                     'rejected'       — the review (or tenant policy)
//                                        refused the kit; terminal
//                     'granted'        — the review approved; the kit's
//                                        capability grants are minted
//                     'active'         — activated, usable
//                     'suspended' ⇄ back to 'active'
//                     'removed'        — terminal; grants revoked
//
// THE EDGE SEAM (DEFERRED-ON-W088). A kit declares the
// system-of-record integrations it wants to reach (edgeIntegrations).
// The kit runtime's deep-integration execution path is expressed
// against the `VerticalKitEdge` port — a clean, provider-neutral adapter
// seam the kit runtime calls. NO implementation is wired by default: the
// Edge Connector (W088, in flight) is the future implementor, and once
// it lands an adapter will route kit integrations through the W082/W083
// connection + grant machinery and compose them onto the W084 deep-action
// pipeline (discover→inspect→propose→authorize→execute→verify→reconcile).
// Until then, executing or inspecting a kit integration without a wired
// edge fails explicitly with `edge_unavailable` — the module never fakes
// success, never stubs Edge internals and never guesses W088's API.

// ---------------------------------------------------------------------------
// Capability declarations (the kit's requested authority — the W081/W083
// plain-language capability vocabulary, kit-scoped)
// ---------------------------------------------------------------------------

/**
 * One capability a kit requires to serve its vertical. The key follows
 * the W081 read./write. convention; label and dataCategories are the
 * plain-language descriptors the tenant's reviewers see at the install
 * grant review (the approver-facing payload of the W009 request).
 */
export interface KitCapabilityDeclaration {
  /** Canonical capability key (e.g. 'write.case-matters'). */
  key: string;
  /** Plain-language label of what the capability lets the kit do. */
  label: string;
  /** Data categories exercising this capability puts in play. */
  dataCategories: string[];
  /** 'read' or 'write' (derived from the key; mirrored for reviewers). */
  mode: 'read' | 'write';
}

// ---------------------------------------------------------------------------
// Starter component definitions (frozen INSIDE the kit manifest)
// ---------------------------------------------------------------------------

/**
 * One starter EXTENSION definition inside a kit — the W025 manifest shape
 * in kit form. These are definitions, not deployed software:
 * materializing a definition into the tenant's extension registry (the
 * extensions module's own registration/deployment lifecycle) is a
 * downstream step this module deliberately does not perform. The
 * declarations are validated with the extensions module's OWN pure
 * consistency rules (permission ↔ capability, quotas, vocabulary) so a
 * kit's extension definitions are shaped exactly like real ones.
 */
export interface KitExtensionDefinition {
  /** Stable slug naming the definition within the kit. */
  definitionKey: string;
  displayName: string;
  description: string;
  /** The normalized capability declaration (W025 shape). */
  capabilities: {
    stateScope: 'none' | 'tenant' | 'install';
    uiSurfaces: string[];
    schedules: { name: string; cron: string }[];
    eventSubscriptions: string[];
    externalParticipants: { label: string; origin: string }[];
    telemetry: boolean;
  };
  /** The declared resource ceilings (W025 shape). */
  quotas: {
    maxStateBytes: number;
    maxScheduleInvocationsPerDay: number;
    maxExternalCallsPerDay: number;
  };
  /** The requested permission ceiling — EXACTLY what the declared
   * capabilities require (the extensions module's least-privilege rule,
   * re-checked by kit verification). */
  requestedPermissions: string[];
}

/**
 * One starter AGENT definition inside a kit — the agents module's
 * definition shape in kit form (role, operating instructions, runtime
 * provider, permission scopes), validated against the agents module's
 * own closed vocabularies. Same as extension definitions, these are
 * definitions, not recruited agents; recruitment follows the agents
 * module's own governed lifecycle downstream.
 */
export interface KitAgentDefinition {
  /** Stable slug naming the definition within the kit. */
  definitionKey: string;
  displayName: string;
  /** The specialist role (e.g. 'legal case-management specialist'). */
  role: string;
  description: string;
  /** Canonical runtime provider key (agents module vocabulary). */
  provider: string;
  /** The agent's operating contract — what it is instructed to do. */
  instructions: string;
  /** Permission scopes (the §20 authority words the agent may act at). */
  permissions: string[];
}

// ---------------------------------------------------------------------------
// Vertical data-schema hints (kit-carried, never core)
// ---------------------------------------------------------------------------

/** One field of a vertical data-schema hint. */
export interface KitSchemaHintField {
  name: string;
  /** Plain-language type hint ('string', 'date', 'decimal', ...). */
  type: string;
  required: boolean;
  note?: string | null;
}

/**
 * One vertical data-schema hint: the shape of a system-of-record entity
 * the kit works with, expressed as plain-language field hints. Hints
 * live INSIDE the kit manifest — no vertical table, column or string
 * ever reaches a core module. They guide the future Edge mapping work
 * (W088/W094) and the tenant's own configuration.
 */
export interface KitDataSchemaHint {
  /** The vertical entity ('matter', 'journal-entry', ...). */
  entity: string;
  label: string;
  fields: KitSchemaHintField[];
  note?: string | null;
}

// ---------------------------------------------------------------------------
// Edge integration declarations (the DEFERRED-ON-W088 deep-integration
// surface)
// ---------------------------------------------------------------------------

/**
 * One declared system-of-record integration of a kit: the external
 * system family the kit's deep integration reaches THROUGH the Edge
 * Connector once W088 lands. The declaration is provider-neutral by
 * construction — a plain-language system label plus the kit capabilities
 * the integration exercises (its read and its write path). Executing or
 * inspecting an integration rides the `VerticalKitEdge` port; with no
 * edge wired, the path fails explicitly (`edge_unavailable`).
 */
export interface KitEdgeIntegrationDeclaration {
  /** Stable slug naming the integration within the kit. */
  integrationKey: string;
  /** Plain-language system-of-record label. */
  systemLabel: string;
  description: string;
  /** The kit capability the read/inspect path exercises. */
  readCapabilityKey: string;
  /** The kit capability the write/execute path exercises — null for a
   * read-only integration (no execute path; least privilege). */
  writeCapabilityKey: string | null;
  /** Which schema-hint entities this integration touches (references
   * into the same manifest's dataSchemaHints). */
  schemaHintEntities: string[];
}

// ---------------------------------------------------------------------------
// The kit manifest
// ---------------------------------------------------------------------------

/**
 * A vertical kit manifest — the frozen, versioned, digest-signed content
 * package. Everything vertical lives here: the capability declarations,
 * the starter extension/agent definitions, the vertical data-schema
 * hints and the edge integration declarations. The first-class content
 * shipped by this module (kits.ts) registers into a tenant's registry
 * through `registerKitVersion` and installs through `installKit`.
 */
export interface VerticalKitManifest {
  /** The versioned manifest FORMAT this manifest obeys (currently 1). */
  kitSchemaVersion: number;
  /** Stable kit identity across versions (e.g. 'legal-case-management'). */
  kitKey: string;
  /** Release semver ('1.0.0') — strictly increasing per kit key. */
  version: string;
  /** The vertical family the kit serves (grouping metadata only —
   * core never interprets it). */
  verticalKey: string;
  displayName: string;
  description: string;
  /** The kit's requested authority — reviewed at install. */
  requiredCapabilities: KitCapabilityDeclaration[];
  /** Starter extension definitions (stay inside the kit). */
  extensionDefinitions: KitExtensionDefinition[];
  /** Starter agent definitions (stay inside the kit). */
  agentDefinitions: KitAgentDefinition[];
  /** Vertical data-schema hints (stay inside the kit). */
  dataSchemaHints: KitDataSchemaHint[];
  /** Declared system-of-record integrations (DEFERRED-ON-W088 paths). */
  edgeIntegrations: KitEdgeIntegrationDeclaration[];
}

// ---------------------------------------------------------------------------
// Registry rows (kit versions + verifications)
// ---------------------------------------------------------------------------

/** One immutable registered kit version (the registry row). */
export interface VerticalKitVersion {
  id: string;
  tenantId: string;
  kitKey: string;
  version: string;
  kitSchemaVersion: number;
  verticalKey: string;
  displayName: string;
  description: string;
  /** The frozen manifest content. */
  manifest: VerticalKitManifest;
  /** The sha-256 digest of the canonical JSON of `manifest`. */
  manifestDigest: string;
  registeredBy: string;
  registeredAt: string;
}

/** A kit version with its DERIVED verification state (latest run decides). */
export interface VerticalKitVersionWithVerification extends VerticalKitVersion {
  verification: {
    state: 'unverified' | 'verified' | 'failed';
    latestRun: VerticalKitVerification | null;
  };
}

/** A kit version summary (list reads). */
export interface VerticalKitVersionSummary extends VerticalKitVersion {
  verificationState: 'unverified' | 'verified' | 'failed';
}

/** The outcome of one deterministic verification check. */
export interface KitVerificationCheckResult {
  check: string;
  passed: boolean;
  detail: string | null;
}

/**
 * One append-only verification run of one kit version. The run records
 * the outcome of every check in the closed vocabulary plus a
 * human-readable summary; runs are never updated or deleted, so the
 * verification history is reconstructable (§24) and drift (a rule added
 * later failing an older manifest, or a row edited outside the service)
 * is visible as a new run, never a rewrite.
 */
export interface VerticalKitVerification {
  id: string;
  tenantId: string;
  kitVersionId: string;
  outcome: 'verified' | 'failed';
  /** Per-check outcomes, in canonical check order. */
  checks: KitVerificationCheckResult[];
  summary: string;
  verifier: string;
  ranAt: string;
}

// ---------------------------------------------------------------------------
// Installations (the tenant lifecycle rows)
// ---------------------------------------------------------------------------

/** The installation lifecycle states (see lifecycle.ts for transitions). */
export type KitInstallationStatus =
  | 'pending-review'
  | 'rejected'
  | 'granted'
  | 'active'
  | 'suspended'
  | 'removed';

/** One kit capability grant minted by an approved install review. */
export interface KitCapabilityGrant {
  id: string;
  tenantId: string;
  installationId: string;
  capabilityKey: string;
  label: string;
  dataCategories: string[];
  status: 'active' | 'revoked';
  grantedBy: string;
  grantedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
}

/** The concrete task a kit capability invocation serves (W083 shape). */
export interface KitTaskContext {
  /** What the task is, in plain organizational language. */
  description: string;
  /** Optional plain-language link to what the task is for. */
  requestedFor?: string | null;
}

/** Why the invocation gate decided what it decided. */
export type KitInvocationBasis = 'kit-grant' | 'grant-missing' | 'installation-inactive';

/** One capability invocation verdict — append-only evidence. */
export interface KitCapabilityInvocation {
  id: string;
  tenantId: string;
  installationId: string;
  capabilityKey: string;
  outcome: 'allowed' | 'denied';
  basis: KitInvocationBasis;
  /** The deterministic plain-language denial (denied only). */
  denialReason: string | null;
  taskContext: KitTaskContext;
  invokedBy: string;
  invokedAt: string;
}

/** One executed system-of-record action through a wired edge. */
export interface KitEdgeAction {
  id: string;
  tenantId: string;
  installationId: string;
  integrationKey: string;
  /** The write capability the action exercised (the gate link below). */
  capabilityKey: string;
  /** The allowed invocation that authorized the write. */
  invocationId: string;
  receiptStatus: 'accepted' | 'rejected' | 'failed';
  /** The edge's own opaque action receipt id (never interpreted). */
  receiptId: string | null;
  receiptDetail: string | null;
  /** The opaque wiring identity of the edge that executed. */
  edgeId: string;
  executedBy: string;
  executedAt: string;
}

/** One append-only installation lifecycle event. */
export interface KitInstallationEvent {
  id: string;
  tenantId: string;
  installationId: string;
  position: number;
  event: string;
  detail: string | null;
  recordedBy: string;
  recordedAt: string;
}

/** One installation with its grants (the full read model). */
export interface KitInstallationDetail {
  installation: KitInstallation;
  /** The frozen required-capability snapshot of the install. */
  requiredCapabilities: KitCapabilityDeclaration[];
  grants: KitCapabilityGrant[];
}

/** The installation row (see KitInstallationDetail for the full read). */
export interface KitInstallation {
  id: string;
  tenantId: string;
  kitKey: string;
  kitVersion: string;
  kitVersionId: string;
  status: KitInstallationStatus;
  /** The actions module's ActionRequest id — the W009 gate record the
   * install review routed through (always set: install routes the gate
   * in the same transaction that creates the row). */
  actionRequestId: string;
  installedBy: string;
  installedAt: string;
  reviewedAt: string | null;
  activatedAt: string | null;
  suspendedAt: string | null;
  removedAt: string | null;
  removalReason: string | null;
}

// ---------------------------------------------------------------------------
// The honest status report
// ---------------------------------------------------------------------------

/** The readiness of one declared integration. */
export interface KitIntegrationReadiness {
  integrationKey: string;
  systemLabel: string;
  /** 'deferred-on-w088' until an edge is wired; 'ready' once one is. */
  readiness: 'deferred-on-w088' | 'ready';
  /** The wired edge's opaque identity (ready only). */
  edgeId: string | null;
}

/** One kit component's honest state. */
export interface KitComponentStatus {
  definitionKey: string;
  displayName: string;
  /** 'defined' — starter definitions inside the kit, NOT deployed
   * software; materialization into the extension/agent registries is a
   * downstream governed step this module does not perform. */
  state: 'defined';
}

/**
 * The honest health/status report of one installation: what is
 * installed, which capabilities hold authority, which components are
 * defined (never claimed as running), which integrations are deferred on
 * the Edge Connector, and the latest audit events. The report never
 * claims execution the module is not performing.
 */
export interface KitStatusReport {
  installationId: string;
  kitKey: string;
  kitVersion: string;
  status: KitInstallationStatus;
  grants: { active: number; revoked: number };
  extensions: KitComponentStatus[];
  agents: KitComponentStatus[];
  integrations: KitIntegrationReadiness[];
  /** The opaque edge wiring identity, or null when no edge is wired. */
  edgeWired: string | null;
  invocations: { allowed: number; denied: number };
  recentEvents: KitInstallationEvent[];
}

// ---------------------------------------------------------------------------
// The edge port (the DEFERRED-ON-W088 adapter seam)
// ---------------------------------------------------------------------------

/** A kit runtime edge inspection request (the read path). */
export interface VerticalKitEdgeInspectRequest {
  installationId: string;
  integrationKey: string;
  capabilityKey: string;
  /** Opaque external entity reference (the provider-side record id). */
  target: string;
}

/** A kit runtime edge execution request (the write path). */
export interface VerticalKitEdgeExecuteRequest {
  installationId: string;
  integrationKey: string;
  capabilityKey: string;
  /** Opaque external entity reference. */
  target: string;
  /** The canonical write payload (plain JSON object; the edge adapter
   * composes the provider-native request — lock 16). */
  payload: Record<string, unknown>;
}

/** The canonical state an edge inspection returned (plain JSON only). */
export interface VerticalKitEdgeState {
  found: boolean;
  state: unknown;
}

/** The canonical action receipt an edge execution returned. */
export interface VerticalKitEdgeReceipt {
  status: 'accepted' | 'rejected' | 'failed';
  /** The provider's own opaque receipt id, or null when it gave none. */
  receiptId: string | null;
  detail: string | null;
}

/**
 * The kit runtime's system-of-record edge port — the clean seam every
 * deep-integration path calls. The Edge Connector (W088, in flight in a
 * parallel work stream) is the intended future implementor: once it
 * lands, an adapter will implement this port over the brokered
 * connections and progressive grants (W082/W083), composing kit writes
 * onto the W084 deep-action pipeline so every execution carries its
 * full evidence chain. Until then the port stays unwired and the
 * execution paths fail explicitly (`edge_unavailable`) — never stubbed,
 * never faked.
 */
export interface VerticalKitEdge {
  /** Opaque wiring identity recorded on executed actions. */
  readonly edgeId: string;
  inspect(request: VerticalKitEdgeInspectRequest): Promise<VerticalKitEdgeState>;
  execute(request: VerticalKitEdgeExecuteRequest): Promise<VerticalKitEdgeReceipt>;
}

// ---------------------------------------------------------------------------
// Inputs and queries
// ---------------------------------------------------------------------------

/** Input of `registerKitVersion` — a full kit manifest. */
export interface RegisterKitVersionInput {
  manifest: VerticalKitManifest;
}

/** What `registerKitVersion` returns: the stored version. */
export interface RegisterKitVersionResult {
  version: VerticalKitVersion;
}

/** Input of `installKit`. */
export interface InstallKitInput {
  kitKey: string;
  version: string;
  /** The approver-facing justification carried on the W009 request. */
  justification?: string | null;
}

/** Input of `decideKitReview` (the human grant-review decision). */
export interface DecideKitReviewInput {
  installationId: string;
  decision: 'approve' | 'reject';
  note?: string | null;
}

/** Input of `activateKit` / `resumeKit`. */
export interface InstallationTargetInput {
  installationId: string;
}

/** Input of `suspendKit` / `removeKit`. */
export interface SuspendedRemovalInput {
  installationId: string;
  reason?: string | null;
}

/** Input of `invokeKitCapability` — the pre-execution authority gate. */
export interface InvokeKitCapabilityInput {
  installationId: string;
  capabilityKey: string;
  taskContext: KitTaskContext;
}

/** Input of `inspectKitIntegration` (the edge read path). */
export interface InspectKitIntegrationInput {
  installationId: string;
  integrationKey: string;
  /** Opaque external entity reference to inspect. */
  target: string;
  taskContext: KitTaskContext;
}

/** Input of `executeKitIntegration` (the edge write path). */
export interface ExecuteKitIntegrationInput {
  installationId: string;
  integrationKey: string;
  /** Opaque external entity reference to write. */
  target: string;
  /** The canonical write payload (plain JSON object). */
  payload: Record<string, unknown>;
  taskContext: KitTaskContext;
}

/** Result of `inspectKitIntegration`: the gate verdict plus the state. */
export interface InspectKitIntegrationResult {
  /** The recorded read-capability invocation (allowed or the denial that
   * stopped the inspection). */
  invocation: KitCapabilityInvocation;
  /** The canonical state (null when the invocation was denied). */
  state: VerticalKitEdgeState | null;
}

/** Result of `executeKitIntegration`: the gate verdict plus the receipt. */
export interface ExecuteKitIntegrationResult {
  /** The recorded write-capability invocation (allowed or the denial that
   * stopped the write). */
  invocation: KitCapabilityInvocation;
  /** The executed action row (null when the invocation was denied). */
  receipt: KitEdgeAction | null;
}

/** Query of `getKitVersion`. */
export interface GetKitVersionQuery {
  kitVersionId: string;
}

/** Query of `listKitVersions`. */
export interface ListKitVersionsQuery {
  kitKey?: string | null;
}

/** Query of `getKitInstallation` / `getKitStatus` / lifecycle operations. */
export interface GetInstallationQuery {
  installationId: string;
}

/** Query of `listKitInstallations`. */
export interface ListKitInstallationsQuery {
  status?: KitInstallationStatus | null;
}

/** Query of `listKitInvocations` / `listKitEdgeActions` / `listKitEvents`. */
export interface ListInstallationRecordsQuery {
  installationId: string;
  limit?: number;
}
