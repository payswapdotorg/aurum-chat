// Pure validation of the cross-platform module's inputs and queries (see
// contract.ts). No database, no clock, no TenantContext reads — the
// org-lab discipline: everything here is unit-testable without
// infrastructure.
//
// VOCABULARY MIRRORING (the house ruling): the frozen W131 client
// vocabulary (ClientPlatformKind, ClientSessionState) and this module's
// own closed unions are mirrored as local constants and compiler-pinned
// to the owning unions with `satisfies` — drift in an owning module
// fails TYPECHECK here, never runtime. The type-only imports keep this
// file runtime-dependency-free (the services own every runtime import).
//
// CANONICAL SERIALIZATION + DIGEST (the projection content-addressing):
// `canonicalJson` serializes any plain-JSON value with recursively
// sorted object keys; `digestOf` sha256-hashes that serialization.
// Clients RECOMPUTE the digest with these two functions to verify a
// served projection against its CompanyStateProjectionRef — they are
// therefore part of the module's public contract surface.

import { createHash } from 'node:crypto';
import type { TenantContext } from '@/infra/tenant';
import type {
  ClientPlatformKind,
  ClientSessionState,
} from '@/modules/execution/contract';
import { CrossPlatformError } from './errors';
import type { CrossPlatformErrorCode } from './errors';
import type {
  BackgroundWorkPhase,
  BackgroundWorkSeam,
  HandoffEvidenceKind,
  HandoffFocusKind,
  HandoffWorkingContext,
  PlatformCapabilityDomain,
  ProductAreaId,
  ShellNavigationState,
} from './types';

// ---------------------------------------------------------------------------
// Limits (bounds every input field — the house discipline)
// ---------------------------------------------------------------------------

export const MAX_DEVICE_LABEL_CHARS = 120;
export const MAX_DRAFT_CHARS = 20000;
export const MAX_FOCUS_REF_CHARS = 256;
export const MAX_NAVIGATION_FOCUS_CHARS = 256;
export const MAX_TOWER_SURFACE_CHARS = 64;
export const MAX_CAPABILITY_INPUT_BYTES = 256 * 1024;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_MESSAGE_LIMIT = 50;
export const MAX_MESSAGE_LIMIT = 500;
export const MAX_TITLE_CHARS = 400;
export const MAX_SEAM_STATUS_CHARS = 64;

// ---------------------------------------------------------------------------
// Vocabularies (mirrored + compiler-pinned; see the header note)
// ---------------------------------------------------------------------------

/** The frozen W131 platform kinds, mirrored. */
export const PLATFORM_KINDS = [
  'web',
  'desktop',
  'mobile',
] as const satisfies readonly ClientPlatformKind[];

/** The frozen W131 client-session states, mirrored. */
export const CLIENT_SESSION_STATES = [
  'active',
  'expired',
  'revoked',
] as const satisfies readonly ClientSessionState[];

/** This module's background-work seams, mirrored. */
export const BACKGROUND_WORK_SEAMS = [
  'mission',
  'execution-run',
  'fabric-lease',
] as const satisfies readonly BackgroundWorkSeam[];

/** This module's background-work phases, mirrored. */
export const BACKGROUND_WORK_PHASES = [
  'in-flight',
  'awaiting-decision',
  'succeeded',
  'failed',
  'cancelled',
  'suspended',
  'lost',
] as const satisfies readonly BackgroundWorkPhase[];

/** This module's handoff focus kinds, mirrored. */
export const HANDOFF_FOCUS_KINDS = [
  'conversation',
  'background-work',
  'mission',
] as const satisfies readonly HandoffFocusKind[];

/** This module's handoff evidence kinds, mirrored. */
export const HANDOFF_EVIDENCE_KINDS = [
  'session-opened',
  'handoff-recorded',
  'resumed',
  'conflict-discarded',
  'session-closed',
] as const satisfies readonly HandoffEvidenceKind[];

/** This module's platform capability domains, mirrored. */
export const PLATFORM_CAPABILITY_DOMAINS = [
  'notifications',
  'file-access',
  'window-management',
  'share',
  'camera',
] as const satisfies readonly PlatformCapabilityDomain[];

/** The W057 product areas, mirrored (the app stays the canonical renderer). */
export const PRODUCT_AREA_IDS = [
  'chat',
  'today',
  'intelligence',
  'people',
  'connections',
  'marketplace',
  'more',
] as const satisfies readonly ProductAreaId[];

