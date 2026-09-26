'use server';

// Provider choice (W091) — the 'use server' write path.
//
// W091's constraint: no new API routes. The surface's writes are SERVER
// ACTIONS — thin, typed wrappers around the pure parse/execute pair in
// lib/actions.ts (so tests drive the exact parsing + contract calls the
// client triggers, without a Next.js boot). Every wrapper:
//   1. resolves the session (the ONLY scope source — an expired session
//      answers honestly instead of acting);
//   2. parses the body with the pure, unit-tested parser;
//   3. executes against the module contract and returns a plain-language
//      summary, or the module's own honest error message.
//
// No domain logic lives here — the module's validation, tenant scoping and
// authority checks decide everything.

import { resolveSession } from '@/app/lib/session';
import { executeProviderPreferencesAction, parseActionBody } from './actions';
import type { ActionOutcome } from './actions';

/** Save (or re-save) the tenant's outcome choice. Any member may call. */
export async function savePreferenceAction(input: {
  preference: string;
  note?: string;
}): Promise<ActionOutcome> {
  const session = await resolveSession();
  if (session.status !== 'authenticated') {
    return { ok: false, error: 'Your session expired — sign in again.' };
  }
  const parsed = parseActionBody({
    action: 'preference.save',
    preference: input.preference,
    note: input.note,
  });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  try {
    const outcome = await executeProviderPreferencesAction(session.context, parsed.value);
    return { ok: true, summary: outcome.summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'the choice could not be saved',
    };
  }
}

/** Apply the saved choice to routing now (requires the technical authority). */
export async function applyPreferenceAction(): Promise<ActionOutcome> {
  const session = await resolveSession();
  if (session.status !== 'authenticated') {
    return { ok: false, error: 'Your session expired — sign in again.' };
  }
  const parsed = parseActionBody({ action: 'preference.apply' });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  try {
    const outcome = await executeProviderPreferencesAction(session.context, parsed.value);
    return { ok: true, summary: outcome.summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'the choice could not be applied',
    };
  }
}

/**
 * The technical override (priority + status of one AI option). Requires the
 * technical authority; cross-tenant and missing accounts answer uniformly.
 */
export async function technicalOverrideAction(
  input: Record<string, unknown>,
): Promise<ActionOutcome> {
  const session = await resolveSession();
  if (session.status !== 'authenticated') {
    return { ok: false, error: 'Your session expired — sign in again.' };
  }
  const parsed = parseActionBody({ action: 'override.update', ...input });
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  try {
    const outcome = await executeProviderPreferencesAction(session.context, parsed.value);
    return { ok: true, summary: outcome.summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'the change could not be saved',
    };
  }
}
