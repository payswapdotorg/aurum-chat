// Input validation of the company-query module (W126). Same discipline as
// every module: the service layer only ever sees Validated* shapes, guards
// are total over the vocabularies, and every rejection is a typed
// CompanyQueryError (errors.ts) — never a thrown string.

import { COMPANY_SURFACES, type CompanySurface } from './types';
import { CompanyQueryError } from './errors';

/** The longest question the plane accepts (matches the chat surface's discipline). */
export const MAX_QUESTION_LENGTH = 2000;
/** The default/maximum number of surfaces a query may scope to (all of them). */
export const MAX_SURFACES = COMPANY_SURFACES.length;

export function isCompanySurface(value: unknown): value is CompanySurface {
  return typeof value === 'string' && (COMPANY_SURFACES as readonly string[]).includes(value);
}

/** The validated query input — the only shape the service layer accepts. */
export interface ValidatedCompanyQueryInput {
  question: string;
  surfaces: CompanySurface[];
}

export function validateCompanyQueryInput(input: unknown): ValidatedCompanyQueryInput {
  if (typeof input !== 'object' || input === null) {
    throw new CompanyQueryError('invalid_query', 'the query input must be an object');
  }
  const candidate = input as { question?: unknown; surfaces?: unknown };
  if (typeof candidate.question !== 'string') {
    throw new CompanyQueryError('invalid_query', 'the question must be a string');
  }
  const question = candidate.question.trim();
  if (question === '') {
    throw new CompanyQueryError('invalid_query', 'the question must not be empty');
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new CompanyQueryError(
      'invalid_query',
      `the question must not exceed ${MAX_QUESTION_LENGTH} characters`,
    );
  }

  let surfaces: CompanySurface[] = [...COMPANY_SURFACES];
  if (candidate.surfaces !== undefined) {
    if (
      !Array.isArray(candidate.surfaces) ||
      candidate.surfaces.length === 0 ||
      candidate.surfaces.length > MAX_SURFACES
    ) {
      throw new CompanyQueryError(
        'invalid_query',
        `the surfaces filter must be a non-empty array of at most ${MAX_SURFACES} surfaces`,
      );
    }
    const seen = new Set<string>();
    for (const surface of candidate.surfaces) {
      if (!isCompanySurface(surface)) {
        throw new CompanyQueryError('invalid_query', `unknown company surface '${String(surface)}'`);
      }
      if (seen.has(surface)) {
        throw new CompanyQueryError('invalid_query', `duplicate company surface '${surface}'`);
      }
      seen.add(surface);
    }
    // Preserve the canonical vocabulary order (stable, provider-neutral).
    surfaces = COMPANY_SURFACES.filter((surface) => seen.has(surface));
  }

  return { question, surfaces };
}

/** Validate the explicit TenantContext (step 1 of the pipeline). */
export function assertCompanyQueryTenantContext(context: {
  tenantId: string;
  principalId: string;
  authority: string[];
}): void {
  if (
    typeof context.tenantId !== 'string' ||
    context.tenantId === '' ||
    typeof context.principalId !== 'string' ||
    context.principalId === '' ||
    !Array.isArray(context.authority)
  ) {
    throw new CompanyQueryError(
      'invalid_context',
      'the company query plane requires an explicit tenant context (tenantId, principalId, authority)',
    );
  }
}
