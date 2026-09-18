// ============================================================================
// destinations — the ONLY public surface of the destinations module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W037 — Destination Gateway:
// "Provider-independent outbound destinations for BI, warehouses, CRM/ERP,
//  spreadsheets, APIs and webhooks with authorization and provenance."
// (ADR-0009: the Destination Gateway is provider-independent and analogous
//  to Sources — and destinations NEVER become domain truth.)
//
//   registerDestination   — register (or RE-AUTHORIZE) one tenant-owned
//      outbound connector per provider account: a Snowflake database, a
//      Looker instance, a Salesforce org, a Google Sheets spreadsheet, a
//      webhook URL… `credentialRef` is an OPAQUE secret-store reference;
//      credential values never reach domain tables. Re-registering an
//      existing destination updates its authorization fields (the
//      re-authorization path) and reports `created: false`.
//   getDestination / listDestinations / setDestinationStatus —
//      tenant-scoped reads (provider/category/status filters; categories
//      are derived adapter classifications) and the enable/disable
//      lifecycle (uniform not-found discipline).
//   dispatchDelivery      — the canonical OUTBOUND path: a canonical
//      export batch (kind + records) bound for one registered destination.
//      Every dispatch runs THREE authorization layers before anything
//      leaves the system: (1) the destination's provider authorization
//      (active, OAuth grant current); (2) the actions module's authority
//      gate — 'data-export' @ EXECUTE (W009; under the built-in default
//      matrix exports wait for a human approval until tenant policy says
//      otherwise); (3) evidence-level authorization — referenced
//      provenance observations must be readable by the calling principal
//      and must not be tagged 'no-export' (the W004 usage tag). When the
//      gate allows, the first physical attempt happens immediately through
//      the provider-neutral delivery transport; the attempt records the
//      adapter-formatted envelope, the provider-neutral outcome and the
//      provider's opaque acknowledgment (append-only audit). A
//      caller-supplied idempotency key replays the original delivery
//      (first write wins — no duplicate gate history).
//   retryDelivery         — re-attempt a 'pending' (an approval may have
//      landed) or 'failed' (transient transport failure) delivery. The
//      gate is replayed through its stable per-delivery key, so an
//      approval between pumps unlocks the delivery without duplicating
//      gate history; each attempt appends to the audit.
//   replayDelivery        — REPROCESSING: re-deliver a recorded payload as
//      a NEW delivery under a FRESH full gate authorization
//      (`replayedFromId` links back to the original).
//   getDelivery / listDeliveries / listDeliveryAttempts — the outbound
//      checkpoint/audit surface (the append-only delivery ledger IS the
//      outbound checkpoint; see types.ts for the interpretation).
//   setDestinationTransport / getDestinationTransport — infrastructure
//      wiring for the provider-neutral delivery port. Transport
//      implementations that touch provider SDKs/HTTP must live inside this
//      module's adapters/ folder (IMPLEMENTATION-STACK §6 provider
//      isolation); no transport is wired by default, so deliveries fail
//      explicitly with `provider_unavailable`.
//
// PROVIDER ISOLATION (lock 16 analog / MODULE-DEPENDENCY-MAP provider
// boundaries): everything exported below is provider-neutral by
// construction. Providers appear only as the canonical `DestinationProvider`
// key owned by this module; the only provider-minted values on this
// surface are OPAQUE strings (account ids, delivery ids). Provider request
// bodies, SDK objects and acknowledgment conventions are composed inside
// `adapters/` and never leave.
//
// ADR-0009 — "destinations never become domain truth": this contract
// records NO observations and exposes NO operation that promotes a
// delivery, an envelope or a provider acknowledgment into evidence,
// claims or beliefs. Delivery rows are outbound audit state only.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's
// destinations, deliveries or attempts is reported as
// `destination_not_found` / `delivery_not_found` — no existence leak.
// ============================================================================

export {
  dispatchDelivery,
  getDelivery,
  getDestination,
  getDestinationTransport,
  listDeliveries,
  listDeliveryAttempts,
  listDestinations,
  registerDestination,
  replayDelivery,
  retryDelivery,
  setDestinationStatus,
  setDestinationTransport,
} from './service';

export { DestinationsError } from './errors';
export type { DestinationsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  DELIVERY_ACTION_KIND,
  DELIVERY_OUTCOMES,
  DELIVERY_STATUSES,
  DESTINATION_AUTH_KINDS,
  DESTINATION_CATEGORIES,
  DESTINATION_PROVIDERS,
  DESTINATION_STATUSES,
  EXPORT_FORBIDDING_USAGE_TAG,
  FORMATTED_DELIVERY_SHAPES,
  MAX_CREDENTIAL_REF_LENGTH,
  MAX_DETAIL_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_ENVELOPE_BYTES,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_KIND_LENGTH,
  MAX_LIST_LIMIT,
  MAX_OAUTH_SCOPES,
  MAX_PAYLOAD_BYTES,
  MAX_PROVIDER_ACCOUNT_ID_LENGTH,
  MAX_PROVIDER_DELIVERY_ID_LENGTH,
  MAX_PROVENANCE_OBSERVATIONS,
  MAX_RECORD_ID_LENGTH,
  MAX_RECORDS_PER_DELIVERY,
  MAX_SCOPE_LENGTH,
  isDeliveryOutcome,
  isDeliveryStatus,
  isDestinationAuthKind,
  isDestinationCategory,
  isDestinationProvider,
  isDestinationStatus,
  isFormattedDeliveryShape,
  isUuid,
} from './validation';

export type {
  ValidatedDispatchDeliveryInput,
  ValidatedListAttemptsQuery,
  ValidatedListDeliveriesQuery,
  ValidatedListDestinationsQuery,
  ValidatedRegisterDestinationInput,
  ValidatedSetStatusInput,
} from './validation';

export type {
  CanonicalOutboundRecord,
  Delivery,
  DeliveryAttempt,
  DeliveryOutcome,
  DeliveryStatus,
  Destination,
  DestinationAuthKind,
  DestinationCategory,
  DestinationDeliveryRequest,
  DestinationProvider,
  DestinationStatus,
  DestinationTransport,
  DispatchDeliveryInput,
  DispatchDeliveryResult,
  FormattedDelivery,
  FormattedDeliveryShape,
  GetDeliveryQuery,
  ListDeliveryAttemptsQuery,
  ListDeliveriesQuery,
  ListDestinationsQuery,
  RegisterDestinationInput,
  RegisterDestinationResult,
  ReplayDeliveryInput,
  RetryDeliveryInput,
  RetryDeliveryResult,
  SetDestinationStatusInput,
  TransportReceipt,
} from './types';
