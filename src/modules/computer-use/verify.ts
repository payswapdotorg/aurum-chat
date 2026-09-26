// The PURE deterministic verification logic of the computer-use module
// (W093) — no database, no clock, no network, no LLM (lock 10 discipline:
// verification is a computation, not an opinion).
//
// The observed-state verification itself is the W084 reconciliation
// VERBATIM — `reconcileOperation` imported from the deep-actions contract
// (the work order: "mapped into the W084 deep-action reconcile shapes —
// do not fork a second evidence model"). This file adds only what is
// browser-specific and still pure:
//
//   * the URL-glob matcher of the governed-automation allowlist (the
//     same `*` semantics at creation, at dispatch and inside the driver);
//   * the deterministic human-readable reasons for a browser-step
//     mismatch and its attention unknown — built from the SAME
//     `StateMismatch` shapes and leaf rendering (`describeMismatch`,
//     `joinAnd`, `clampDetail`) the deep-actions evidence carries, so
//     the human investigating a browser divergence reads the same
//     sentence style the deep-action divergences produce.

import {
  clampDetail,
  describeMismatch,
  joinAnd,
  type StateMismatch,
} from '@/modules/deep-actions/contract';
import type { StepVerification } from './types';

// ---------------------------------------------------------------------------
// JSON-safe mismatch encoding (the W084 shapes, JSON-serializable)
// ---------------------------------------------------------------------------

/**
 * Encodes the W084 StateMismatch shapes for JSON persistence: the
 * reconciliation marks an ABSENT expected field with `actual: undefined`,
 * and JSON has no undefined — absence is encoded as null everywhere the
 * diff is persisted or returned (the same array feeds the reason, the
 * evidence observation and the failure bundle, so all three agree).
 */
export function toJsonSafeMismatches(mismatches: StateMismatch[]): StateMismatch[] {
  return mismatches.map((mismatch) => ({
    path: mismatch.path,
    expected: mismatch.expected === undefined ? null : mismatch.expected,
    actual: mismatch.actual === undefined ? null : mismatch.actual,
  }));
}

// ---------------------------------------------------------------------------
// The allowlist glob matcher (pure, shared by every check site)
// ---------------------------------------------------------------------------

/**
 * Does `url` match an allowlist glob? `*` matches any run of characters
 * (including '/'), everything else is literal — deliberately simple and
 * dependency-free so creation, dispatch and the driver-side double all
 * agree by construction.
 */
export function urlMatchesGlob(url: string, glob: string): boolean {
  if (!glob.includes('*')) {
    return url === glob;
  }
  const pattern = globToRegExp(glob);
  return pattern.test(url);
}

/** Compiles an allowlist glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (const character of glob) {
    if (character === '*') {
      source += '.*';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  source += '$';
  return new RegExp(source);
}

// ---------------------------------------------------------------------------
// Deterministic human-readable language (the deep-actions reason precedent)
// ---------------------------------------------------------------------------

/**
 * The deterministic human-readable reason recorded on the mismatch
 * evidence and the attention unknown: the task, the step, the divergent
 * paths and — when the page did not move at all — the unchanged-state
 * flag. Grounded entirely in the records being verified.
 */
export function buildBrowserMismatchReason(input: {
  taskDescription: string;
  stepKey: string;
  url: string;
  mismatches: StateMismatch[];
  stateUnchanged: boolean;
}): string {
  const parts: string[] = [
    `The governed browser task "${input.taskDescription}" executed, but step '${input.stepKey}' on '${input.url}' did not observe the expected page state`,
  ];
  parts.push(`: ${joinAnd(input.mismatches.map(describeMismatch))}.`);
  if (input.stateUnchanged) {
    parts.push(
      ' The observed page state is identical to the previous verified step — the browser accepted the action but the page never moved.',
    );
  } else {
    parts.push(
      ' The observed page state changed, but not to what the governed plan promised.',
    );
  }
  parts.push(
    ' The divergence is preserved as evidence with the action trace and screenshot reference; investigate before any retry.',
  );
  return parts.join('');
}

/**
 * The deterministic question of the attention unknown (lock 7 — the gap
 * must be consequential to be first-class): why did the governed,
 * accepted browser action not produce the promised page state?
 */
export function buildBrowserMismatchUnknownQuestion(input: {
  taskDescription: string;
  stepKey: string;
  url: string;
}): string {
  return `Why did the governed browser step '${input.stepKey}' of task "${input.taskDescription}" not leave '${input.url}' in the expected state?`;
}

/** The deterministic consequence of the attention unknown. */
export function buildBrowserMismatchUnknownConsequence(input: {
  stepKey: string;
  url: string;
}): string {
  return `The browser fallback executed an authorized step against '${input.url}' whose observed state diverges from the governed plan (step '${input.stepKey}'); the task's outcome is unproven until the divergence is investigated and either corrected or explained — the fallback refuses to treat an unverified observation as a result.`;
}

/** Renders a verification verdict's divergence for the audit feed. */
export function describeVerification(verdict: StepVerification): string {
  if (verdict.matched) return 'verified';
  return `diverged (${joinAnd(verdict.mismatches.map(describeMismatch))})`;
}

/** Truncates a detail string to the audit column's bound (re-exported guard). */
export { clampDetail };
