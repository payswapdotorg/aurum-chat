// AI preferences (W091) — the action surface.
//
// The /ai/preferences surface's WRITE path is a thin, explicit
// dispatcher over the provider-preferences module's contract:
//
//   preference.setPersonal — the member's own outcome priority (any
//                            signed-in member; no claim — the module
//                            takes the principal from the context)
//   preference.clearPersonal — back to the company/default fold
//   preference.setTenant    — the company-wide priority + policy-first
//                            posture (claim-gated in the module)
//   override.set            — pin a provider for one AI route
//                            (claim-gated; reason required)
//   override.clear          — retire a pin — reversible by setting it
//                            again (claim-gated)
//
// Discipline (scope rules / GOVERNANCE):
//   * this surface implements NO domain logic — every operation delegates
//     to a contract call and lets the module's own validation, tenant
//     scoping and authority checks decide ('provider-preferences:
//     administer' gates the management writes);
//   * body parsing/validation is pure and unit-testable; execution is a
//     separate step so tests drive the exact code the
//     /api/product/ai/preferences route drives without booting Next.js;
//   * the override action validates the provider against the llm
//     registry BEFORE the module call (this surface knows it is pinning
//     an llm-gateway provider; the module itself stays vocabulary-open
//     — the provider-billing discipline).

import type { TenantContext } from '@/infra/tenant';
import { listLlmProviders } from '@/modules/llm/contract';
import {
  isProviderPreferenceOutcome,
  ProviderPreferencesError,
  clearPersonalPreference,
  clearTechnicalOverride,
  setPersonalPreference,
  setTechnicalOverride,
  setTenantPreference,
  type ProviderPreferenceOutcome,
  type SetTechnicalOverrideResult,
  type TechnicalOverride,
} from '@/modules/provider-preferences/contract';

// ---------------------------------------------------------------------------
// Action vocabulary
// ---------------------------------------------------------------------------

export const PREFERENCE_ACTIONS = [
  'preference.setPersonal',
  'preference.clearPersonal',
  'preference.setTenant',
  'override.set',
  'override.clear',
] as const;

export type PreferenceAction = (typeof PREFERENCE_ACTIONS)[number];

