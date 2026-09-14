// Unit tests for the people module's employee status lifecycle (pure logic).

import { describe, expect, it } from 'vitest';
import { canTransitionEmployeeStatus, isEmployeeStatus } from '../employee-status';

describe('employee status vocabulary', () => {
  it('recognizes the status vocabulary', () => {
    for (const status of ['active', 'on_leave', 'terminated'] as const) {
      expect(isEmployeeStatus(status)).toBe(true);
    }
    for (const bad of ['Active', 'fired', '', 'on-leave', null, 1, undefined]) {
      expect(isEmployeeStatus(bad)).toBe(false);
    }
  });
});

describe('employee status transitions', () => {
  it('allows leave round-trips and termination', () => {
    expect(canTransitionEmployeeStatus('active', 'on_leave')).toBe(true);
    expect(canTransitionEmployeeStatus('on_leave', 'active')).toBe(true);
    expect(canTransitionEmployeeStatus('active', 'terminated')).toBe(true);
    expect(canTransitionEmployeeStatus('on_leave', 'terminated')).toBe(true);
  });

  it('makes termination terminal and rejects no-op transitions', () => {
    expect(canTransitionEmployeeStatus('terminated', 'active')).toBe(false);
    expect(canTransitionEmployeeStatus('terminated', 'on_leave')).toBe(false);
    expect(canTransitionEmployeeStatus('active', 'active')).toBe(false);
    expect(canTransitionEmployeeStatus('on_leave', 'on_leave')).toBe(false);
    expect(canTransitionEmployeeStatus('terminated', 'terminated')).toBe(false);
  });
});
