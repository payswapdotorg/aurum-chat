// Pure human-readable-reason logic of the capability-grants module (W083).
// No database, no clock, no network — everything here is a total,
// deterministic function of its arguments (lock 10 discipline: no LLM ever
// composes authority language; the same task and scope always produce the
// same reason).
//
// §10 of the post-S002 handoff is binding on every string built here:
// "users see outcomes — not technology". A reason never names a provider,
// a broker, an OAuth scope or a token; it names WHAT THE ORGANIZATION CAN
// DO (the inventory's plain-language capability labels), WHICH SYSTEM it
// happens on (the inventory display name) and WHICH CONCRETE TASK makes the
// permission necessary. Data categories are surfaced in plain language so
// the approver sees what is in play.
//
// The two builders:
//
//   * buildAuthorityRequestReason — what a PENDING ASK tells its approver:
//     why this narrowly scoped write authority is necessary for the task,
//     what the connection already holds, and that approving grants exactly
//     the requested capabilities — nothing more.
//
//   * buildInvocationDenialReason — what a DENIED WRITE INVOCATION tells
//     the caller: the capability the task needed, the system it lives on,
//     what the connection currently holds (read-only, or the narrower
//     grants it does have) and that the missing authority must be asked
//     for before the write can proceed.

import type {
  CapabilityDescriptor,
  GrantedCapability,
  TaskContext,
} from './types';

/** Plain-language join (the W081 explain.ts precedent: "a, b and c"). */
export function joinAnd(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The task phrase every reason grounds itself in. */
function taskPhrase(task: TaskContext): string {
  const trimmed = task.description.trim();
  const forPart =
    task.requestedFor !== undefined && task.requestedFor !== null && task.requestedFor.trim() !== ''
      ? ` (for ${task.requestedFor.trim()})`
      : '';
  return `the task "${trimmed}"${forPart}`;
}

/** "Read customer profiles and interaction history" → the quoted label list. */
function quotedLabels(capabilities: readonly CapabilityDescriptor[]): string {
  return joinAnd(capabilities.map((capability) => `"${capability.label}"`));
}

/**
 * The human-readable reason of one authority REQUEST (the W009 gate's
 * justification and the approver-facing payload's `reason`).
 *
 * Deterministic shape:
 *   1. the task and why the permission is necessary;
 *   2. the exact capabilities being asked for (plain-language labels);
 *   3. the data categories in play;
 *   4. what the connection holds today and what approving changes — exactly
 *      the requested capabilities, nothing more.
 */
export function buildAuthorityRequestReason(input: {
  systemDisplayName: string;
  taskContext: TaskContext;
  requested: readonly CapabilityDescriptor[];
  alreadyGranted: readonly GrantedCapability[];
  connectionMode: 'read-only' | 'elevated';
}): string {
  const { systemDisplayName, taskContext, requested, alreadyGranted, connectionMode } = input;
  const requestedPhrase = quotedLabels(requested);
  const categories = [...new Set(requested.flatMap((capability) => capability.dataCategories))].sort();
  const categoriesPhrase =
    categories.length > 0 ? ` It would put ${joinAnd(categories.map((c) => `"${c}"`))} in play.` : '';

  const heldPhrase =
    alreadyGranted.length > 0
      ? ` The connection already holds write authority for ${joinAnd(alreadyGranted.map((g) => `"${g.label}"`))}.`
      : connectionMode === 'read-only'
        ? ' The connection starts read-only: it can look, but not change anything.'
        : '';

  return (
    `${taskPhrase(taskContext)} needs write authority on ${systemDisplayName}: ` +
    `Aurum cannot complete it without ${requestedPhrase}.${categoriesPhrase}` +
    `${heldPhrase} Approving this request grants exactly ${requestedPhrase} — nothing more — ` +
    `and it can be revoked at any time.`
  );
}

/**
 * The human-readable reason of one DENIED write invocation — the exact
 * sentence the acceptance demands ("action invocation produces
 * human-readable reason and exact requested scope").
 *
 * Deterministic shape:
 *   1. the capability the task needed and the system it lives on;
 *   2. the concrete task it was needed for;
 *   3. what the connection holds today (read-only floor, plus any narrower
 *      grants);
 *   4. that the write is stopped until the missing authority is asked for
 *      and granted.
 */
export function buildInvocationDenialReason(input: {
  systemDisplayName: string;
  taskContext: TaskContext;
  missing: readonly CapabilityDescriptor[];
  alreadyGranted: readonly GrantedCapability[];
  connectionMode: 'read-only' | 'elevated';
}): string {
  const { systemDisplayName, taskContext, missing, alreadyGranted, connectionMode } = input;
  const missingPhrase = quotedLabels(missing);

  const heldPhrase =
    alreadyGranted.length > 0
      ? ` The connection holds write authority only for ${joinAnd(alreadyGranted.map((g) => `"${g.label}"`))}.`
      : connectionMode === 'read-only'
        ? ' The connection is read-only: it can look, but not change anything.'
        : '';

  return (
    `${taskPhrase(taskContext)} requires write authority on ${systemDisplayName} ` +
    `(${missingPhrase}), which the connection does not hold.${heldPhrase} ` +
    `The write is stopped. Ask for exactly this capability — and only it — ` +
    `through a capability authority request before retrying.`
  );
}

/**
 * The grant-event detail line of one grant (what the lifecycle ledger
 * records): the scope in plain language plus its provenance.
 */
export function grantEventDetail(input: {
  capabilityLabels: readonly string[];
  via: string;
}): string {
  return `granted ${joinAnd(input.capabilityLabels.map((label) => `"${label}"`))} via request ${input.via}`;
}
