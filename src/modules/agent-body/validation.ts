// Pure validation/normalization logic of the agent-body module (no
// database, no cross-module reads — the only import is the frozen
// provider-fabric TYPE). Everything a caller may put into body or binding
// state crosses these guards first; the SQL CHECK constraints in
// migrations/001 mirror the load-bearing rules as defense in depth.
//
// Deliberately strict about unknown keys: a caller can never smuggle
// identity, tenancy or system-stamped times into body state — ids, tenant,
// `createdBy`, `createdAt`, `updatedAt`, `retiredAt`, attachment
// positions and attachment stamps are minted by the system, and the update
// surface has NO `role` key (identity is immutable — W133's separation
// means a body keeps its identity for life; only its policies, capabilities
// and hooks are management controls).
//
// NO CREDENTIALS IN BODY STATE (the coverage module's §13 discipline,
// applied here): credential-shaped INPUT KEYS are rejected outright at
// every level of the five §1 policy descriptors (a recursive scan), and
// opaque reference VALUES that look like raw provider credentials are
// refused — the body stores policies and opaque references, never secrets.
//
// THE LOCAL PURPOSE MIRROR: the frozen W132 seam
// ('@/modules/provider-fabric/contract') exports ModelBindingPurpose as a
// TYPE ONLY, so the runtime purpose list is mirrored here
// (MODEL_BINDING_PURPOSES) — one list, documented, reconciled by the
// compiler via the type annotation. If the frozen seam ever adds a
// purpose, this mirror fails to compile until it is updated (the `satisfies`
// discipline below pins it).
//
// Also pure, and unit-tested in isolation:
//  * `isAttachablePolicyOutcome` — the recorded ruling as a function: only
//    a 'compatible' verdict may activate an attachment ('incompatible'
//    AND 'unknown' both refuse);
//  * `validatePolicyCheckPayload` — the verbatim payload's shape guard
//    (outcome/basis/checkedBy/checkedAt).

import type { TenantContext } from '@/infra/tenant';
import { AgentBodyError } from './errors';
import {
  AGENT_BODY_STATUSES,
  BODY_BINDING_STATUSES,
  POLICY_CHECK_OUTCOMES,
} from './types';
import type {
  AgentBodyHookRef,
  AgentBodyStatus,
  BodyBindingStatus,
  PolicyCheckOutcome,
  PolicyCheckPayload,
} from './types';
import type { ModelBindingPurpose } from '@/modules/provider-fabric/contract';

// ---------------------------------------------------------------------------
// Vocabularies and limits
// ---------------------------------------------------------------------------

export { AGENT_BODY_STATUSES, BODY_BINDING_STATUSES, POLICY_CHECK_OUTCOMES };
export type { AgentBodyStatus, BodyBindingStatus, PolicyCheckOutcome };

/**
 * The runtime mirror of the frozen W132 purpose list. The frozen
 * provider-fabric contract exports the TYPE only, so validation needs the
 * values locally. The cast below is the reconciliation: this array is
 * pinned to the frozen union — adding a purpose upstream without updating
 * this mirror is a compile error here, and a stray value here that is not
 * in the frozen union is a compile error too.
 */
const MODEL_BINDING_PURPOSE_VALUES = [
  'cognition',
  'conversation',
  'analysis',
  'background',
] as const satisfies readonly ModelBindingPurpose[];

/** Runtime purpose list (see the header note — the frozen seam is types-only). */
export const MODEL_BINDING_PURPOSES: readonly ModelBindingPurpose[] =
  MODEL_BINDING_PURPOSE_VALUES;

