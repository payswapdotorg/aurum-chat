// Public domain types of the sources module (W036 — Source Gateway).
//
// W036 owns provider-independent INBOUND connectors: "Provider-independent
// inbound connectors with OAuth/credentials isolation, polling/webhooks,
// checkpointing, replay and dedupe" (ARCHITECTURE.md §10: source connectors
// ingest authorized information from internal and external systems, with
// idempotency, checkpointing, retries, replay/reprocessing, provenance and
// audit).
//
// Everything here is provider-neutral BY CONSTRUCTION (lock 16 / the
// provider-boundary rules of MODULE-DEPENDENCY-MAP.md): providers appear
// only as the canonical `SourceProvider` key owned by this module's
// validation vocabulary; provider-native webhook envelopes, record objects
// and cursor semantics are parsed inside `adapters/` and never leave this
// module in their raw shape. The only provider-minted values that cross
// the boundary are OPAQUE strings (account ids, record ids, cursors) —
// exactly the discipline the channels module applies to message ids.
//
// Credential isolation (GOVERNANCE mandatory invariant; IMPLEMENTATION-
// STACK §8): `credentialRef` is an OPAQUE reference into the secret store.
// OAuth token values, API keys and passwords never reach a domain table,
// a log line or a contract result. The domain tracks only NON-SECRET
// authorization STATE: the authorization kind, the granted scopes and the
// grant's expiry.
//
// Ingestion semantics (deliberate, tested):
//   * records become immutable OBSERVATIONS through the observations
//     contract (W004) with lineage method `connector`, provenance
//     `{ kind: 'source', id }` and the provider key as the channel —
//     observation ids on the ledger link every ingested provider record
//     to its evidence (provenance and audit);
//   * the append-only `source_records` ledger is the DEDUPE authority:
//     one observation per (tenant, source, provider record id), ever —
//     webhook redeliveries, poll re-fetches after partial failures and
//     checkpoint replays are all suppressed against it;
//   * polling CHECKPOINTS advance only after the batch is ingested; a
//     mid-batch crash re-fetches the same window on the next poll and
//     dedupe suppresses what was already observed (at-least-once fetch,
//     exactly-once observation per record).

// ---------------------------------------------------------------------------
// Providers, modes, statuses
// ---------------------------------------------------------------------------

/**
 * Canonical source-provider vocabulary (owned by this module — the sources
 * counterpart of the identity module's channel-provider keys). Mirrored by
 * the `provider` CHECK in migrations/001 and the adapter registry.
 */
export type SourceProvider =
  | 'salesforce'
  | 'hubspot'
  | 'zendesk'
  | 'jira'
  | 'linear'
  | 'confluence'
  | 'notion'
  | 'github'
  | 'google-drive'
  | 'google-calendar'
  | 'stripe'
  | 'quickbooks'
  | 'zapier';

/** How a source can be ingested: pulled on a schedule, or pushed to Aurum. */
export type SourceIngestionMode = 'polling' | 'webhook';

/** Which canonical path ingested a provider record. */
export type SourceIngestionVia = 'polling' | 'webhook';

export type SourceStatus = 'active' | 'disabled';

/**
 * How the tenant authorized the connector (non-secret classification of
 * the credential held in the secret store behind `credentialRef`).
 */
export type SourceAuthKind = 'oauth' | 'credentials';

// ---------------------------------------------------------------------------
// Canonical record (adapter output — provider-neutral)
// ---------------------------------------------------------------------------

/**
 * One provider record, normalized by the provider's PRIVATE adapter (or
 * re-emitted by the wired transport): the unit of source ingestion.
 *
 * `providerRecordId` is the provider's own stable record/event id — the
 * dedupe key on the ingestion ledger. `kind` is a canonical classification
 * (`crm.opportunity.updated`, `support.ticket.created`, …) matching the
 * observations module's kind vocabulary. `occurredAt` is the provider's
 * event time (strict ISO 8601) and becomes the observation's `observedAt`.
 */
