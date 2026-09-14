// Employee status lifecycle (pure logic, no database).
//
// `terminated` is terminal: a terminated employment is never silently
// resurrected — a new employment record for the same human is a new person
// lifecycle decision, out of W002 scope. No-op transitions are rejected so
// every recorded transition is a real state change.

import type { EmployeeStatus } from './types';

const TRANSITIONS: Record<EmployeeStatus, readonly EmployeeStatus[]> = {
  active: ['on_leave', 'terminated'],
  on_leave: ['active', 'terminated'],
  terminated: [],
};

export function isEmployeeStatus(value: unknown): value is EmployeeStatus {
  return value === 'active' || value === 'on_leave' || value === 'terminated';
}

/** True when the `from → to` transition is allowed (different, legal states). */
export function canTransitionEmployeeStatus(from: EmployeeStatus, to: EmployeeStatus): boolean {
  return from !== to && TRANSITIONS[from].includes(to);
}