/** Body-role grammar — canonical lowercase slug (the identity). */
const ROLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Capability-key grammar — colon-joined lowercase slug segments. */
const CAPABILITY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}(?::[a-z0-9][a-z0-9-]{0,63})*$/;
/** Hook-registry / general kind grammar (epistemics/audit/coverage precedent). */
const HOOK_REGISTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
/** Strict ISO 8601 with an explicit offset (timestamptz; IMPLEMENTATION-STACK §8). */
const ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
/** Credential-shaped INPUT keys — never part of body state (recursive scan). */
const CREDENTIAL_KEY_PATTERN = /credential|secret|token|passphrase|password|api[-_]?key/i;
/** Raw-credential-looking opaque references — refs and binding ids only. */
const CREDENTIAL_VALUE_PATTERN =
  /^(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|gho_[A-Za-z0-9]{30,}|xox[baprs]-|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

export const MAX_LABEL_CHARS = 128;
export const MAX_DESCRIPTION_CHARS = 1024;
export const MAX_CAPABILITY_CHARS = 128;
export const MAX_CAPABILITIES = 64;
export const MAX_HOOKS = 64;
export const MAX_HOOK_REF_CHARS = 256;
export const MAX_BINDING_ID_CHARS = 256;
export const MAX_BASIS_CHARS = 2048;
export const MAX_CHECKED_BY_CHARS = 256;
export const MAX_REASON_CHARS = 2048;
/** Serialized-size bound for one §1 policy descriptor (JSON.stringify length). */
export const MAX_POLICY_DESCRIPTOR_BYTES = 16384;
/** Depth bound for the recursive descriptor scan (defense against cyclic/deep input). */
export const MAX_POLICY_DESCRIPTOR_DEPTH = 8;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

// ---------------------------------------------------------------------------
// Vocabulary guards
// ---------------------------------------------------------------------------

export function isAgentBodyStatus(value: unknown): value is AgentBodyStatus {
  return typeof value === 'string' && (AGENT_BODY_STATUSES as readonly string[]).includes(value);
}

export function isBodyBindingStatus(value: unknown): value is BodyBindingStatus {
  return typeof value === 'string' && (BODY_BINDING_STATUSES as readonly string[]).includes(value);
}

export function isPolicyCheckOutcome(value: unknown): value is PolicyCheckOutcome {
  return typeof value === 'string' && (POLICY_CHECK_OUTCOMES as readonly string[]).includes(value);
}

export function isModelBindingPurpose(value: unknown): value is ModelBindingPurpose {
  return (
    typeof value === 'string' &&
    (MODEL_BINDING_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * The recorded ruling as a function: ONLY a 'compatible' verdict may
 * activate an attachment. 'incompatible' refuses outright (typed
 * `policy_check_failed`, nothing appended); 'unknown' is treated exactly
 * the same — an unverified compatibility can never activate. The layer
 * records verdicts verbatim and never fabricates one; it simply refuses to
 * possess a body with a binding it cannot vouch for. (Reversible at TL
 * discretion — see WORK-NOTES.md.)
 */
export function isAttachablePolicyOutcome(outcome: PolicyCheckOutcome): boolean {
  return outcome === 'compatible';
}

/** Uuid shape guard; malformed ids are "not found" upstream. */
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Validates the shape of an explicit TenantContext (throws `invalid_context`). */
export function assertAgentBodyTenantContext(ctx: TenantContext): void {
  if (typeof ctx.tenantId !== 'string' || ctx.tenantId.trim() === '') {
    throw new AgentBodyError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof ctx.principalId !== 'string' || ctx.principalId.trim() === '') {
    throw new AgentBodyError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(ctx.authority)) {
    throw new AgentBodyError('invalid_context', 'TenantContext.authority must be an array of claims');
  }
}

// ---------------------------------------------------------------------------
// Shared field guards
// ---------------------------------------------------------------------------

type InputCode =
  | 'invalid_body_input'
  | 'invalid_binding_input'
  | 'invalid_query';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  code: InputCode,
  where: string,
): void {
  for (const key of Object.keys(value)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new AgentBodyError(
        code,
        `body state never carries credentials: field '${key}' is rejected on ${where}`,
      );
    }
    if (!(allowed as readonly string[]).includes(key)) {
      throw new AgentBodyError(
        code,
        `unknown field '${key}' on ${where} (allowed: ${allowed.join(', ')})`,
      );
    }
  }
}

function requireString(
  value: unknown,
  field: string,
  code: InputCode,
  maxChars: number,
): string {
  if (typeof value !== 'string') throw new AgentBodyError(code, `${field} must be a string`);
  const text = value.trim();
  if (text === '') throw new AgentBodyError(code, `${field} must be a non-empty string`);
  if (text.length > maxChars) {
    throw new AgentBodyError(code, `${field} must be at most ${maxChars} characters`);
  }
  return text;
}

function optionalString(
  value: unknown,
  field: string,
  code: InputCode,
  maxChars: number,
): string | null {
  if (value === undefined || value === null) return null;
  return requireString(value, field, code, maxChars);
}

/**
 * Recursive credential-key scan of a JSON value (bounded depth). Body
 * state never carries credentials at ANY level of a policy descriptor —
 * the five §1 descriptors describe BEHAVIOR and POLICY, not secrets.
 */
function assertNoCredentialKeys(
  value: unknown,
  where: string,
  depth: number,
): void {
  if (depth > MAX_POLICY_DESCRIPTOR_DEPTH) {
    throw new AgentBodyError(
      'invalid_body_input',
      `${where} nests deeper than ${MAX_POLICY_DESCRIPTOR_DEPTH} levels`,
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialKeys(item, where, depth + 1);
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        throw new AgentBodyError(
          'invalid_body_input',
          `body state never carries credentials: key '${key}' is rejected inside ${where}`,
        );
      }
      assertNoCredentialKeys(value[key], where, depth + 1);
    }
  }
}

/**
 * A §1 policy descriptor: honest plain-JSON-or-null. `undefined` is the
 * caller's "leave unchanged" (update semantics) and normalizes to
 * `undefined`; `null` is an explicit "not stated" and normalizes to `null`;
 * a value must be a plain JSON object within the serialized-size bound and
 * free of credential-shaped keys at any depth.
 */
function policyDescriptor(
  value: unknown,
  field: string,
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isPlainObject(value)) {
    throw new AgentBodyError(
      'invalid_body_input',
      `${field} must be a plain JSON object or null (honest policy statement), not ${Array.isArray(value) ? 'an array' : typeof value}`,
    );
  }
  assertNoCredentialKeys(value, field, 0);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AgentBodyError('invalid_body_input', `${field} must be JSON-serializable`);
  }
  if (serialized.length > MAX_POLICY_DESCRIPTOR_BYTES) {
    throw new AgentBodyError(
      'invalid_body_input',
      `${field} must serialize to at most ${MAX_POLICY_DESCRIPTOR_BYTES} characters`,
    );
  }
  return value;
}

