// Typed errors of the vertical-kits module. Consumers catch
// `VerticalKitsError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Tenancy (ADR-0001): every table this module owns is tenant-scoped, so
// the no-leak rule is the plain SQL one — another tenant's installs,
// grants, lifecycle events or recipe references are indistinguishable
// from missing (`kit_not_installed` / not-found reads), on reads AND
// writes. Kit DEFINITIONS themselves are versioned platform-supplied
// DATA served generically (the registry holds no tenant column because
// it holds no rows at all — see kits.ts); only lifecycle state is a
// tenant's own.

export type VerticalKitsErrorCode =
  | 'invalid_context'
  | 'invalid_input'
  | 'invalid_kit'
  | 'kit_not_found'
  | 'kit_not_available'
  | 'package_mismatch'
  | 'kit_not_installed'
  | 'kit_conflict'
  | 'approval_required'
  | 'forbidden';

export class VerticalKitsError extends Error {
  constructor(
    public readonly code: VerticalKitsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerticalKitsError';
  }
}