export function isPreferenceAction(value: unknown): value is PreferenceAction {
  return (
    typeof value === 'string' && (PREFERENCE_ACTIONS as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Parsed inputs (shape-checked; the contract re-validates authoritatively)
// ---------------------------------------------------------------------------

export type ParsedActionInput =
  | { action: 'preference.setPersonal'; outcomePriority: ProviderPreferenceOutcome[] }
  | { action: 'preference.clearPersonal' }
  | {
      action: 'preference.setTenant';
      outcomePriority: ProviderPreferenceOutcome[];
      policyFirst: boolean;
    }
  | {
      action: 'override.set';
      gateway: string;
      capability: string | null;
      provider: string;
      reason: string;
    }
  | { action: 'override.clear'; gateway: string; capability: string | null };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Parse an outcome priority list the forms send (['cost','speed',…]). */
function parseOutcomePriority(value: unknown): ProviderPreferenceOutcome[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw new PreferenceActionParseError(
      'outcomePriority must be an ordered list of 1..4 outcomes (cost, privacy, quality, speed)',
    );
  }
  const seen = new Set<string>();
  const out: ProviderPreferenceOutcome[] = [];
  for (const entry of value) {
    if (!isProviderPreferenceOutcome(entry)) {
      throw new PreferenceActionParseError(
        `'${String(entry)}' is not a known priority outcome (cost, privacy, quality, speed)`,
      );
    }
    if (seen.has(entry)) {
      throw new PreferenceActionParseError(`'${entry}' appears twice in the priority list`);
    }
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/** The parse error of this surface (mapped to HTTP 400 by api.ts). */
export class PreferenceActionParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreferenceActionParseError';
  }
}

/** Parse one action body (pure; throws PreferenceActionParseError). */
export function parseActionBody(body: unknown): ParsedActionInput {
  if (!isPlainObject(body) || typeof body.action !== 'string') {
    throw new PreferenceActionParseError('the body must be an object with an action field');
  }
  if (!isPreferenceAction(body.action)) {
    throw new PreferenceActionParseError(
      `unknown action '${body.action}' (expected one of: ${PREFERENCE_ACTIONS.join(', ')})`,
    );
  }
  switch (body.action) {
    case 'preference.setPersonal':
      return {
        action: 'preference.setPersonal',
        outcomePriority: parseOutcomePriority(body.outcomePriority),
      };
    case 'preference.clearPersonal':
      return { action: 'preference.clearPersonal' };
    case 'preference.setTenant':
      if (typeof body.policyFirst !== 'boolean') {
        throw new PreferenceActionParseError('policyFirst must be a boolean');
      }
      return {
        action: 'preference.setTenant',
        outcomePriority: parseOutcomePriority(body.outcomePriority),
        policyFirst: body.policyFirst,
      };
    case 'override.set': {
      if (
        typeof body.provider !== 'string' ||
        body.provider.trim() === '' ||
        typeof body.reason !== 'string' ||
        body.reason.trim() === ''
      ) {
        throw new PreferenceActionParseError(
          'override.set needs a provider and a non-empty reason',
        );
      }
      const capability =
        typeof body.capability === 'string' && body.capability !== ''
          ? body.capability
          : null;
      return {
        action: 'override.set',
        gateway: 'llm',
        capability,
        provider: body.provider,
        reason: body.reason,
      };
    }
    case 'override.clear': {
      const capability =
        typeof body.capability === 'string' && body.capability !== ''
          ? body.capability
          : null;
      return { action: 'override.clear', gateway: 'llm', capability };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution (delegates to the module contract only)
// ---------------------------------------------------------------------------

export type ActionResult =
  | {
      action: 'preference.setPersonal';
      summary: string;
      outcomePriority: ProviderPreferenceOutcome[];
    }
  | { action: 'preference.clearPersonal'; summary: string }
  | {
      action: 'preference.setTenant';
      summary: string;
      outcomePriority: ProviderPreferenceOutcome[];
      policyFirst: boolean;
    }
  | { action: 'override.set'; summary: string; override: TechnicalOverride }
  | { action: 'override.clear'; summary: string; override: TechnicalOverride };

/**
 * Execute one parsed action through the provider-preferences contract.
 * The module's own authority gate decides the 403s ('unauthorized'),
 * its validation decides the 400s — this surface maps, never decides.
 */
export async function executeAction(
  ctx: TenantContext,
  parsed: ParsedActionInput,
): Promise<ActionResult> {
  switch (parsed.action) {
    case 'preference.setPersonal': {
      const personal = await setPersonalPreference(ctx, {
        outcomePriority: parsed.outcomePriority,
      });
      return {
        action: 'preference.setPersonal',
        summary: 'Your priority is saved — it applies to your interactions from now on.',
        outcomePriority: personal.outcomePriority,
      };
    }
    case 'preference.clearPersonal': {
      await clearPersonalPreference(ctx);
      return {
        action: 'preference.clearPersonal',
        summary: 'Your priority is cleared — the company setting (or the balanced default) applies.',
      };
    }
    case 'preference.setTenant': {
      const tenant = await setTenantPreference(ctx, {
        outcomePriority: parsed.outcomePriority,
        policyFirst: parsed.policyFirst,
      });
      return {
        action: 'preference.setTenant',
        summary: 'The company-wide priority is saved.',
        outcomePriority: tenant.outcomePriority,
        policyFirst: tenant.policyFirst,
      };
    }
    case 'override.set': {
      // This surface pins llm-gateway providers: validate the key
      // against the registry first (the module stays vocabulary-open —
      // the provider-billing discipline).
      const providers = await listLlmProviders();
      if (!providers.includes(parsed.provider as (typeof providers)[number])) {
        throw new PreferenceActionParseError(
          `'${parsed.provider}' is not a provider this gateway can route to`,
        );
      }
      const result: SetTechnicalOverrideResult = await setTechnicalOverride(ctx, {
        gateway: parsed.gateway,
        capability: parsed.capability,
        provider: parsed.provider,
        reason: parsed.reason,
      });
      return {
        action: 'override.set',
        summary: `The technical override is set${
          result.created ? '' : ' (the existing pin was replaced)'
        } and recorded in the audit feed. It stays reversible — clear it any time.`,
        override: result.override,
      };
    }
    case 'override.clear': {
      const override = await clearTechnicalOverride(ctx, {
        gateway: parsed.gateway,
        capability: parsed.capability,
      });
      return {
        action: 'override.clear',
        summary:
          'The technical override is cleared — the preference policy chooses again. Setting a new pin re-activates the route any time.',
        override,
      };
    }
  }
}

/** Map a module/parse error to an HTTP-ish outcome (the api.ts seam). */
export function actionErrorStatus(error: unknown): { status: 400 | 403 | 404 | 500; message: string } {
  if (error instanceof PreferenceActionParseError) {
    return { status: 400, message: error.message };
  }
  if (error instanceof ProviderPreferencesError) {
    switch (error.code) {
      case 'unauthorized':
        return { status: 403, message: error.message };
      case 'invalid_input':
      case 'invalid_query':
      case 'invalid_context':
        return { status: 400, message: error.message };
      case 'explanation_not_found':
      case 'override_not_found':
        return { status: 404, message: error.message };
    }
  }
  return {
    status: 500,
    message: error instanceof Error ? error.message : 'the action failed unexpectedly',
  };
}
