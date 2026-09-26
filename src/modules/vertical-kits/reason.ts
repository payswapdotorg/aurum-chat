// Pure deterministic reason-building of the vertical-kits module
// (W092). No database, no clock, no LLM, no randomness — the human-
// readable language of kit capability denials, built exactly like the
// capability-grants module's reason.ts (lock 10: the reason a denial
// carries is a computation, not an opinion).
//
// Every denial names the concrete task it served and the EXACT missing
// scope, so a caller (and the human reading the audit) knows precisely
// what authority the kit lacks.

import type { KitTaskContext } from './types';

/** Join a list into plain organizational English (the house helper). */
export function joinAnd(items: readonly string[]): string {
  if (items.length === 0) return 'none';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Clamp a detail string to the storage cap (defense in depth). */
export function clampDetail(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** The grounded task phrase ("for task '<description>'"). */
export function taskPhrase(taskContext: KitTaskContext): string {
  const description = taskContext.description.slice(0, 200);
  const requestedFor =
    taskContext.requestedFor !== undefined &&
    taskContext.requestedFor !== null &&
    taskContext.requestedFor.length > 0
      ? ` (for ${taskContext.requestedFor.slice(0, 120)})`
      : '';
  return `for task '${description}'${requestedFor}`;
}

/**
 * The denial reason of an invocation against a non-active installation:
 * the state itself is the reason, named verbatim.
 */
export function buildInactiveInstallationReason(
  status: string,
  taskContext: KitTaskContext,
): string {
  return (
    `the kit installation is '${status}' — capability invocations require an ` +
    `active installation ${taskPhrase(taskContext)}`
  );
}

/**
 * The denial reason of an invocation with no active grant for the
 * capability: the EXACT requested scope plus exactly what the kit's
 * reviewed scope does cover (the capability-grants denial discipline —
 * the caller learns precisely what is missing).
 */
export function buildMissingGrantReason(
  capabilityKey: string,
  activeGrantKeys: readonly string[],
  installationStatus: string,
  taskContext: KitTaskContext,
): string {
  const covered =
    activeGrantKeys.length === 0
      ? 'the kit currently holds no active capability grants'
      : `the kit's reviewed scope covers exactly: ${joinAnd(activeGrantKeys)}`;
  return (
    `capability '${capabilityKey}' is not part of this kit installation's ` +
    `reviewed scope — ${covered} ${taskPhrase(taskContext)}; the installation ` +
    `is '${installationStatus}'`
  );
}
