// Pure result-normalization and secret-screening logic of the
// edge-connector module (W088: "result normalization" + "local secret
// handling"). No database, no clock, no network.
//
// RESULT NORMALIZATION: an edge executor's RAW outcome is normalized
// INTO the canonical deep-action shapes — `DeepActionState` for inspect
// jobs, `DeepActionReceipt` for execute jobs — BEFORE anything crosses
// back to the gateway. A provider-shaped or non-canonical result (a
// class instance, a symbol, a cycle, an oversized body, an unknown
// status, extra keys) is REJECTED LOUDLY with the machine-readable code
// 'invalid_result': provider objects never even reach the gateway's
// transport boundary (this mirrors — and sits in front of — deep-actions'
// own `invalid_transport_result` guard, which stays as the outer layer
// of the same discipline).
//
// SECRET SCREENING: the edge is the ONLY place that holds the private
// systems' credential VALUES, so it is the only place that can screen
// results for them. Every normalized result is serialized and matched
// against every local secret VALUE before it is reported; a leak is
// refused loudly ('secret_leak_detected') and the value NEVER crosses —
// not into a gateway table, an event, or an error message.

import type { DeepActionReceipt, DeepActionState } from '@/modules/deep-actions/contract';
import type { EdgeJobKind, EdgeJobResult } from './types';
import { isPlainJsonValue } from './validation';

/** Canonical result cap (256 KiB — mirrors the deep-actions state cap). */
export const MAX_RESULT_BYTES = 262_144;

/** The verdict of one normalization: accepted, or the code 'invalid_result'. */
export type EdgeResultNormalization =
  | { ok: true; result: EdgeJobResult }
  | { ok: false; reason: 'invalid_result' };

/**
 * Normalizes one raw executor outcome into the canonical shape the job's
 * kind demands. Strict unknown-key rejection; plain JSON only; opaque
 * strings only — everything else is refused with 'invalid_result'.
 */
export function normalizeEdgeJobResult(kind: EdgeJobKind, raw: unknown): EdgeResultNormalization {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'invalid_result' };
  }
  const proto = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) {
    return { ok: false, reason: 'invalid_result' };
  }
  if (kind === 'inspect') {
    const keys = Object.keys(raw as Record<string, unknown>);
    if (keys.length !== 2 || !keys.includes('found') || !keys.includes('state')) {
      return { ok: false, reason: 'invalid_result' };
    }
    const found = (raw as Record<string, unknown>).found;
    if (typeof found !== 'boolean') return { ok: false, reason: 'invalid_result' };
    const state = (raw as Record<string, unknown>).state;
    if (state === undefined) return { ok: false, reason: 'invalid_result' };
    if (!isPlainJsonValue(state)) return { ok: false, reason: 'invalid_result' };
    const serialized = JSON.stringify(state) ?? 'null';
    if (serialized.length > MAX_RESULT_BYTES) return { ok: false, reason: 'invalid_result' };
    const normalized: DeepActionState = { found, state };
    return { ok: true, result: normalized };
  }
  const keys = Object.keys(raw as Record<string, unknown>);
  if (
    keys.length !== 3 ||
    !keys.includes('status') ||
    !keys.includes('receiptId') ||
    !keys.includes('detail')
  ) {
    return { ok: false, reason: 'invalid_result' };
  }
  const candidate = raw as Record<string, unknown>;
  if (
    candidate.status !== 'accepted' &&
    candidate.status !== 'rejected' &&
    candidate.status !== 'failed'
  ) {
    return { ok: false, reason: 'invalid_result' };
  }
  const receiptId = candidate.receiptId;
  if (
    receiptId !== null &&
    (typeof receiptId !== 'string' || receiptId.length === 0 || receiptId.length > 200)
  ) {
    return { ok: false, reason: 'invalid_result' };
  }
  const detail = candidate.detail;
  if (detail !== null && (typeof detail !== 'string' || detail.length === 0 || detail.length > 500)) {
    return { ok: false, reason: 'invalid_result' };
  }
  const normalized: DeepActionReceipt = {
    status: candidate.status,
    receiptId: receiptId as string | null,
    detail: detail as string | null,
  };
  return { ok: true, result: normalized };
}

/**
 * True when the canonical serialization of `value` contains any of the
 * given local secret VALUES — the leak screen every reported result
 * passes. Secrets shorter than 8 characters are ignored (trivial
 * collision guard, honestly documented: a screening secret must be a
 * real credential, not a fragment).
 */
export function screenForSecrets(value: unknown, secrets: readonly string[]): boolean {
  const serialized = JSON.stringify(value) ?? 'null';
  for (const secret of secrets) {
    if (secret.length >= 8 && serialized.includes(secret)) return true;
  }
  return false;
}
