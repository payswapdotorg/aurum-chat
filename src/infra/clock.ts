// Injectable clock: application code reads time through `now()`; tests
// substitute a fixed Clock (IMPLEMENTATION-STACK §8: test-controllable time).

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** Current time (system clock). */
export function now(): Date {
  return systemClock.now();
}

/** A Clock frozen at a fixed instant — for tests. */
export function fixedClock(at: Date | string | number): Clock {
  const fixed = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  return {
    now: () => new Date(fixed.getTime()),
  };
}
