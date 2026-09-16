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
  | 'forbidden_by_policy';

export class ExtensionsError extends Error {
  constructor(
    public readonly code: ExtensionsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExtensionsError';
  }
}