/** The tower's fifteen drill-down surface slugs (W033/W057, mirrored). */
export const TOWER_SURFACE_SLUGS = [
  'today',
  'goals',
  'situation',
  'unknowns',
  'missions',
  'risks',
  'opportunities',
  'capabilities',
  'processes',
  'automation',
  'workforce',
  'agents',
  'evidence',
  'recommendations',
  'approvals',
] as const;

// ---------------------------------------------------------------------------
// Canonical serialization + digest (the projection content-addressing)
// ---------------------------------------------------------------------------

/**
 * Serialize a plain-JSON value canonically: object keys recursively
 * sorted (arrays keep order — order is semantic), `undefined` rejected
 * (it is not JSON), numbers/strings/booleans/null pass through. Two
 * structurally equal values ALWAYS serialize identically — that is what
 * makes a digest a content address.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CrossPlatformError(
          'invalid_query',
          'projections cannot contain non-finite numbers',
        );
      }
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((entry) => serialize(entry)).join(',')}]`;
      }
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const parts: string[] = [];
      for (const key of keys) {
        const entry = (value as Record<string, unknown>)[key];
        if (entry === undefined) {
          throw new CrossPlatformError(
            'invalid_query',
            `projections cannot contain undefined at key '${key}'`,
          );
        }
        parts.push(`${JSON.stringify(key)}:${serialize(entry)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CrossPlatformError(
        'invalid_query',
        `projections cannot contain a value of type '${typeof value}'`,
      );
  }
}

/** The sha256 digest over the canonical serialization (hex, 'sha256:'-prefixed). */
export function digestOf(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isPlatformKind(value: unknown): value is ClientPlatformKind {
  return typeof value === 'string' && (PLATFORM_KINDS as readonly string[]).includes(value);
}

export function isClientSessionState(value: unknown): value is ClientSessionState {
  return typeof value === 'string' && (CLIENT_SESSION_STATES as readonly string[]).includes(value);
}

export function isBackgroundWorkSeam(value: unknown): value is BackgroundWorkSeam {
  return typeof value === 'string' && (BACKGROUND_WORK_SEAMS as readonly string[]).includes(value);
}

export function isBackgroundWorkPhase(value: unknown): value is BackgroundWorkPhase {
  return typeof value === 'string' && (BACKGROUND_WORK_PHASES as readonly string[]).includes(value);
}

export function isHandoffFocusKind(value: unknown): value is HandoffFocusKind {
  return typeof value === 'string' && (HANDOFF_FOCUS_KINDS as readonly string[]).includes(value);
}

export function isHandoffEvidenceKind(value: unknown): value is HandoffEvidenceKind {
  return typeof value === 'string' && (HANDOFF_EVIDENCE_KINDS as readonly string[]).includes(value);
}

export function isCapabilityDomain(value: unknown): value is PlatformCapabilityDomain {
  return (
    typeof value === 'string' && (PLATFORM_CAPABILITY_DOMAINS as readonly string[]).includes(value)
  );
}

export function isProductAreaId(value: unknown): value is ProductAreaId {
  return typeof value === 'string' && (PRODUCT_AREA_IDS as readonly string[]).includes(value);
}

export function isTowerSurfaceSlug(value: unknown): value is string {
  return (
    typeof value === 'string' && (TOWER_SURFACE_SLUGS as readonly string[]).includes(value)
  );
}

export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

// ---------------------------------------------------------------------------
// Context assertion (ADR-0001 — the explicit context is never ambient)
// ---------------------------------------------------------------------------

export function assertCrossPlatformTenantContext(ctx: TenantContext): void {
  if (ctx === null || typeof ctx !== 'object') {
    throw new CrossPlatformError('invalid_context', 'TenantContext must be an object');
  }
  if (!isUuid(ctx.tenantId)) {
    throw new CrossPlatformError('invalid_context', 'TenantContext.tenantId must be a uuid');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.length === 0) {
    throw new CrossPlatformError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new CrossPlatformError('invalid_context', 'TenantContext.authority must be an array');
  }
}

// ---------------------------------------------------------------------------
// Shared field assertions
// ---------------------------------------------------------------------------

function requireObject(value: unknown, code: CrossPlatformErrorCode, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CrossPlatformError(code, `${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertOptionalString(
  value: unknown,
  field: string,
  maxChars: number,
  code: CrossPlatformErrorCode,
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new CrossPlatformError(code, `${field} must be a string when present`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxChars) {
    throw new CrossPlatformError(code, `${field} must be at most ${maxChars} chars`);
  }
  return trimmed;
}

function assertLimit(
  value: unknown,
  field: string,
  code: CrossPlatformErrorCode,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new CrossPlatformError(code, `${field} must be an integer 1..${max}`);
  }
  return value;
}

function assertIsoTimestamp(
  value: unknown,
  field: string,
  code: CrossPlatformErrorCode,
): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new CrossPlatformError(code, `${field} must be a strict ISO 8601 timestamp`);
  }
  return value;
}

function assertUuidInput(
  value: unknown,
  field: string,
  code: CrossPlatformErrorCode,
): string {
  if (!isUuid(value)) {
    throw new CrossPlatformError(code, `${field} must be a uuid`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Client session inputs
// ---------------------------------------------------------------------------

export interface ValidatedRegisterClientSessionInput {
  platform: ClientPlatformKind;
  deviceLabel: string | null;
  expiresAt: string | null;
}

export function validateRegisterClientSessionInput(
  input: unknown,
): ValidatedRegisterClientSessionInput {
  const object = requireObject(input, 'invalid_session_input', 'registerClientSession input');
  if (!isPlatformKind(object.platform)) {
    throw new CrossPlatformError(
      'invalid_session_input',
      'platform must be one of web | desktop | mobile',
    );
  }
  const deviceLabel = assertOptionalString(
    object.deviceLabel,
    'deviceLabel',
    MAX_DEVICE_LABEL_CHARS,
    'invalid_session_input',
  );
  let expiresAt: string | null = null;
  if (object.expiresAt !== undefined && object.expiresAt !== null) {
    // Structural ISO check only — the future-ness check lives in the
    // service, which owns the injectable clock (this layer stays pure).
    expiresAt = assertIsoTimestamp(object.expiresAt, 'expiresAt', 'invalid_session_input');
  }
  return { platform: object.platform, deviceLabel, expiresAt };
}

export interface ValidatedListClientSessionsQuery {
  platform?: ClientPlatformKind;
  state?: ClientSessionState;
  limit: number;
}

export function validateListClientSessionsQuery(
  query: unknown,
): ValidatedListClientSessionsQuery {
  const object = requireObject(query ?? {}, 'invalid_query', 'listClientSessions query');
  const valid: ValidatedListClientSessionsQuery = {
    limit: assertLimit(object.limit, 'limit', 'invalid_query', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
  };
  if (object.platform !== undefined && object.platform !== null) {
    if (!isPlatformKind(object.platform)) {
      throw new CrossPlatformError('invalid_query', 'platform must be one of web | desktop | mobile');
    }
    valid.platform = object.platform;
  }
  if (object.state !== undefined && object.state !== null) {
    if (!isClientSessionState(object.state)) {
      throw new CrossPlatformError('invalid_query', 'state must be one of active | expired | revoked');
    }
    valid.state = object.state;
  }
  return valid;
}

export interface ValidatedSessionRefInput {
  clientSessionId: string;
}

export function validateSessionRefInput(
  input: unknown,
  code: CrossPlatformErrorCode,
): ValidatedSessionRefInput {
  const object = requireObject(input, code, 'session reference input');
  return { clientSessionId: assertUuidInput(object.clientSessionId, 'clientSessionId', code) };
}

// ---------------------------------------------------------------------------
// State projection queries
// ---------------------------------------------------------------------------

export interface ValidatedReadConversationStateQuery {
  conversationId: string;
  messageLimit: number;
}

export function validateReadConversationStateQuery(
  query: unknown,
): ValidatedReadConversationStateQuery {
  const object = requireObject(query, 'invalid_query', 'readConversationState query');
  return {
    conversationId: assertUuidInput(object.conversationId, 'conversationId', 'invalid_query'),
    messageLimit: assertLimit(
      object.messageLimit,
      'messageLimit',
      'invalid_query',
      MAX_MESSAGE_LIMIT,
      DEFAULT_MESSAGE_LIMIT,
    ),
  };
}

export interface ValidatedReadCompanyOverviewQuery {
  goalLimit: number;
  missionLimit: number;
}

export function validateReadCompanyOverviewQuery(
  query: unknown,
): ValidatedReadCompanyOverviewQuery {
  const object = requireObject(query ?? {}, 'invalid_query', 'readCompanyOverview query');
  return {
    goalLimit: assertLimit(object.goalLimit, 'goalLimit', 'invalid_query', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
    missionLimit: assertLimit(
      object.missionLimit,
      'missionLimit',
      'invalid_query',
      MAX_LIST_LIMIT,
      DEFAULT_LIST_LIMIT,
    ),
  };
}

// ---------------------------------------------------------------------------
// Background-work queries
// ---------------------------------------------------------------------------

export interface ValidatedListBackgroundWorkQuery {
  seam?: BackgroundWorkSeam;
  phase?: BackgroundWorkPhase;
  limit: number;
}

export function validateListBackgroundWorkQuery(
  query: unknown,
): ValidatedListBackgroundWorkQuery {
  const object = requireObject(query ?? {}, 'invalid_query', 'listBackgroundWork query');
  const valid: ValidatedListBackgroundWorkQuery = {
    limit: assertLimit(object.limit, 'limit', 'invalid_query', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
  };
  if (object.seam !== undefined && object.seam !== null) {
    if (!isBackgroundWorkSeam(object.seam)) {
      throw new CrossPlatformError(
        'invalid_query',
        'seam must be one of mission | execution-run | fabric-lease',
      );
    }
    valid.seam = object.seam;
  }
  if (object.phase !== undefined && object.phase !== null) {
    if (!isBackgroundWorkPhase(object.phase)) {
      throw new CrossPlatformError('invalid_query', 'phase is not a background-work phase');
    }
    valid.phase = object.phase;
  }
  return valid;
}

export interface ValidatedGetBackgroundWorkItemInput {
  seam: BackgroundWorkSeam;
  workRef: string;
}

export function validateGetBackgroundWorkItemInput(
  input: unknown,
): ValidatedGetBackgroundWorkItemInput {
  const object = requireObject(input, 'invalid_query', 'getBackgroundWorkItem input');
  if (!isBackgroundWorkSeam(object.seam)) {
    throw new CrossPlatformError(
      'invalid_query',
      'seam must be one of mission | execution-run | fabric-lease',
    );
  }
  const workRef = object.workRef;
  if (typeof workRef !== 'string' || workRef.length < 1 || workRef.length > MAX_FOCUS_REF_CHARS) {
    throw new CrossPlatformError('invalid_query', 'workRef must be a 1..256 char reference');
  }
  return { seam: object.seam, workRef };
}

// ---------------------------------------------------------------------------
// Handoff inputs
// ---------------------------------------------------------------------------

function assertNavigationState(
  value: unknown,
  code: CrossPlatformErrorCode,
): ShellNavigationState {
  const object = requireObject(value, code, 'navigation state');
  if (!isProductAreaId(object.area)) {
    throw new CrossPlatformError(code, 'navigation.area must be a product area id');
  }
  const navigation: ShellNavigationState = { area: object.area };
  if (object.towerSurface !== undefined && object.towerSurface !== null) {
    if (!isTowerSurfaceSlug(object.towerSurface)) {
      throw new CrossPlatformError(code, 'navigation.towerSurface must be a tower surface slug');
    }
    navigation.towerSurface = object.towerSurface;
  } else {
    navigation.towerSurface = null;
  }
  navigation.focusRef = assertOptionalString(
    object.focusRef,
    'navigation.focusRef',
    MAX_NAVIGATION_FOCUS_CHARS,
    code,
  );
  return navigation;
}

/** Validates the working context (the unit of handoff) — shape, bounds, focus rules. */
export function validateHandoffWorkingContext(
  value: unknown,
  code: CrossPlatformErrorCode,
): HandoffWorkingContext {
  const object = requireObject(value, code, 'working context');
  if (!isHandoffFocusKind(object.focusKind)) {
    throw new CrossPlatformError(code, 'context.focusKind must be one of conversation | background-work | mission');
  }
  const focusRef = object.focusRef;
  if (
    typeof focusRef !== 'string' ||
    focusRef.length < 1 ||
    focusRef.length > MAX_FOCUS_REF_CHARS
  ) {
    throw new CrossPlatformError(code, 'context.focusRef must be a 1..256 char reference');
  }
  let focusSeam: BackgroundWorkSeam | undefined;
  if (object.focusSeam !== undefined && object.focusSeam !== null) {
    if (!isBackgroundWorkSeam(object.focusSeam)) {
      throw new CrossPlatformError(
        code,
        'context.focusSeam must be one of mission | execution-run | fabric-lease',
      );
    }
    focusSeam = object.focusSeam;
  }
  if (object.focusKind === 'background-work' && focusSeam === undefined) {
    throw new CrossPlatformError(
      code,
      'context.focusSeam is required when focusKind is background-work',
    );
  }
  if (object.focusKind !== 'background-work' && focusSeam !== undefined) {
    throw new CrossPlatformError(
      code,
      'context.focusSeam is only allowed when focusKind is background-work',
    );
  }
  const draft =
    object.draft === undefined || object.draft === null
      ? null
      : (() => {
          if (typeof object.draft !== 'string') {
            throw new CrossPlatformError(code, 'context.draft must be a string when present');
          }
          if (object.draft.length > MAX_DRAFT_CHARS) {
            throw new CrossPlatformError(
              code,
              `context.draft must be at most ${MAX_DRAFT_CHARS} chars`,
            );
          }
          return object.draft;
        })();
  const navigation = assertNavigationState(object.navigation, code);
  return {
    focusKind: object.focusKind,
    focusRef,
    ...(focusSeam === undefined ? {} : { focusSeam }),
    draft,
    navigation,
  };
}

export interface ValidatedOpenHandoffSessionInput {
  clientSessionId: string;
  context: HandoffWorkingContext;
}

export function validateOpenHandoffSessionInput(
  input: unknown,
): ValidatedOpenHandoffSessionInput {
  const object = requireObject(input, 'invalid_handoff_input', 'openHandoffSession input');
  return {
    clientSessionId: assertUuidInput(object.clientSessionId, 'clientSessionId', 'invalid_handoff_input'),
    context: validateHandoffWorkingContext(object.context, 'invalid_handoff_input'),
  };
}

export interface ValidatedRecordHandoffInput {
  handoffSessionId: string;
  toClientSessionId: string;
}

export function validateRecordHandoffInput(input: unknown): ValidatedRecordHandoffInput {
  const object = requireObject(input, 'invalid_handoff_input', 'recordHandoff input');
  return {
    handoffSessionId: assertUuidInput(
      object.handoffSessionId,
      'handoffSessionId',
      'invalid_handoff_input',
    ),
    toClientSessionId: assertUuidInput(
      object.toClientSessionId,
      'toClientSessionId',
      'invalid_handoff_input',
    ),
  };
}

export interface ValidatedResumeHandoffInput {
  handoffSessionId: string;
  clientSessionId: string;
  clientRevision: number | null;
}

export function validateResumeHandoffInput(input: unknown): ValidatedResumeHandoffInput {
  const object = requireObject(input, 'invalid_handoff_input', 'resumeHandoff input');
  const valid: ValidatedResumeHandoffInput = {
    handoffSessionId: assertUuidInput(
      object.handoffSessionId,
      'handoffSessionId',
      'invalid_handoff_input',
    ),
    clientSessionId: assertUuidInput(object.clientSessionId, 'clientSessionId', 'invalid_handoff_input'),
    clientRevision: null,
  };
  if (object.clientRevision !== undefined && object.clientRevision !== null) {
    if (
      typeof object.clientRevision !== 'number' ||
      !Number.isInteger(object.clientRevision) ||
      object.clientRevision < 0
    ) {
      throw new CrossPlatformError(
        'invalid_handoff_input',
        'clientRevision must be a non-negative integer',
      );
    }
    valid.clientRevision = object.clientRevision;
  }
  return valid;
}

export interface ValidatedHandoffSessionRefInput {
  handoffSessionId: string;
}

export function validateHandoffSessionRefInput(
  input: unknown,
): ValidatedHandoffSessionRefInput {
  const object = requireObject(input, 'invalid_query', 'handoff session reference');
  return {
    handoffSessionId: assertUuidInput(
      object.handoffSessionId,
      'handoffSessionId',
      'invalid_query',
    ),
  };
}

export interface ValidatedListHandoffSessionsQuery {
  status?: 'open' | 'closed';
  focusKind?: HandoffFocusKind;
  platform?: ClientPlatformKind;
  limit: number;
}

export function validateListHandoffSessionsQuery(
  query: unknown,
): ValidatedListHandoffSessionsQuery {
  const object = requireObject(query ?? {}, 'invalid_query', 'listHandoffSessions query');
  const valid: ValidatedListHandoffSessionsQuery = {
    limit: assertLimit(object.limit, 'limit', 'invalid_query', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
  };
  if (object.status !== undefined && object.status !== null) {
    if (object.status !== 'open' && object.status !== 'closed') {
      throw new CrossPlatformError('invalid_query', 'status must be open | closed');
    }
    valid.status = object.status;
  }
  if (object.focusKind !== undefined && object.focusKind !== null) {
    if (!isHandoffFocusKind(object.focusKind)) {
      throw new CrossPlatformError(
        'invalid_query',
        'focusKind must be one of conversation | background-work | mission',
      );
    }
    valid.focusKind = object.focusKind;
  }
  if (object.platform !== undefined && object.platform !== null) {
    if (!isPlatformKind(object.platform)) {
      throw new CrossPlatformError('invalid_query', 'platform must be one of web | desktop | mobile');
    }
    valid.platform = object.platform;
  }
  return valid;
}

export interface ValidatedListHandoffEvidenceQuery {
  handoffSessionId: string;
  kind?: HandoffEvidenceKind;
  limit: number;
}

export function validateListHandoffEvidenceQuery(
  query: unknown,
): ValidatedListHandoffEvidenceQuery {
  const object = requireObject(query, 'invalid_query', 'listHandoffEvidence query');
  const valid: ValidatedListHandoffEvidenceQuery = {
    handoffSessionId: assertUuidInput(
      object.handoffSessionId,
      'handoffSessionId',
      'invalid_query',
    ),
    limit: assertLimit(object.limit, 'limit', 'invalid_query', MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT),
  };
  if (object.kind !== undefined && object.kind !== null) {
    if (!isHandoffEvidenceKind(object.kind)) {
      throw new CrossPlatformError('invalid_query', 'kind is not a handoff evidence kind');
    }
    valid.kind = object.kind;
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Platform capability inputs
// ---------------------------------------------------------------------------

export interface ValidatedInvokePlatformCapabilityInput {
  platform: ClientPlatformKind;
  domain: PlatformCapabilityDomain;
  input: unknown;
}

export function validateInvokePlatformCapabilityInput(
  value: unknown,
): ValidatedInvokePlatformCapabilityInput {
  const object = requireObject(value, 'invalid_capability_input', 'invokePlatformCapability input');
  if (!isPlatformKind(object.platform)) {
    throw new CrossPlatformError(
      'invalid_capability_input',
      'platform must be one of web | desktop | mobile',
    );
  }
  if (!isCapabilityDomain(object.domain)) {
    throw new CrossPlatformError(
      'invalid_capability_input',
      'domain must be one of notifications | file-access | window-management | share | camera',
    );
  }
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalJson(object.input ?? null), 'utf8');
  } catch {
    throw new CrossPlatformError(
      'invalid_capability_input',
      'input must be plain JSON (canonicalizable)',
    );
  }
  if (bytes > MAX_CAPABILITY_INPUT_BYTES) {
    throw new CrossPlatformError(
      'invalid_capability_input',
      `input must canonicalize to at most ${MAX_CAPABILITY_INPUT_BYTES} bytes`,
    );
  }
  return { platform: object.platform, domain: object.domain, input: object.input ?? null };
}

// ---------------------------------------------------------------------------
// Shell queries
// ---------------------------------------------------------------------------

export interface ValidatedReadShellModelQuery {
  focus: {
    focusKind: HandoffFocusKind;
    focusRef: string;
    focusSeam?: BackgroundWorkSeam;
  } | null;
}

export function validateReadShellModelQuery(query: unknown): ValidatedReadShellModelQuery {
  const object = requireObject(query ?? {}, 'invalid_query', 'readShellModel query');
  if (object.focus === undefined || object.focus === null) {
    return { focus: null };
  }
  const focus = object.focus as Record<string, unknown>;
  const context = validateHandoffWorkingContext(
    {
      focusKind: focus.focusKind,
      focusRef: focus.focusRef,
      focusSeam: focus.focusSeam,
      draft: null,
      navigation: { area: 'chat' },
    },
    'invalid_query',
  );
  return {
    focus: {
      focusKind: context.focusKind,
      focusRef: context.focusRef,
      ...(context.focusSeam === undefined ? {} : { focusSeam: context.focusSeam }),
    },
  };
}


