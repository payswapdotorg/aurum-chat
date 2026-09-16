// Typed errors of the marketplace module. Consumers catch
// `MarketplaceError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant discipline (ADR-0001, adapted to the platform catalog):
// the marketplace owns PLATFORM-level tables (the package catalog —
// scripts/arch-allowlist.json), so tenancy is enforced as a VISIBILITY
// rule rather than a SQL WHERE clause: a package that is not yet
// PUBLISHED/INSTALLABLE is visible ONLY to its submitting tenant and to
// platform operators. For every other tenant, someone else's
// draft/submitted/rejected package — and its verification runs, review
// decisions and lifecycle trail — is indistinguishable from a missing
// one (`package_not_found`), on reads AND on writes (submitting,
// verifying, reviewing, publishing or installing a foreign non-public
// package id reads the same as a missing one). The one validated
// cross-module reference (the extension manifest an extension package
// freezes at creation) is uniformly `invalid_manifest_ref` for the same
// reason: missing, malformed and foreign-tenant manifest ids are
// indistinguishable.

export type MarketplaceErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_query'
  | 'invalid_manifest_ref'
  | 'invalid_transition'
  | 'forbidden'
  | 'separation_of_duties'
  | 'package_not_found'
  | 'package_conflict';

export class MarketplaceError extends Error {
  constructor(
    public readonly code: MarketplaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}
