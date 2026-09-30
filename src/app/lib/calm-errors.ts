// Calm, user-facing phrasing for API failures (W123 / B-01).
//
// Display-only: this maps known failure codes and internal-sounding module
// messages to short, recoverable sentences. Statuses, error codes and
// control flow are untouched — only the text a person reads changes.

interface FailureBody {
  error?: string;
  message?: string;
}

const GENERIC =
  'Something went wrong. Please try again, or contact support if it keeps happening.';

const PERMISSION = 'You need admin permission to do that.';

/** Short sentences for the failure codes the surfaces actually emit. */
const CODE_PHRASES: Record<string, string> = {
  unauthenticated: 'Please sign in and try again.',
  unauthorized: PERMISSION,
  forbidden: PERMISSION,
  separation_of_duties: 'You cannot decide your own request.',
  no_active_company:
    'Choose a company before continuing — complete onboarding first.',
  invalid_text: 'Please write a message before sending.',
  not_pending: 'This request was already decided.',
  conflict:
    'That didn’t go through — the record changed. Refresh and try again.',
  policy_conflict:
    'That didn’t go through — the record changed. Refresh and try again.',
  ingestion_busy: 'A check is already running — try again in a moment.',
  source_conflict: 'This source is already registered.',
  delivery_not_retryable: 'This delivery can no longer be retried.',
  identity_already_verified: 'This identity is already verified.',
  identity_already_linked: 'This identity is already linked to a person.',
  identity_not_verified: 'Only verified identities can do that.',
  identity_not_eligible: 'This identity is not eligible for that yet.',
  identity_revoked: 'This verification was revoked — re-verify to continue.',
  identity_not_linked: 'This identity is not linked to a person.',
  challenge_not_active:
    'No verification code is active — send a new one and try again.',
  challenge_expired: 'That code has expired — send a new one and try again.',
  challenge_code_mismatch:
    'That code didn’t match — check it and try again.',
  challenge_attempts_exhausted:
    'Too many incorrect attempts — send a new code and try again.',
};

// Module messages that speak the build's internal language (field names,
// internal ids, permission strings) never reach a customer verbatim.
const INTERNAL_MESSAGE =
  /TenantContext|tenantId|principalId|subjectKind|subjectId|providerAccountId|actionKind|requestId|authority claim|non-empty string|is not a uuid|\(W0\d\d\)/;

/**
 * Turn a JSON failure body (`{ error, message }`) into calm display text.
 * Known codes map to short sentences; quiet domain messages pass through;
 * anything internal or unrecognized falls back to the generic retry line.
 */
export function calmFailureText(body: FailureBody | null | undefined): string {
  const code = body?.error ?? '';
  const message = body?.message ?? '';

  const mapped = CODE_PHRASES[code];
  if (mapped !== undefined) return mapped;
  if (code === 'internal') return GENERIC;
  if (code.endsWith('_not_found') || code === 'invalid_reference') {
    return "We couldn't find that record — it may have been removed.";
  }

  if (message !== '') {
    if (/authority claim/.test(message)) return PERMISSION;
    if (INTERNAL_MESSAGE.test(message)) return GENERIC;
    return message;
  }
  return GENERIC;
}