/** Declared capability keys: grammar, count and no duplicates. */
function permittedCapabilities(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AgentBodyError('invalid_body_input', 'permittedCapabilities must be an array of capability keys');
  }
  if (value.length > MAX_CAPABILITIES) {
    throw new AgentBodyError(
      'invalid_body_input',
      `permittedCapabilities carries at most ${MAX_CAPABILITIES} keys`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !CAPABILITY_PATTERN.test(item)) {
      throw new AgentBodyError(
        'invalid_body_input',
        `permittedCapabilities entries must be colon-joined lowercase slugs (e.g. 'company-query:run'), got '${String(item)}'`,
      );
    }
    if (item.length > MAX_CAPABILITY_CHARS) {
      throw new AgentBodyError(
        'invalid_body_input',
        `permittedCapabilities entries must be at most ${MAX_CAPABILITY_CHARS} characters`,
      );
    }
    if (seen.has(item)) {
      throw new AgentBodyError(
        'invalid_body_input',
        `permittedCapabilities must not repeat '${item}'`,
      );
    }
    seen.add(item);
    out.push(item);
  }
  return out;
}

/** Opaque (registry, ref) hook references: shape, grammar, count, no duplicates. */
function hookRefs(value: unknown, field: string): AgentBodyHookRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new AgentBodyError('invalid_body_input', `${field} must be an array of { registry, ref } references`);
  }
  if (value.length > MAX_HOOKS) {
    throw new AgentBodyError('invalid_body_input', `${field} carries at most ${MAX_HOOKS} references`);
  }
  const seen = new Set<string>();
  const out: AgentBodyHookRef[] = [];
  for (const item of value) {
    if (!isPlainObject(item)) {
      throw new AgentBodyError('invalid_body_input', `${field} entries must be objects of { registry, ref }`);
    }
    rejectUnknownKeys(item, ['registry', 'ref'], 'invalid_body_input', `${field} entry`);
    const registry = item['registry'];
    if (typeof registry !== 'string' || !HOOK_REGISTRY_PATTERN.test(registry)) {
      throw new AgentBodyError(
        'invalid_body_input',
        `${field}.registry must be a registry key (letters, digits, . _ : -), got '${String(registry)}'`,
      );
    }
    const ref = item['ref'];
    if (typeof ref !== 'string' || ref.trim() === '' || ref.length > MAX_HOOK_REF_CHARS) {
      throw new AgentBodyError(
        'invalid_body_input',
        `${field}.ref must be a non-empty opaque reference of at most ${MAX_HOOK_REF_CHARS} characters`,
      );
    }
    if (CREDENTIAL_VALUE_PATTERN.test(ref)) {
      throw new AgentBodyError(
        'invalid_body_input',
        `${field}.ref looks like a raw credential — hooks reference registries, never secrets`,
      );
    }
    const dedupe = `${registry}::${ref}`;
    if (seen.has(dedupe)) {
      throw new AgentBodyError(
        'invalid_body_input',
        `${field} must not repeat the '${registry}' reference '${ref}'`,
      );
    }
    seen.add(dedupe);
    out.push({ registry, ref });
  }
  return out;
}

