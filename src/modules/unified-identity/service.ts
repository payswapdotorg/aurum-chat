// Implementation of the unified-identity module's public operations (see
// contract.ts). W095 — Unified Cross-Channel, Meeting and Telephony
// Identity Verification.
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db
// port with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps come from the clock port;
// every statement is scoped by the explicit TenantContext (ADR-0001) —
// cross-tenant access is indistinguishable from
// `unified_identity_not_found` / `ambiguity_not_found`.
//
// AUTHORITY SPLIT (the identity module's interim model, reused verbatim so
// one class of identity administrators governs every modality):
//   - identity:link   — associating a registry identity with a subject;
//   - identity:attest — trust withdrawal (revocation) and ambiguity
//     resolution.
// Observation and evidence-governed auto-linking are deliberately NOT
// claim-gated: they are ingestion-path operations (the meetings/realtime
// unification passes), and the auto-link fires only on UNIQUE
// verified-evidence matches — ambiguity never merges (the W095 rule).
//
// The identity module (W002) remains the identity authority: messaging/
// sms/voice resolution delegates to the people/identity contracts, this
// module never persists shadow rows for them, and no challenge workflow
// is duplicated here (verification methods are evidence matches and
// admin attestations only).

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  findExternalIdentityByProviderKey,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  type ChannelProvider,
} from '@/modules/identity/contract';
import {
  getEmployeeByPerson,
  getPerson,
  listPersonIdentities,
  resolveIdentity,
  type Employee,
  type Person,
} from '@/modules/people/contract';
import { listMeetingParticipants } from '@/modules/meetings/contract';
import {
  getRealtimeSession,
  listRealtimeParticipants,
  listRealtimeSessions,
} from '@/modules/realtime/contract';
import { UnifiedIdentityError } from './errors';
import {
  describeCandidates,
  decideMatch,
  relateEvidenceToSubject,
} from './matching';
import {
  assertModalityProvider,
  assertUnifiedTenantContext,
  isRegistryModality,
  isUnifiedModality,
  isUnifiedStatus,
  MAX_EVIDENCE_LENGTH,
  MAX_LIST_LIMIT,
  MAX_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  modalityOfChannelProvider,
  normalizeDisplayName,
  normalizeEmailFacet,
  normalizeLimit,
  normalizePhoneFacet,
  normalizeProviderAccountId,
  optionalText,
  REGISTRY_MODALITIES,
  requireText,
  requireUnifiedAuthority,
  requireUuid,
  UNIFIED_MODALITIES,
} from './validation';
import type {
  LinkUnifiedSubjectInput,
  MatchCandidate,
  ObserveModalityIdentityInput,
  ObserveModalityIdentityResult,
  RegistryModality,
  ResolveUnifiedAmbiguityInput,
  ResolveUnifiedIdentityInput,
  RevokeUnifiedLinkInput,
  UnifiedAmbiguity,
  UnifiedAmbiguityKind,
  UnifiedAmbiguityResolutionAction,
  UnifiedAmbiguityStatus,
  UnifiedIdentity,
  UnifiedIdentityEvent,
  UnifiedIdentityView,
  UnifiedMatchOutcome,
  UnifiedModality,
  UnifiedModalityReach,
  UnifiedResolution,
  UnifiedStatus,
  UnifiedSubjectProfile,
  UnifiedUnifySummary,
  UnifiedVerificationMethod,
  ListUnifiedAmbiguitiesQuery,
  ListUnifiedIdentitiesQuery,
  ListUnifiedIdentityEventsQuery,
  UnifyMeetingIdentitiesInput,
  UnifyRealtimeIdentitiesInput,
} from './types';

// ---------------------------------------------------------------------------
// Row shapes + mappers
// ---------------------------------------------------------------------------

interface UnifiedIdentityRow extends DbRow {
  id: string;
  tenant_id: string;
  modality: string;
  provider: string;
  provider_account_id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  subject_id: string | null;
  status: string;
  verification_method: string | null;
  verification_evidence: string | null;
  verified_at: Date | string | null;
  verified_by: string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  linked_at: Date | string | null;
  first_seen_at: Date | string;
  last_seen_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AmbiguityRow extends DbRow {
  id: string;
  tenant_id: string;
  unified_identity_id: string;
  kind: string;
  candidates: unknown;
  detail: string;
  status: string;
  resolved_action: string | null;
  resolved_by: string | null;
  resolved_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface EventRow extends DbRow {
  id: string;
  tenant_id: string;
  unified_identity_id: string;
  kind: string;
  detail: string;
  occurred_at: Date | string;
}

const VERIFICATION_METHODS: readonly UnifiedVerificationMethod[] = [
  'cross_modality_match',
  'admin_attestation',
];

const AMBIGUITY_KINDS: readonly UnifiedAmbiguityKind[] = [
  'conflicting_subject_matches',
  'linked_subject_conflict',
];

const AMBIGUITY_ACTIONS: readonly UnifiedAmbiguityResolutionAction[] = [
  'admin_linked',
  'revoked',
  'evidence_resolved',
  'dismissed',
];

const EVENT_KINDS: readonly UnifiedIdentityEvent['kind'][] = [
  'observed',
  'linked',
  'admin_linked',
  'revoked',
  'ambiguity_opened',
  'ambiguity_resolved',
];

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toRegistryModality(value: string): RegistryModality {
  const modality = REGISTRY_MODALITIES.find((candidate) => candidate === value);
  if (modality === undefined) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `unified identity row carries unknown modality '${value}'`,
    );
  }
  return modality;
}

