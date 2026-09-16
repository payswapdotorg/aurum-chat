// Pure manifest rules of the extensions module (W025 — Extension
// Contracts). No database, no context, no time — these are the rules a
// manifest must satisfy, shared by THREE enforcers so they can never
// drift apart:
//
//   1. validation.ts      — registration-time input validation;
//   2. migrations/002     — a storage-level trigger (defense in depth:
//                           a write bypassing the service cannot store
//                           an inconsistent manifest);
//   3. verification.ts    — the deterministic verification checks that
//                           re-examine a STORED manifest and produce
//                           append-only evidence.
//
// THE CAPABILITY MODEL (ARCHITECTURE.md §17 — "Runtime supports
// persistent tenant/install scoped state, host-rendered declarative UI,
// scheduled triggers, event subscriptions, scoped external participants,
// isolation, quotas, versioning, deployment, rollback, disablement,
// compatibility and telemetry"). W025 defines the contract surface of
// that list; W026 implements the runtime. A manifest declares:
//
//   * stateScope            — 'none' | 'tenant' | 'install' (persistent
//                             scoped state);
//   * uiSurfaces            — host-rendered declarative UI surfaces the
//                             extension contributes to (closed
//                             vocabulary anchored in §21/§22: the
//                             management control tower, briefings, chat);
//   * schedules             — declarative scheduled triggers (name + cron);
//   * eventSubscriptions    — canonical event topics to subscribe to;
//   * externalParticipants  — scoped external systems the extension may
//                             participate with (label + https origin);
//   * telemetry             — whether the extension emits its own
//                             telemetry events.
//
// THE PERMISSION MODEL: every capability area maps to exactly one closed
// permission scope (persistent state maps to two: read and write). A
// manifest is consistent when the requested permission set is EXACTLY
// the permissions its declared capabilities require — no capability may
// run undeclared (least privilege is enforced, not advisory), and no
// permission may be requested without the capability that justifies it
// (no scope hoarding). This requested set is the CEILING any future
// install/runtime grant (W026/W028) is bounded by; grants are not W025
// scope — the contract defines what may be asked for.
//
// QUOTAS: each runtime-consuming capability declares its ceiling —
// maxStateBytes, maxScheduleInvocationsPerDay, maxExternalCallsPerDay —
// present (≥ 1, ≤ cap) exactly when the corresponding capability is
// declared, zero otherwise. A quota without its capability is as
// inconsistent as a capability without its quota.

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The closed permission vocabulary of extension manifests. Order is
 * canonical (normalization sorts requests into it, so equal manifests
 * always serialize identically).
 */
export const EXTENSION_PERMISSIONS = [
  'state:read',
  'state:write',
  'ui:render',
  'schedule:run',
  'events:subscribe',
  'external:participate',
  'telemetry:emit',
] as const;

export type ExtensionPermission = (typeof EXTENSION_PERMISSIONS)[number];

export function isExtensionPermission(value: unknown): value is ExtensionPermission {
  return (
    typeof value === 'string' &&
    (EXTENSION_PERMISSIONS as readonly string[]).includes(value)
  );
}

/**
 * The closed vocabulary of host-rendered declarative UI surfaces an
 * extension may contribute to (ARCHITECTURE.md §21 — the management
 * control tower surfaces; §22 — briefings; §21 — "Chat remains available
 * for natural interaction"; plus the extension's own settings form).
 * The host renders; extensions never ship their own UI runtime (W026).
 */
export const EXTENSION_UI_SURFACES = [
  'control-tower-panel',
  'briefing-card',
  'chat-panel',
  'settings-form',
] as const;

export type ExtensionUiSurface = (typeof EXTENSION_UI_SURFACES)[number];

export function isExtensionUiSurface(value: unknown): value is ExtensionUiSurface {
  return (
    typeof value === 'string' &&
    (EXTENSION_UI_SURFACES as readonly string[]).includes(value)
  );
}

/**
 * The persistence scope of extension state (§17 "persistent tenant/install
 * scoped state"): 'none', shared per tenant, or isolated per install.
 */
export const EXTENSION_STATE_SCOPES = ['none', 'tenant', 'install'] as const;

export type ExtensionStateScope = (typeof EXTENSION_STATE_SCOPES)[number];

