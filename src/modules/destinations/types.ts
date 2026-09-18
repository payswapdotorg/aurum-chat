// Public domain types of the destinations module (W037 — Destination
// Gateway).
//
// W037 owns provider-independent OUTBOUND connectors: "Provider-independent
// outbound destinations for BI, warehouses, CRM/ERP, spreadsheets, APIs and
// webhooks with authorization and provenance" (ARCHITECTURE.md §10:
// destination connectors publish authorized Aurum findings/results to
// analytics systems, warehouses, BI tools, CRMs, ERPs, spreadsheets, APIs
// and webhooks; ADR-0009: the Destination Gateway is provider-independent
// and analogous to Sources — and destinations NEVER become domain truth).
//
// Everything here is provider-neutral BY CONSTRUCTION (lock 16 analog /
// ADR-0015 provider independence): providers appear only as the canonical
// `DestinationProvider` key owned by this module's validation vocabulary;
// provider-native request shapes, account-id semantics and delivery-ack
// conventions are composed inside `adapters/` and never leave this module
// in their raw form. The only provider-minted values that cross the
// boundary are OPAQUE strings (account ids, delivery ids).
//
// Credential isolation (GOVERNANCE mandatory invariant; IMPLEMENTATION-
// STACK §8, mirroring the sources module): `credentialRef` is an OPAQUE
// reference into the secret store. OAuth token values, API keys, passwords
// and signing secrets never reach a domain table, a log line or a contract
// result. The domain tracks only NON-SECRET authorization STATE: the
// authorization kind, the granted scopes and the grant's expiry.
//
// AUTHORIZATION is deliberately TWO-LAYERED (the work item's acceptance
// core), with a third evidence-level layer:
//   1. PROVIDER authorization — the OAuth/credentials grant recorded on
//      the destination (mirrors sources: lapsed grants fail fast,
//      re-registration is the re-authorization path, transport-reported
//      refreshes advance the recorded expiry);
//   2. ACTION authorization — every outbound delivery is gated through the
//      actions module's authority matrix (W009) as the canonical §20 kind
//      'data-export' at the EXECUTE level. Under the built-in default
//      matrix EXECUTE is approval-gated, so exports wait for an explicit
//      human decision until tenant policy says otherwise (GOVERNANCE:
//      "high-impact actions are policy-gated").
//   3. EVIDENCE-level authorization — a delivery that references
//      observations as its provenance may only export evidence the calling
//      principal may read (the observations contract enforces tenant and
//      principal visibility) and NEVER evidence tagged 'no-export' (the
//      W004 usage-constraint tag this module consumes, exactly as the
//      actions module's dependency posture anticipated for W037).
//
// PROVENANCE: every delivery records who requested it, when, what content
// (kind + records), which evidence it derives from
// (`provenanceObservationIds`), which authority-gate request authorized it
// (`actionRequestId`), which earlier delivery it replays
// (`replayedFromId`), and one append-only attempt row per physical
// delivery attempt carrying the EXACT adapter-formatted envelope handed to
// the transport plus the provider's opaque acknowledgment. §10's delivery
// guarantees map as follows (all tested):
//   * idempotency — a caller-supplied idempotency key replays the original
//     delivery (first write wins; no second gate request, no second
//     delivery); the gate itself is authorized ONCE per delivery through a
//     stable key and replayed ever after;
//   * checkpointing — the append-only delivery ledger IS the outbound
//     checkpoint: outbound units are whole payloads, not resumable
//     windows, so the per-delivery terminal state (readable through
//     getDelivery/listDeliveries) is the resume point producers reprocess
//     from (the deliberate mirror-image of the sources module's cursors);
//   * retries — retryDelivery re-attempts a 'pending' (approval may have
//     landed) or 'failed' (transient transport failure) delivery, appending
//     the next attempt row;
//   * replay/reprocessing — replayDelivery re-delivers a recorded payload
//     as a NEW delivery (fresh full gate authorization, fresh attempts,
//     `replayedFromId` linking back);
//   * audit — attempts are append-only storage-level (triggers); the
//     delivery ledger is forward-only and substantive-immutable.
//
// ADR-0009's "destinations never become domain truth" is carried by
// construction: this module records NO observations and exposes NO
// operation that promotes a delivery or an acknowledgment into evidence,
// claims or beliefs — delivery records are outbound audit state only.

