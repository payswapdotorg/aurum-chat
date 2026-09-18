// ============================================================================
// api — the ONLY public surface of the api module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W038 — Public API:
// "Versioned tenant-scoped API exposing capability-oriented operations and
//  webhooks. No raw persistence access."
//
// ADR-0005 — API and MCP: "API and MCP expose provider-independent Aurum
// capabilities rather than persistence operations. Every operation is
// tenant-scoped, authorized and audited." Locks 31/32 mirror it.
//
// WHAT THIS MODULE OWNS
//   * THE KERNEL — `handleApiRequest(request): Promise<ApiResponse>`: a
//     completely framework-free request pipeline (authenticate → scope
//     tenant → permission-check → delegate → audit → fan out). The Next.js
//     route handlers under src/app/api/v1/** are thin adapters that
//     translate HTTP into an ApiRequest and frame the ApiResponse — every
//     routing, authentication, authorization and audit decision lives
//     HERE, so the whole public surface is testable without HTTP.
//   * API KEYS — the machine-caller credentials: tenant-scoped, principal-
//     bound, capability-scoped, revocable; only sha-256 hashes persist.
//     Keys are minted through this contract (by the future auth module,
//     the control tower, tests — or over HTTP by a key holding
//     'api:administer'); there is deliberately NO unauthenticated key
//     issuance: that is the auth module's problem, not the API's.
//   * WEBHOOKS — tenant-scoped outbound event delivery: subscriptions
//     (https endpoint + event-type patterns + opaque signing-secret
//     reference), immutable per-operation audit events as the fanout
//     source, an explicit resumable dispatch pump with bounded attempts
//     and exponential backoff, append-only attempt evidence, explicit
//     redelivery, and HMAC-SHA256 signed envelopes.
//
// WHAT THE SURFACE EXPOSES (capability-oriented, lock 31)
//   Reads: goals (+versions), unknowns, beliefs, missions (+versions),
//   knowledge (+evidence), observations (+lineage), capabilities (+gap
//   analysis), agents (+execution traces), approvals (+decisions) — each
//   through the owning module's contract and nothing else.
//   Writes: requesting investigations (missions), the W009 approval
//   workflow (authorizeAction — including proposing agent recruitment via
//   the 'agent-recruitment' action kind — and decideApproval, which the
//     actions module's own 'actions:approve' claim gate still governs),
//   api keys and webhooks themselves.
//   There is deliberately NO operation that reads or writes another
//   module's tables, emits SQL on behalf of a caller, or exposes provider
//   objects of any kind.
//
// Tenancy (ADR-0001): a presented key resolves onto exactly one tenant;
// every delegated call carries that tenant's explicit TenantContext; the
// grantee principal's membership is re-verified through the organizations
// contract on EVERY request. Another tenant's records are
// indistinguishable from missing ones — no existence leak.
//
// Dependency posture: this module imports the contracts of organizations
// (membership), events (audit + fanout), goals, missions, epistemics,
// memory, observations, capabilities, agents and actions (the delegated
// capabilities) — `all application contracts → api/mcp`
// (MODULE-DEPENDENCY-MAP.md). The MCP server (W039) reuses this same
// discipline against the same contracts.
// ============================================================================

// The request kernel — what src/app/api/v1/** (and any future transport)
// calls.
export { handleApiRequest } from './kernel';

// API-key management (the future auth module / control tower / tests call
// these directly; HTTP callers reach them through the kernel with the
// 'api:administer' scope).
export {
  createApiKey,
  listApiKeys,
  requirePrincipalMembership,
  revokeApiKey,
  setWebhookTransport as setApiWebhookTransport,
  getWebhookTransport as getApiWebhookTransport,
} from './service';

// Webhook subscriptions.
export {
  createWebhookSubscription,
  deactivateWebhookSubscription,
  getWebhookSubscription,
  listWebhookSubscriptions,
} from './service';

// Webhook deliveries: fanout, test pings, reads, redelivery, the pump.
export {
  dispatchWebhookDeliveries,
  fanoutEvent,
  getWebhookDelivery,
  listWebhookDeliveries,
  redeliverWebhookDelivery,
  sendWebhookTest,
} from './service';

// Audit surface (the events-module trail behind lock 32).
export { API_AUDIT_EVENT_TYPE, auditApiOperation, WEBHOOK_TEST_EVENT_TYPE } from './service';
export type { ApiAuditDetail } from './service';

// Capability-scope vocabulary (pure).
export {
  API_KEY_AUTHORITY_CLAIMS,
  API_SCOPES,
  isApiKeyAuthorityClaim,
  isApiScope,
  parseAuthorityGrant,
  parseScopeGrant,
} from './scopes';
export type { ApiKeyAuthorityClaim, ApiScope } from './scopes';

// Pure webhook logic: pattern matching, backoff, the signature scheme,
// receipt classification, URL validation.
export {
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  MAX_EVENT_TYPE_PATTERNS,
  MAX_WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_BACKOFF_BASE_SECONDS,
  WEBHOOK_BACKOFF_CAP_SECONDS,
  backoffSecondsForAttempt,
  classifyWebhookReceipt,
  computeWebhookSignature,
  eventTypeMatches,
  isEventTypeId,
  isEventTypePattern,
  parseEventTypePatterns,
  validateWebhookUrl,
} from './webhook';

// The versioned route table (pure) + discovery manifest.
export {
  API_ROUTES,
  buildDiscoveryDocument,
  matchApiRoute,
  splitApiPath,
} from './routes';
export type { ApiMethod, ApiRouteSpec, RouteMatch } from './routes';

// Errors + the domain-error → HTTP taxonomy.
export { ApiError, httpStatusFor, mapDomainErrorCode, mapDomainError } from './errors';
export type { ApiErrorCode, MappedDomainError } from './errors';

export { API_BASE_PATH, API_VERSION } from './types';
export type {
  ApiDiscoveryDocument,
  ApiKey,
  ApiKeyIssuance,
  ApiKeyStatus,
  ApiOperationDescriptor,
  ApiRequest,
  ApiResponse,
  CreateApiKeyInput,
  CreateWebhookSubscriptionInput,
  DispatchWebhookDeliveriesResult,
  FanoutEventResult,
  WebhookAttemptOutcome,
  WebhookDelivery,
  WebhookDeliveryAttempt,
  WebhookDeliveryDetail,
  WebhookDeliveryKind,
  WebhookDeliveryStatus,
  WebhookDispatchOutcome,
  WebhookSubscription,
  WebhookSubscriptionStatus,
  WebhookTransport,
  WebhookTransportReceipt,
  WebhookTransportRequest,
} from './types';