function requireRole(value: unknown): string {
  if (typeof value !== 'string' || !ROLE_PATTERN.test(value)) {
    throw new AgentBodyError(
      'invalid_body_input',
      `role must be a lowercase slug of letters, digits and hyphens (1..64 chars, e.g. 'ride-agent'), got '${String(value)}'`,
    );
  }
  return value;
}

function requireBodyId(value: unknown, code: InputCode): string {
  if (!isUuid(value)) {
    throw new AgentBodyError(code, 'bodyId must be a uuid');
  }
  return value;
}

function requirePurpose(value: unknown, code: InputCode): ModelBindingPurpose {
  if (!isModelBindingPurpose(value)) {
    throw new AgentBodyError(
      code,
      `purpose must be one of: ${MODEL_BINDING_PURPOSES.join(', ')} (the frozen W132 vocabulary)`,
    );
  }
  return value;
}

function parseLimit(value: unknown, code: InputCode = 'invalid_query'): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new AgentBodyError(code, 'limit must be a positive integer');
  }
  if (value > MAX_LIST_LIMIT) {
    throw new AgentBodyError(code, `limit must be at most ${MAX_LIST_LIMIT}`);
  }
  return value;
}

function requireInstant(
  value: unknown,
  field: string,
  code: InputCode,
): string {
  if (typeof value !== 'string' || !ISO_INSTANT_PATTERN.test(value)) {
    throw new AgentBodyError(
      code,
      `${field} must be a strict ISO 8601 instant with an explicit offset`,
    );
  }
  if (Number.isNaN(new Date(value).getTime())) {
    throw new AgentBodyError(code, `${field} is not a valid instant`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// The verbatim policy-check payload
// ---------------------------------------------------------------------------

/**
 * The shape guard of the verbatim policy-check payload:
 *   { outcome, basis, checkedBy, checkedAt }.
 * `checkedAt` is caller-supplied on purpose — the check happened upstream
 * and this layer records it VERBATIM (it never re-mints the check time).
 */
export function validatePolicyCheckPayload(value: unknown): PolicyCheckPayload {
  if (!isPlainObject(value)) {
    throw new AgentBodyError(
      'invalid_binding_input',
      'policyCheck must be an object of { outcome, basis, checkedBy, checkedAt }',
    );
  }
  rejectUnknownKeys(value, ['outcome', 'basis', 'checkedBy', 'checkedAt'], 'invalid_binding_input', 'policyCheck');
  if (!isPolicyCheckOutcome(value['outcome'])) {
    throw new AgentBodyError(
      'invalid_binding_input',
      `policyCheck.outcome must be one of: ${POLICY_CHECK_OUTCOMES.join(', ')}`,
    );
  }
  const basis = requireString(value['basis'], 'policyCheck.basis', 'invalid_binding_input', MAX_BASIS_CHARS);
  const checkedBy = requireString(
    value['checkedBy'],
    'policyCheck.checkedBy',
    'invalid_binding_input',
    MAX_CHECKED_BY_CHARS,
  );
  const checkedAt = requireInstant(value['checkedAt'], 'policyCheck.checkedAt', 'invalid_binding_input');
  return { outcome: value['outcome'], basis, checkedBy, checkedAt };
}

// ---------------------------------------------------------------------------
// Body create / update / retire / get / list
// ---------------------------------------------------------------------------

/** The normalized create input (everything optional has an honest default). */
export interface ValidatedCreateAgentBodyInput {
  role: string;
  label: string;
  description: string | null;
  communicationBehavior: Record<string, unknown> | null;
  informationAcquisitionBehavior: Record<string, unknown> | null;
  companyContextAccess: Record<string, unknown> | null;
  memoryPolicy: Record<string, unknown> | null;
  escalationBehavior: Record<string, unknown> | null;
  permittedCapabilities: string[];
  evidenceHooks: AgentBodyHookRef[];
  learningHooks: AgentBodyHookRef[];
}

const CREATE_BODY_KEYS = [
  'role',
  'label',
  'description',
  'communicationBehavior',
  'informationAcquisitionBehavior',
  'companyContextAccess',
  'memoryPolicy',
  'escalationBehavior',
  'permittedCapabilities',
  'evidenceHooks',
  'learningHooks',
] as const;

export function validateCreateAgentBodyInput(input: unknown): ValidatedCreateAgentBodyInput {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_body_input', 'the create input must be an object');
  }
  rejectUnknownKeys(input, CREATE_BODY_KEYS, 'invalid_body_input', 'createAgentBody input');
  return {
    role: requireRole(input['role']),
    label: requireString(input['label'], 'label', 'invalid_body_input', MAX_LABEL_CHARS),
    description: optionalString(
      input['description'],
      'description',
      'invalid_body_input',
      MAX_DESCRIPTION_CHARS,
    ),
    communicationBehavior: policyDescriptor(input['communicationBehavior'], 'communicationBehavior') ?? null,
    informationAcquisitionBehavior:
      policyDescriptor(input['informationAcquisitionBehavior'], 'informationAcquisitionBehavior') ?? null,
    companyContextAccess: policyDescriptor(input['companyContextAccess'], 'companyContextAccess') ?? null,
    memoryPolicy: policyDescriptor(input['memoryPolicy'], 'memoryPolicy') ?? null,
    escalationBehavior: policyDescriptor(input['escalationBehavior'], 'escalationBehavior') ?? null,
    permittedCapabilities: permittedCapabilities(input['permittedCapabilities']),
    evidenceHooks: hookRefs(input['evidenceHooks'], 'evidenceHooks'),
    learningHooks: hookRefs(input['learningHooks'], 'learningHooks'),
  };
}

/**
 * The normalized update input — PARTIAL semantics: `undefined` fields stay
 * unchanged, an explicit `null`/`[]` clears. The update surface has NO
 * `role` key (identity immutable) and must carry at least one mutable
 * field: a no-op update is rejected as malformed, not recorded.
 */
export interface ValidatedUpdateAgentBodyInput {
  bodyId: string;
  label: string | undefined;
  description: string | null | undefined;
  communicationBehavior: Record<string, unknown> | null | undefined;
  informationAcquisitionBehavior: Record<string, unknown> | null | undefined;
  companyContextAccess: Record<string, unknown> | null | undefined;
  memoryPolicy: Record<string, unknown> | null | undefined;
  escalationBehavior: Record<string, unknown> | null | undefined;
  permittedCapabilities: string[] | undefined;
  evidenceHooks: AgentBodyHookRef[] | undefined;
  learningHooks: AgentBodyHookRef[] | undefined;
}

const UPDATE_BODY_KEYS = [
  'bodyId',
  'label',
  'description',
  'communicationBehavior',
  'informationAcquisitionBehavior',
  'companyContextAccess',
  'memoryPolicy',
  'escalationBehavior',
  'permittedCapabilities',
  'evidenceHooks',
  'learningHooks',
] as const;

export function validateUpdateAgentBodyInput(input: unknown): ValidatedUpdateAgentBodyInput {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_body_input', 'the update input must be an object');
  }
  // Identity is immutable: `role` on an update is rejected BEFORE the
  // generic unknown-key branch so the message says why (the same rejection
  // would fire below, but the honest error names the law).
  if ('role' in input) {
    throw new AgentBodyError(
      'invalid_body_input',
      'role is the immutable body identity — it cannot be updated (create a new body instead)',
    );
  }
  rejectUnknownKeys(input, UPDATE_BODY_KEYS, 'invalid_body_input', 'updateAgentBody input');
  const bodyId = requireBodyId(input['bodyId'], 'invalid_body_input');
  const label =
    input['label'] === undefined
      ? undefined
      : requireString(input['label'], 'label', 'invalid_body_input', MAX_LABEL_CHARS);
  const description =
    input['description'] === undefined
      ? undefined
      : optionalString(input['description'], 'description', 'invalid_body_input', MAX_DESCRIPTION_CHARS);
  const valid: ValidatedUpdateAgentBodyInput = {
    bodyId,
    label,
    description,
    communicationBehavior: policyDescriptor(input['communicationBehavior'], 'communicationBehavior'),
    informationAcquisitionBehavior: policyDescriptor(
      input['informationAcquisitionBehavior'],
      'informationAcquisitionBehavior',
    ),
    companyContextAccess: policyDescriptor(input['companyContextAccess'], 'companyContextAccess'),
    memoryPolicy: policyDescriptor(input['memoryPolicy'], 'memoryPolicy'),
    escalationBehavior: policyDescriptor(input['escalationBehavior'], 'escalationBehavior'),
    permittedCapabilities:
      input['permittedCapabilities'] === undefined ? undefined : permittedCapabilities(input['permittedCapabilities']),
    evidenceHooks: input['evidenceHooks'] === undefined ? undefined : hookRefs(input['evidenceHooks'], 'evidenceHooks'),
    learningHooks: input['learningHooks'] === undefined ? undefined : hookRefs(input['learningHooks'], 'learningHooks'),
  };
  const carriesField =
    valid.label !== undefined ||
    valid.description !== undefined ||
    valid.communicationBehavior !== undefined ||
    valid.informationAcquisitionBehavior !== undefined ||
    valid.companyContextAccess !== undefined ||
    valid.memoryPolicy !== undefined ||
    valid.escalationBehavior !== undefined ||
    valid.permittedCapabilities !== undefined ||
    valid.evidenceHooks !== undefined ||
    valid.learningHooks !== undefined;
  if (!carriesField) {
    throw new AgentBodyError(
      'invalid_body_input',
      'the update input carries no field — at least one mutable field (label, description, a §1 policy descriptor, permittedCapabilities, evidenceHooks, learningHooks) is required',
    );
  }
  return valid;
}

export interface ValidatedRetireAgentBodyInput {
  bodyId: string;
}

export function validateRetireAgentBodyInput(input: unknown): ValidatedRetireAgentBodyInput {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_body_input', 'the retire input must be an object');
  }
  rejectUnknownKeys(input, ['bodyId'], 'invalid_body_input', 'retireAgentBody input');
  return { bodyId: requireBodyId(input['bodyId'], 'invalid_body_input') };
}

