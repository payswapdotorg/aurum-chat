// Pure runtime rules of the extensions module (W026 — General-Purpose
// Extension Runtime). No database, no context, no time — the closed
// vocabularies, bounds and pure helpers the runtime's operations and the
// tests (and later W027/W028) share, exactly the way manifest-rules.ts
// serves W025's three enforcers.
//
// W026 implements the RUNTIME half of ARCHITECTURE.md §17's extension
// story ("Runtime supports persistent tenant/install scoped state,
// host-rendered declarative UI, scheduled triggers, event subscriptions,
// scoped external participants, isolation, quotas, versioning,
// deployment, rollback, disablement, compatibility and telemetry").
// W025 owns the contracts the runtime consumes: manifests declare WHAT
// an extension needs (capabilities + requestedPermissions ceiling +
// quotas + host range); W026 makes those declarations OPERATIONAL:
//
//   * DEPLOYMENT carries the effective GRANT (granted permissions ⊆ the
//     deployed manifest's requestedPermissions ceiling — the W025
//     "install-time grant" the contract layer explicitly deferred here);
//     every runtime operation is authorized against the CURRENT
//     deployment's grant, so least privilege is enforced at run time,
//     not just at review time. Deployments and rollbacks go through the
//     actions module's authority matrix (kind 'extension-deployment',
//     level EXECUTE — §20's uniform gate), each applied transition
//     appends one immutable deployment record, and the current
//     deployment (latest record per (extension, install)) is DERIVED,
//     never mutated — history is the record, the present is a fold.
//   * PERSISTENT SCOPED STATE: tenant scope = one namespace per
//     (tenant, extension) shared across deployments (state survives
//     version upgrades and rollbacks); install scope = one namespace
//     per (tenant, extension, installKey), isolated between installs.
//     Both are bounded by the manifest's maxStateBytes quota.
//   * DECLARATIVE UI: extensions contribute UI DOCUMENTS — flat, closed-
//     vocabulary, data-only declarations per (extension, surface) that
//     the HOST renders. Extensions never ship code to the UI layer;
//     there is deliberately no scripting, no layout engine and no event
//     handler in the vocabulary (isolation: the host renders data).
//   * SCHEDULES: the host's scheduler fires a DECLARED schedule by name
//     (the manifest's cron grammar is already validated by W025); the
//     runtime appends one immutable run record per invocation, bounded
//     by maxScheduleInvocationsPerDay per (tenant, extension, install,
//     UTC day).
//   * EVENT SUBSCRIPTIONS: dispatch one canonical topic to every install
//     whose current deployment's manifest subscribes to it; each
//     delivery is append-only evidence (delivered, or not_granted when
//     the install's grant omits events:subscribe — a grant downgrade is
//     visible, never silent).
//   * SCOPED EXTERNAL PARTICIPATION: outbound calls are restricted to
//     the EXACT https origins the current deployment's manifest
//     declares, bounded by maxExternalCallsPerDay, and executed through
//     the injectable http port (http.ts) — egress is host-provided
//     infrastructure, never ambient network access from domain code.
//   * TELEMETRY: extensions may emit their own bounded telemetry events
//     (gated on the manifest's telemetry capability and the
//     telemetry:emit grant); the runtime's own activity records
//     (deployments, schedule runs, deliveries, external calls) are
//     themselves append-only evidence.
//   * COMPATIBILITY: the runtime pins its own host version
//     (EXTENSION_RUNTIME_HOST_VERSION, tracking the architecture
//     version); deployment re-checks the manifest's declared range
//     against it with W025's exported pure check.
//
// Disablement is W025's lifecycle (SUSPENDED): every runtime operation
// re-checks the extension is ACTIVE, so a suspended extension is fully
// inert while its state, history and evidence survive.

import { NAME_SLUG_PATTERN, type ExtensionCapabilities, type ExtensionExternalParticipant } from './manifest-rules';
import { parseSemver } from './semver';

// ---------------------------------------------------------------------------
// Host identity
// ---------------------------------------------------------------------------

/**
 * The version of THIS extension runtime, which manifests declare their
 * hostCompatibility range against. Tracks the frozen architecture
 * version (2.1) — the runtime is the §17 host surface that lock
 * describes. Deployment re-checks compatibility against this value.
 */
export const EXTENSION_RUNTIME_HOST_VERSION = '2.1.0';

/** Parsed parts of the runtime host version (for comparisons). */
export const EXTENSION_RUNTIME_HOST_PARTS = parseSemver(EXTENSION_RUNTIME_HOST_VERSION)!;

// ---------------------------------------------------------------------------
// Installs and state keys
// ---------------------------------------------------------------------------

/**
 * The install key of a tenant's primary install — the one deployments
 * use when the caller does not distinguish installs. A deployment with
 * this key upgrades in place; a different key is a separate install
 * (isolated install-scoped state, isolated quota windows).
 */
export const DEFAULT_INSTALL_KEY = 'default';

