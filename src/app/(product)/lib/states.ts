// Product shell (W057) — shared state-pattern logic.
//
// The quiet loading/empty/error system the plan asks for ("quiet skeleton,
// empty and error states"). This module holds the pure half: the pill tone
// vocabulary, human copy for module error codes, and the status→tone
// mappings shared by the shell chrome (notifications) and the product
// surfaces. The presentational half lives in components/states.tsx.

/** The shell's status-pill vocabulary (color is never the only signal). */
export type PillTone = 'positive' | 'warning' | 'error' | 'neutral' | 'info';

/** Human copy for a pill tone (used as the accessible dot label). */
export const PILL_TONE_LABEL: Record<PillTone, string> = {
  positive: 'healthy',
  warning: 'needs attention',
  error: 'failing',
  neutral: 'settled',
  info: 'informational',
};

/** Map a connection status ('active' | 'disabled') to a pill tone. */
export function connectionStatusTone(status: string): PillTone {
  switch (status) {
    case 'active':
      return 'positive';
    case 'disabled':
      return 'neutral';
    default:
      return 'neutral';
  }
}

/** Human copy for a connection status. */
export function connectionStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'disabled':
      return 'Disabled';
    default:
      return status;
  }
}

/**
 * Friendly, non-leaking copy for an arbitrary error. Module errors carry a
 * `code`; unknown errors collapse to a generic sentence — the shell never
 * renders raw stacks or driver messages to users.
 */
export function errorSummary(error: unknown): { title: string; detail: string } {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  const message =
    error instanceof Error && error.message !== '' ? error.message : null;
  switch (code) {
    case 'forbidden':
    case 'unauthorized':
      return {
        title: 'Not allowed here',
        detail:
          'The acting principal lacks the authority for this operation. Membership and authority claims come from your company scope.',
      };
    case 'tenant_not_found':
      return {
        title: 'Company unavailable',
        detail:
          'This company cannot be read with the current principal — either the id is wrong or the principal is not a member.',
      };
    default:
      return {
        title: 'Something went wrong',
        detail:
          message === null
            ? 'This surface could not be assembled right now. Try again in a moment.'
            : `This surface could not be assembled right now: ${message}`,
      };
  }
}

/** True when an error looks like a scope problem (used for retry copy). */
export function isScopeError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : null;
  return code === 'tenant_not_found' || code === 'forbidden' || code === 'unauthorized';
}
