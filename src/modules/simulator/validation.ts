// Pure validation and derivation helpers of the simulator module (W056) —
// no database, no clock; the repo's validation.ts convention (reject
// unknown keys, bound every string, type every field).

import { SimulatorError } from './errors';
import type { RevealGroundTruthQuery } from './types';
import { TOTAL_MONTHS } from './world';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new SimulatorError('invalid_input', `${label} rejects unknown key '${key}'`);
    }
  }
}

/** The repo-wide TenantContext discipline (the attention precedent). */
export function assertSimulatorTenantContext(ctx: unknown): void {
  if (!isPlainObject(ctx)) {
    throw new SimulatorError('invalid_context', 'TenantContext must be an object');
  }
  const context = ctx as Record<string, unknown>;
  if (typeof context.tenantId !== 'string' || context.tenantId.trim() === '') {
    throw new SimulatorError('invalid_context', 'TenantContext.tenantId must be a non-empty string');
  }
  if (typeof context.principalId !== 'string' || context.principalId.trim() === '') {
    throw new SimulatorError('invalid_context', 'TenantContext.principalId must be a non-empty string');
  }
  if (!Array.isArray(context.authority)) {
    throw new SimulatorError('invalid_context', 'TenantContext.authority must be an array');
  }
}

export interface ValidatedMaterializeInput {
  seed: number;
  name: string | null;
  startMonth: number;
}

export function validateMaterializeInput(input: unknown): ValidatedMaterializeInput {
  if (!isPlainObject(input)) {
    throw new SimulatorError('invalid_input', 'materializeCompany input must be an object');
  }
  rejectUnknownKeys(input, ['seed', 'name', 'startMonth'], 'materializeCompany input');
  const seed = input.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > 0x7fff_ffff) {
    throw new SimulatorError('invalid_input', 'seed must be an integer in [0, 2147483647]');
  }
  let name: string | null = null;
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string' || input.name.trim().length < 1) {
      throw new SimulatorError('invalid_input', 'name must be a non-empty string when present');
    }
    if (input.name.trim().length > MAX_NAME_LENGTH) {
      throw new SimulatorError('invalid_input', `name must be at most ${MAX_NAME_LENGTH} characters`);
    }
    name = input.name.trim();
  }
  let startMonth = 1;
  if (input.startMonth !== undefined && input.startMonth !== null) {
    if (
      typeof input.startMonth !== 'number' ||
      !Number.isInteger(input.startMonth) ||
      input.startMonth < 1 ||
      input.startMonth > TOTAL_MONTHS
    ) {
      throw new SimulatorError(
        'invalid_input',
        `startMonth must be an integer in [1, ${TOTAL_MONTHS}] when present`,
      );
    }
    startMonth = input.startMonth;
  }
  return { seed, name, startMonth };
}

export interface ValidatedAdvanceInput {
  companyId: string;
  learning: boolean;
  judgments: boolean;
  snapshot: boolean;
}

export function validateAdvanceInput(input: unknown): ValidatedAdvanceInput {
  if (!isPlainObject(input)) {
    throw new SimulatorError('invalid_input', 'advanceMonth input must be an object');
  }
  rejectUnknownKeys(input, ['companyId', 'learning', 'judgments', 'snapshot'], 'advanceMonth input');
  if (typeof input.companyId !== 'string' || !UUID_PATTERN.test(input.companyId)) {
    throw new SimulatorError('invalid_input', 'companyId must be a uuid');
  }
  if (typeof input.learning !== 'boolean') {
    throw new SimulatorError('invalid_input', 'learning must be a boolean');
  }
  if (
    input.judgments !== undefined &&
    input.judgments !== null &&
    typeof input.judgments !== 'boolean'
  ) {
    throw new SimulatorError('invalid_input', 'judgments must be a boolean when present');
  }
  if (
    input.snapshot !== undefined &&
    input.snapshot !== null &&
    typeof input.snapshot !== 'boolean'
  ) {
    throw new SimulatorError('invalid_input', 'snapshot must be a boolean when present');
  }
  return {
    companyId: input.companyId,
    learning: input.learning,
    judgments: input.judgments === undefined || input.judgments === null ? true : input.judgments,
    snapshot: input.snapshot === undefined || input.snapshot === null ? true : input.snapshot,
  };
}

export function validateCompanyQuery(input: unknown): { companyId: string } {
  if (!isPlainObject(input)) {
    throw new SimulatorError('invalid_input', 'company query must be an object');
  }
  rejectUnknownKeys(input, ['companyId'], 'company query');
  if (typeof input.companyId !== 'string' || !UUID_PATTERN.test(input.companyId)) {
    throw new SimulatorError('invalid_input', 'companyId must be a uuid');
  }
  return { companyId: input.companyId };
}

export function validateRevealQuery(input: unknown): RevealGroundTruthQuery {
  if (!isPlainObject(input)) {
    throw new SimulatorError('invalid_input', 'reveal query must be an object');
  }
  rejectUnknownKeys(input, ['companyId', 'month'], 'reveal query');
  if (typeof input.companyId !== 'string' || !UUID_PATTERN.test(input.companyId)) {
    throw new SimulatorError('invalid_input', 'companyId must be a uuid');
  }
  if (
    typeof input.month !== 'number' ||
    !Number.isInteger(input.month) ||
    input.month < 1 ||
    input.month > TOTAL_MONTHS
  ) {
    throw new SimulatorError('invalid_input', `month must be an integer in [1, ${TOTAL_MONTHS}]`);
  }
  return { companyId: input.companyId, month: input.month };
}

/** Rounds to 4 decimals — the score granularity of the CompanyModel. */
export function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