export interface CanonicalSourceRecord {
  providerRecordId: string;
  kind: string;
  payload: unknown;
  occurredAt: string;
}

// ---------------------------------------------------------------------------
// Sources (tenant-owned inbound connectors)
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped inbound connector: one authorized provider endpoint the
 * tenant ingests evidence from (a Salesforce org, a HubSpot portal, a Jira
 * site, a Stripe account, …) — ARCHITECTURE.md §3: tenants own their
 * sources.
 *
 * `credentialRef` is an OPAQUE secret-store reference; the credential value
 * never reaches any domain table (IMPLEMENTATION-STACK §8; GOVERNANCE:
 * source credentials are tenant-scoped and never stored in semantic
 * memory). OAuth metadata (`oauthScopes`, `oauthExpiresAt`) is non-secret
 * authorization state; it is incoherent (and rejected) for
 * `credentials`-authorized sources.
 *
 * `modes` reports the ingestion modes the provider's adapter supports —
 * derived, provider-neutral capability, never a provider object.
 */
export interface Source {
  id: string;
  tenantId: string;
  provider: SourceProvider;
  /** Canonical, adapter-normalized account id (opaque string). */
  providerAccountId: string;
  displayName: string | null;
  authKind: SourceAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted OAuth scopes (oauth sources only; empty otherwise). */
  oauthScopes: string[];
  /** When the OAuth grant lapses (oauth sources only; null = non-expiring). */
  oauthExpiresAt: string | null;
  status: SourceStatus;
  /** Ingestion modes the provider adapter supports. */
  modes: SourceIngestionMode[];
  createdBy: string;
  /** ISO 8601 — service clock. */
  createdAt: string;
  /** ISO 8601 — service clock; moves on status/authorization changes only. */
  updatedAt: string;
}

export interface RegisterSourceInput {
  provider: SourceProvider;
  /** Raw provider account id; normalized by the provider's adapter. */
  providerAccountId: string;
  displayName?: string | null;
  authKind: SourceAuthKind;
  /** Opaque secret-store reference (never the credential value). */
  credentialRef: string;
  /** Granted scopes; required to be empty for `credentials` sources. */
  oauthScopes?: string[];
  /** Grant expiry (strict ISO 8601); required to be null for `credentials` sources. */
  oauthExpiresAt?: string | null;
}

/**
 * Result of `registerSource`. Re-registering an EXISTING source is the
 * re-authorization path: it updates the authorization fields (auth kind,
 * credential reference, scopes, expiry) and reports `created: false` —
 * the connector's identity (provider, account, provenance history) never
 * changes.
 */
export interface RegisterSourceResult {
  source: Source;
  created: boolean;
}

export interface ListSourcesQuery {
  provider?: SourceProvider;
  status?: SourceStatus;
  /** 1..500, default 50. */
  limit?: number;
}

export interface SetSourceStatusInput {
  sourceId: string;
  status: SourceStatus;
}

// ---------------------------------------------------------------------------
// Ingestion results
// ---------------------------------------------------------------------------

/** The ledger link proving what evidence one ingested record became. */
export interface IngestedRecord {
  providerRecordId: string;
  /** The observation recorded for this provider record (W004 evidence). */
  observationId: string;
}

/** Result of `receiveSourceWebhook`. */
export interface WebhookResult {
  source: Source;
  /** Records the provider's webhook delivered. */
  fetched: number;
  /** Records that became NEW observations. */
  ingested: number;
  /** Records suppressed by the dedupe ledger (already ingested). */
  duplicates: number;
  observations: IngestedRecord[];
}

export interface PollSourceInput {
  sourceId: string;
  /** 1..200, default 50. */
  maxRecords?: number;
}

/**
 * Input of `receiveSourceWebhook` — the provider webhook edge. `payload` is
 * the raw provider-native JSON envelope as it arrived; it is parsed by the
 * provider's adapter INSIDE this module and never crosses back out.
 */
export interface ReceiveWebhookInput {
  provider: SourceProvider;
  payload: unknown;
}