/** Install keys are name slugs (≤ 64 chars, [A-Za-z0-9._:-] family). */
export const INSTALL_KEY_PATTERN = NAME_SLUG_PATTERN;

export function isInstallKey(value: string): boolean {
  return INSTALL_KEY_PATTERN.test(value);
}

/**
 * State keys: ≤ 128 chars, alnum first, then the slug character family.
 * The same discipline as W025's schedule names, at KV-key scale.
 */
export const STATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isStateKey(value: string): boolean {
  return STATE_KEY_PATTERN.test(value);
}

/** Maximum serialized size of ONE state value (JSON.stringify bytes). */
export const MAX_STATE_VALUE_BYTES = 262_144; // 256 KiB

// ---------------------------------------------------------------------------
// Declarative UI (host-rendered; data only)
// ---------------------------------------------------------------------------

/**
 * The closed vocabulary of declarative UI blocks. Deliberately
 * presentational only — heading, text, metric, list, table, divider.
 * No scripting, no layout, no handlers: the host renders data the
 * extension declared (§17 "host-rendered declarative UI"; §21's control
 * tower surfaces are the primary consumers).
 */
export const EXTENSION_UI_BLOCK_TYPES = [
  'heading',
  'text',
  'metric',
  'list',
  'table',
  'divider',
] as const;

export type ExtensionUiBlockType = (typeof EXTENSION_UI_BLOCK_TYPES)[number];

export function isExtensionUiBlockType(value: unknown): value is ExtensionUiBlockType {
  return (
    typeof value === 'string' &&
    (EXTENSION_UI_BLOCK_TYPES as readonly string[]).includes(value)
  );
}

/** One block of a declarative UI document (discriminated by `type`). */
export type ExtensionUiBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'metric'; label: string; value: string }
  | { type: 'list'; items: string[] }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'divider' };

/**
 * A declarative UI document: an optional title plus a FLAT list of
 * blocks (depth is one — a panel, not a page tree). The host renders it;
 * nothing in it executes.
 */
export interface ExtensionUiDocument {
  title: string | null;
  blocks: ExtensionUiBlock[];
}

export const MAX_UI_BLOCKS = 32;
export const MAX_UI_TEXT_CHARS = 500;
export const MAX_UI_TABLE_COLUMNS = 8;
export const MAX_UI_TABLE_ROWS = 32;
export const MAX_UI_LIST_ITEMS = 32;

/**
 * The problems that make a UI document unrenderable — the closed
 * vocabulary, the block shapes, and the bounds. Empty array =
 * renderable. Pure; shared by validation (publish) so a stored document
 * is always host-renderable.
 */
export function uiDocumentProblems(document: ExtensionUiDocument): string[] {
  const problems: string[] = [];
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return ['the UI document must be an object with blocks'];
  }
  const { title, blocks } = document as { title?: unknown; blocks?: unknown };
  if (title !== undefined && title !== null) {
    if (typeof title !== 'string') {
      problems.push('title must be a string or null');
    } else if (title.length > MAX_UI_TEXT_CHARS) {
      problems.push(`title must be at most ${MAX_UI_TEXT_CHARS} characters`);
    }
  }
  if (!Array.isArray(blocks)) {
    problems.push('blocks must be an array');
    return problems;
  }
  if (blocks.length > MAX_UI_BLOCKS) {
    problems.push(`blocks must declare at most ${MAX_UI_BLOCKS} blocks (got ${blocks.length})`);
  }
  blocks.forEach((block: unknown, index: number) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) {
      problems.push(`block #${index} must be an object`);
      return;
    }
    const entry = block as Record<string, unknown>;
    if (!isExtensionUiBlockType(entry['type'])) {
      problems.push(`block #${index} has type '${String(entry['type'])}' which is not a known UI block type`);
      return;
    }
    const checkText = (field: string): void => {
      const value = entry[field];
      if (typeof value !== 'string' || value.length === 0) {
        problems.push(`block #${index} (${String(entry['type'])}) needs a non-empty ${field}`);
      } else if (value.length > MAX_UI_TEXT_CHARS) {
        problems.push(`block #${index} (${String(entry['type'])}) ${field} must be at most ${MAX_UI_TEXT_CHARS} characters`);
      }
    };
    switch (entry['type']) {
      case 'heading':
      case 'text':
        checkText('text');
        break;
      case 'metric':
        checkText('label');
        checkText('value');
        break;
      case 'list': {
        const items = entry['items'];
        if (!Array.isArray(items)) {
          problems.push(`block #${index} (list) needs an items array`);
          break;
        }
        if (items.length > MAX_UI_LIST_ITEMS) {
          problems.push(`block #${index} (list) must declare at most ${MAX_UI_LIST_ITEMS} items (got ${items.length})`);
        }
        items.forEach((item: unknown) => {
          if (typeof item !== 'string' || item.length > MAX_UI_TEXT_CHARS) {
            problems.push(`block #${index} (list) items must be non-empty strings of at most ${MAX_UI_TEXT_CHARS} characters`);
          }
        });
        break;
      }
      case 'table': {
        const columns = entry['columns'];
        const rows = entry['rows'];
        if (!Array.isArray(columns) || columns.length === 0) {
          problems.push(`block #${index} (table) needs a non-empty columns array`);
          break;
        }
        if (columns.length > MAX_UI_TABLE_COLUMNS) {
          problems.push(`block #${index} (table) must declare at most ${MAX_UI_TABLE_COLUMNS} columns (got ${columns.length})`);
        }
        for (const column of columns) {
          if (typeof column !== 'string' || column.length === 0 || column.length > MAX_UI_TEXT_CHARS) {
            problems.push(`block #${index} (table) columns must be non-empty strings of at most ${MAX_UI_TEXT_CHARS} characters`);
            break;
          }
        }
        if (!Array.isArray(rows)) {
          problems.push(`block #${index} (table) needs a rows array`);
          break;
        }
        if (rows.length > MAX_UI_TABLE_ROWS) {
          problems.push(`block #${index} (table) must declare at most ${MAX_UI_TABLE_ROWS} rows (got ${rows.length})`);
        }
        rows.forEach((row: unknown) => {
          if (!Array.isArray(row)) {
            problems.push(`block #${index} (table) rows must be arrays`);
            return;
          }
          if (row.length !== columns.length) {
            problems.push(`block #${index} (table) rows must have exactly ${columns.length} cells`);
          }
          for (const cell of row) {
            if (typeof cell !== 'string' || cell.length > MAX_UI_TEXT_CHARS) {
              problems.push(`block #${index} (table) cells must be strings of at most ${MAX_UI_TEXT_CHARS} characters`);
              break;
            }
          }
        });
        break;
      }
      case 'divider':
        break;
    }
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Schedules, events, telemetry: shared bounds
// ---------------------------------------------------------------------------