// ---------------------------------------------------------------------------
// Providers, categories, statuses
// ---------------------------------------------------------------------------

/**
 * Canonical destination-provider vocabulary (owned by this module — the
 * outbound counterpart of the sources module's provider keys), spanning the
 * six families of the work item: BI (looker, tableau, power-bi),
 * warehouses (snowflake, bigquery, redshift), CRM/ERP (salesforce,
 * hubspot, netsuite), spreadsheets (google-sheets, airtable), APIs
 * (http-api) and webhooks (webhook). Mirrored by the `provider` CHECK in
 * migrations/001 and the adapter registry.
 */
export type DestinationProvider =
  | 'looker'
  | 'tableau'
  | 'power-bi'
  | 'snowflake'
  | 'bigquery'
  | 'redshift'
  | 'salesforce'
  | 'hubspot'
  | 'netsuite'
  | 'google-sheets'
  | 'airtable'
  | 'http-api'
  | 'webhook';

/**
 * Canonical destination family (the work item's six categories), derived
 * from the provider's adapter — provider-neutral classification, never a
 * provider object.
 */
export type DestinationCategory =
  | 'bi'
  | 'warehouse'
  | 'crm-erp'
  | 'spreadsheet'
  | 'api'
  | 'webhook';

export type DestinationStatus = 'active' | 'disabled';

/**
 * How the tenant authorized the connector (non-secret classification of
 * the credential held in the secret store behind `credentialRef`).
 */
export type DestinationAuthKind = 'oauth' | 'credentials';

/** Lifecycle of one outbound delivery (forward-only; see migrations/002). */
export type DeliveryStatus = 'pending' | 'delivered' | 'rejected' | 'failed';

/** Provider-neutral outcome of one physical delivery attempt. */
export type DeliveryOutcome = 'delivered' | 'rejected' | 'failed';

// ---------------------------------------------------------------------------
// Canonical outbound records (the unit of export)
// ---------------------------------------------------------------------------

/**
 * One record of an outbound export batch — the provider-neutral unit of
 * delivery. `recordId` is the record's stable identity within the batch
 * (unique per delivery; providers that dedupe by external id carry it in
 * their adapter-composed envelope). `data` is the record's content — any
 * plain JSON value for envelope-style providers (`webhook`, `http-api`);
 * structured stores (warehouses, BI, spreadsheets, CRM/ERP) require a
 * plain JSON OBJECT per record (adapter-declared, validated at dispatch —
 * `invalid_delivery_records` otherwise).
 */
