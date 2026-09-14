// Typed errors of the events module. Consumers catch `EventsError` and
// branch on `code`; messages are for humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`event_not_found`) — the existence of another tenant's history
// must never leak (ADR-0001). This includes causation references: an event
// of another tenant cannot be named as a cause.

export type EventsErrorCode =
  | 'invalid_context'
  | 'invalid_event_input'
  | 'invalid_event_query'
  | 'event_not_found';

export class EventsError extends Error {
  constructor(
    public readonly code: EventsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventsError';
  }
}
