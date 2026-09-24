// The canonical hot-swap evidence format (W089): gateway-agnostic records
// proving one provider can replace another for a capability WITHOUT domain
// changes (GOVERNANCE.md "Provider swap evidence"; builds on the llm
// module's hot-swap verification precedent — request digest, two pinned
// targets, deterministic STRUCTURAL comparison, semantic judgment stays
// with the caller).
//
// The owning gateway persists evidence through its own append-only tables
// (the llm module's llm_hot_swap_verifications is the precedent); this
// module defines the canonical RECORD the ecosystem shares, a deterministic
// builder, and a validator the conformance kit uses to prove emission.

import { createHash } from 'node:crypto';
import { ProviderSdkError } from './errors';
import type { HotSwapEvidenceInput, HotSwapEvidenceRecord, HotSwapTargetDescriptor } from './types';

// ---------------------------------------------------------------------------
// Stable serialization + digest
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON serialization: object keys sorted recursively, arrays
 * preserved, so the same VALUE always serializes to the same bytes
 * regardless of property insertion order.
 */
export function stableCanonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(serialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${serialize(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

/** SHA-256 hex digest of a canonical request's stable serialization. */
export function canonicalRequestDigest(canonicalRequest: unknown): string {
  return createHash('sha256').update(stableCanonicalJson(canonicalRequest)).digest('hex');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function validateTarget(
  value: unknown,
  where: string,
  issues: string[]): value is HotSwapTargetDescriptor {
  if (!isPlainObject(value)) {
    issues.push(`${where} must be an object`);
    return false;
  }
  let ok = true;
  if (typeof value['provider'] !== 'string' || value['provider'].trim() === '') {
    issues.push(`${where}.provider must be a non-empty string`);
    ok = false;
  }
  if (value['target'] !== null && value['target'] !== undefined && typeof value['target'] !== 'string') {
    issues.push(`${where}.target must be a string or null`);
    ok = false;
  }
  if (value['resultKind'] !== 'completed' && value['resultKind'] !== 'failed') {
    issues.push(`${where}.resultKind must be 'completed' or 'failed'`);
    ok = false;
  }
  return ok;
}

/**
 * Validate a hot-swap evidence record against the canonical format. Returns
 * the list of issues (empty = valid). Structural, deterministic, total —
 * safe to run on untrusted records.
 */
export function validateHotSwapEvidenceRecord(record: unknown): string[] {
  const issues: string[] = [];
  if (!isPlainObject(record)) {
    issues.push('the record must be an object');
    return issues;
  }
  if (record['sdk'] !== 'provider-hot-swap-evidence') {
    issues.push("sdk must be 'provider-hot-swap-evidence'");
  }
  if (record['evidenceVersion'] !== 1) {
    issues.push('evidenceVersion must be 1');
  }
  for (const field of ['gateway', 'capability', 'evidenceId'] as const) {
    const value = record[field];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`${field} must be a non-empty string`);
    }
  }
  const digest = record['requestDigest'];
  if (typeof digest !== 'string' || !SHA256_HEX_PATTERN.test(digest)) {
    issues.push('requestDigest must be a SHA-256 hex string (64 lowercase hex characters)');
  }
  const targetA = record['providerA'];
  const targetB = record['providerB'];
  const targetAOk = validateTarget(targetA, 'providerA', issues);
  const targetBOk = validateTarget(targetB, 'providerB', issues);
  if (targetAOk && targetBOk) {
    const a = targetA as HotSwapTargetDescriptor;
    const b = targetB as HotSwapTargetDescriptor;
    const differ = a.provider !== b.provider || a.target !== b.target;
    if (!differ) {
      issues.push('providerA and providerB must differ (a hot-swap needs different targets)');
    }
  }
  const outcome = record['outcome'];
  if (outcome !== 'equivalent' && outcome !== 'completed-divergent' && outcome !== 'failed') {
    issues.push("outcome must be 'equivalent', 'completed-divergent' or 'failed'");
  }
  if (record['comparison'] !== 'deterministic-structural') {
    issues.push("comparison must be 'deterministic-structural' (semantic judgment stays with the caller)");
  }
  const executedAt = record['executedAt'];
  if (typeof executedAt !== 'string' || !ISO_TIMESTAMP_PATTERN.test(executedAt)) {
    issues.push('executedAt must be an ISO 8601 timestamp');
  }
  const note = record['note'];
  if (note !== null && note !== undefined && typeof note !== 'string') {
    issues.push('note must be a string or null');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

/**
 * Build one canonical hot-swap evidence record. Deterministic: the same
 * inputs always produce the same record. Provide `requestDigest` (the
 * gateway's own digest over ITS canonical request — preferred, as with the
 * llm module) or `canonicalRequest` (the SDK digests it via stable
 * serialization). Throws ProviderSdkError('invalid_evidence') on malformed
 * input.
 */
export function buildHotSwapEvidence(input: HotSwapEvidenceInput): HotSwapEvidenceRecord {
  const issues: string[] = [];
  if (typeof input.gateway !== 'string' || input.gateway.trim() === '') {
    issues.push('gateway must be a non-empty string');
  }
  if (typeof input.capability !== 'string' || input.capability.trim() === '') {
    issues.push('capability must be a non-empty string');
  }
  if (typeof input.evidenceId !== 'string' || input.evidenceId.trim() === '') {
    issues.push('evidenceId must be a non-empty string');
  }
  if (typeof input.executedAt !== 'string' || !ISO_TIMESTAMP_PATTERN.test(input.executedAt)) {
    issues.push('executedAt must be an ISO 8601 timestamp');
  }
  validateTarget(input.providerA, 'providerA', issues);
  validateTarget(input.providerB, 'providerB', issues);
  if (
    issues.length === 0 &&
    input.providerA.provider === input.providerB.provider &&
    input.providerA.target === input.providerB.target
  ) {
    issues.push('providerA and providerB must differ (a hot-swap needs different targets)');
  }

  let digest = input.requestDigest ?? null;
  if (digest === null) {
    if (input.canonicalRequest === undefined || input.canonicalRequest === null) {
      issues.push("provide either requestDigest or canonicalRequest (one is required)");
    } else {
      digest = canonicalRequestDigest(input.canonicalRequest);
    }
  } else if (!SHA256_HEX_PATTERN.test(digest)) {
    issues.push('requestDigest must be a SHA-256 hex string (64 lowercase hex characters)');
  }

  const note = input.note ?? null;
  if (note !== null && (typeof note !== 'string' || note.length > 500)) {
    issues.push('note must be a string of at most 500 characters');
  }

  if (issues.length > 0) {
    throw new ProviderSdkError(
      'invalid_evidence',
      `invalid hot-swap evidence input: ${issues.join('; ')}`,
    );
  }

  return {
    sdk: 'provider-hot-swap-evidence',
    evidenceVersion: 1,
    gateway: input.gateway,
    capability: input.capability,
    requestDigest: digest!,
    providerA: input.providerA,
    providerB: input.providerB,
    outcome: input.outcome,
    comparison: 'deterministic-structural',
    evidenceId: input.evidenceId,
    executedAt: input.executedAt,
    note,
  };
}
