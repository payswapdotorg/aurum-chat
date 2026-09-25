// The PURE deterministic reconciliation logic of the deep-actions module
// (W084) — no database, no clock, no network, no LLM (lock 10 discipline:
// reconciliation is a computation, not an opinion).
//
// Reconciliation answers ONE question per operation: did the authorized,
// executed and accepted write leave the external entity in the state the
// proposal promised? The comparison is SUBSET semantics over plain JSON:
// every leaf entry of the canonical EXPECTATION must be present and
// structurally equal in the OBSERVED post-state. A single violated entry
// is a mismatch; mismatches are enumerated (path, expected, actual) so
// the recorded evidence and the attention unknown say exactly WHAT
// diverged — never merely "something did".
//
// The mismatch REASONS are deterministic plain language (the W083
// reason.ts precedent): the task, the system, the target, the divergent
// paths and the unchanged-state flag — the human investigating the
// unknown reads the same sentence the evidence carries.

import type {
  OperationReconciliation,
  StateMismatch,
} from './types';

// ---------------------------------------------------------------------------
// Structural equality of plain JSON values
// ---------------------------------------------------------------------------

/** Structural equality of plain JSON values (arrays ordered, objects keyed). */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => jsonDeepEqual(entry, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (
      !Object.prototype.hasOwnProperty.call(b, key) ||
      !jsonDeepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      )
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// The per-operation reconciliation (the acceptance core)
// ---------------------------------------------------------------------------

function walkExpectation(
  expected: unknown,
  actual: unknown,
  path: string,
  mismatches: StateMismatch[],
): void {
  if (jsonDeepEqual(expected, actual)) return;
  if (
    typeof expected === 'object' &&
    expected !== null &&
    !Array.isArray(expected) &&
    typeof actual === 'object' &&
    actual !== null &&
    !Array.isArray(actual)
  ) {
    // Nested expectation objects descend: every expected entry must hold.
    for (const [key, value] of Object.entries(expected)) {
      const nextPath = path === '' ? key : `${path}.${key}`;
      const nextActual = Object.prototype.hasOwnProperty.call(actual, key)
        ? (actual as Record<string, unknown>)[key]
        : undefined;
      walkExpectation(value, nextActual, nextPath, mismatches);
    }
    return;
  }
  mismatches.push({ path: path === '' ? '<root>' : path, expected, actual });
}

/**
 * The deterministic reconciliation verdict of one operation: every
 * expectation entry must be present and structurally equal in the
 * observed post-state (subset semantics); `stateUnchanged` additionally
 * reports whether the observed post-state is identical to the pre-state
 * (the classic "the provider accepted the write but nothing moved"
 * divergence, recorded for the investigating human).
 */
export function reconcileOperation(
  expectation: unknown,
  observedPostState: unknown,
  preState: unknown,
): OperationReconciliation {
  const mismatches: StateMismatch[] = [];
  if (typeof expectation === 'object' && expectation !== null && !Array.isArray(expectation)) {
    for (const [key, value] of Object.entries(expectation)) {
      const actual =
        typeof observedPostState === 'object' &&
        observedPostState !== null &&
        !Array.isArray(observedPostState) &&
        Object.prototype.hasOwnProperty.call(observedPostState, key)
          ? (observedPostState as Record<string, unknown>)[key]
          : undefined;
      walkExpectation(value, actual, key, mismatches);
    }
  } else {
    // A non-object expectation cannot happen (validated at creation) —
    // reconcile it as a whole against the observed state.
    walkExpectation(expectation, observedPostState, '', mismatches);
  }
  return {
    matched: mismatches.length === 0,
    mismatches,
    stateUnchanged: jsonDeepEqual(observedPostState, preState),
  };
}

// ---------------------------------------------------------------------------
// Receipt verification (the other half of VERIFY)
// ---------------------------------------------------------------------------

export interface ReceiptVerification {
  verified: boolean;
  reason: string;
}

/**
 * The deterministic verification of one recorded action receipt: an
 * executed write is receipt-verified exactly when the provider ACCEPTED
 * it. A 'failed' receipt is not verified (the execution stayed resumable
 * — it never reaches verify); a 'rejected' receipt failed the task. The
 * reason is deterministic plain language for the audit trail.
 */
export function verifyReceipt(
  receiptStatus: string | null,
  receiptId: string | null,
): ReceiptVerification {
  if (receiptStatus === 'accepted') {
    return {
      verified: true,
      reason:
        receiptId === null
          ? 'the external system accepted the write (no provider receipt id was returned)'
          : `the external system accepted the write (provider receipt ${receiptId})`,
    };
  }
  if (receiptStatus === 'rejected') {
    return {
      verified: false,
      reason: 'the external system permanently refused the write — the task failed before verification',
    };
  }
  if (receiptStatus === 'failed') {
    return {
      verified: false,
      reason: 'the write attempt failed transiently — the execution is resumable, not verified',
    };
  }
  return {
    verified: false,
    reason: 'no action receipt was recorded for this operation — the write never executed',
  };
}

// ---------------------------------------------------------------------------
// Deterministic human-readable language (the reason.ts precedent)
// ---------------------------------------------------------------------------

/** Joins a list into plain language ("a", "a and b", "a, b and c"). */
export function joinAnd(values: readonly string[]): string {
  if (values.length === 0) return '';
  if (values.length === 1) return values[0]!;
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]!}`;
}

/** Renders one mismatch entry for human reading. */
export function describeMismatch(mismatch: StateMismatch): string {
  const expected = JSON.stringify(mismatch.expected) ?? String(mismatch.expected);
  const actual =
    mismatch.actual === undefined
      ? 'absent'
      : (JSON.stringify(mismatch.actual) ?? String(mismatch.actual));
  return `'${mismatch.path}' (expected ${expected}, observed ${actual})`;
}

/**
 * The deterministic human-readable reason recorded on the mismatch
 * evidence and the attention unknown: the task, the system, the target,
 * the divergent paths and — when the state did not move at all — the
 * unchanged-state flag. Grounded entirely in the records being reconciled.
 */
export function buildMismatchReason(input: {
  taskDescription: string;
  systemDisplayName: string;
  operationKey: string;
  target: string;
  mismatches: StateMismatch[];
  stateUnchanged: boolean;
}): string {
  const parts: string[] = [
    `The authorized task "${input.taskDescription}" executed against '${input.systemDisplayName}', but operation '${input.operationKey}' on '${input.target}' did not land in the expected state`,
  ];
  parts.push(`: ${joinAnd(input.mismatches.map(describeMismatch))}.`);
  if (input.stateUnchanged) {
    parts.push(
      ' The observed state is identical to the pre-execution state — the external system accepted the write but nothing changed.',
    );
  } else {
    parts.push(
      ' The observed state changed, but not to what the approved plan promised.',
    );
  }
  parts.push(
    ' The divergence is preserved as evidence; investigate before any retry.',
  );
  return parts.join('');
}

/**
 * The deterministic question of the attention unknown (lock 7 — the gap
 * must be consequential to be first-class): why did the authorized,
 * approved, accepted write not produce the promised downstream state?
 */
export function buildMismatchUnknownQuestion(input: {
  taskDescription: string;
  systemDisplayName: string;
  operationKey: string;
  target: string;
}): string {
  return `Why did the authorized action "${input.taskDescription}" not leave '${input.target}' in the expected state in ${input.systemDisplayName} (operation '${input.operationKey}')?`;
}

/** The deterministic consequence of the attention unknown. */
export function buildMismatchUnknownConsequence(input: {
  systemDisplayName: string;
  target: string;
  mismatchCount: number;
}): string {
  return `The executed action's downstream state in ${input.systemDisplayName} diverges from what Aurum proposed and the approver approved ('${input.target}'${input.mismatchCount > 1 ? ` and ${input.mismatchCount - 1} other target${input.mismatchCount === 2 ? '' : 's'}` : ''}); the organization's records may be inconsistent until the divergence is investigated and either corrected or explained.`;
}

/** Truncates a detail string to the audit column's bound (defense in depth). */
export function clampDetail(detail: string, max = 500): string {
  return detail.length <= max ? detail : `${detail.slice(0, max - 1)}…`;
}