export interface ValidatedGetAgentBodyQuery {
  bodyId: string;
}

export function validateGetAgentBodyQuery(input: unknown): ValidatedGetAgentBodyQuery {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_query', 'the get query must be an object');
  }
  rejectUnknownKeys(input, ['bodyId'], 'invalid_query', 'getAgentBody query');
  return { bodyId: requireBodyId(input['bodyId'], 'invalid_query') };
}

export interface ValidatedListAgentBodiesQuery {
  status: AgentBodyStatus | null;
  limit: number;
}

export function validateListAgentBodiesQuery(input: unknown): ValidatedListAgentBodiesQuery {
  if (input === undefined || input === null) return { status: null, limit: DEFAULT_LIST_LIMIT };
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_query', 'the list query must be an object');
  }
  rejectUnknownKeys(input, ['status', 'limit'], 'invalid_query', 'listAgentBodies query');
  let status: AgentBodyStatus | null = null;
  if (input['status'] !== undefined && input['status'] !== null) {
    if (!isAgentBodyStatus(input['status'])) {
      throw new AgentBodyError(
        'invalid_query',
        `status must be one of: ${AGENT_BODY_STATUSES.join(', ')}`,
      );
    }
    status = input['status'];
  }
  return { status, limit: parseLimit(input['limit']) };
}