function toUnifiedStatus(value: string): UnifiedStatus {
  const status = ['unverified', 'verified', 'revoked'].find((candidate) => candidate === value);
  if (status === undefined) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `unified identity row carries unknown status '${value}'`,
    );
  }
  return status as UnifiedStatus;
}

function toVerificationMethod(value: string | null): UnifiedVerificationMethod | null {
  if (value === null) return null;
  const method = VERIFICATION_METHODS.find((candidate) => candidate === value);
  return method === undefined ? null : method;
}

function toAmbiguityKind(value: string): UnifiedAmbiguityKind {
  const kind = AMBIGUITY_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `ambiguity row carries unknown kind '${value}'`,
    );
  }
  return kind;
}

function toAmbiguityAction(value: string | null): UnifiedAmbiguityResolutionAction | null {
  if (value === null) return null;
  const action = AMBIGUITY_ACTIONS.find((candidate) => candidate === value);
  return action === undefined ? null : action;
}

function toCandidates(value: unknown): MatchCandidate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (candidate): candidate is MatchCandidate =>
      typeof candidate === 'object' &&
      candidate !== null &&
      typeof (candidate as MatchCandidate).personId === 'string' &&
      typeof (candidate as MatchCandidate).matchedVia === 'string' &&
      typeof (candidate as MatchCandidate).provider === 'string' &&
      typeof (candidate as MatchCandidate).providerAccountId === 'string',
  );
}