export function isExtensionStateScope(value: unknown): value is ExtensionStateScope {
  return (
    typeof value === 'string' &&
    (EXTENSION_STATE_SCOPES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Capability declarations (the normalized shape persisted in
// extension_manifests.capabilities and re-examined by verification)
// ---------------------------------------------------------------------------

/** One declarative scheduled trigger. */
export interface ExtensionScheduleDeclaration {
  /** Stable slug naming the trigger within the extension. */
  name: string;
  /** Five-field cron expression (minute hour day-of-month month day-of-week). */
  cron: string;
}

/** One scoped external participant the extension may talk to. */
export interface ExtensionExternalParticipant {
  /** Human-readable label. */
  label: string;
  /** The https origin calls are scoped to (scheme + host [+ port], nothing else). */
  origin: string;
}

/** The normalized capability declaration of a manifest. */
export interface ExtensionCapabilities {
  stateScope: ExtensionStateScope;
  uiSurfaces: ExtensionUiSurface[];
  schedules: ExtensionScheduleDeclaration[];
  eventSubscriptions: string[];
  externalParticipants: ExtensionExternalParticipant[];
  telemetry: boolean;
}

/** The declared resource ceilings of a manifest. */
export interface ExtensionQuotas {
  maxStateBytes: number;
  maxScheduleInvocationsPerDay: number;
  maxExternalCallsPerDay: number;
}

// Bounded declarations keep manifests reviewable (a manifest with ten
// thousand schedules is not a declaration, it is an attack).
export const MAX_SCHEDULES = 16;
export const MAX_EVENT_TOPICS = 32;
export const MAX_EXTERNAL_PARTICIPANTS = 32;
export const MAX_UI_SURFACES = 4; // the vocabulary size; duplicates are normalized away

export const MAX_STATE_BYTES = 268_435_456; // 256 MiB of persistent scoped state
export const MAX_SCHEDULE_INVOCATIONS_PER_DAY = 1_440; // at most once a minute
export const MAX_EXTERNAL_CALLS_PER_DAY = 100_000;

// ---------------------------------------------------------------------------
// Permission ↔ capability consistency (the security core — shared by
// validation, the storage trigger and the verification checks)
// ---------------------------------------------------------------------------

/**
 * The permissions a capability declaration REQUIRES — the exact set, in
 * canonical order. Persistent state requires both reading and writing
 * its own state (an extension that persists but cannot read back is not
 * a meaningful declaration).
 */
export function requiredPermissionsForCapabilities(
  capabilities: ExtensionCapabilities,
): ExtensionPermission[] {
  const required = new Set<ExtensionPermission>();
  if (capabilities.stateScope !== 'none') {
    required.add('state:read');
    required.add('state:write');
  }
  if (capabilities.uiSurfaces.length > 0) required.add('ui:render');
  if (capabilities.schedules.length > 0) required.add('schedule:run');
  if (capabilities.eventSubscriptions.length > 0) required.add('events:subscribe');
  if (capabilities.externalParticipants.length > 0) required.add('external:participate');
  if (capabilities.telemetry) required.add('telemetry:emit');
  return [...EXTENSION_PERMISSIONS].filter((permission) => required.has(permission));
}

/**
 * The problems that make a (capabilities, permissions) pair inconsistent —
 * in both directions. Empty array = consistent. Pure; the same rule set
 * is mirrored by the extension_manifests storage trigger (migrations/002)
 * so a bypassing write cannot dodge it, and re-run by the
 * `permissions-consistency` verification check so drift is detectable.
 */
export function capabilityPermissionProblems(
  capabilities: ExtensionCapabilities,
  requestedPermissions: readonly string[],
): string[] {
  const problems: string[] = [];
  const required: ReadonlySet<string> = new Set(requiredPermissionsForCapabilities(capabilities));
  const requested = new Set<string>(requestedPermissions);

  for (const permission of required) {
    if (!requested.has(permission)) {
      problems.push(
        `capability declaration requires permission '${permission}' which is not requested`,
      );
    }
  }
  for (const permission of requestedPermissions) {
    if (!required.has(permission)) {
      problems.push(
        `requested permission '${permission}' is not justified by any declared capability`,
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Quota rules
// ---------------------------------------------------------------------------

/**
 * The problems that make a (capabilities, quotas) pair inconsistent:
 * a quota must be present (≥ 1, ≤ its ceiling) exactly when its
 * capability is declared, and zero otherwise. Empty array = consistent.
 */
export function capabilityQuotaProblems(
  capabilities: ExtensionCapabilities,
  quotas: ExtensionQuotas,
): string[] {
  const problems: string[] = [];
  const needsState = capabilities.stateScope !== 'none';
  const needsSchedules = capabilities.schedules.length > 0;
  const needsExternal = capabilities.externalParticipants.length > 0;

  if (needsState) {
    if (quotas.maxStateBytes < 1) {
      problems.push('stateScope is declared but quotas.maxStateBytes is not');
    } else if (quotas.maxStateBytes > MAX_STATE_BYTES) {
      problems.push(
        `quotas.maxStateBytes exceeds the ceiling of ${MAX_STATE_BYTES} bytes (got ${quotas.maxStateBytes})`,
      );
    }
  } else if (quotas.maxStateBytes !== 0) {
    problems.push('quotas.maxStateBytes is set without a state capability (stateScope must not be none)');
  }

  if (needsSchedules) {
    if (quotas.maxScheduleInvocationsPerDay < 1) {
      problems.push('schedules are declared but quotas.maxScheduleInvocationsPerDay is not');
    } else if (quotas.maxScheduleInvocationsPerDay > MAX_SCHEDULE_INVOCATIONS_PER_DAY) {
      problems.push(
        `quotas.maxScheduleInvocationsPerDay exceeds the ceiling of ${MAX_SCHEDULE_INVOCATIONS_PER_DAY} (got ${quotas.maxScheduleInvocationsPerDay})`,
      );
    }
  } else if (quotas.maxScheduleInvocationsPerDay !== 0) {
    problems.push('quotas.maxScheduleInvocationsPerDay is set without any declared schedule');
  }

  if (needsExternal) {
    if (quotas.maxExternalCallsPerDay < 1) {
      problems.push('externalParticipants are declared but quotas.maxExternalCallsPerDay is not');
    } else if (quotas.maxExternalCallsPerDay > MAX_EXTERNAL_CALLS_PER_DAY) {
      problems.push(
        `quotas.maxExternalCallsPerDay exceeds the ceiling of ${MAX_EXTERNAL_CALLS_PER_DAY} (got ${quotas.maxExternalCallsPerDay})`,
      );
    }
  } else if (quotas.maxExternalCallsPerDay !== 0) {
    problems.push('quotas.maxExternalCallsPerDay is set without any declared external participant');
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Field validators (shared by validation and the verification checks)
// ---------------------------------------------------------------------------

/**
 * Five-field cron validation (minute hour day-of-month month
 * day-of-week), numeric tokens only: `*`, single values, ranges
 * (`a-b`, a ≤ b), steps (`*\/n`, `a-b/n`) and comma-separated lists.
 * Deliberately no macro names and no 7-field seconds/year fields — the
 * extension runtime (W026) binds this shape to a scheduler, and a
 * closed, reviewable grammar beats a permissive one.
 */
export function isValidCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const bounds: Array<[number, number]> = [
    [0, 59], // minute
    [0, 23], // hour
    [1, 31], // day of month
    [1, 12], // month
    [0, 7], // day of week (0 and 7 are both Sunday)
  ];
  return fields.every((field, index) => {
    const [min, max] = bounds[index]!;
    if (field === '*') return true;
    return field.split(',').every((token) => {
      const stepSplit = token.split('/');
      if (stepSplit.length > 2) return false;
      const base = stepSplit[0]!;
      let low: number;
      let high: number;
      if (base === '*') {
        low = min;
        high = max;
      } else {
        const rangeSplit = base.split('-');
        if (rangeSplit.length > 2) return false;
        if (!/^(0|[1-9][0-9]*)$/.test(rangeSplit[0]!)) return false;
        low = Number(rangeSplit[0]!);
        if (rangeSplit.length === 2) {
          if (!/^(0|[1-9][0-9]*)$/.test(rangeSplit[1]!)) return false;
          high = Number(rangeSplit[1]!);
        } else {
          high = low;
        }
      }
      if (low < min || low > max || high < min || high > max || low > high) return false;
      if (stepSplit.length === 2) {
        if (!/^(0|[1-9][0-9]*)$/.test(stepSplit[1]!)) return false;
        const step = Number(stepSplit[1]!);
        if (step < 1) return false;
      }
      return true;
    });
  });
}

/**
 * Is `value` a scoped https origin — `https://host[:port]` and nothing
 * else? External participation (§17 "scoped external participants") is
 * scoped to origins; paths, queries, fragments, credentials and plain
 * http are all rejected so the runtime (W026) can enforce egress by
 * exact origin match.
 */
export function isHttpsOrigin(value: string): boolean {
  if (value.length > 255) return false;
  let rest: string | undefined;
  if (value.startsWith('https://')) {
    rest = value.slice('https://'.length);
  } else {
    return false;
  }
  if (rest === '' || rest.includes('/') || rest.includes('?') || rest.includes('#')) return false;
  if (rest.includes('@')) return false; // no credentials in an origin
  // host [: port] — the host itself is non-empty; a port, when present,
  // is numeric and bounded. IPv6 literals in brackets are accepted.
  const bracketHost = /^\[[0-9A-Fa-f:.]+\](?::(\d{1,5}))?$/.exec(rest);
  if (bracketHost !== null) {
    return bracketHost[1] === undefined || (Number(bracketHost[1]) <= 65_535);
  }
  const hostPort = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::(\d{1,5}))?$/.exec(
    rest,
  );
  if (hostPort === null) return false;
  return hostPort[1] !== undefined && (hostPort[2] === undefined || Number(hostPort[2]) <= 65_535);
}

/** Event topics are canonical slugs (the house KIND_PATTERN discipline). */
export const EVENT_TOPIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Stable identifiers (schedule names, extension keys share this shape family). */
export const NAME_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isEventTopic(value: string): boolean {
  return EVENT_TOPIC_PATTERN.test(value);
}

export function isNameSlug(value: string): boolean {
  return NAME_SLUG_PATTERN.test(value);
}

/**
 * The problems that make the capability DECLARATIONS themselves
 * malformed (wrong vocabulary, bad cron, bad origin, bad topic, wrong
 * shapes) — the `capability-declarations` verification check. Empty
 * array = well-formed. Validates the NORMALIZED shape, so a row written
 * bypassing the service with garbage in `capabilities` fails here.
 */
export function capabilityDeclarationProblems(capabilities: ExtensionCapabilities): string[] {
  const problems: string[] = [];
  if (!isExtensionStateScope(capabilities.stateScope)) {
    problems.push(`stateScope must be one of ${EXTENSION_STATE_SCOPES.join(', ')} (got '${String(capabilities.stateScope)}')`);
  }
  if (!Array.isArray(capabilities.uiSurfaces)) {
    problems.push('uiSurfaces must be an array');
  } else {
    for (const surface of capabilities.uiSurfaces) {
      if (!isExtensionUiSurface(surface)) {
        problems.push(`uiSurfaces entry '${String(surface)}' is not a known declarative UI surface`);
      }
    }
  }
  if (!Array.isArray(capabilities.schedules)) {
    problems.push('schedules must be an array');
  } else {
    for (const schedule of capabilities.schedules) {
      if (schedule === null || typeof schedule !== 'object') {
        problems.push('each schedule must be an object with name and cron');
        continue;
      }
      const entry = schedule as { name?: unknown; cron?: unknown };
      if (typeof entry.name !== 'string' || !isNameSlug(entry.name)) {
        problems.push(`schedule name '${String(entry.name)}' must be a slug of at most 64 characters`);
      }
      if (typeof entry.cron !== 'string' || !isValidCronExpression(entry.cron)) {
        problems.push(`schedule '${String(entry.name)}' has an invalid five-field cron expression ('${String(entry.cron)}')`);
      }
    }
  }
  if (!Array.isArray(capabilities.eventSubscriptions)) {
    problems.push('eventSubscriptions must be an array');
  } else {
    for (const topic of capabilities.eventSubscriptions) {
      if (typeof topic !== 'string' || !isEventTopic(topic)) {
        problems.push(`event subscription topic '${String(topic)}' is not a canonical topic slug`);
      }
    }
  }
  if (!Array.isArray(capabilities.externalParticipants)) {
    problems.push('externalParticipants must be an array');
  } else {
    for (const participant of capabilities.externalParticipants) {
      if (participant === null || typeof participant !== 'object') {
        problems.push('each external participant must be an object with label and origin');
        continue;
      }
      const entry = participant as { label?: unknown; origin?: unknown };
      if (typeof entry.label !== 'string' || entry.label.trim() === '') {
        problems.push('each external participant needs a non-empty label');
      }
      if (typeof entry.origin !== 'string' || !isHttpsOrigin(entry.origin)) {
        problems.push(`external participant '${String(entry.label)}' origin '${String(entry.origin)}' is not a plain https origin`);
      }
    }
  }
  if (typeof capabilities.telemetry !== 'boolean') {
    problems.push('telemetry must be a boolean');
  }
  return problems;
}