// ---------------------------------------------------------------------------
// Binding attach / detach / history / active
// ---------------------------------------------------------------------------

export interface ValidatedAttachModelBindingInput {
  bodyId: string;
  bindingId: string;
  purpose: ModelBindingPurpose;
  policyCheck: PolicyCheckPayload;
}

export function validateAttachModelBindingInput(input: unknown): ValidatedAttachModelBindingInput {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_binding_input', 'the attach input must be an object');
  }
  rejectUnknownKeys(
    input,
    ['bodyId', 'bindingId', 'purpose', 'policyCheck'],
    'invalid_binding_input',
    'attachModelBinding input',
  );
  const bodyId = requireBodyId(input['bodyId'], 'invalid_binding_input');
  const bindingId = requireString(
    input['bindingId'],
    'bindingId',
    'invalid_binding_input',
    MAX_BINDING_ID_CHARS,
  );
  if (CREDENTIAL_VALUE_PATTERN.test(bindingId)) {
    throw new AgentBodyError(
      'invalid_binding_input',
      'bindingId is an opaque provider-fabric reference, never a credential',
    );
  }
  const purpose = requirePurpose(input['purpose'], 'invalid_binding_input');
  const policyCheck = validatePolicyCheckPayload(input['policyCheck']);
  return { bodyId, bindingId, purpose, policyCheck };
}

