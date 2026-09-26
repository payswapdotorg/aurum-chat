// The signed-envelope core of the edge-connector (W088) — PURE logic, no
// database, no clock, no network. Both sides of the edge boundary use
// exactly these functions, which is what makes the protocol provable
// customer-side: the deterministic simulator (runtime/simulator.ts)
// verifies envelopes with ITS OWN key material through the same
// canonicalization Aurum signed with, never by trusting Aurum's state.
//
//   * canonicalJson          — the deterministic JSON form (sorted object
//     keys, no whitespace) every signature is computed over;
//   * canonicalEnvelopeMaterial — canonicalJson(envelope);
//   * edgeAuthMaterial       — the canonical dial-home proof material
//     (purpose-, tenant-, edge- and nonce-scoped);
//   * createHmacSigner       — the EdgeSigner implementation factory
//     (HMAC-SHA256, hex). The secret key material is wiring-time
//     configuration held OUTSIDE all domain tables — Aurum persists only
//     the OPAQUE key id (local secret handling, the W082 discipline).
//
// Replay resistance: every envelope carries a fresh nonce
// (canonicalEnvelopeMaterial includes it), and every dial-home proof
// material includes a fresh request nonce — a replayed signature is over
// stale material by construction.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EdgeAuthentication, EdgeJobEnvelope, EdgeSigner } from './types';

/** HMAC-SHA256 signature length in hex characters. */
export const EDGE_SIGNATURE_HEX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted lexicographically at every
 * depth, no insignificant whitespace, arrays order-preserving. The signed
 * form of every edge-protocol value.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serializeCanonical(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${serializeCanonical(entry)}`).join(',')}}`;
  }
  // Symbols/functions/undefined at top level: the protocol carries plain
  // JSON only; callers canonicalize validated values.
  return 'null';
}

/** The canonical material a job envelope's signature is computed over. */
export function canonicalEnvelopeMaterial(envelope: EdgeJobEnvelope): string {
  return canonicalJson(envelope);
}

/**
 * The canonical material of a dial-home proof: purpose-, tenant-, edge-
 * and nonce-scoped, so a proof is bound to exactly one call shape and
 * can never be replayed against another.
 */
export function edgeAuthMaterial(
  purpose: 'heartbeat' | 'pull' | 'submit',
  auth: Pick<EdgeAuthentication, 'tenantId' | 'edgeId' | 'requestNonce'>,
): string {
  return `edge-auth:v1:${purpose}:${auth.tenantId}:${auth.edgeId}:${auth.requestNonce}`;
}

// ---------------------------------------------------------------------------
// The HMAC signer (wiring-time infrastructure; key material never persisted)
// ---------------------------------------------------------------------------

function hmacHex(key: string, material: string): string {
  return createHmac('sha256', key).update(material, 'utf8').digest('hex');
}

/** Constant-time hex comparison (never a string !== shortcut on secrets). */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * The EdgeSigner factory: HMAC-SHA256 over the canonical material, keyed
 * by OPAQUE key id. `secretKeys` maps key ids to the enrollment key
 * material the customer provisioned out-of-band — the material lives in
 * wiring configuration (and at the edge), never in a domain table.
 */
export function createHmacSigner(config: { secretKeys: Record<string, string> }): EdgeSigner {
  const keys = new Map(Object.entries(config.secretKeys));
  return {
    sign(keyId: string, material: string): string {
      const key = keys.get(keyId);
      if (key === undefined) {
        throw new Error(`no enrollment key configured for key id '${keyId}'`);
      }
      return hmacHex(key, material);
    },
    verify(keyId: string, material: string, signature: string): boolean {
      const key = keys.get(keyId);
      if (key === undefined) return false;
      return safeEqualHex(hmacHex(key, material), signature);
    },
  };
}

/**
 * Pure signature check of a signed envelope against a signer the CALLER
 * supplies (edge implementers pass their own key-holding signer). This is
 * the edge-side primitive; `verifyEdgeJobEnvelope` (the service) layers
 * tenant scope, allowlist, expiry and replay adjudication on top.
 */
export function verifyEnvelopeSignature(
  envelope: EdgeJobEnvelope,
  signature: string,
  signer: Pick<EdgeSigner, 'verify'>,
): boolean {
  return signer.verify(envelope.keyId, canonicalEnvelopeMaterial(envelope), signature);
}
