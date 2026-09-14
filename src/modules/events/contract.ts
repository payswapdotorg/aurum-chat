// ============================================================================
// events — the ONLY public surface of the events module
// (IMPLEMENTATION-STACK §2; cross-module imports of anything else are
// architecture violations detected by scripts/check-architecture.ts).
//
// W003 — Events:
// "Create immutable versioned domain event envelope with tenant, actor,
//  source, correlation and causation fields. Verify ordering metadata and
//  idempotency keys."
//
//   appendEvent            — append one immutable, versioned event to the
//      tenant's history. The envelope (id, tenancy, commit time, sequence
//      position, envelope version) is system-minted; ordering and
//      idempotency are enforced at the storage layer.
//   getEvent               — tenant-scoped read of one event.
//   listEvents             — filtered, sequenced replay of the tenant's
//      history (type/version, actor, source, correlation, causation,
//      idempotency key, occurred window, sequence cursor, direction).
//   getEventCausationChain — the causation ancestry of one event up to its
//      root (whole correlation flows are one
//      listEvents({ correlationId }) away).
//
// There is deliberately NO operation to update, delete, correct or
// overwrite an event: events are immutable history (lock 5). The database
// enforces the same with triggers that reject UPDATE/DELETE/TRUNCATE
// (migrations/001 and /002). Idempotent re-append of a recorded key returns
// the original event — it is a replay, not a mutation.
//
// Tenancy (ADR-0001): every operation takes an explicit TenantContext and
// is tenant-scoped at the SQL layer; access to another tenant's history
// (including as a causation reference) is reported as `event_not_found` —
// no existence leak.
// ============================================================================

export {
  appendEvent,
  getEvent,
  getEventCausationChain,
  listEvents,
} from './service';

export { EventsError } from './errors';
export type { EventsErrorCode } from './errors';

export {
  DEFAULT_LIST_LIMIT,
  ENVELOPE_VERSION,
  EVENT_ACTOR_KINDS,
  EVENT_SOURCE_KINDS,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_LIST_LIMIT,
  isEventActorKind,
  isEventSourceKind,
} from './validation';

export type {
  ValidatedAppendInput,
  ValidatedListQuery,
} from './validation';

export type {
  AppendEventInput,
  Event,
  EventActor,
  EventActorKind,
  EventCausationChain,
  EventSource,
  EventSourceKind,
  ListEventsQuery,
} from './types';