export interface ValidatedDetachModelBindingInput {
  bodyId: string;
  purpose: ModelBindingPurpose;
  reason: string;
}

export function validateDetachModelBindingInput(input: unknown): ValidatedDetachModelBindingInput {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_binding_input', 'the detach input must be an object');
  }
  rejectUnknownKeys(
    input,
    ['bodyId', 'purpose', 'reason'],
    'invalid_binding_input',
    'detachModelBinding input',
  );
  const bodyId = requireBodyId(input['bodyId'], 'invalid_binding_input');
  const purpose = requirePurpose(input['purpose'], 'invalid_binding_input');
  const reason = requireString(input['reason'], 'reason', 'invalid_binding_input', MAX_REASON_CHARS);
  return { bodyId, purpose, reason };
}

export interface ValidatedGetBodyBindingsQuery {
  bodyId: string;
  purpose: ModelBindingPurpose | null;
  status: BodyBindingStatus | null;
  limit: number;
}

export function validateGetBodyBindingsQuery(input: unknown): ValidatedGetBodyBindingsQuery {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_query', 'the bindings query must be an object');
  }
  rejectUnknownKeys(
    input,
    ['bodyId', 'purpose', 'status', 'limit'],
    'invalid_query',
    'getBodyBindings query',
  );
  const bodyId = requireBodyId(input['bodyId'], 'invalid_query');
  let purpose: ModelBindingPurpose | null = null;
  if (input['purpose'] !== undefined && input['purpose'] !== null) {
    purpose = requirePurpose(input['purpose'], 'invalid_query');
  }
  let status: BodyBindingStatus | null = null;
  if (input['status'] !== undefined && input['status'] !== null) {
    if (!isBodyBindingStatus(input['status'])) {
      throw new AgentBodyError(
        'invalid_query',
        `status must be one of: ${BODY_BINDING_STATUSES.join(', ')}`,
      );
    }
    status = input['status'];
  }
  return { bodyId, purpose, status, limit: parseLimit(input['limit']) };
}

export interface ValidatedGetActiveBindingQuery {
  bodyId: string;
  purpose: ModelBindingPurpose;
}

export function validateGetActiveBindingQuery(input: unknown): ValidatedGetActiveBindingQuery {
  if (!isPlainObject(input)) {
    throw new AgentBodyError('invalid_query', 'the active-binding query must be an object');
  }
  rejectUnknownKeys(input, ['bodyId', 'purpose'], 'invalid_query', 'getActiveBinding query');
  const bodyId = requireBodyId(input['bodyId'], 'invalid_query');
  const purpose = requirePurpose(input['purpose'], 'invalid_query');
  return { bodyId, purpose };
}
