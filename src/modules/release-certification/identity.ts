// W079 — the deployment identity assembly (contract §3: the ten fields
// every certification run must record). PURE adapters over the JSON the
// live target and the read-only Vercel deployment listing produce; the
// driver performs the I/O and passes the raw bodies here.

import type { DeploymentIdentity, G1HealthObservation } from './types';

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * The defensive health observation (G1's subject). Reads exactly the
 * fields the health contract documents (docs/DEPLOYMENT.md §7); anything
 * absent reads as null/[] and the G1 evaluator reports it.
 */
export function observeG1Health(httpStatus: number, body: unknown): G1HealthObservation {
  const root = asRecord(body);
  const environment = asRecord(root['environment']);
  const components = asRecord(root['components']);
  const db = asRecord(components['db']);
  const queue = asRecord(components['queue']);
  const cache = asRecord(components['cache']);
  const lock = asRecord(components['lock']);
  const email = asRecord(components['email']);
  const blob = asRecord(components['blob']);
  const readiness = asRecord(root['readiness']);
  const worker = asRecord(root['worker']);
  return {
    httpStatus,
    healthStatus: asString(root['status']),
    environment: asString(environment['environment']),
    hostedOnVercel: asBoolean(environment['hostedOnVercel']),
    dbBackend: asString(db['backend']),
    dbMigrations: asNumber(db['migrations']),
    dbError: asString(db['error']),
    queueBackend: asString(queue['backend']),
    cacheBackend: asString(cache['backend']),
    lockBackend: asString(lock['backend']),
    emailBackend: asString(email['backend']),
    blobBackend: asString(blob['backend']),
    refusals: asStringArray(asRecord(readiness)['refusals']),
    warnings: asStringArray(asRecord(readiness)['warnings']),
    workerMetrics: Object.keys(worker).length === 0 ? null : worker,
  };
}

/**
 * The deployment identity manifest (contract §3, all ten fields). The
 * `deployment` input is the read-only Vercel deployments listing entry
 * for the production target (never a secret); `git` is the repository
 * state the run interprets the result with.
 */
export function deploymentIdentity(input: {
  hostname: string;
  deploymentId: string;
  commitSha: string;
  deploymentCreatedAt: string;
  certificationStartedAt: string;
  health: G1HealthObservation;
  worker: { seamTokenGated: boolean | null; snapshotReachable: boolean | null; environment: string | null; queueDepth: number | null };
  command: string;
  git: { remote: string; branch: string; baseCommit: string; headCommit: string };
}): DeploymentIdentity {
  return {
    hostname: input.hostname,
    deploymentId: input.deploymentId,
    commitSha: input.commitSha,
    deploymentCreatedAt: input.deploymentCreatedAt,
    certificationStartedAt: input.certificationStartedAt,
    environmentLabel: input.health.environment,
    databaseBackendClass: input.health.dbBackend,
    workerRuntimeState: input.worker,
    command: input.command,
    repository: input.git,
  };
}

/**
 * The read-only Vercel deployment listing adapter: extracts the
 * identity fields of one deployment entry (uid, readyState, createdAt,
   * the git commit SHA the deployment was built from).
 */
export function deploymentFromListing(entry: unknown): {
  deploymentId: string | null;
  readyState: string | null;
  createdAt: string | null;
  commitSha: string | null;
} {
  const record = asRecord(entry);
  const meta = asRecord(record['meta']);
  return {
    deploymentId: asString(record['uid']),
    readyState: asString(record['readyState']),
    createdAt:
      asNumber(record['createdAt']) === null
        ? null
        : new Date(asNumber(record['createdAt']) as number).toISOString(),
    commitSha: asString(meta['githubCommitSha']),
  };
}

/**
 * The deployment-identity gate (contract §3: the certification report
 * must fail if the target is not the expected production deployment).
 * The expected identity is operator-declared; the run refuses to certify
 * a target whose observed deployment does not match it.
 */
export function identityVerificationReasons(expected: {
  deploymentId: string;
  commitSha: string;
  createdAt: string;
}, observed: {
  deploymentId: string | null;
  readyState: string | null;
  createdAt: string | null;
  commitSha: string | null;
}): string[] {
  const reasons: string[] = [];
  if (observed.deploymentId !== expected.deploymentId) {
    reasons.push(
      `the live production deployment is '${observed.deploymentId}' (expected '${expected.deploymentId}')`,
    );
  }
  if (observed.readyState !== 'READY') {
    reasons.push(`the live production deployment state is '${observed.readyState}' (expected READY)`);
  }
  if (observed.commitSha !== expected.commitSha) {
    reasons.push(
      `the live production deployment was built from '${observed.commitSha}' (expected '${expected.commitSha}')`,
    );
  }
  if (observed.createdAt === null || !observed.createdAt.startsWith(expected.createdAt.slice(0, 10))) {
    reasons.push(
      `the live production deployment was created at '${observed.createdAt}' (expected the ${expected.createdAt.slice(0, 10)} deployment)`,
    );
  }
  return reasons;
}
