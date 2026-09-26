// Provider choice (W091) — the action surface.
//
// The /provider-preferences surface's WRITE path is a thin, explicit
// dispatcher over the provider-preferences module's contract (the outcome
// layer over the llm gateway — no second routing channel):
//
//   preference.save  — save (or re-save, unlimited) the tenant's outcome
//                      choice; any member may save. When the saver holds
//                      the technical authority claim the choice is applied
//                      immediately, otherwise the honest
//                      requiresAdministrator state comes back.
//   preference.apply — (claim-gated) write the saved choice's priorities
//                      through the llm contract's existing input.
//   override.update  — (claim-gated) the technical override: a small,
//                      reversible projection onto the llm contract's
//                      account controls (priority + status).
//
// Discipline (the ai/lib/actions.ts pattern, minus the API route — W091
// uses server actions, so this layer stays PURE and the 'use server'
// wrappers in server-actions.ts stay thin):
//   * this surface implements NO domain logic — every operation delegates
//     to a contract call and lets the module's own validation, tenant
//     scoping and authority checks decide;
//   * body parsing/validation is pure and unit-testable; execution is a
//     separate step so tests drive the exact code the server actions run;
//   * summaries are plain language and come from the contract itself (the
//     application summary names what happened, never provider jargon).

import type { TenantContext } from '@/infra/tenant';
import {
  MAX_NOTE_LENGTH,
  PREFERENCE_KINDS,
  applyPreferenceProfile,
  isProviderPreferenceKind,
  isUuid,
  savePreferenceProfile,
  updateProviderAccountControls,
} from '@/modules/provider-preferences/contract';
import type { ProviderPreferenceKind } from '@/modules/provider-preferences/contract';

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export const PROVIDER_PREFERENCES_ACTIONS = [
  'preference.save',
  'preference.apply',
  'override.update',
] as const;

export type ProviderPreferencesAction = (typeof PROVIDER_PREFERENCES_ACTIONS)[number];

export function isProviderPreferencesAction(
  value: unknown,
): value is ProviderPreferencesAction {
  return (
    typeof value === 'string' &&
    (PROVIDER_PREFERENCES_ACTIONS as readonly string[]).includes(value)
  );
}

/** The routing-priority bounds the override form accepts (lower is tried first). */
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 1000;

// ---------------------------------------------------------------------------
// Parsed inputs (shape-checked; the contract re-validates authoritatively)
// ---------------------------------------------------------------------------

export type ParsedActionInput =
  | {
      action: 'preference.save';
      preference: ProviderPreferenceKind;
      note: string | null;
    }
  | { action: 'preference.apply' }
  | {
      action: 'override.update';
      accountId: string;
      priority: number | null;
      status: 'active' | 'disabled' | null;
    };

export type ParseResult =
  | { ok: true; value: ParsedActionInput }
  | { ok: false; error: string };

/** What every 'use server' wrapper returns to the client (plain words only). */
export type ActionOutcome =
  | { ok: true; summary: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Pure body parsing
// ---------------------------------------------------------------------------

function isObject(body: unknown): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parse and shape-check one action body. PURE. The module contract remains
 * the authoritative validator — this layer only guarantees the shape the
 * dispatcher needs and produces readable messages for the client.
 */
export function parseActionBody(body: unknown): ParseResult {
  if (!isObject(body)) {
    return { ok: false, error: 'the request must be an object' };
  }
  const action = body['action'];
  if (!isProviderPreferencesAction(action)) {
    return {
      ok: false,
      error: `unknown action '${String(action)}' (supported: ${PROVIDER_PREFERENCES_ACTIONS.join(', ')})`,
    };
  }

  switch (action) {
    case 'preference.save': {
      const preference = body['preference'];
      if (!isProviderPreferenceKind(preference)) {
        return {
          ok: false,
          error: `preference must be one of ${PREFERENCE_KINDS.join(', ')} — pick one of the choices on the page`,
        };
      }
      if (
        body['note'] !== undefined &&
        body['note'] !== null &&
        typeof body['note'] !== 'string'
      ) {
        return { ok: false, error: 'the reason must be plain text' };
      }
      const note = text(body['note']);
      if (note !== null && note.length > MAX_NOTE_LENGTH) {
        return {
          ok: false,
          error: `the reason must be at most ${MAX_NOTE_LENGTH} characters`,
        };
      }
      return { ok: true, value: { action, preference, note } };
    }
    case 'preference.apply': {
      return { ok: true, value: { action } };
    }
    case 'override.update': {
      const accountId = text(body['accountId']);
      if (accountId === null) {
        return { ok: false, error: 'the override needs the account it changes' };
      }
      if (!isUuid(accountId)) {
        return { ok: false, error: 'the account address is not valid — pick an option from the list' };
      }

      let priority: number | null = null;
      if (body['priority'] !== undefined && body['priority'] !== null && body['priority'] !== '') {
        const value = body['priority'];
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < PRIORITY_MIN ||
          value > PRIORITY_MAX
        ) {
          return {
            ok: false,
            error: `priority must be a whole number between ${PRIORITY_MIN} and ${PRIORITY_MAX} (lower is tried first)`,
          };
        }
        priority = value;
      }

      let status: 'active' | 'disabled' | null = null;
      if (body['status'] !== undefined && body['status'] !== null && body['status'] !== '') {
        const value = body['status'];
        if (value !== 'active' && value !== 'disabled') {
          return {
            ok: false,
            error: "status must be 'active' or 'disabled'",
          };
        }
        status = value;
      }

      if (priority === null && status === null) {
        return {
          ok: false,
          error: 'the override must change the priority or the status',
        };
      }
      return { ok: true, value: { action, accountId, priority, status } };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution (delegates to the module contract, nothing else)
// ---------------------------------------------------------------------------

/** What one executed action reports back (plain words + plain facts). */
export interface ProviderPreferencesActionOutcome {
  action: string;
  summary: string;
  result: unknown;
}

/**
 * Execute one parsed action against the provider-preferences contract.
 * Errors propagate (ProviderPreferencesError carries the honest code +
 * message); the server-action wrappers translate them for the client.
 */
export async function executeProviderPreferencesAction(
  ctx: TenantContext,
  input: ParsedActionInput,
): Promise<ProviderPreferencesActionOutcome> {
  switch (input.action) {
    case 'preference.save': {
      const outcome = await savePreferenceProfile(ctx, {
        preference: input.preference,
        note: input.note,
      });
      return {
        action: input.action,
        // The contract's own plain-language application summary — it names
        // what happened (applied now / waiting for an administrator).
        summary: outcome.application.summary,
        result: {
          preference: outcome.profile.preference,
          applied: outcome.application.applied,
          requiresAdministrator: outcome.application.requiresAdministrator,
          written: outcome.application.written,
        },
      };
    }
    case 'preference.apply': {
      const outcome = await applyPreferenceProfile(ctx, {});
      return {
        action: input.action,
        summary: outcome.application.summary,
        result: {
          preference: outcome.profile.preference,
          applied: outcome.application.applied,
          requiresAdministrator: outcome.application.requiresAdministrator,
          written: outcome.application.written,
        },
      };
    }
    case 'override.update': {
      const outcome = await updateProviderAccountControls(ctx, {
        accountId: input.accountId,
        ...(input.priority === null ? {} : { priority: input.priority }),
        ...(input.status === null ? {} : { status: input.status }),
      });
      return {
        action: input.action,
        summary: outcome.summary,
        result: {
          accountId: outcome.account.id,
          label: outcome.account.label,
          priority: outcome.account.priority,
          status: outcome.account.status,
        },
      };
    }
  }
}
