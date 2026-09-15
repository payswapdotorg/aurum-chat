// Typed errors of the notifications module. Consumers catch
// `NotificationsError` and branch on `code`; messages are for
// humans/logs, never for control flow.
//
// Cross-tenant access is deliberately indistinguishable from a missing
// record (`notification_not_found` / `policy_not_found`) — the existence
// of another tenant's notifications or policies must never leak
// (ADR-0001), the same uniform not-found discipline every sibling module
// applies.

export type NotificationsErrorCode =
  | 'invalid_context'
  | 'invalid_notification_input'
  | 'invalid_notification_query'
  | 'invalid_policy_input'
  | 'invalid_policy_query'
  | 'forbidden'
  | 'policy_not_found'
  | 'policy_conflict'
  | 'notification_not_found'
  | 'notification_not_acknowledgeable'
  | 'acknowledgment_not_required'
  | 'already_acknowledged';

export class NotificationsError extends Error {
  constructor(
    public readonly code: NotificationsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationsError';
  }
}
