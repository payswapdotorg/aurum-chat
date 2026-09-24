// Pure 5-field cron evaluation (W080 — schedules).
//
// Standard UNIX cron semantics, evaluated in UTC at minute granularity
// (the workflow module's schedules are UTC-only — the CHECK constraint
// in migrations/002 pins timezone='UTC'):
//   field         allowed values
//   minute        0-59
//   hour          0-23
//   day of month  1-31
//   month         1-12
//   day of week   0-7 (0 and 7 are both Sunday)
// Each field accepts `*`, `a`, `a-b`, `a-b/n`, `a/n` (step from a) and
// comma-separated lists of those. Names (JAN, MON) are deliberately NOT
// supported — the numeric-only grammar keeps parsing total and the
// evaluation deterministic.
//
// The classic Vixie-cron day rule applies: when BOTH day-of-month and
// day-of-week are restricted (neither is `*`), a minute matches when
// EITHER matches; otherwise the restricted one must match.
//
// `nextOccurrence` steps minute-by-minute (seconds zeroed) with a hard
// horizon (4 years) so a syntactically valid but never-matching
// expression (e.g. `0 0 31 2 *`) terminates deterministically with null.
// This is pure logic — no clock, no database — and is unit-tested
// directly.

/** Minimum seconds between cron evaluation steps. */
export const CRON_HORIZON_YEARS = 4;

interface CronField {
  /** Sorted matched values (empty = unrestricted `*`). */
  values: number[];
  /** True when the field is `*` (unrestricted). */
  any: boolean;
}

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** True when the day-of-month field is `*` (unrestricted). */
  domAny: boolean;
  /** True when the day-of-week field is `*` (unrestricted). */
  dowAny: boolean;
}

const FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

const DAY_OF_WEEK_FIELD = 4;

function parseField(raw: string, fieldIndex: number): CronField {
  const [minAllowed, maxAllowed] = FIELD_RANGES[fieldIndex]!;
  const parts = raw.split(',');
  const values = new Set<number>();
  let any = false;
  for (const part of parts) {
    const token = part.trim();
    if (token === '') {
      throw new Error(`empty list item in cron field '${raw}'`);
    }
    const stepMatch = /^(\*|(?:\d+)(?:-\d+)?)(?:\/(\d+))?$/.exec(token);
    if (stepMatch === null) {
      throw new Error(`invalid cron field token '${token}'`);
    }
    const rangePart = stepMatch[1]!;
    const step = stepMatch[2] === undefined ? 1 : Number.parseInt(stepMatch[2]!, 10);
    if (step < 1) {
      throw new Error(`cron step must be >= 1 (got ${String(step)})`);
    }
    let from: number;
    let to: number;
    if (rangePart === '*') {
      from = minAllowed;
      to = maxAllowed;
      if (parts.length === 1 && step === 1) any = true;
    } else if (rangePart.includes('-')) {
      const [rawFrom, rawTo] = rangePart.split('-');
      from = Number.parseInt(rawFrom!, 10);
      to = Number.parseInt(rawTo!, 10);
    } else {
      from = Number.parseInt(rangePart, 10);
      to = from;
    }
    if (!Number.isInteger(from) || !Number.isInteger(to)) {
      throw new Error(`invalid cron range '${rangePart}'`);
    }
    if (from < minAllowed || to > maxAllowed || from > to) {
      throw new Error(
        `cron value out of range: '${token}' (field allows ${minAllowed}-${maxAllowed})`,
      );
    }
    for (let value = from; value <= to; value += step) {
      // Day-of-week 7 is Sunday (same as 0) — normalize to 0.
      values.add(fieldIndex === DAY_OF_WEEK_FIELD && value === 7 ? 0 : value);
    }
  }
  return { values: [...values].sort((a, b) => a - b), any };
}

/** Parse a 5-field cron expression (throws on invalid grammar/ranges). */
export function parseCron(expression: string): ParsedCron {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error('cron expression must be a non-empty string');
  }
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have exactly 5 fields (got ${fields.length})`);
  }
  const parsedFields = fields.map((raw, index) => parseField(raw, index));
  return {
    minutes: parsedFields[0]!.values,
    hours: parsedFields[1]!.values,
    daysOfMonth: parsedFields[2]!.values,
    months: parsedFields[3]!.values,
    daysOfWeek: parsedFields[4]!.values,
    domAny: parsedFields[2]!.any,
    dowAny: parsedFields[4]!.any,
  };
}

/** Is this cron expression syntactically valid? */
export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(parsed: ParsedCron, dayOfMonth: number, dayOfWeek: number): boolean {
  // The Vixie rule: when BOTH day fields are restricted, either may
  // match; otherwise the restricted one (if any) must match.
  if (parsed.domAny && parsed.dowAny) return true;
  const domMatch = parsed.daysOfMonth.includes(dayOfMonth);
  const dowMatch = parsed.daysOfWeek.includes(dayOfWeek);
  if (parsed.domAny) return dowMatch;
  if (parsed.dowAny) return domMatch;
  return domMatch || dowMatch;
}

/** Does the given instant (at minute granularity) match the expression? */
export function cronMatches(parsed: ParsedCron, at: Date): boolean {
  if (!parsed.minutes.includes(at.getUTCMinutes())) return false;
  if (!parsed.hours.includes(at.getUTCHours())) return false;
  if (!parsed.months.includes(at.getUTCMonth() + 1)) return false;
  return dayMatches(parsed, at.getUTCDate(), at.getUTCDay());
}

/**
 * The first matching instant strictly after `after` (UTC, minute
 * granularity), or null when nothing matches within the horizon
 * (CRON_HORIZON_YEARS). Pure — the caller owns the clock.
 */
export function nextCronOccurrence(parsed: ParsedCron, after: Date): Date | null {
  const minuteMs = 60_000;
  // Start at the next minute boundary strictly after `after`.
  let cursor = Math.floor(after.getTime() / minuteMs) * minuteMs + minuteMs;
  const horizon = after.getTime() + CRON_HORIZON_YEARS * 365 * 24 * 60 * minuteMs;
  while (cursor <= horizon) {
    const candidate = new Date(cursor);
    if (cronMatches(parsed, candidate)) return candidate;
    cursor += minuteMs;
  }
  return null;
}

/**
 * Every matching instant in `(from, to]` (UTC, minute granularity), in
 * ascending order, capped at `max` entries to keep a runaway expression
 * (a catch-up window over a per-minute cron) bounded. Pure.
 */
export function cronOccurrencesBetween(
  parsed: ParsedCron,
  from: Date,
  to: Date,
  max = 1000,
): Date[] {
  const out: Date[] = [];
  let cursor = from.getTime();
  while (out.length < max) {
    const next = nextCronOccurrence(parsed, new Date(cursor));
    if (next === null || next.getTime() > to.getTime()) break;
    out.push(next);
    cursor = next.getTime();
  }
  return out;
}
