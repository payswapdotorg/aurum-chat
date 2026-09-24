// Typed errors of the integration-intelligence module. Consumers catch
// `IntegrationError` and branch on `code`; messages are for humans/logs,
// never for control flow.
//
// The NO-SCAN INVARIANT lives here as `discovery_not_authorized`: the only
// thing runDiscovery may ever fetch through is a source with an ACTIVE
// admin grant in the caller's tenant. Everything else — an un-granted
// source, another tenant's source, a revoked grant — is refused BEFORE any
// transport interaction, exactly like the sources module's
// `provider_unavailable` discipline (never a silent no-op, never a fake
// success, and here never a network touch).
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`*_not_found`) — the existence of another tenant's grants,
// systems, recommendations, batches or verification runs must never leak
// (ADR-0001).

export type IntegrationErrorCode =
  | 'invalid_context'
  | 'invalid_integration_input'
  | 'invalid_directory_record'
  | 'forbidden'
  | 'discovery_not_authorized'
  | 'discovery_grant_not_found'
  | 'system_not_found'
  | 'recommendation_not_found'
  | 'recommendation_status_conflict'
  | 'batch_not_found'
  | 'batch_not_pending'
  | 'system_not_connected'
  | 'verification_unavailable';

export class IntegrationError extends Error {
  constructor(
    public readonly code: IntegrationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrationError';
  }
}
