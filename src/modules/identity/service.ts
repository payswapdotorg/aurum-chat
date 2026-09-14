// Implementation of the identity module's public operations (see contract.ts).
//
// Conventions (IMPLEMENTATION-STACK §3/§8): all SQL goes through the db port
// with `$n` placeholders; ids are uuids minted by PostgreSQL
// (`gen_random_uuid()`); semantic timestamps come from the injectable clock;
// every statement is scoped by the explicit TenantContext (ADR-0001) —
// cross-tenant access is indistinguishable from `identity_not_found`.
//
// The verified-linking workflow implemented here (ADR-0003, lock 15):
//   register (unverified) → issue challenge → complete challenge
//   (or: admin attestation) → attach subject → [detach / revoke]
// Only `verified` identities may be attached to a subject, so a channel
// account can never act as a disconnected pseudo-employee.

import { now } from '@/infra/clock';
import { getDb, type DbRow } from '@/infra/db';
import type { TenantContext } from '@/infra/tenant';
import {
  assertTenantContext,
  IDENTITY_AUTHORITY_ATTEST,
  IDENTITY_AUTHORITY_LINK,
  requireAuthority,
} from './access';
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MAX_SECONDS,
  CHALLENGE_TTL_MIN_SECONDS,
  challengeCodeMatches,
  DEFAULT_CHALLENGE_TTL_SECONDS,
  generateChallengeCode,
  hashChallengeCode,
} from './challenge';
import { IdentityError } from './errors';
import { assertChannelProvider } from './providers';
import type {
  AttachSubjectInput,
  AttestIdentityInput,
  CompleteChallengeInput,
  DetachSubjectInput,
  ExternalIdentity,
  FindByProviderKeyInput,
  IdentityStatus,
  IssuedChallenge,
  IssueChallengeInput,
  RegisterExternalIdentityInput,
  RegisterExternalIdentityResult,
  RevokeVerificationInput,
  SubjectKind,
  VerificationMethod,
} from './types';

interface IdentityRow extends DbRow {
  id: string;
  tenant_id: string;
  provider: string;
  provider_account_id: string;
  display_name: string | null;
  subject_id: string | null;
  subject_kind: string | null;
  linked_at: Date | string | null;
  status: string;
  verification_method: string | null;
  verified_at: Date | string | null;
  verified_by: string | null;
  verification_evidence: string | null;
  revoked_at: Date | string | null;
  revoked_reason: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface ChallengeRow extends DbRow {
  id: string;
  tenant_id: string;
  identity_id: string;
  code_hash: string;
  issued_at: Date | string;
  expires_at: Date | string;
  attempts: number;
  max_attempts: number;
  consumed_at: Date | string | null;
  superseded_at: Date | string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IDENTITY_STATUSES: readonly IdentityStatus[] = ['unverified', 'pending', 'verified', 'revoked'];

const VERIFICATION_METHODS: readonly VerificationMethod[] = ['challenge_response', 'admin_attestation'];

function toIso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function toMillis(value: Date | string): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}

function toIdentityStatus(value: string): IdentityStatus {
  const status = IDENTITY_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new IdentityError('invalid_identity_input', `identity row carries unknown status '${value}'`);
  }
  return status;
}

function toVerificationMethod(value: string | null): VerificationMethod | null {
  if (value === null) return null;
  const method = VERIFICATION_METHODS.find((candidate) => candidate === value);
  return method === undefined ? null : method;
}

function mapIdentity(row: IdentityRow): ExternalIdentity {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    provider: assertChannelProvider(row.provider),
    providerAccountId: row.provider_account_id,
    displayName: row.display_name,
    subjectId: row.subject_id,
    subjectKind: row.subject_kind === null ? null : 'person',
    linkedAt: row.linked_at === null ? null : toIso(row.linked_at),
    status: toIdentityStatus(row.status),
    verificationMethod: toVerificationMethod(row.verification_method),
    verifiedAt: row.verified_at === null ? null : toIso(row.verified_at),
    verifiedBy: row.verified_by,
    verificationEvidence: row.verification_evidence,
    revokedAt: row.revoked_at === null ? null : toIso(row.revoked_at),
    revokedReason: row.revoked_reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function normalizeProviderAccountId(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') {
    throw new IdentityError('invalid_identity_input', 'providerAccountId must be a non-empty string');
  }
  return trimmed;
}

