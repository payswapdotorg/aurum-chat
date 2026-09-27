// Carrier webhook REQUEST AUTHENTICITY verification (MODULE-INTERNAL —
// the vendor-specific signature algorithms live only here, lock 16; the
// carrier-facing route consumes them through the module contract's
// provider-neutral carrier-edge function).
//
// TWILIO (documented request validation): Twilio co-signs every webhook
// it delivers with `X-Twilio-Signature` = base64(HMAC-SHA1(authToken,
// url + Σ sorted-params(key + value))). The URL is the FULL URL the
// carrier POSTed to (scheme, host, path, query); the params are the POST
// parameters sorted alphabetically by key with each key and value
// concatenated in order. The vendor's default webhook content type is
// `application/x-www-form-urlencoded` (the verified path); JSON bodies
// are supported by stringifying each top-level value (primitives via
// String(), objects via JSON.stringify) into the same documented
// concatenation.
//
// TELNYX (documented request validation): Telnyx signs every webhook
// with Ed25519 over the payload `${Telnyx-Timestamp}|${rawBody}` and
// delivers the base64 signature in `Telnyx-Signature`. Verification uses
// the account's configured webhook PUBLIC KEY — a base64-encoded
// DER/SPKI Ed25519 key. (Replay redelivery is additionally idempotent at
// the application layer: the cellular event ledger dedupes on the
// vendor's stable event id.)
//
// Both verifiers are PURE (no I/O), fail CLOSED (missing headers,
// malformed keys, non-matching digests → false; never an exception), and
// use timing-safe comparison where a secret is involved.

import { createHmac, createPublicKey, timingSafeEqual, verify as ed25519Verify } from 'node:crypto';

/** Parse a POST body into the flat string params Twilio's signature concatenates. */
export function twilioSignatureParams(
  rawBody: string,
  contentType: string | null,
): Record<string, string> {
  const type = contentType === null ? '' : contentType.toLowerCase();
  if (type.includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody) as unknown;
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      out[key] =
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'boolean'
            ? String(value)
            : value === null || value === undefined
              ? ''
              : JSON.stringify(value);
    }
    return out;
  }
  // The vendor default: application/x-www-form-urlencoded.
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody)) {
    out[key] = value;
  }
  return out;
}

/** base64(HMAC-SHA1(authToken, url + Σ sorted(key+value))) — the documented digest. */
export function twilioExpectedSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  let payload = url;
  for (const key of Object.keys(params).sort()) {
    payload += key + params[key]!;
  }
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

/**
 * Verify one Twilio webhook request. `signature` is the raw
 * X-Twilio-Signature header value. Missing/malformed → false (fail
 * closed). Comparison is timing-safe.
 */
export function verifyTwilioWebhookSignature(input: {
  authToken: string;
  url: string;
  params: Record<string, string>;
  signature: string | null;
}): boolean {
  if (input.signature === null || input.signature.trim() === '') return false;
  const expected = Buffer.from(
    twilioExpectedSignature(input.authToken, input.url, input.params),
    'base64',
  );
  let provided: Buffer;
  try {
    provided = Buffer.from(input.signature.trim(), 'base64');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/**
 * Verify one Telnyx webhook request. `publicKeyBase64Der` is the
 * configured webhook public key; `timestamp`/`signature` are the
 * Telnyx-Timestamp / Telnyx-Signature header values; `rawBody` is the
 * exact body bytes the carrier delivered (as received). Missing headers
 * or a malformed key → false (fail closed).
 */
export function verifyTelnyxWebhookSignature(input: {
  publicKeyBase64Der: string;
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
}): boolean {
  if (input.timestamp === null || input.timestamp.trim() === '') return false;
  if (input.signature === null || input.signature.trim() === '') return false;
  let publicKey;
  try {
    publicKey = createPublicKey({
      key: Buffer.from(input.publicKeyBase64Der.trim(), 'base64'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    // A malformed configured key never authenticates anything.
    return false;
  }
  const signedPayload = Buffer.from(`${input.timestamp.trim()}|${input.rawBody}`, 'utf8');
  let signature: Buffer;
  try {
    signature = Buffer.from(input.signature.trim(), 'base64');
  } catch {
    return false;
  }
  try {
    return ed25519Verify(null, signedPayload, publicKey, signature);
  } catch {
    return false;
  }
}
