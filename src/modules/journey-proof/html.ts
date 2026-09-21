// Minimal HTML inspection utilities for the W070 proof suites (pure,
// dependency-free, regex-based — deliberately NOT a DOM: the proofs need
// tag presence, attribute values and link graphs, not tree mutation).
//
// What these functions are used for:
//   * extracting every in-document link of a rendered page (the
//     no-dead-end and journey-walking proofs);
//   * resolving hrefs against the page's own route (absolute paths,
//     hash- and query-stripped matching);
//   * the accessibility audit (accessible names, landmarks, images,
//     inputs, tables, tabindex).
//
// The regexes handle the HTML React's server renderer emits (always
// quoted attributes, no comments-in-tags, entities in text). They do not
// need to handle arbitrary hand-written HTML.

/** Minimal entity decoding for accessible-name text. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)));
}

/** One parsed opening tag: its name and attributes (lowercased names). */
export interface ParsedTag {
  name: string;
  attrs: Record<string, string>;
  /** Where the tag starts in the document. */
  index: number;
  /** The full opening tag source (up to and including '>'). */
  source: string;
}

const TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^<>]*?)?)\/?>/g;
const ATTR_PATTERN = /([a-zA-Z][a-zA-Z0-9-:]*)\s*=\s*"([^"]*)"|([a-zA-Z][a-zA-Z0-9-:]*)\s*=\s*'([^']*)'/g;

/** Parse one tag source's attributes into a name→value map. */
function parseAttrs(attrSource: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of attrSource.matchAll(ATTR_PATTERN)) {
    const name = (match[1] ?? match[3] ?? '').toLowerCase();
    const value = match[2] ?? match[4] ?? '';
    if (name !== '') attrs[name] = value;
  }
  return attrs;
}

/** Every opening tag with the given name, in document order. */
export function findTags(html: string, tagName: string): ParsedTag[] {
  const lower = tagName.toLowerCase();
  const tags: ParsedTag[] = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    if (match[1]!.toLowerCase() !== lower) continue;
    tags.push({
      name: lower,
      attrs: parseAttrs(match[2] ?? ''),
      index: match.index ?? 0,
      source: match[0],
    });
  }
  return tags;
}

/** The inner text of an element (tags stripped, entities decoded, whitespace collapsed). */
export function textContent(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * The end index of the element that starts at `startIndex` (after its
 * opening tag), or -1 when unbalanced. Handles nested same-name elements.
 */
export function elementEnd(html: string, tagName: string, startIndex: number): number {
  const lower = tagName.toLowerCase();
  let depth = 0;
  const pattern = new RegExp(`<(/?)${lower}(?:\\s[^<>]*?)?/?>`, 'gi');
  pattern.lastIndex = startIndex;
  for (let match = pattern.exec(html); match !== null; match = pattern.exec(html)) {
    const closing = match[1] === '/';
    const selfClosing = match[0].endsWith('/>');
    if (!closing && !selfClosing) depth += 1;
    else if (closing) {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    }
  }
  return -1;
}

/** Does the element carry a `hidden` attribute or `aria-hidden="true"`? */
export function isHiddenTag(tag: ParsedTag): boolean {
  return 'hidden' in tag.attrs || tag.attrs['aria-hidden'] === 'true';
}

/**
 * The accessible name of an element per the static subset that matters
 * here: aria-label, aria-labelledby (resolved against the document),
 * the title attribute, then the inner text (links/buttons) — or the
 * value/placeholder where the element has no text.
 */
export function accessibleName(html: string, tag: ParsedTag): string {
  const label = tag.attrs['aria-label'];
  if (label !== undefined && label.trim() !== '') return label.trim();
  const labelledBy = tag.attrs['aria-labelledby'];
  if (labelledBy !== undefined && labelledBy.trim() !== '') {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => findTagById(html, id))
      .filter((found): found is { tag: ParsedTag; end: number } => found !== null)
      .map((found) => textContent(html.slice(found.tag.index, found.end)));
    if (parts.length > 0) return parts.join(' ').trim();
  }
  const title = tag.attrs['title'];
  if (title !== undefined && title.trim() !== '') return title.trim();
  const end = elementEnd(html, tag.name, tag.index);
  const inner = end === -1 ? '' : html.slice(tag.source.length + tag.index, end - `</${tag.name}>`.length);
  const text = textContent(inner);
  if (text !== '') return text;
  const value = tag.attrs['value'];
  if (value !== undefined && value.trim() !== '') return value.trim();
  const placeholder = tag.attrs['placeholder'];
  if (placeholder !== undefined && placeholder.trim() !== '') return '';
  return '';
}

/** Find the element carrying a given id (opening tag + its end index). */
export function findTagById(html: string, id: string): { tag: ParsedTag; end: number } | null {
  for (const tag of allTags(html)) {
    if (tag.attrs['id'] === id) {
      return { tag, end: elementEnd(html, tag.name, tag.index) };
    }
  }
  return null;
}

/** Every opening tag in the document, in order. */
export function allTags(html: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  for (const match of html.matchAll(TAG_PATTERN)) {
    tags.push({
      name: match[1]!.toLowerCase(),
      attrs: parseAttrs(match[2] ?? ''),
      index: match.index ?? 0,
      source: match[0],
    });
  }
  return tags;
}

/** Strip the query string and hash from a path (link-graph identity). */
export function stripQueryAndHash(href: string): string {
  const withoutHash = href.split('#')[0] ?? '';
  return withoutHash.split('?')[0] ?? '';
}

/** Does an href point inside the app (relative, or same-origin absolute)? */
export function isInternalHref(href: string): boolean {
  if (href === '' || href.startsWith('#')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false; // mailto:, https://other…
  if (href.startsWith('//')) return false;
  return true;
}

/** Resolve an internal href against a base path (the page's own route). */
export function resolveHref(href: string, basePath: string): string {
  if (href.startsWith('/')) return href;
  const baseSegments = basePath.split('/').filter((segment) => segment !== '');
  // basePath is a directory-style base: resolve relative segments against it.
  const segments = [...baseSegments];
  for (const segment of href.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}