async function loadIdentityRow(ctx: TenantContext, identityId: string): Promise<IdentityRow> {
  const result = await getDb().query<IdentityRow>(
    `SELECT * FROM identities WHERE tenant_id = $1 AND id = $2`,
    [ctx.tenantId, identityId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Cross-tenant access is indistinguishable from a missing record (no existence leak).
    throw new IdentityError('identity_not_found', `identity '${identityId}' does not exist in this tenant`);
  }
  return row;
}

/** Get-or-create an ExternalIdentity for a (provider, account) pair within the tenant. */
export async function registerExternalIdentity(
  ctx: TenantContext,
  input: RegisterExternalIdentityInput,
): Promise<RegisterExternalIdentityResult> {
  assertTenantContext(ctx);
  const provider = assertChannelProvider(input.provider);
  const providerAccountId = normalizeProviderAccountId(input.providerAccountId);
  const displayName = input.displayName?.trim() || null;
  const at = now();
  const db = getDb();

  // ON CONFLICT DO NOTHING collapses duplicate registrations (inbound channel
  // traffic re-registering the same account) onto the existing row.
  const inserted = await db.query<IdentityRow>(
    `INSERT INTO identities (tenant_id, provider, provider_account_id, display_name, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (tenant_id, provider, provider_account_id) DO NOTHING
       RETURNING *`,
    [ctx.tenantId, provider, providerAccountId, displayName, at],
  );
  const row = inserted.rows[0];
  if (row !== undefined) {
    return { identity: mapIdentity(row), created: true };
  }
  const existing = await findExternalIdentityByProviderKey(ctx, { provider, providerAccountId });
  if (existing === null) {
    // Unreachable barring a delete path (none exists today); stay loud rather than wrong.
    throw new IdentityError('identity_not_found', 'identity disappeared after a duplicate-registration conflict');
  }
  return { identity: existing, created: false };
}

export async function getExternalIdentity(
  ctx: TenantContext,
  identityId: string,
): Promise<ExternalIdentity> {
  assertTenantContext(ctx);
  return mapIdentity(await loadIdentityRow(ctx, identityId));
}

export async function findExternalIdentityByProviderKey(
  ctx: TenantContext,
  input: FindByProviderKeyInput,
): Promise<ExternalIdentity | null> {
  assertTenantContext(ctx);
  const provider = assertChannelProvider(input.provider);
  const providerAccountId = normalizeProviderAccountId(input.providerAccountId);
  const result = await getDb().query<IdentityRow>(
    `SELECT * FROM identities WHERE tenant_id = $1 AND provider = $2 AND provider_account_id = $3`,
    [ctx.tenantId, provider, providerAccountId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapIdentity(row);
}

export async function listSubjectIdentities(
  ctx: TenantContext,
  subjectId: string,
): Promise<ExternalIdentity[]> {
  assertTenantContext(ctx);
  const result = await getDb().query<IdentityRow>(
    `SELECT * FROM identities WHERE tenant_id = $1 AND subject_id = $2 ORDER BY created_at, id`,
    [ctx.tenantId, subjectId],
  );
  return result.rows.map((row) => mapIdentity(row));
}

export async function issueVerificationChallenge(
  ctx: TenantContext,
  input: IssueChallengeInput,
): Promise<IssuedChallenge> {
  assertTenantContext(ctx);
  const row = await loadIdentityRow(ctx, input.identityId);
  if (row.status === 'verified') {
    throw new IdentityError('identity_already_verified', 'identity is already verified');
  }
  if (row.status === 'revoked') {
    throw new IdentityError(
      'identity_revoked',
      'verification was revoked; an explicit admin attestation is required to re-verify',
    );
  }
  const ttlSeconds = input.ttlSeconds ?? DEFAULT_CHALLENGE_TTL_SECONDS;
  if (
    typeof ttlSeconds !== 'number' ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < CHALLENGE_TTL_MIN_SECONDS ||
    ttlSeconds > CHALLENGE_TTL_MAX_SECONDS
  ) {
    throw new IdentityError(
      'invalid_challenge_ttl',
      `ttlSeconds must be an integer between ${CHALLENGE_TTL_MIN_SECONDS} and ${CHALLENGE_TTL_MAX_SECONDS}`,
    );
  }

  const code = generateChallengeCode();
  const codeHash = hashChallengeCode(ctx.tenantId, row.id, code);
  const at = now();
  const expiresAt = new Date(at.getTime() + ttlSeconds * 1_000);
  const db = getDb();

  const challengeId = await db.transaction(async (tx) => {
    // Any newer challenge invalidates all older outstanding ones.
    await tx.query(
      `UPDATE identity_challenges SET superseded_at = $1
         WHERE tenant_id = $2 AND identity_id = $3
           AND consumed_at IS NULL AND superseded_at IS NULL`,
      [at, ctx.tenantId, row.id],
    );
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO identity_challenges (tenant_id, identity_id, code_hash, issued_at, expires_at, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ctx.tenantId, row.id, codeHash, at, expiresAt, CHALLENGE_MAX_ATTEMPTS],
    );
    await tx.query(
      `UPDATE identities SET status = 'pending', updated_at = $1 WHERE tenant_id = $2 AND id = $3`,
      [at, ctx.tenantId, row.id],
    );
    return inserted.rows[0]!.id;
  });

  return { identityId: row.id, challengeId, code, expiresAt: expiresAt.toISOString() };
}

export async function completeVerificationChallenge(
  ctx: TenantContext,
  input: CompleteChallengeInput,
): Promise<ExternalIdentity> {
  assertTenantContext(ctx);
  const row = await loadIdentityRow(ctx, input.identityId);
  if (row.status === 'verified') {
    throw new IdentityError('identity_already_verified', 'identity is already verified');
  }
  if (row.status === 'revoked') {
    throw new IdentityError('identity_revoked', 'verification was revoked; re-verify via admin attestation');
  }
  if (row.status !== 'pending') {
    throw new IdentityError('challenge_not_active', 'no verification challenge has been issued for this identity');
  }
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (code === '') {
    throw new IdentityError('invalid_identity_input', 'code must be a non-empty string');
  }

  const at = now();
  const db = getDb();

  const active = await db.query<ChallengeRow>(
    `SELECT * FROM identity_challenges
       WHERE tenant_id = $1 AND identity_id = $2
         AND consumed_at IS NULL AND superseded_at IS NULL
       ORDER BY issued_at DESC LIMIT 1`,
    [ctx.tenantId, row.id],
  );
  const challenge = active.rows[0];
  if (challenge === undefined) {
    throw new IdentityError('challenge_not_active', 'no active verification challenge for this identity');
  }
  if (toMillis(challenge.expires_at) <= at.getTime()) {
    throw new IdentityError('challenge_expired', 'the verification challenge has expired; issue a new one');
  }

  // Claim one attempt in a committed statement so failed attempts survive the
  // mismatch error (an attacker must not get free retries by crashing the flow).
  const claim = await db.query<{ attempts: number }>(
    `UPDATE identity_challenges SET attempts = attempts + 1
       WHERE tenant_id = $1 AND id = $2 AND attempts < max_attempts
       RETURNING attempts`,
    [ctx.tenantId, challenge.id],
  );
  if (claim.rows[0] === undefined) {
    await db.query(
      `UPDATE identity_challenges SET superseded_at = $1
         WHERE tenant_id = $2 AND id = $3 AND superseded_at IS NULL`,
      [at, ctx.tenantId, challenge.id],
    );
    throw new IdentityError(
      'challenge_attempts_exhausted',
      'too many incorrect attempts; issue a new verification challenge',
    );
  }
  if (!challengeCodeMatches(challenge.code_hash, ctx.tenantId, row.id, code)) {
    throw new IdentityError('challenge_code_mismatch', 'incorrect verification code');
  }

  return db.transaction(async (tx) => {
    const consumed = await tx.query(
      `UPDATE identity_challenges SET consumed_at = $1
         WHERE tenant_id = $2 AND id = $3 AND consumed_at IS NULL`,
      [at, ctx.tenantId, challenge.id],
    );
    if ((consumed.rowCount ?? 0) === 0) {
      // Concurrent completion won the race — the identity is already verified.
      const current = await tx.query<IdentityRow>(
        `SELECT * FROM identities WHERE tenant_id = $1 AND id = $2`,
        [ctx.tenantId, row.id],
      );
      return mapIdentity(current.rows[0]!);
    }
    const verified = await tx.query<IdentityRow>(
      `UPDATE identities
         SET status = 'verified', verification_method = 'challenge_response',
             verified_at = $1, verified_by = $2, updated_at = $1
         WHERE tenant_id = $3 AND id = $4
         RETURNING *`,
      [at, ctx.principalId, ctx.tenantId, row.id],
    );
    return mapIdentity(verified.rows[0]!);
  });
}

export async function attestIdentity(
  ctx: TenantContext,
  input: AttestIdentityInput,
): Promise<ExternalIdentity> {
  requireAuthority(ctx, IDENTITY_AUTHORITY_ATTEST);
  const row = await loadIdentityRow(ctx, input.identityId);
  if (row.status === 'verified') {
    throw new IdentityError('identity_already_verified', 'identity is already verified');
  }
  const evidence = typeof input.evidence === 'string' ? input.evidence.trim() : '';
  if (evidence === '') {
    throw new IdentityError('invalid_identity_input', 'attestation requires non-empty evidence');
  }
  const at = now();
  const result = await getDb().query<IdentityRow>(
    `UPDATE identities
       SET status = 'verified', verification_method = 'admin_attestation',
           verified_at = $1, verified_by = $2, verification_evidence = $3,
           revoked_at = NULL, revoked_reason = NULL, updated_at = $1
       WHERE tenant_id = $4 AND id = $5
       RETURNING *`,
    [at, ctx.principalId, evidence, ctx.tenantId, row.id],
  );
  return mapIdentity(result.rows[0]!);
}

export async function revokeVerification(
  ctx: TenantContext,
  input: RevokeVerificationInput,
): Promise<ExternalIdentity> {
  requireAuthority(ctx, IDENTITY_AUTHORITY_ATTEST);
  const row = await loadIdentityRow(ctx, input.identityId);
  if (row.status !== 'verified') {
    throw new IdentityError('identity_not_verified', 'only verified identities can be revoked');
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '') {
    throw new IdentityError('invalid_identity_input', 'revocation requires a non-empty reason');
  }
  const at = now();
  // Revocation voids the verification AND detaches the subject: the trust
  // basis for the link is gone, so the identity must stop resolving.
  const result = await getDb().query<IdentityRow>(
    `UPDATE identities
       SET status = 'revoked',
           verification_method = NULL, verified_at = NULL, verified_by = NULL, verification_evidence = NULL,
           revoked_at = $1, revoked_reason = $2,
           subject_id = NULL, subject_kind = NULL, linked_at = NULL,
           updated_at = $1
       WHERE tenant_id = $3 AND id = $4
       RETURNING *`,
    [at, reason, ctx.tenantId, row.id],
  );
  return mapIdentity(result.rows[0]!);
}

export async function attachVerifiedSubject(
  ctx: TenantContext,
  input: AttachSubjectInput,
): Promise<ExternalIdentity> {
  requireAuthority(ctx, IDENTITY_AUTHORITY_LINK);
  const row = await loadIdentityRow(ctx, input.identityId);
  if (row.status !== 'verified') {
    throw new IdentityError(
      'identity_not_verified',
      'only verified identities can be linked to a subject (lock 15: no pseudo-employees)',
    );
  }
  const subjectKind: SubjectKind = input.subjectKind ?? 'person';
  if (subjectKind !== 'person') {
    throw new IdentityError('invalid_subject', "subjectKind must be 'person' (W002)");
  }
  const subjectId = typeof input.subjectId === 'string' ? input.subjectId.trim() : '';
  if (!UUID_PATTERN.test(subjectId)) {
    throw new IdentityError('invalid_subject', 'subjectId must be a uuid');
  }
  if (row.subject_id === subjectId) {
    return mapIdentity(row); // idempotent re-attach to the same subject
  }
  if (row.subject_id !== null) {
    throw new IdentityError(
      'identity_already_linked',
      'identity is already linked to another subject; detach it first',
    );
  }
  const at = now();
  const result = await getDb().query<IdentityRow>(
    `UPDATE identities
       SET subject_id = $1, subject_kind = $2, linked_at = $3, updated_at = $3
       WHERE tenant_id = $4 AND id = $5
       RETURNING *`,
    [subjectId, subjectKind, at, ctx.tenantId, row.id],
  );
  return mapIdentity(result.rows[0]!);
}

export async function detachSubject(
  ctx: TenantContext,
  input: DetachSubjectInput,
): Promise<ExternalIdentity> {
  requireAuthority(ctx, IDENTITY_AUTHORITY_LINK);
  const row = await loadIdentityRow(ctx, input.identityId);
  if (row.subject_id === null) {
    throw new IdentityError('identity_not_linked', 'identity is not linked to a subject');
  }
  const at = now();
  const result = await getDb().query<IdentityRow>(
    `UPDATE identities
       SET subject_id = NULL, subject_kind = NULL, linked_at = NULL, updated_at = $1
       WHERE tenant_id = $2 AND id = $3
       RETURNING *`,
    [at, ctx.tenantId, row.id],
  );
  return mapIdentity(result.rows[0]!);
}
