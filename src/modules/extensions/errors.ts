// Typed errors of the extensions module (W025 — Extension Contracts).
// Consumers catch `ExtensionsError` and branch on `code`; messages are
// for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`extension_not_found` / `manifest_not_found`) — the existence
// of another tenant's extensions or manifests must never leak
// (ADR-0001), including through the verification and lifecycle paths.
//
// `forbidden` is the claim-gated authorization failure of the registry
// writes: registering a manifest version and running a verification
// both require the 'extensions:administer' authority claim (attaching
// software-capability definitions and verification evidence to a tenant
// is a management action).
//
// `forbidden_by_policy` is the actions authority matrix speaking: a
// lifecycle transition was brought to the 'extension-deployment' gate
// (W009) and the tenant's policy forbids that level outright — the
// rejection is recorded by the actions module as evidence before this
// error surfaces.
//
// `version_conflict` / `version_not_monotonic` / `extension_deprecated`
// guard the versioned-manifest invariants: one immutable manifest per
// (extension, version), strictly increasing versions per extension, and
// no new versions for a retired extension.
//
// `verification_required` is the coupling the work item's title
// declares ("lifecycle AND verification states"): an extension cannot
// become ACTIVE while its latest manifest version is not VERIFIED.
//
// W026 — General-Purpose Extension Runtime — adds the runtime codes.
// The authorization model has two layers, and the codes mirror them:
// deployment/rollback are matrix-gated (like the W025 lifecycle codes:
// `forbidden_by_policy`, plus `extension_not_active` /
// `verification_required` / `incompatible_host` / `grant_exceeds_ceiling`
// / `invalid_rollback` for the deploy-time preconditions); every runtime
// operation is grant-gated against the CURRENT deployment
// (`no_deployment` when none exists, `state_not_declared` /
// `surface_not_declared` / `schedule_not_declared` /
// `origin_not_declared` / `telemetry_not_declared` when the deployed
// manifest declares no such capability, `permission_not_granted` when
// the deployment's grant omits the permission, `scope_mismatch` when
// the state scope and the install key disagree). Quotas are enforced,
// not advisory (`state_quota_exceeded`, `schedule_quota_exceeded`,
// `external_quota_exceeded`). Cross-tenant access stays uniform
// not-found (`extension_not_found`, `manifest_not_found`,
// `deployment_not_found`) — no existence leak, exactly like W025.

export type ExtensionsErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'forbidden'
  | 'extension_not_found'
  | 'manifest_not_found'
  | 'version_conflict'
  | 'version_not_monotonic'
  | 'extension_deprecated'
  | 'invalid_transition'
  | 'verification_required'
  | 'forbidden_by_policy'
  // W026 — runtime: deployment preconditions and the authority gate
  | 'extension_not_active'
  | 'incompatible_host'
  | 'grant_exceeds_ceiling'
  | 'invalid_rollback'
  | 'deployment_not_found'
  // W026 — runtime: capability and grant enforcement
  | 'no_deployment'
  | 'state_not_declared'
  | 'surface_not_declared'
  | 'schedule_not_declared'
  | 'origin_not_declared'
  | 'telemetry_not_declared'
  | 'permission_not_granted'
  | 'scope_mismatch'
  // W026 — runtime: quotas
  | 'state_quota_exceeded'
  | 'schedule_quota_exceeded'
  | 'external_quota_exceeded';

export class ExtensionsError extends Error {
  constructor(
    public readonly code: ExtensionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionsError';
  }
}