export interface CanonicalOutboundRecord {
  recordId: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// Destinations (tenant-owned outbound connectors)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped outbound connector: one authorized provider endpoint the
 * tenant publishes Aurum findings/results to (a Snowflake database, a
 * Looker instance, a Salesforce org, a Google Sheets spreadsheet, a
 * webhook URL, …) — ARCHITECTURE.md §3/§10: tenants own their
 * destinations.
 *
 * `credentialRef` is an OPAQUE secret-store reference; the credential value
 * never reaches any domain table (IMPLEMENTATION-STACK §8; GOVERNANCE:
 * connector credentials are tenant-scoped and never stored in semantic
 * memory). OAuth metadata (`oauthScopes`, `oauthExpiresAt`) is non-secret
 * authorization state; it is incoherent (and rejected) for
 * `credentials`-authorized destinations. For `webhook` / `http-api`
 * destinations the `providerAccountId` canonically carries the endpoint
 * ADDRESS (opaque to this module — the transport owns its interpretation);
 * the signing secret / API token stays behind `credentialRef`.
 *
 * `category` and `requiresObjectRecords` are derived, provider-neutral
 * adapter capabilities — never provider objects (lock 16 analog).
 */
export interface Destination {
  id: string;
  tenantId: string;
  provider: DestinationProvider;
  /** Canonical, adapter-normalized account id (opaque string). */
  providerAccountId: string;
  displayName: string | null;
  authKind: DestinationAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted OAuth scopes (oauth destinations only; empty otherwise). */
  oauthScopes: string[];
  /** When the OAuth grant lapses (oauth destinations only; null = non-expiring). */
  oauthExpiresAt: string | null;
  status: DestinationStatus;
  /** Canonical destination family (derived from the provider's adapter). */
  category: DestinationCategory;
  /** Whether every record's data must be a plain JSON object for this provider. */
  requiresObjectRecords: boolean;
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on status/authorization changes only. */
  updatedAt: string;
}

export interface RegisterDestinationInput {
  provider: DestinationProvider;
  /** Raw provider account id; normalized by the provider's adapter. */
  providerAccountId: string;
  displayName?: string | null;
  authKind: DestinationAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted scopes; required to be empty for `credentials` destinations. */
  oauthScopes?: string[];
  /** Grant expiry (strict ISO 8601); required to be null for `credentials` destinations. */
  oauthExpiresAt?: string | null;
}

/**
 * Result of `registerDestination`. Re-registering an EXISTING destination
 * is the re-authorization path: it updates the authorization fields (auth
 * kind, credential reference, scopes, expiry) and reports `created: false`
 * — the connector's identity (provider, account, delivery history) never
 * changes.
 */
export interface RegisterDestinationResult {
  destination: Destination;
  created: boolean;
}

export interface ListDestinationsQuery {
  provider?: DestinationProvider;
  category?: DestinationCategory;
  status?: DestinationStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetDestinationStatusInput {
  destinationId: string;
  status: DestinationStatus;
}

// ---------------------------------------------------------------------------
// Deliveries (the outbound ledger)
// ---------------------------------------------------------------------------

/**
 * One outbound delivery: a canonical export batch bound for one registered
 * destination, carrying its full provenance. Substantive fields (kind,
 * records, provenance, destination, requester) are immutable history; only
 * the lifecycle `status` moves, and only FORWARD ('pending' → terminal;
 * 'failed' → terminal or stayed-'failed' on another transient retry) —
 * storage-level (migrations/002).
 *
 * `status` semantics:
 *   * 'pending'   — not yet terminally resolved: awaiting the authority
 *                   gate's human approval, or awaiting a wired transport
 *                   (no attempt has succeeded or terminally failed);
 *   * 'delivered' — terminal; the provider ACCEPTED the batch;
 *   * 'rejected'  — terminal; the authority gate forbade the export, or
 *                   the provider permanently refused it;
 *   * 'failed'    — last attempt failed transiently; retryable.
 */
export interface Delivery {
  id: string;
  tenantId: string;
  destinationId: string;
  /** Provider snapshotted at dispatch (delivery provenance outlives connector changes). */
  provider: DestinationProvider;
  /** Canonical classification of the export batch, e.g. 'findings.opportunities'. */
  kind: string;
  /** The canonical export batch exactly as requested (immutable). */
  records: CanonicalOutboundRecord[];
  /** Evidence the batch derives from (validated observations; may be empty). */
  provenanceObservationIds: string[];
  /** Caller-supplied dedupe key; a recorded key replays the original delivery. */
  idempotencyKey: string | null;
  /** The actions-module request that gated this delivery (one-way fill). */
  actionRequestId: string | null;
  /** The delivery this one replays (reprocessing), when any. */
  replayedFromId: string | null;
  status: DeliveryStatus;
  /** The principal whose dispatch created the delivery. */
  requestedBy: string;
  /** ISO 8601 — service clock. */
  requestedAt: string;
  /** ISO 8601 — service clock; moves on lifecycle transitions only. */
  updatedAt: string;
}

export interface DispatchDeliveryInput {
  destinationId: string;
  /** Canonical classification of the export batch (1..128, canonical pattern). */
  kind: string;
  /** 1..200 canonical outbound records; unique recordIds. */
  records: CanonicalOutboundRecord[];
  /** 0..32 observation uuids the batch derives from (evidence authorization applies). */
  provenanceObservationIds?: string[];
  /** Caller-supplied dedupe key (≤200, canonical pattern); replays when recorded. */
  idempotencyKey?: string | null;
}

export interface DispatchDeliveryResult {
  delivery: Delivery;
  /** false when a recorded idempotency key replayed an existing delivery. */
  created: boolean;
  /**
   * The physical attempt performed, when one happened this call (null when
   * the gate awaits human approval, replayed an earlier delivery, or the
   * gate rejected the export outright).
   */
  attempt: DeliveryAttempt | null;
}

export interface RetryDeliveryInput {
  deliveryId: string;
}

export interface RetryDeliveryResult {
  delivery: Delivery;
  /** The physical attempt performed, when one happened (null while still gated). */
  attempt: DeliveryAttempt | null;
}

/** Input of `replayDelivery` — re-deliver a recorded payload as a NEW delivery. */
export interface ReplayDeliveryInput {
  deliveryId: string;
}

export interface GetDeliveryQuery {
  deliveryId: string;
}

export interface ListDeliveriesQuery {
  destinationId?: string;
  provider?: DestinationProvider;
  kind?: string;
  status?: DeliveryStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface ListDeliveryAttemptsQuery {
  deliveryId: string;
  /** 1..500, default 50. */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Attempts (append-only physical delivery audit)
// ---------------------------------------------------------------------------

/**
 * One physical delivery attempt — append-only audit evidence: the EXACT
 * adapter-formatted envelope the transport was handed (what actually left
 * the system), the provider-neutral outcome, the provider's opaque
 * acknowledgment id and the wall-clock window of the attempt.
 */
export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  /** 1-based; one per physical attempt, unique per delivery. */
  attemptNumber: number;
  /** The adapter-formatted envelope handed to the transport (audit copy). */
  envelope: FormattedDelivery;
  outcome: DeliveryOutcome;
  /** The provider's own delivery/ack id, when it returns one (opaque). */
  providerDeliveryId: string | null;
  detail: string | null;
  /** ISO 8601 — when the attempt began (service clock). */
  startedAt: string;
  /** ISO 8601 — when the attempt completed (service clock). */
  completedAt: string;
}

// ---------------------------------------------------------------------------
// Delivery port (provider-neutral outbound; implementations are
// module-internal)
// ---------------------------------------------------------------------------

/** How an adapter-composed body is meant to be carried to the provider. */
export type FormattedDeliveryShape =
  | 'event' // notification envelope (webhooks)
  | 'records' // keyed upsert semantics (APIs, CRM/ERP, tabular stores)
  | 'rows'; // positional/cell semantics (warehouses, BI, spreadsheets)

/**
 * The adapter-composed request body for one delivery attempt:
 * provider-specific in STRUCTURE (composed by the provider's PRIVATE
 * adapter), provider-neutral in SHAPE — a plain JSON body plus a canonical
 * carriage hint. Opaque to everything outside the transport port.
 */
export interface FormattedDelivery {
  shape: FormattedDeliveryShape;
  body: unknown;
}

/** The provider-neutral request handed to the transport. */
export interface DestinationDeliveryRequest {
  provider: DestinationProvider;
  tenantId: string;
  destinationId: string;
  /** Canonical, adapter-normalized account id (opaque). */
  providerAccountId: string;
  /** Opaque secret-store reference — the transport resolves credentials. */
  credentialRef: string;
  /** The delivery this attempt belongs to (provider-side idempotency where supported). */
  deliveryId: string;
  /** 1-based attempt number (retry hint). */
  attempt: number;
  /** Canonical classification of the export batch. */
  kind: string;
  /** The adapter-composed request body for this attempt. */
  envelope: FormattedDelivery;
}

/**
 * The provider-neutral outcome of one delivery attempt. `status`
 * 'delivered' — the provider ACCEPTED the batch (not "the consumer read
 * it"); 'rejected' — the provider refused it (permanent: bad target,
 * policy, schema mismatch, …); 'failed' — transport error (transient; the
 * delivery stays retryable). `authorizationExpiresAt` is how a transport
 * that REFRESHED an OAuth grant reports the new expiry (non-secret
 * authorization state; the service records it on the destination) —
 * incoherent for credentials-authorized destinations and rejected loudly.
 */
export interface TransportReceipt {
  status: DeliveryOutcome;
  /** The provider's own delivery/ack id, when it returns one (opaque). */
  providerDeliveryId: string | null;
  detail: string | null;
  authorizationExpiresAt?: string | null;
}

/**
 * The delivery port real transports implement. Transports that touch
 * provider SDKs/HTTP must live inside `src/modules/destinations/adapters/`
 * (IMPLEMENTATION-STACK §6 provider isolation); they are wired at process
 * start via `setDestinationTransport`. No transport is wired by default —
 * deliveries then fail explicitly with `provider_unavailable`.
 */
export interface DestinationTransport {
  deliver(request: DestinationDeliveryRequest): Promise<TransportReceipt>;
}
