// ============================================================================
// sources — the ONLY public surface of the sources module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W036 — Source Gateway:
// "Provider-independent inbound connectors with OAuth/credentials
//  isolation, polling/webhooks, checkpointing, replay and dedupe."
//
//   registerSource      — register (or RE-AUTHORIZE) one tenant-owned
//      inbound connector per provider account: a Salesforce org, a HubSpot
//      portal, a Jira site, a Stripe account… `credentialRef` is an OPAQUE
//      secret-store reference; credential values never reach domain
//      tables. Re-registering an existing source updates its authorization
//      fields (the re-authorization path) and reports `created: false`.
//   getSource / listSources / setSourceStatus — tenant-scoped reads and
//      the enable/disable lifecycle (uniform not-found discipline).
//   pollSource          — the canonical POLLING path: the provider-neutral
//      fetch transport pulls records since the source's stored checkpoint
//      (opaque cursor); new records become immutable observations through
//      the observations contract (W004, lineage `connector`, provenance
//      `{ kind: 'source', id }`); the checkpoint advances only after the
//      batch is ingested, so a failed poll retried re-fetches the same
//      window and dedupe suppresses re-observation.
//   receiveSourceWebhook— the canonical WEBHOOK path: a provider webhook
//      payload (provider key + raw JSON envelope) is parsed by the
//      provider's PRIVATE adapter into canonical records; the envelope's
//      account resolves onto this tenant's registered source. Redelivered
//      envelopes dedupe on the ingestion ledger — one observation per
//      provider record id, ever.
//   getSourceCheckpoint / listSourceCheckpoints / replaySource —
//      checkpoint reads, the append-only cursor history (the audit and
//      the legal rewind targets), and REPLAY: rewinding the cursor to a
//      recorded checkpoint (or to the beginning) so the next poll
//      reprocesses that window under dedupe.
//   setSourceTransport / getSourceTransport — infrastructure wiring for
//      the provider-neutral fetch port. Transport implementations that
//      touch provider SDKs/HTTP must live inside this module's adapters/
//      folder (IMPLEMENTATION-STACK §6 provider isolation); no transport is
//      wired by default, so polls fail explicitly with
//      `provider_unavailable`.
//
// PROVIDER ISOLATION (lock 16 / MODULE-DEPENDENCY-MAP provider boundaries):
// everything exported below is provider-neutral by construction. Providers
// appear only as the canonical `SourceProvider` key owned by this module;
// the only provider-minted values on this surface are OPAQUE strings
// (account ids, record ids, cursors). Provider webhook envelopes, SDK
// objects, record shapes and cursor semantics are parsed inside `adapters/`
// and never leave.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's sources,
// checkpoints, replay targets or ingestion state is reported as
// `source_not_found` / `checkpoint_not_found` — no existence leak.
// ============================================================================

export {
  getSource,
  getSourceCheckpoint,
  getSourceTransport,
  listSourceCheckpoints,
  listSources,
  pollSource,
  receiveSourceWebhook,
  registerSource,
  replaySource,
  setSourceStatus,
  setSourceTransport,
} from './service';

export { SourcesError } from './errors';
export type { SourcesErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_RECORDS,
  MAX_BATCH_RECORDS,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_CURSOR_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_LIST_LIMIT,
  MAX_MAX_RECORDS,
  MAX_OAUTH_SCOPES,
  MAX_PAYLOAD_BYTES,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_RECORD_ID_LENGTH,
  MAX_SCOPE_LENGTH,
  SOURCE_AUTH_KINDS,
  SOURCE_INGESTION_MODES,
  SOURCE_INGESTION_VIAS,
  SOURCE_PROVIDERS,
  SOURCE_STATUSES,
  cursorAdvance,
  isSourceAuthKind,
  isSourceIngestionMode,
  isSourceIngestionVia,
  isSourceProvider,
  isSourceStatus,
} from './validation';

export type {
  ValidatedFetchResult,
  ValidatedListCheckpointsQuery,
  ValidatedListSourcesQuery,
  ValidatedPollInput,
  ValidatedReceiveWebhookInput,
  ValidatedRecord,
  ValidatedRegisterSourceInput,
  ValidatedWebhookParseResult,
} from './validation';

export type {
  CanonicalSourceRecord,
  GetSourceCheckpointQuery,
  IngestedRecord,
  ListSourceCheckpointsQuery,
  ListSourcesQuery,
  PollResult,
  PollSourceInput,
  ReceiveWebhookInput,
  RegisterSourceInput,
  RegisterSourceResult,
  ReplayResult,
  ReplaySourceInput,
  SetSourceStatusInput,
  Source,
  SourceAuthKind,
  SourceCheckpoint,
  SourceCheckpointEntry,
  SourceFetchRequest,
  SourceFetchResult,
  SourceIngestionMode,
  SourceIngestionVia,
  SourceProvider,
  SourceStatus,
  SourceTransport,
  WebhookResult,
} from './types';