/** Telemetry event names are name slugs (the schedule-name discipline). */
export const TELEMETRY_NAME_PATTERN = NAME_SLUG_PATTERN;

export function isTelemetryName(value: string): boolean {
  return TELEMETRY_NAME_PATTERN.test(value);
}

/** Maximum serialized size of one event-dispatch payload. */
export const MAX_EVENT_PAYLOAD_BYTES = 65_536; // 64 KiB

/** Maximum serialized size of one telemetry payload. */
export const MAX_TELEMETRY_PAYLOAD_BYTES = 65_536; // 64 KiB

// ---------------------------------------------------------------------------
// Scoped external participation
// ---------------------------------------------------------------------------

/** The closed method vocabulary of extension external participation. */
export const EXTENSION_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export type ExtensionHttpMethod = (typeof EXTENSION_HTTP_METHODS)[number];

export function isExtensionHttpMethod(value: unknown): value is ExtensionHttpMethod {
  return (
    typeof value === 'string' &&
    (EXTENSION_HTTP_METHODS as readonly string[]).includes(value)
  );
}

export const MAX_EXTERNAL_PATH_CHARS = 512;
export const MAX_EXTERNAL_HEADER_COUNT = 16;
export const MAX_EXTERNAL_HEADER_NAME_CHARS = 64;
export const MAX_EXTERNAL_HEADER_VALUE_CHARS = 256;
export const MAX_EXTERNAL_BODY_BYTES = 262_144; // 256 KiB

/**
 * The request-path grammar of external participation: starts with '/',
 * printable ASCII only (no space, no fragment, no control characters),
 * bounded length. The query string ('?' ...) is allowed; the runtime
 * always concatenates `<declared origin><path>`, so the origin remains
 * the security boundary.
 */
export const EXTERNAL_PATH_PATTERN = /^\/[\x21-\x22\x24-\x7E]{0,511}$/;

export function isExternalPath(value: string): boolean {
  return EXTERNAL_PATH_PATTERN.test(value);
}

/**
 * The declared participant whose origin is EXACTLY `origin`, or null.
 * Exact string equality — never prefix, never suffix, never parse-and-
 * compare: 'https://api.example.com' does not authorize
 * 'https://api.example.com.evil.io' nor 'https://api.example.com:8443'.
 */
export function participantForOrigin(
  capabilities: ExtensionCapabilities,
  origin: string,
): ExtensionExternalParticipant | null {
  for (const participant of capabilities.externalParticipants) {
    if (participant.origin === origin) return participant;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Quota windows
// ---------------------------------------------------------------------------

/**
 * The start of the UTC day containing `at` — the deterministic quota
 * window of the runtime (daily quotas are per (tenant, extension,
 * install, UTC day); a fixed window keeps counting replayable and
 * test-controllable through the injectable clock). Pure.
 */
export function utcDayStart(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

// ---------------------------------------------------------------------------
// Serialization (bounded, deterministic)
// ---------------------------------------------------------------------------

/** Serialized byte length of a JSON value; null when it is not JSON. */
export function jsonByteLength(value: unknown): number | null {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== 'string') return null; // undefined/symbol at top level
    return byteLength(text);
  } catch {
    return null;
  }
}

/** UTF-8 byte length of a string. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