/** Result of `pollSource`. */
export interface PollResult {
  source: Source;
  /** Records the provider returned for this window. */
  fetched: number;
  /** Records that became NEW observations. */
  ingested: number;
  /** Records suppressed by the dedupe ledger (already ingested). */
  duplicates: number;
  observations: IngestedRecord[];
  /** Current checkpoint after the poll (null when none was ever recorded). */
  checkpoint: SourceCheckpoint | null;
  /** Whether the provider reports more data past this window. */
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Checkpoints (polling state + append-only history)
// ---------------------------------------------------------------------------

/**
 * The current polling checkpoint of a source: the OPAQUE provider cursor
 * the next poll resumes from. `cursor` null means "from the beginning of
 * the provider's history" (a source that never polled, or one rewound to
 * the start by replay).
 */
export interface SourceCheckpoint {
  sourceId: string;
  cursor: string | null;
  /** ISO 8601 — when the cursor last moved (poll advance or replay rewind). */
  updatedAt: string;
}

/** One append-only checkpoint history entry — a legal replay target. */
export interface SourceCheckpointEntry {
  id: string;
  sourceId: string;
  /** The cursor this entry recorded (null = the beginning). */
  cursor: string | null;
  /** What recorded the entry: a poll advance or a replay rewind. */
  origin: 'poll' | 'replay';
  /** The principal whose call recorded the entry. */
  recordedBy: string;
  /** ISO 8601 — service clock. */
  recordedAt: string;
}

export interface GetSourceCheckpointQuery {
  sourceId: string;
}

export interface ListSourceCheckpointsQuery {
  sourceId: string;
  /** 1..500, default 50. */
  limit?: number;
}

/**
 * Input of `replaySource` — exactly ONE target: rewind to a recorded
 * checkpoint entry (`checkpointId`), or to the beginning of the provider's
 * history (`fromStart`). The next poll re-fetches from the rewound cursor;
 * the dedupe ledger suppresses records already observed.
 */
export interface ReplaySourceInput {
  sourceId: string;
  checkpointId?: string | null;
  fromStart?: boolean;
}

export interface ReplayResult {
  source: Source;
  /** The history entry the checkpoint was rewound to (null for `fromStart`). */
  rewoundTo: SourceCheckpointEntry | null;
  /** The current checkpoint after the rewind. */
  checkpoint: SourceCheckpoint;
}

// ---------------------------------------------------------------------------
// Fetch port (provider-neutral polling; implementations are module-internal)
// ---------------------------------------------------------------------------

/** The provider-neutral fetch request handed to the transport. */
export interface SourceFetchRequest {
  provider: SourceProvider;
  tenantId: string;
  sourceId: string;
  /** Canonical, adapter-normalized account id (opaque). */
  providerAccountId: string;
  /** Opaque secret-store reference — the transport resolves credentials. */
  credentialRef: string;
  /** Resume point; null = fetch from the beginning of the provider's history. */
  cursor: string | null;
  maxRecords: number;
}

/**
 * The provider-neutral outcome of one fetch. `nextCursor` null means the
 * provider has no further data (an exhausted window); `hasMore` reports
 * whether more data exists past this batch. `authorizationExpiresAt` is
 * how a transport that REFRESHED an OAuth grant reports the new expiry
 * (non-secret authorization state; the service records it on the source).
 */
export interface SourceFetchResult {
  records: CanonicalSourceRecord[];
  nextCursor: string | null;
  hasMore: boolean;
  authorizationExpiresAt?: string | null;
}

/**
 * The polling port real transports implement. Transports that touch
 * provider SDKs/HTTP must live inside `src/modules/sources/adapters/`
 * (IMPLEMENTATION-STACK §6 provider isolation); they are wired at process
 * start via `setSourceTransport`. No transport is wired by default —
 * polls then fail explicitly with `provider_unavailable`.
 */
export interface SourceTransport {
  fetch(request: SourceFetchRequest): Promise<SourceFetchResult>;
}
