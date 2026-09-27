// W107 — the vertical-kit ↔ edge-execution COMPOSITION ADAPTER.
//
// This file is the composition the W092 edge seam has awaited since the
// Edge Connector (W088) landed: it implements the kit-side
// `VerticalKitEdge` port using the edge-side PUBLIC transport — the W088
// Edge Connector's `createEdgeDeepActionTransport`, which is the W084
// DeepActionTransport port implemented over signed, tenant-scoped EDGE
// JOBS. Provider/runtime objects never cross the kit domain contract:
// the kit runtime keeps speaking `VerticalKitEdge` (opaque targets,
// canonical payloads, W084-shaped results) and the edge keeps speaking
// its own contract — THIS adapter is the only thing that translates, and
// it lives inside the vertical-kits module's ownership boundary.
//
//   kit runtime (W092)                       edge-connector (W088)
//   VerticalKitEdgeInspectRequest    ┌──┐    DeepActionInspectRequest
//   VerticalKitEdgeExecuteRequest →  │  │ →  DeepActionExecuteRequest
//   VerticalKitEdgeState   ←──────── │  │ ←  DeepActionState
//   VerticalKitEdgeReceipt ←──────── └──┘    DeepActionReceipt
//                                          (createEdgeDeepActionTransport
//                                           rides edge jobs end-to-end:
//                                           issue → dial-home → result)
//
// WHAT THE ADAPTER DOES (and deliberately does NOT do):
//
//   * REQUEST MAPPING — a kit integration's (integration, capability,
//     target, payload) becomes a W084 transport request. The connection
//     identity slots of the W084 request shape (connectionId /
//     credentialRef / systemKey) are WIRING-TIME configuration of this
//     binding, not kit manifest data: the wiring layer supplies the
//     opaque credential reference the EDGE resolves locally (the W082
//     discipline — values never cross) and an optional advisory system
//     key. The connection slot is inert at the edge transport (only the
//     deep-action pipeline interprets it) and carries this binding's
//     truthful descriptor.
//
//   * IDEMPOTENCY DISCIPLINE (the W084 retry semantics, reused — never
//     forked):
//       - INSPECT mints a FRESH key per call: a kit read is a live read
//         of the system of record and must never replay a previously
//         recorded outcome (the W088 job store replays recorded keys by
//         design — exactly what a retried WRITE wants and exactly what a
//         live READ must not get).
//       - EXECUTE derives a STABLE content-addressed key
//         `kit-edge:<installation>:w:<scope-hash>:<payload-hash>`: a
//         retried or duplicated identical write replays the ORIGINAL
//         edge job (never a second execution — the deep-action
//         discipline verbatim), while a changed payload is a genuinely
//         new write and executes fresh. The scope hash (not the raw
//         target) rides the key because edge idempotency keys are
//         charset-bounded while external targets are opaque strings.
//
//   * RESULT MAPPING — the transport's results are ALREADY W084-shaped
//     ({found, state} reads; {status, receiptId, detail} receipts in the
//     'accepted'/'rejected'/'failed' taxonomy); the adapter re-shapes
//     them onto the kit port's identical structures. Edge-minted values
//     stay OPAQUE strings (receipt ids). Provider objects never cross
//     (lock 16) — the kit service's canonicalization stands unchanged
//     behind this adapter.
//
//   * ERROR POSTURE — honest, propagating (the W084-composition
//     precedent): transport failures (edge_not_connected,
//     signer_unavailable, an expired envelope, an edge-boundary refusal
//     of an INSPECT job) surface to the kit caller as the edge
//     contract's own typed error, exactly as EdgeConnectorError surfaces
//     through the deep-action pipeline. A refused/failed EXECUTE is NOT
//     an error — it is the canonical receipt, returned as data.
//
//   * AUTHORITY — nothing here re-checks kit grants: the kit runtime
//     consults the W009-fronted capability gate BEFORE the edge is ever
//     invoked (see service.ts — gateKitCapability precedes every
//     edge.inspect/edge.execute call), so a denial never reaches this
//     adapter. The edge-side allowlist (W088) adds the EDGE's own
//     boundary policy on top — defense in depth, both sides.
//
//   * TENANT SCOPE — the binding captures its TenantContext at
//     construction: every edge job this adapter issues is scoped to the
//     wiring tenant, and the returned edge carries its `tenantId` marker
//     so the module's per-tenant registry can refuse a cross-tenant
//     wiring mistake loudly (never a silent leak).
//
// NO edge-connector internal is imported: only the PUBLIC contract
// (`@/modules/edge-connector/contract`) — the architecture-checker-legal
// import for cross-module composition. No vertical semantics leak the
// other way either: the edge receives plain W081-style capability keys
// and opaque targets, exactly as the W088 contract defines them.

