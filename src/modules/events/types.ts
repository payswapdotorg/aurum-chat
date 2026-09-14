// Public domain types of the events module (W003 — Events).
//
// An Event is an immutable historical occurrence (ARCHITECTURE.md §4,
// lock 5): something that HAPPENED in the tenant's world — a message was
// received, an invoice was registered, a goal was approved. Events are the
// facts of history; they are not evidence with a confidence (that is the
// observations module, W004) and not understanding (epistemics, W007).
// Downstream modules (process intelligence W016, audit, the API surface)
// derive everything from the append-only event log.
//
// The envelope is VERSIONED (work item W003) on two axes:
//   - `envelopeVersion` — the version of the envelope SHAPE itself, stamped
//     by the module (never caller-supplied). Readers of any row know which
//     envelope layout they are decoding, so the log can outlive envelope
//     evolution without rewriting history.
//   - `typeVersion` — the version of THIS event type's payload contract,
//     chosen by the emitting module. Payload schemas evolve by bumping the
//     type version; old rows keep their old version forever.
//
// Provenance fields (work item): `tenantId` (lock 3 — every business datum
// is tenant-scoped), `actor` (who or what caused the occurrence) and
// `source` (the surface the event entered Aurum through). Both are
// provider-neutral references (lock 16): opaque ids owned by their modules
// (people W002, agents W021+, sources W036) or human-readable labels —
// never provider objects.
//
// `correlationId` / `causationId` (ARCHITECTURE.md §25 — executions carry
// correlation and causation identities): the correlation id groups every
// event of one logical flow; the causation id names the event that directly
// caused this one. The service guarantees a COMPLETE correlation chain: an
// explicit id wins; a caused event otherwise inherits its cause's
// correlation id; a root event otherwise correlates to itself.
//
// Ordering metadata (work item acceptance): `sequence` is a per-tenant,
// strictly increasing integer assigned at append time — the canonical
// replay order, unique within the tenant. `occurredAt` is when the
// occurrence happened per the acting system's clock; `recordedAt` is when
// Aurum committed it (service-controlled, from the injectable clock).
//
// Idempotency (work item acceptance): `idempotencyKey` is an
// emitter-supplied dedupe key, unique per tenant. Re-appending the same key
// returns the originally recorded event — at-least-once emitters (source
// connectors, channel webhooks, retries) cannot duplicate history.

/** Who or what caused a historical occurrence. */
export type EventActorKind = 'person' | 'agent' | 'system' | 'external' | 'source';

/**
 * The initiator of an event. `id` is an opaque reference to the record
 * owned by the respective module (people W002 for `person`, agents W021+
 * for `agent`, sources W036 for `source`); none of those modules is a
 * dependency of events (L0 foundation), so the reference is deliberately
 * unverified here. `label` carries a human-readable origin. At least one
 * of `id` / `label` must be present — provenance must be traceable.
 */
export interface EventActor {
  kind: EventActorKind;
  id?: string | null;
  label?: string | null;
}

/** The surface through which an event entered Aurum. */
export type EventSourceKind = 'source' | 'channel' | 'system' | 'api' | 'external';

/**
 * Provenance of the delivery path: a source connector (`source`), a
 * communication channel (`channel`), an internal Aurum subsystem
 * (`system`), the public API (`api`) or an external origin (`external`).
 * Same traceability rule as the actor: `id` or `label` must be present,
 * and both are provider-neutral (lock 16).
 */
export interface EventSource {
  kind: EventSourceKind;
  id?: string | null;
  label?: string | null;
}

/** Input shape of `appendEvent`. */
export interface AppendEventInput {
  /** Canonical event classification, e.g. `invoice.registered`, `goal.approved`. */
  type: string;
  /** Version of this type's payload contract — defaults to 1. */
  typeVersion?: number;
  /** The occurrence's content — any plain JSON value (must be JSON-serializable, non-null). */
  payload: unknown;
  /**
   * When the occurrence happened per the acting system's clock — strict
   * ISO 8601 with explicit offset.
   */
  occurredAt: string;
  actor: EventActor;
  source: EventSource;
  /**
   * Explicit correlation id for the flow this event belongs to. When
   * omitted, a caused event inherits its cause's correlation id and a root
   * event correlates to itself. An explicit id always wins over
   * inheritance.
   */
  correlationId?: string | null;
  /** The event that directly caused this one; must exist in the same tenant. */
  causationId?: string | null;
  /**
   * Emitter-supplied dedupe key, unique per tenant. Re-appending an
   * already-recorded key returns the original event unchanged (first
   * write wins) — retries and webhook redeliveries cannot duplicate
   * history. Omit for events without a natural key.
   */
  idempotencyKey?: string | null;
}

/** One recorded event — the persisted, immutable envelope. */
export interface Event {
  id: string;
  tenantId: string;
  /** Envelope shape version, stamped by the module (see ENVELOPE_VERSION). */
  envelopeVersion: number;
  type: string;
  typeVersion: number;
  payload: unknown;
  /** ISO 8601 — when the occurrence happened (acting system's clock). */
  occurredAt: string;
  /** ISO 8601 — when Aurum committed the event (service-controlled). */
  recordedAt: string;
  /** Per-tenant, strictly increasing — the canonical replay order. */
  sequence: number;
  actor: EventActor;
  source: EventSource;
  /** Always present: explicit, inherited from the cause, or the event's own id (root). */
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string | null;
}

/** Query shape of `listEvents`. */
export interface ListEventsQuery {
  type?: string;
  /** Requires `type` (a version is meaningless without its type). */
  typeVersion?: number;
  actorKind?: EventActorKind;
  /** Requires `actorKind`. */
  actorId?: string;
  sourceKind?: EventSourceKind;
  /** Requires `sourceKind`. */
  sourceId?: string;
  /** Every event of one logical flow. */
  correlationId?: string;
  /** The direct children of one event. */
  causationId?: string;
  /** Locate a previously appended event by its dedupe key. */
  idempotencyKey?: string;
  /** Inclusive lower bound on `occurredAt` — strict ISO 8601. */
  occurredFrom?: string;
  /** Inclusive upper bound on `occurredAt` — strict ISO 8601. */
  occurredTo?: string;
  /** Inclusive lower bound on `sequence` — replay cursor. */
  sequenceFrom?: number;
  /** Inclusive upper bound on `sequence` — replay cursor. */
  sequenceTo?: number;
  /** Replay direction: `asc` (default, canonical order) or `desc`. */
  order?: 'asc' | 'desc';
  /** 1..500, default 50. */
  limit?: number;
}

/** The causation ancestry of one event: the event plus its causes, root last. */
export interface EventCausationChain {
  event: Event;
  /**
   * The direct cause first, then its cause, up to the root event (which
   * has `causationId` null). Empty for a root event.
   */
  causes: Event[];
}
