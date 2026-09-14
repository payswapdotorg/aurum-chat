// Slug derivation and validation (pure logic, no db).
//
// Slugs are the human-facing identifiers of tenants (platform namespace,
// globally unique) and workspaces (per-tenant namespace). A slug is 1–63
// chars of `[a-z0-9-]`, starting and ending with an alphanumeric. Callers
// may pass an explicit slug (normalized, then validated) or let the module
// derive one from the entity name; if a name yields no usable slug (for
// example a name made entirely of punctuation), the caller must supply one.

export const SLUG_MAX_LENGTH = 63;

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

/**
 * Best-effort normalization: lowercase, collapse everything that is not
 * `a-z0-9` into single dashes, trim dashes, cap at 63 chars. Returns ''
 * when nothing usable remains.
 */
export function normalizeSlug(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '');
  return collapsed.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/**
 * Derive a workspace/tenant slug from a name, or null when the name cannot
 * yield a valid slug (caller must then provide an explicit one).
 */
export function deriveSlug(name: string): string | null {
  const normalized = normalizeSlug(name);
  return isValidSlug(normalized) ? normalized : null;
}
