// Platform surfaces (W116) — the small pure display helpers of the
// waitlist desk (deterministic, dependency-free; the DOM suite locks the
// markup these feed).

/** The warm tile palette count (CSS carries the tones, .platform-tile[data-tone]). */
export const WAITLIST_TILE_TONES = 6;

/**
 * The deterministic contact-tile tone for a display name — the messenger
 * DNA: every contact row carries a colored initial tile, and the same
 * name always paints the same tone.
 */
export function waitlistTileTone(displayName: string): number {
  let sum = 0;
  for (const char of displayName) sum += char.codePointAt(0) ?? 0;
  return sum % WAITLIST_TILE_TONES;
}

/** The contact-tile initial (first code point, uppercased). */
export function waitlistTileInitial(displayName: string): string {
  const trimmed = displayName.trim();
  return trimmed === '' ? '?' : trimmed[0]!.toUpperCase();
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/**
 * Format one instant for the waitlist rows (UTC, deterministic — the same
 * stamp always renders the same text): "Oct 8, 2026 · 14:05".
 */
export function formatWaitlistInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${MONTHS[date.getUTCMonth()]!} ${date.getUTCDate()}, ${date.getUTCFullYear()}` +
    ` · ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  );
}