function mapUnifiedIdentity(row: UnifiedIdentityRow): UnifiedIdentity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    modality: toRegistryModality(row.modality),
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    email: row.email,
    phone: row.phone,
    subjectId: row.subject_id,
    status: toUnifiedStatus(row.status),
    verificationMethod: toVerificationMethod(row.verification_method),
    verificationEvidence: row.verification_evidence,
    verifiedAt: row.verified_at === null ? null : toIso(row.verified_at),
    verifiedBy: row.verified_by,
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    revokedReason: row.revoked_reason,
    linkedAt: row.linked_at === null ? null : toIso(row.linked_at),
    firstSeenAt: toIso(row.first_seen_at),
    lastSeenAt: toIso(row.last_seen_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapAmbiguity(row: AmbiguityRow): UnifiedAmbiguity {
  const status: UnifiedAmbiguityStatus = row.status === 'resolved' ? 'resolved' : 'open';
  return {
    id: row.id,
    tenantId: row.tenant_id,
    unifiedIdentityId: row.unified_identity_id,
    kind: toAmbiguityKind(row.kind),
    candidates: toCandidates(row.candidates),
    detail: row.detail,
    status,
    resolvedAction: toAmbiguityAction(row.resolved_action),
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapEvent(row: EventRow): UnifiedIdentityEvent {
  const kind = EVENT_KINDS.find((candidate) => candidate === row.kind);
  if (kind === undefined) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `unified identity event row carries unknown kind '${row.kind}'`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    unifiedIdentityId: row.unified_identity_id,
    kind,
    detail: row.detail,
    occurredAt: toIso(row.occurred_at),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function loadUnifiedIdentityRow(
  ctx: TenantContext,
  unifiedIdentityId: string,
): Promise<UnifiedIdentityRow> {
  const result = await getDb().query<UnifiedIdentityRow>(
    `SELECT * FROM unified_identities WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, unifiedIdentityId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant access is indistinguishable from a missing record (no existence leak).
    throw new UnifiedIdentityError(
      'unified_identity_not_found',
      `unified identity '${unifiedIdentityId}' does not exist in this tenant`,
    );
  }
  return row;
}

async function recordEvent(
  ctx: TenantContext,
  unifiedIdentityId: string,
  kind: UnifiedIdentityEvent['kind'],
  detail: string,
  at: Date,
): Promise<void> {
  await getDb().query(
    `INSERT INTO unified_identity_events (tenant_id, unified_identity_id, kind, detail, occurred_at)
       VALUES ($1, $2, $3, $4, $5)`,
    [ctx.tenantId, unifiedIdentityId, kind, detail, at],
  );
}

/**
 * Gathers match candidates for an observation's facets through the
 * identity contract: a facet is evidence only when it equals the account
 * of a VERIFIED, subject-linked identity (email facet → provider 'email',
 * delivered and lowercased probes; phone facet → providers 'sms' AND
 * 'voice' — the same E.164 may be verified to different persons on each,
 * which is exactly the ambiguity the guard must catch). Display names are
 * never evidence.
 */
async function gatherCandidates(
  ctx: TenantContext,
  email: string | null,
  phone: string | null,
): Promise<MatchCandidate[]> {
  const candidates: MatchCandidate[] = [];
  if (email !== null) {
    const probes = email === email.toLowerCase() ? [email] : [email, email.toLowerCase()];
    for (const probe of probes) {
      const identity = await findExternalIdentityByProviderKey(ctx, {
        provider: 'email',
        providerAccountId: probe,
      });
      if (identity !== null && identity.status === 'verified' && identity.subjectId !== null) {
        candidates.push({
          personId: identity.subjectId,
          matchedVia: 'email',
          provider: 'email',
          providerAccountId: identity.providerAccountId,
        });
      }
    }
  }
  if (phone !== null) {
    for (const provider of ['sms', 'voice'] as const) {
      const identity = await findExternalIdentityByProviderKey(ctx, {
        provider,
        providerAccountId: phone,
      });
      if (identity !== null && identity.status === 'verified' && identity.subjectId !== null) {
        candidates.push({
          personId: identity.subjectId,
          matchedVia: provider,
          provider,
          providerAccountId: identity.providerAccountId,
        });
      }
    }
  }
  return candidates;
}

/**
 * Records (or refreshes) the open ambiguity ledger row for one registry
 * identity + kind, and appends the evidence event. One OPEN row per
 * (identity, kind): a repeated ambiguous observation refreshes it instead
 * of stacking duplicates.
 */
async function recordAmbiguity(
  ctx: TenantContext,
  row: UnifiedIdentityRow,
  kind: UnifiedAmbiguityKind,
  candidates: MatchCandidate[],
  at: Date,
): Promise<string> {
  const db = getDb();
  const evidence = describeCandidates(candidates);
  const detail =
    kind === 'linked_subject_conflict'
      ? `verified link to person ${row.subject_id} conflicts with newer evidence: ${evidence}`
      : `matching evidence pointed at more than one organizational person: ${evidence}`;
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM unified_ambiguities
       WHERE tenant_id = $1 AND unified_identity_id = $2 AND kind = $3 AND status = 'open'
       ORDER BY created_at DESC LIMIT 1`,
    [ctx.tenantId, row.id, kind],
  );
  const open = existing.rows[0];
  if (open !== undefined) {
    await db.query(
      `UPDATE unified_ambiguities
         SET candidates = $3::jsonb, detail = $4, updated_at = $5
         WHERE tenant_id = $1 AND id = $2`,
      [ctx.tenantId, open.id, JSON.stringify(candidates), detail, at],
    );
    await recordEvent(ctx, row.id, 'ambiguity_opened', detail, at);
    return open.id;
  }
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO unified_ambiguities (tenant_id, unified_identity_id, kind, candidates, detail, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $6) RETURNING id`,
    [ctx.tenantId, row.id, kind, JSON.stringify(candidates), detail, at],
  );
  await recordEvent(ctx, row.id, 'ambiguity_opened', detail, at);
  return inserted.rows[0]!.id;
}

/** Closes every open ambiguity of one identity with the given action. */
async function closeOpenAmbiguities(
  ctx: TenantContext,
  unifiedIdentityId: string,
  action: UnifiedAmbiguityResolutionAction,
  at: Date,
): Promise<void> {
  const closed = await getDb().query<{ id: string }>(
    `UPDATE unified_ambiguities
       SET status = 'resolved', resolved_action = $3, resolved_by = $4, resolved_at = $5, updated_at = $5
       WHERE tenant_id = $1 AND unified_identity_id = $2 AND status = 'open'
       RETURNING id`,
    [ctx.tenantId, unifiedIdentityId, action, ctx.principalId, at],
  );
  for (const closedRow of closed.rows) {
    await recordEvent(
      ctx,
      unifiedIdentityId,
      'ambiguity_resolved',
      `ambiguity ${closedRow.id} closed by ${action}`,
      at,
    );
  }
}

/** Applies a verified link onto a registry row (the single write path). */
async function applyVerifiedLink(
  ctx: TenantContext,
  row: UnifiedIdentityRow,
  personId: string,
  method: UnifiedVerificationMethod,
  evidence: string,
  at: Date,
): Promise<UnifiedIdentityRow> {
  const result = await getDb().query<UnifiedIdentityRow>(
    `UPDATE unified_identities
       SET subject_id = $3, linked_at = $4, status = 'verified',
           verification_method = $5, verification_evidence = $6,
           verified_at = $4, verified_by = $7,
           revoked_at = NULL, revoked_reason = NULL, updated_at = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
    [ctx.tenantId, row.id, personId, at, method, evidence, ctx.principalId],
  );
  return result.rows[0]!;
}

// ---------------------------------------------------------------------------
// Observation (the on-sight registry edge + the ambiguity guard)
// ---------------------------------------------------------------------------

export async function observeModalityIdentity(
  ctx: TenantContext,
  input: ObserveModalityIdentityInput,
): Promise<ObserveModalityIdentityResult> {
  assertUnifiedTenantContext(ctx);
  if (input === null || typeof input !== 'object') {
    throw new UnifiedIdentityError('invalid_unified_input', 'input must be an object');
  }
  if (!isRegistryModality(input.modality)) {
    throw new UnifiedIdentityError(
      'unsupported_modality',
      `modality '${String(input.modality)}' is not a registry modality (${REGISTRY_MODALITIES.join(
        ', ',
      )}); messaging/sms/voice identities are owned by the identity module — resolve them via resolveUnifiedIdentity`,
    );
  }
  const modality = input.modality;
  const provider = assertModalityProvider(modality, input.provider);
  const providerAccountId = normalizeProviderAccountId(input.providerAccountId);
  const displayName = normalizeDisplayName(input.displayName);
  const email = normalizeEmailFacet(input.email);
  const phone = normalizePhoneFacet(input.phone);
  const at = now();
  const db = getDb();

  // Get-or-create (on-sight registration; duplicates collapse onto one row).
  const inserted = await db.query<UnifiedIdentityRow>(
    `INSERT INTO unified_identities (
       tenant_id, modality, provider, provider_account_id, display_name, email, phone,
       first_seen_at, last_seen_at, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8, $8)
       ON CONFLICT (tenant_id, modality, provider, provider_account_id) DO NOTHING
       RETURNING *`,
    [ctx.tenantId, modality, provider, providerAccountId, displayName, email, phone, at],
  );
  let row = inserted.rows[0];
  let created = false;
  if (row !== undefined) {
    created = true;
    await recordEvent(
      ctx,
      row.id,
      'observed',
      `first ${modality} observation: ${provider}/${providerAccountId}`,
      at,
    );
  } else {
    // Existing identity: facets move forward (nulls never erase), sighting refreshed.
    const refreshed = await db.query<UnifiedIdentityRow>(
      `UPDATE unified_identities SET
           display_name = COALESCE($3, display_name),
           email = COALESCE($4, email),
           phone = COALESCE($5, phone),
           last_seen_at = $6, updated_at = $6
         WHERE tenant_id = $1 AND modality = $2 AND provider = $7
           AND provider_account_id = $8
         RETURNING *`,
      [ctx.tenantId, modality, displayName, email, phone, at, provider, providerAccountId],
    );
    row = refreshed.rows[0];
    if (row === undefined) {
      // Unreachable barring a delete path (none exists); stay loud rather than wrong.
      throw new UnifiedIdentityError(
        'unified_identity_not_found',
        'unified identity disappeared after a duplicate-observation conflict',
      );
    }
  }

  // The ambiguity guard. A revoked unification never re-links automatically —
  // only an explicit admin attestation restores trust (identity-module
  // discipline for revoked identities).
  if (row.status === 'revoked') {
    return { identity: mapUnifiedIdentity(row), created, match: { outcome: 'unmatched' } };
  }

  const candidates = await gatherCandidates(ctx, row.email, row.phone);

  if (row.status === 'verified' && row.subject_id !== null) {
    const relation = relateEvidenceToSubject(row.subject_id, candidates);
    if (relation.relation === 'conflict') {
      const ambiguityId = await recordAmbiguity(
        ctx,
        row,
        'linked_subject_conflict',
        relation.candidates,
        at,
      );
      return {
        identity: mapUnifiedIdentity(row),
        created,
        match: {
          outcome: 'link_retained',
          personId: row.subject_id,
          candidates: relation.candidates,
          ambiguityId,
        },
      };
    }
    return {
      identity: mapUnifiedIdentity(row),
      created,
      match: { outcome: 'already_linked', personId: row.subject_id, candidates },
    };
  }

  const decision = decideMatch(candidates);
  if (decision.kind === 'none') {
    return { identity: mapUnifiedIdentity(row), created, match: { outcome: 'unmatched' } };
  }
  if (decision.kind === 'ambiguous') {
    const ambiguityId = await recordAmbiguity(
      ctx,
      row,
      'conflicting_subject_matches',
      decision.candidates,
      at,
    );
    return {
      identity: mapUnifiedIdentity(row),
      created,
      match: { outcome: 'ambiguous', candidates: decision.candidates, ambiguityId },
    };
  }

  // Unique verified-evidence match: the ONE legal auto-merge (lock 15 is
  // honored — the link rides on the person's own verified identities).
  const evidence = `unique cross-modality evidence match: ${describeCandidates(decision.candidates)}`;
  const linked = await applyVerifiedLink(
    ctx,
    row,
    decision.personId,
    'cross_modality_match',
    evidence,
    at,
  );
  await recordEvent(ctx, row.id, 'linked', evidence, at);
  await closeOpenAmbiguities(ctx, row.id, 'evidence_resolved', at);
  return {
    identity: mapUnifiedIdentity(linked),
    created,
    match: { outcome: 'linked', personId: decision.personId, candidates: decision.candidates },
  };
}

// ---------------------------------------------------------------------------
// Explicit trust operations (claim-gated, mirroring the identity module)
// ---------------------------------------------------------------------------

export async function linkUnifiedSubject(
  ctx: TenantContext,
  input: LinkUnifiedSubjectInput,
): Promise<UnifiedIdentity> {
  assertUnifiedTenantContext(ctx);
  requireUnifiedAuthority(ctx, IDENTITY_AUTHORITY_LINK);
  if (input === null || typeof input !== 'object') {
    throw new UnifiedIdentityError('invalid_unified_input', 'input must be an object');
  }
  const unifiedIdentityId = requireUuid(input.unifiedIdentityId, 'unifiedIdentityId');
  const personId = requireUuid(input.personId, 'personId');
  const evidence = requireText(input.evidence, 'evidence', MAX_EVIDENCE_LENGTH);

  // The module's own resource first (uniform `unified_identity_not_found`,
  // no existence leak), then the subject's tenant-scoped existence check.
  const row = await loadUnifiedIdentityRow(ctx, unifiedIdentityId);
  await getPerson(ctx, personId);
  if (row.status === 'verified') {
    if (row.subject_id === personId) {
      return mapUnifiedIdentity(row); // idempotent re-attestation of the same subject
    }
    throw new UnifiedIdentityError(
      'unified_identity_already_linked',
      'unified identity is already linked to another subject; revoke the link first',
    );
  }
  const at = now();
  const linked = await applyVerifiedLink(
    ctx,
    row,
    personId,
    'admin_attestation',
    evidence,
    at,
  );
  await recordEvent(
    ctx,
    row.id,
    'admin_linked',
    `admin attestation linked person ${personId}: ${evidence}`,
    at,
  );
  await closeOpenAmbiguities(ctx, row.id, 'admin_linked', at);
  return mapUnifiedIdentity(linked);
}

export async function revokeUnifiedLink(
  ctx: TenantContext,
  input: RevokeUnifiedLinkInput,
): Promise<UnifiedIdentity> {
  assertUnifiedTenantContext(ctx);
  requireUnifiedAuthority(ctx, IDENTITY_AUTHORITY_ATTEST);
  if (input === null || typeof input !== 'object') {
    throw new UnifiedIdentityError('invalid_unified_input', 'input must be an object');
  }
  const unifiedIdentityId = requireUuid(input.unifiedIdentityId, 'unifiedIdentityId');
  const reason = requireText(input.reason, 'reason', MAX_REASON_LENGTH);
  const row = await loadUnifiedIdentityRow(ctx, unifiedIdentityId);
  if (row.status !== 'verified') {
    throw new UnifiedIdentityError(
      'unified_identity_not_verified',
      'only verified unified identities can be revoked',
    );
  }
  const at = now();
  // Revocation voids the verification AND detaches the subject — the trust
  // basis for the link is gone (identity-module discipline).
  const result = await getDb().query<UnifiedIdentityRow>(
    `UPDATE unified_identities
       SET status = 'revoked',
           verification_method = NULL, verification_evidence = NULL,
           verified_at = NULL, verified_by = NULL,
           revoked_at = $3, revoked_reason = $4,
           subject_id = NULL, linked_at = NULL, updated_at = $3
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
    [ctx.tenantId, row.id, at, reason],
  );
  await recordEvent(ctx, row.id, 'revoked', `link revoked: ${reason}`, at);
  await closeOpenAmbiguities(ctx, row.id, 'revoked', at);
  return mapUnifiedIdentity(result.rows[0]!);
}

export async function resolveUnifiedAmbiguity(
  ctx: TenantContext,
  input: ResolveUnifiedAmbiguityInput,
): Promise<UnifiedAmbiguity> {
  assertUnifiedTenantContext(ctx);
  requireUnifiedAuthority(ctx, IDENTITY_AUTHORITY_ATTEST);
  if (input === null || typeof input !== 'object') {
    throw new UnifiedIdentityError('invalid_unified_input', 'input must be an object');
  }
  const ambiguityId = requireUuid(input.ambiguityId, 'ambiguityId');
  if (input.action !== 'dismissed') {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      "action must be 'dismissed' — linking closes ambiguities through linkUnifiedSubject, revocation through revokeUnifiedLink",
    );
  }
  const note = optionalText(input.note, 'note', MAX_NOTE_LENGTH);
  const result = await getDb().query<AmbiguityRow>(
    `SELECT * FROM unified_ambiguities WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, ambiguityId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new UnifiedIdentityError(
      'ambiguity_not_found',
      `ambiguity '${ambiguityId}' does not exist in this tenant`,
    );
  }
  if (row.status === 'resolved') {
    throw new UnifiedIdentityError(
      'ambiguity_already_resolved',
      'the ambiguity is already resolved',
    );
  }
  const at = now();
  const updated = await getDb().query<AmbiguityRow>(
    `UPDATE unified_ambiguities
       SET status = 'resolved', resolved_action = 'dismissed', resolved_by = $3,
           resolved_at = $4, updated_at = $4
       WHERE tenant_id = $1 AND id = $2
       RETURNING *`,
    [ctx.tenantId, ambiguityId, ctx.principalId, at],
  );
  await recordEvent(
    ctx,
    row.unified_identity_id,
    'ambiguity_resolved',
    `ambiguity ${ambiguityId} dismissed${note === null ? '' : `: ${note}`}`,
    at,
  );
  return mapAmbiguity(updated.rows[0]!);
}

// ---------------------------------------------------------------------------
// Unified resolution + profile (the W095 proof surface)
// ---------------------------------------------------------------------------

export async function resolveUnifiedIdentity(
  ctx: TenantContext,
  input: ResolveUnifiedIdentityInput,
): Promise<UnifiedResolution> {
  assertUnifiedTenantContext(ctx);
  if (input === null || typeof input !== 'object') {
    throw new UnifiedIdentityError('invalid_unified_input', 'input must be an object');
  }
  if (!isUnifiedModality(input.modality)) {
    throw new UnifiedIdentityError(
      'invalid_unified_input',
      `modality must be one of ${UNIFIED_MODALITIES.join(', ')}`,
    );
  }
  const modality: UnifiedModality = input.modality;
  const provider = assertModalityProvider(modality, input.provider);
  const providerAccountId = normalizeProviderAccountId(input.providerAccountId);

  // Identity-backed modalities delegate to the people/identity contracts —
  // the identity module stays the authority for channel accounts.
  if (modality === 'messaging' || modality === 'sms' || modality === 'voice') {
    const resolution = await resolveIdentity(ctx, {
      provider: provider as ChannelProvider,
      providerAccountId,
    });
    switch (resolution.status) {
      case 'unknown_identity':
        return { status: 'unknown_identity' };
      case 'unresolved_identity':
        return {
          status: 'unverified',
          view: { origin: 'identity_module', identity: resolution.identity },
        };
      case 'resolved':
        return {
          status: 'resolved',
          view: { origin: 'identity_module', identity: resolution.identity },
          person: resolution.person,
          employee: resolution.employee,
        };
    }
  }

  const result = await getDb().query<UnifiedIdentityRow>(
    `SELECT * FROM unified_identities
       WHERE tenant_id = $1 AND modality = $2 AND provider = $3 AND provider_account_id = $4`,
    [ctx.tenantId, modality, provider, providerAccountId],
  );
  const row = result.rows[0];
  if (row === undefined) return { status: 'unknown_identity' };
  if (row.status !== 'verified' || row.subject_id === null) {
    return { status: 'unverified', view: { origin: 'unified_registry', identity: mapUnifiedIdentity(row) } };
  }
  const person: Person = await getPerson(ctx, row.subject_id);
  const employee: Employee | null = await getEmployeeByPerson(ctx, row.subject_id);
  return {
    status: 'resolved',
    view: { origin: 'unified_registry', identity: mapUnifiedIdentity(row) },
    person,
    employee,
  };
}

export async function getUnifiedSubjectProfile(
  ctx: TenantContext,
  personId: string,
): Promise<UnifiedSubjectProfile> {
  assertUnifiedTenantContext(ctx);
  const pid = requireUuid(personId, 'personId');
  const person = await getPerson(ctx, pid);
  const employee = await getEmployeeByPerson(ctx, pid);

  const groups = new Map<UnifiedModality, UnifiedIdentityView[]>();
  const push = (modality: UnifiedModality, view: UnifiedIdentityView): void => {
    const bucket = groups.get(modality);
    if (bucket === undefined) groups.set(modality, [view]);
    else bucket.push(view);
  };

  // Identity-backed modalities: only verified, subject-linked identities count.
  const identities = await listPersonIdentities(ctx, pid);
  for (const identity of identities) {
    if (identity.status !== 'verified' || identity.subjectId !== pid) continue;
    push(modalityOfChannelProvider(identity.provider), {
      origin: 'identity_module',
      identity,
    });
  }

  // Registry modalities: verified rows linked to this subject.
  const registryRows = await getDb().query<UnifiedIdentityRow>(
    `SELECT * FROM unified_identities
       WHERE tenant_id = $1 AND subject_id = $2 AND status = 'verified'
       ORDER BY created_at, id`,
    [ctx.tenantId, pid],
  );
  for (const row of registryRows.rows) {
    push(toRegistryModality(row.modality), {
      origin: 'unified_registry',
      identity: mapUnifiedIdentity(row),
    });
  }

  const modalities: UnifiedModalityReach[] = [];
  for (const modality of UNIFIED_MODALITIES) {
    const identitiesOfModality = groups.get(modality);
    if (identitiesOfModality === undefined || identitiesOfModality.length === 0) continue;
    modalities.push({ modality, identities: identitiesOfModality });
  }
  return { person, employee, modalities, verifiedModalityCount: modalities.length };
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

export async function getUnifiedIdentity(
  ctx: TenantContext,
  unifiedIdentityId: string,
): Promise<UnifiedIdentity> {
  assertUnifiedTenantContext(ctx);
  const id = requireUuid(unifiedIdentityId, 'unifiedIdentityId');
  return mapUnifiedIdentity(await loadUnifiedIdentityRow(ctx, id));
}

export async function listUnifiedIdentities(
  ctx: TenantContext,
  query: ListUnifiedIdentitiesQuery = {},
): Promise<UnifiedIdentity[]> {
  assertUnifiedTenantContext(ctx);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (query.modality !== undefined && query.modality !== null) {
    if (!isRegistryModality(query.modality)) {
      throw new UnifiedIdentityError(
        'invalid_unified_query',
        `modality must be one of ${REGISTRY_MODALITIES.join(', ')}`,
      );
    }
    params.push(query.modality);
    conditions.push(`modality = $${params.length}`);
  }
  if (query.status !== undefined && query.status !== null) {
    if (!isUnifiedStatus(query.status)) {
      throw new UnifiedIdentityError('invalid_unified_query', 'status must be a unified status');
    }
    params.push(query.status);
    conditions.push(`status = $${params.length}`);
  }
  if (query.subjectId !== undefined && query.subjectId !== null) {
    params.push(requireUuid(query.subjectId, 'subjectId'));
    conditions.push(`subject_id = $${params.length}`);
  }
  const limit = normalizeLimit(query.limit);
  params.push(limit);
  const result = await getDb().query<UnifiedIdentityRow>(
    `SELECT * FROM unified_identities WHERE ${conditions.join(' AND ')}
       ORDER BY created_at, id LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => mapUnifiedIdentity(row));
}

export async function listUnifiedAmbiguities(
  ctx: TenantContext,
  query: ListUnifiedAmbiguitiesQuery = {},
): Promise<UnifiedAmbiguity[]> {
  assertUnifiedTenantContext(ctx);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (query.status !== undefined && query.status !== null) {
    if (query.status !== 'open' && query.status !== 'resolved') {
      throw new UnifiedIdentityError('invalid_unified_query', "status must be 'open' or 'resolved'");
    }
    params.push(query.status);
    conditions.push(`status = $${params.length}`);
  }
  if (query.unifiedIdentityId !== undefined && query.unifiedIdentityId !== null) {
    params.push(requireUuid(query.unifiedIdentityId, 'unifiedIdentityId'));
    conditions.push(`unified_identity_id = $${params.length}`);
  }
  const limit = normalizeLimit(query.limit);
  params.push(limit);
  const result = await getDb().query<AmbiguityRow>(
    `SELECT * FROM unified_ambiguities WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => mapAmbiguity(row));
}

export async function listUnifiedIdentityEvents(
  ctx: TenantContext,
  query: ListUnifiedIdentityEventsQuery = {},
): Promise<UnifiedIdentityEvent[]> {
  assertUnifiedTenantContext(ctx);
  const conditions: string[] = ['tenant_id = $1'];
  const params: unknown[] = [ctx.tenantId];
  if (query.unifiedIdentityId !== undefined && query.unifiedIdentityId !== null) {
    params.push(requireUuid(query.unifiedIdentityId, 'unifiedIdentityId'));
    conditions.push(`unified_identity_id = $${params.length}`);
  }
  const limit = normalizeLimit(query.limit);
  params.push(limit);
  const result = await getDb().query<EventRow>(
    `SELECT * FROM unified_identity_events WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at, id LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => mapEvent(row));
}

// ---------------------------------------------------------------------------
// Pull-based unification passes (meetings / realtime registries)
// ---------------------------------------------------------------------------

/**
 * Lenient facet normalization for ingestion passes: a malformed provider
 * facet is EVIDENCE lost, never a reason to drop the identity — the
 * facet becomes null and the observation proceeds.
 */
function lenientFacet(value: string | null | undefined, normalize: (v: unknown) => string | null): string | null {
  try {
    return normalize(value);
  } catch {
    return null;
  }
}

function tally(summary: UnifiedUnifySummary, outcome: UnifiedMatchOutcome['outcome']): void {
  switch (outcome) {
    case 'linked':
      summary.linked += 1;
      break;
    case 'ambiguous':
      summary.ambiguous += 1;
      break;
    case 'link_retained':
      summary.linkRetained += 1;
      break;
    default:
      break;
  }
}

export async function unifyMeetingIdentities(
  ctx: TenantContext,
  input: UnifyMeetingIdentitiesInput = {},
): Promise<UnifiedUnifySummary> {
  assertUnifiedTenantContext(ctx);
  const limit = normalizeLimit(input.limit);
  const participants = await listMeetingParticipants(ctx, { limit });
  const summary: UnifiedUnifySummary = {
    considered: participants.length,
    created: 0,
    linked: 0,
    ambiguous: 0,
    linkRetained: 0,
    skipped: 0,
  };
  for (const participant of participants) {
    const result = await observeModalityIdentity(ctx, {
      modality: 'meeting',
      provider: participant.provider,
      providerAccountId: participant.providerParticipantId,
      displayName: lenientFacet(participant.displayName, normalizeDisplayName),
      email: lenientFacet(participant.email, normalizeEmailFacet),
      phone: null,
    });
    if (result.created) summary.created += 1;
    tally(summary, result.match.outcome);
  }
  return summary;
}

export async function unifyRealtimeIdentities(
  ctx: TenantContext,
  input: UnifyRealtimeIdentitiesInput = {},
): Promise<UnifiedUnifySummary> {
  assertUnifiedTenantContext(ctx);
  const limit = normalizeLimit(input.limit);
  const providerBySession = new Map<string, string>();
  if (input.sessionId !== undefined && input.sessionId !== null) {
    const sessionId = requireUuid(input.sessionId, 'sessionId');
    const session = await getRealtimeSession(ctx, sessionId);
    providerBySession.set(session.id, session.provider);
  } else {
    const sessions = await listRealtimeSessions(ctx, { limit: MAX_LIST_LIMIT });
    for (const session of sessions) providerBySession.set(session.id, session.provider);
  }
  const participants = await listRealtimeParticipants(
    ctx,
    input.sessionId !== undefined && input.sessionId !== null
      ? { sessionId: input.sessionId, limit }
      : { limit },
  );
  const summary: UnifiedUnifySummary = {
    considered: participants.length,
    created: 0,
    linked: 0,
    ambiguous: 0,
    linkRetained: 0,
    skipped: 0,
  };
  for (const participant of participants) {
    // Aurum's own realtime participant is an application actor, not an
    // external organizational identity — never unified.
    if (participant.role === 'aurum') {
      summary.skipped += 1;
      continue;
    }
    const provider = providerBySession.get(participant.sessionId);
    if (provider === undefined) {
      // Participant beyond the session window — rerun with a sessionId or a
      // higher limit rather than guessing the transport provider.
      summary.skipped += 1;
      continue;
    }
    const result = await observeModalityIdentity(ctx, {
      modality: 'realtime',
      provider,
      providerAccountId: participant.providerParticipantId,
      displayName: lenientFacet(participant.displayName, normalizeDisplayName),
      email: lenientFacet(participant.email, normalizeEmailFacet),
      phone: lenientFacet(participant.phone, normalizePhoneFacet),
    });
    if (result.created) summary.created += 1;
    tally(summary, result.match.outcome);
  }
  return summary;
}

