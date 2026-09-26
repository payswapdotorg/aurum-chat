// Pure signed-envelope logic of the edge-connector module (W088: "signed
// tenant-scoped jobs"). No database, no clock, no network — only
// node:crypto and deterministic serialization.
//
// THE CONTRACT: the job envelope is versioned, tenant-scoped
// (tenantId mandatory), capability-declared, idempotency-keyed, and
// SIGNED with HMAC-SHA256 over its CANONICAL serialization (sorted keys,
// no whitespace — byte-stable across processes and languages). The
// signing secret is WIRING CONFIGURATION on both sides (gateway signer +
// edge verifier); it is never persisted — job rows record only the key
// REFERENCE (`signerKeyRef`) and the signature.
//
// A job whose signature, tenant, version or idempotency key fails
// verification is rejected with a MACHINE-READABLE reason (never a vague
// error): 'unsupported_version' | 'bad_signature' | 'tenant_mismatch' |
// 'edge_mismatch' | 'invalid_idempotency_key' | 'invalid_envelope'.
// Verification order is structural → version → idempotency shape →
// signature → contextual (tenant/edge), so every failure mode is
// distinguishable in audit.
//
// SECRET HYGIENE: rejection details carry field names and shapes only —
// never a secret value (the verification secret's only use is inside the
// HMAC).

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  EdgeJobEnvelope,
  EdgeJobSigner,
  EnvelopeVerification,
  SignedEdgeJob,
} from './types';
import { EDGE_JOB_ENVELOPE_VERSION } from './types';
import { isUuid } from './validation';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,198}[A-Za-z0-9])?$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, no insignificant whitespace,
 * UTF-8. The byte-stable form every digest and signature is computed
 * over (the same discipline as canonical receipt digests elsewhere in
//  the house — two serializers must never disagree).
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value) ?? 'null';
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => serialize(entry)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`).join(',')}}`;
  }
  // Symbols/functions/BigInt never ride an envelope (validated upstream).
  return 'null';
}

/** The canonical bytes of one envelope (what every signature covers). */
export function canonicalEnvelopeBytes(envelope: EdgeJobEnvelope): Buffer {
  return Buffer.from(canonicalJson(envelope), 'utf8');
}

/** SHA-256 hex digest over arbitrary bytes. */
export function digestOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** SHA-256 hex digest of one envelope's canonical bytes. */
export function envelopeDigest(envelope: EdgeJobEnvelope): string {
  return digestOf(canonicalEnvelopeBytes(envelope));
}

/**
 * SHA-256 hex digest of one allowlist (order-insensitive, deduplicated):
 * the versioned identity of an edge's declared capability set — recorded
 * at registration, audited on change, reported in every heartbeat, and
 * compared to surface drift.
 */
export function allowlistDigestOf(allowlist: readonly string[]): string {
  const unique = [...new Set(allowlist)].sort();
  return digestOf(Buffer.from(canonicalJson(unique), 'utf8'));
}

// ---------------------------------------------------------------------------
// Signing (gateway side — the signer is wiring configuration)
// ---------------------------------------------------------------------------

/** Signs one envelope with the wired signer. */
export function signEnvelope(envelope: EdgeJobEnvelope, signer: EdgeJobSigner): SignedEdgeJob {
  return {
    envelope,
    signature: signer.sign(canonicalEnvelopeBytes(envelope)),
    signerKeyRef: signer.keyRef,
  };
}

// ---------------------------------------------------------------------------
// Verification (edge side AND gateway re-verification)
// ---------------------------------------------------------------------------

/**
 * Verifies one signed envelope against a verification secret and the
 * expected tenant/edge scope. Returns a machine-readable verdict: every
//  rejection names its reason. Structural checks first, then version,
//  then idempotency-key shape, then the HMAC (timing-safe), then the
//  contextual tenant/edge match.
 */
export function verifySignedEnvelope(
  signed: unknown,
  config: { verificationSecret: string; expectedTenantId?: string; expectedEdgeKey?: string },
): EnvelopeVerification {
  if (
    typeof signed !== 'object' ||
    signed === null ||
    Array.isArray(signed)
  ) {
    return { ok: false, reason: 'invalid_envelope', detail: 'the signed job is not an object' };
  }
  const candidate = signed as Partial<SignedEdgeJob>;
  if (
    typeof candidate.envelope !== 'object' ||
    candidate.envelope === null ||
    Array.isArray(candidate.envelope)
  ) {
    return { ok: false, reason: 'invalid_envelope', detail: 'the signed job carries no envelope object' };
  }
  if (typeof candidate.signature !== 'string' || !HEX64_PATTERN.test(candidate.signature)) {
    return {
      ok: false,
      reason: 'invalid_envelope',
      detail: "the signed job's signature is not a hex HMAC-SHA256 digest",
    };
  }
  if (typeof candidate.signerKeyRef !== 'string' || candidate.signerKeyRef.length === 0) {
    return {
      ok: false,
      reason: 'invalid_envelope',
      detail: "the signed job carries no signer key reference",
    };
  }
  const envelope = candidate.envelope as Partial<EdgeJobEnvelope>;

  // Version (forward-only).
  if (envelope.v !== EDGE_JOB_ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: 'unsupported_version',
      detail: `envelope version ${String(envelope.v)} is not supported (this verifier accepts v${EDGE_JOB_ENVELOPE_VERSION})`,
    };
  }

  // Tenant scope is mandatory.
  if (!isUuid(envelope.tenantId)) {
    return {
      ok: false,
      reason: 'invalid_envelope',
      detail: 'the envelope carries no tenant scope (tenantId is mandatory)',
    };
  }

  // Idempotency key shape (replay safety rides on it).
  if (
    typeof envelope.idempotencyKey !== 'string' ||
    !IDEMPOTENCY_KEY_PATTERN.test(envelope.idempotencyKey)
  ) {
    return {
      ok: false,
      reason: 'invalid_idempotency_key',
      detail: "the envelope's idempotency key does not match the canonical pattern",
    };
  }

  // The signature covers EVERY envelope field — any tamper breaks here.
  const expected = createHmac('sha256', config.verificationSecret)
    .update(canonicalEnvelopeBytes(envelope as EdgeJobEnvelope))
    .digest('hex');
  const given = Buffer.from(candidate.signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return {
      ok: false,
      reason: 'bad_signature',
      detail: 'the HMAC-SHA256 signature does not verify — the envelope was tampered with or signed with another key',
    };
  }

  // Contextual scope (defense in depth beyond the signature).
  if (config.expectedTenantId !== undefined && envelope.tenantId !== config.expectedTenantId) {
    return {
      ok: false,
      reason: 'tenant_mismatch',
      detail: 'the envelope is scoped to another tenant',
    };
  }
  if (config.expectedEdgeKey !== undefined && envelope.edgeKey !== config.expectedEdgeKey) {
    return {
      ok: false,
      reason: 'edge_mismatch',
      detail: 'the envelope is addressed to another edge',
    };
  }
  return { ok: true };
}