import { createHash } from 'node:crypto';
import type { TenantContext } from '@/infra/tenant';
import { newId } from '@/infra/ids';
import {
  canonicalJson,
  createEdgeDeepActionTransport,
  type EdgeJobDriver,
} from '@/modules/edge-connector/contract';
import { VerticalKitsError } from './errors';
import { assertVerticalKitsTenantContext } from './validation';
import type {
  VerticalKitEdge,
  VerticalKitEdgeExecuteRequest,
  VerticalKitEdgeInspectRequest,
  VerticalKitEdgeReceipt,
  VerticalKitEdgeState,
} from './types';

// ---------------------------------------------------------------------------
// The wiring options
// ---------------------------------------------------------------------------

/** Options of `createEdgeConnectorKitEdge` (the W107 composition binding). */
export interface EdgeConnectorKitEdgeOptions {
  /** The edge runtime that serves this binding's jobs (opaque W088 id). */
  edgeId: string;
  /**
   * How the edge's dial-home loop is advanced while a transport call
   * waits (the W088 contract: production wiring awaits the edge's own
   * polling cycle; tests drive the deterministic simulator). Never an
   * outbound connection toward the edge.
   */
  drive: EdgeJobDriver;
  /**
   * The OPAQUE credential reference carried on every job envelope this
   * binding issues (the W082 discipline: the EDGE resolves it against
   * its own local secret store — the value never crosses the boundary).
   * 1..200 characters, wiring-supplied.
   */
  credentialRef: string;
  /**
   * The plain-language system-of-record descriptor carried on every job
   * envelope this binding issues (3..312 characters; the W084 request
   * shape requires the slot and the edge treats it as ADVISORY — the
   * edge's own allowlist is the boundary policy). Wiring-supplied; a
   * natural value is the kit integration's systemLabel.
   */
  systemKey: string;
  /** Edge-job envelope lifetime in seconds (default 300, W088 contract). */
  ttlSeconds?: number;
}

// ---------------------------------------------------------------------------
// Idempotency-key derivation (the W084 discipline, content-addressed)
// ---------------------------------------------------------------------------

/** sha-256 hex of the canonical JSON of the kit request's scope. */
function scopeHash(request: { installationId: string; integrationKey: string; target: string }): string {
  return createHash('sha256')
    .update(canonicalJson([request.installationId, request.integrationKey, request.target]))
    .digest('hex');
}

/** sha-256 hex of the canonical JSON of the write payload. */
function payloadHash(payload: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/**
 * The idempotency key of one kit READ: fresh per call — a live read must
 * never replay a previously recorded outcome (the job store's replay is
 * the WRITE retry discipline, not a read cache).
 */
function inspectIdempotencyKey(
  request: VerticalKitEdgeInspectRequest,
): string {
  return `kit-edge:${request.installationId}:i:${scopeHash(request)}:${newId()}`;
}

/**
 * The idempotency key of one kit WRITE: stable and content-addressed —
 * an identical write replays the ORIGINAL edge job (never a second
 * execution); a changed payload is a new key and executes fresh.
 */
function executeIdempotencyKey(request: VerticalKitEdgeExecuteRequest): string {
  return `kit-edge:${request.installationId}:w:${scopeHash(request)}:${payloadHash(request.payload)}`;
}

// ---------------------------------------------------------------------------
// The composition adapter
// ---------------------------------------------------------------------------

/**
 * Builds the W107 composition: a `VerticalKitEdge` (the W092 kit-side
 * port) whose inspect/execute ride the REAL W088 Edge Connector
 * transport (`createEdgeDeepActionTransport` — the W084
 * DeepActionTransport port over signed, tenant-scoped edge jobs). Wire
 * it per tenant through `setTenantKitEdge` (or, for a single-tenant
 * process/tests, through the module's global `setVerticalKitEdge`
 * seam); the kit runtime then executes kit integrations against the
 * customer-controlled edge exactly as the deep-action pipeline does —
 * same envelopes, same dial-home loop, same W084-shaped evidence.
 *
 * The returned object satisfies the frozen kit port and additionally
 * carries `tenantId` — the wiring tenant this binding issues jobs for.
 * The module's registry uses that marker to refuse cross-tenant wiring
 * mistakes loudly (an honest guard, not a silent leak).
 */
export function createEdgeConnectorKitEdge(
  ctx: TenantContext,
  options: EdgeConnectorKitEdgeOptions,
): VerticalKitEdge {
  assertVerticalKitsTenantContext(ctx);
  if (typeof options.edgeId !== 'string' || options.edgeId.trim() === '') {
    throw new VerticalKitsError(
      'invalid_input',
      "the edge binding requires a non-empty 'edgeId' (the opaque W088 runtime id)",
    );
  }
  if (typeof options.drive !== 'function') {
    throw new VerticalKitsError(
      'invalid_input',
      "the edge binding requires a 'drive' hook (the W088 EdgeJobDriver contract)",
    );
  }
  if (
    typeof options.credentialRef !== 'string' ||
    options.credentialRef.length < 1 ||
    options.credentialRef.length > 200
  ) {
    throw new VerticalKitsError(
      'invalid_input',
      "the edge binding requires an opaque 'credentialRef' of 1..200 characters (the W082 discipline — the edge resolves it locally)",
    );
  }
  if (
    typeof options.systemKey !== 'string' ||
    options.systemKey.length < 3 ||
    options.systemKey.length > 312
  ) {
    throw new VerticalKitsError(
      'invalid_input',
      "the edge binding requires a plain-language 'systemKey' of 3..312 characters (the advisory system-of-record descriptor)",
    );
  }

  // THE REAL W088 TRANSPORT — the public composition the edge-connector
  // module exports (never a re-implemented lookalike): every kit edge
  // call becomes a signed, tenant-scoped edge job, executed
  // customer-side through the dial-home loop, whose canonical result
  // maps back into the W084 shapes.
  const transport = createEdgeDeepActionTransport(ctx, {
    edgeId: options.edgeId,
    drive: options.drive,
    ttlSeconds: options.ttlSeconds,
  });

  // The W084 request's connection slot is inert at the edge transport
  // (only the deep-action pipeline interprets it) — this binding's
  // descriptor rides it so the request is truthful about its origin.
  const connectionSlot = `kit-edge:${options.edgeId}`;

  const edge: VerticalKitEdge = {
    edgeId: options.edgeId,

    async inspect(request: VerticalKitEdgeInspectRequest): Promise<VerticalKitEdgeState> {
      const state = await transport.inspect({
        connectionId: connectionSlot,
        credentialRef: options.credentialRef,
        systemKey: options.systemKey,
        capabilityKey: request.capabilityKey,
        target: request.target,
        idempotencyKey: inspectIdempotencyKey(request),
      });
      // Already W084-shaped ({found, state}) — re-shaped onto the kit
      // port's identical structure; opaque/plain-JSON values only.
      return { found: state.found, state: state.state };
    },

    async execute(request: VerticalKitEdgeExecuteRequest): Promise<VerticalKitEdgeReceipt> {
      const receipt = await transport.execute({
        connectionId: connectionSlot,
        credentialRef: options.credentialRef,
        systemKey: options.systemKey,
        capabilityKey: request.capabilityKey,
        target: request.target,
        payload: request.payload,
        idempotencyKey: executeIdempotencyKey(request),
      });
      // Already W084-shaped (the accepted/rejected/failed taxonomy,
      // opaque receipt id, bounded detail) — re-shaped verbatim.
      return {
        status: receipt.status,
        receiptId: receipt.receiptId,
        detail: receipt.detail,
      };
    },
  };

  // The wiring-tenant marker: the per-tenant registry refuses a
  // cross-tenant registration of THIS binding loudly (the marker is
  // additive to the frozen port shape — structural typing permits it).
  return Object.assign(edge, { tenantId: ctx.tenantId });
}
