// The W084 composition (W088 — result normalization): a DeepActionTransport
// implementation whose inspect/execute requests become SIGNED, tenant-
// scoped EDGE JOBS, executed customer-side, whose canonical results map
// back into the deep-action pipeline's exact shapes.
//
// The deep-action discover→inspect→propose→authorize→execute→verify→
// reconcile pipeline stays THE reconciliation model (the work order: "do
// not fork a second reconciliation model"): this transport is the exit
// seam's edge-flavored implementation — the W082 broker connection's
// opaque credentialRef passes straight through to the envelope (the edge
// resolves secret material locally); the W083 gate is consulted by the
// pipeline itself before any write reaches this seam; and the receipts
// this transport returns use the deep-actions taxonomy VERBATIM
// ('accepted' / 'rejected' permanent refusal / 'failed' transient — the
// pipeline's retry discipline stays intact).
//
// OUTBOUND-ONLY POSTURE: the transport NEVER opens a connection toward
// the edge. It issues the job and awaits the edge's own dial-home loop
// through the injected `drive` hook — production wiring waits for the
// edge's polling cycle to complete the job; test wiring drives the
// deterministic simulator's dial-home cycle. Idempotency keys ride the
// pipeline's stable per-operation keys, so a retried phase replays the
// ORIGINAL edge job (never a second execution).

import type { TenantContext } from '@/infra/tenant';
import type {
  DeepActionExecuteRequest,
  DeepActionInspectRequest,
  DeepActionReceipt,
  DeepActionState,
  DeepActionTransport,
} from '@/modules/deep-actions/contract';
import { EdgeConnectorError } from './errors';
import { getEdgeJob, issueEdgeJob } from './service';
import type { EdgeJob, EdgeJobDriver, IssueEdgeJobInput } from './types';

export interface CreateEdgeDeepActionTransportOptions {
  /** The edge runtime that serves this transport's jobs. */
  edgeId: string;
  /**
   * How the edge's dial-home loop is advanced while a transport call
   * waits (production: await the edge's own polling cycle; tests: drive
   * the deterministic simulator). Never an outbound connection.
   */
  drive: EdgeJobDriver;
  /** Edge-job envelope lifetime in seconds (default 300). */
  ttlSeconds?: number;
}

/** Map a completed edge job to the canonical deep-action READ result. */
function toDeepActionState(job: EdgeJob): DeepActionState {
  const state = job.resultState ?? { found: false, state: null };
  return { found: state.found, state: state.state ?? null };
}

/** Map a completed edge job to the canonical deep-action RECEIPT. */
function toDeepActionReceipt(job: EdgeJob): DeepActionReceipt {
  return {
    status: job.receiptStatus ?? 'failed',
    receiptId: job.receiptId,
    detail:
      job.receiptDetail ??
      `edge job '${job.id}' ended '${job.state}' without a receipt — the edge boundary must always report one`,
  };
}

async function settleJob(
  ctx: TenantContext,
  jobId: string,
  drive: EdgeJobDriver,
): Promise<EdgeJob> {
  let job = await getEdgeJob(ctx, { jobId });
  const terminal = job.state === 'succeeded' || job.state === 'rejected' || job.state === 'failed';
  if (!terminal) {
    await drive({ jobId });
    job = await getEdgeJob(ctx, { jobId });
  }
  switch (job.state) {
    case 'succeeded':
    case 'rejected':
    case 'failed':
      return job;
    case 'expired':
      // An expired envelope is a TRANSIENT outcome from the pipeline's
      // perspective: the edge never took the job; a retry re-issues.
      throw new EdgeConnectorError(
        'edge_job_failed',
        `edge job '${job.id}' expired before the edge executed it`,
      );
    default:
      throw new EdgeConnectorError(
        'edge_job_incomplete',
        `edge job '${job.id}' is still '${job.state}' after the driver ran — the driver must advance the edge's dial-home loop to completion`,
      );
  }
}

async function issueAndSettle(
  ctx: TenantContext,
  input: IssueEdgeJobInput,
  drive: EdgeJobDriver,
): Promise<EdgeJob> {
  const issued = await issueEdgeJob(ctx, input);
  return settleJob(ctx, issued.job.id, drive);
}

/**
 * Builds a DeepActionTransport (the W084 port) whose reads and writes
 * execute on the customer-controlled edge. The returned object is wired
 * via the deep-actions module's `setDeepActionTransport` — the pipeline
 * then executes against private/on-prem systems exactly as against any
 * connected SaaS system, with evidence, verification and reconciliation
 * unchanged.
 */
export function createEdgeDeepActionTransport(
  ctx: TenantContext,
  options: CreateEdgeDeepActionTransportOptions,
): DeepActionTransport {
  const ttlSeconds = options.ttlSeconds ?? 300;
  return {
    async inspect(request: DeepActionInspectRequest): Promise<DeepActionState> {
      const job = await issueAndSettle(
        ctx,
        {
          edgeId: options.edgeId,
          kind: 'inspect',
          capabilityKey: request.capabilityKey,
          target: request.target,
          payload: null,
          credentialRef: request.credentialRef,
          systemKey: request.systemKey,
          idempotencyKey: request.idempotencyKey,
          ttlSeconds,
        },
        options.drive,
      );
      if (job.state === 'rejected' || job.state === 'failed') {
        // The pipeline treats an inspect-phase failure as an explicit,
        // honest error (never a fake read).
        throw new EdgeConnectorError(
          job.state === 'rejected' ? 'edge_job_rejected' : 'edge_job_failed',
          job.receiptDetail ?? `edge job '${job.id}' inspect ended '${job.state}'`,
        );
      }
      return toDeepActionState(job);
    },
    async execute(request: DeepActionExecuteRequest): Promise<DeepActionReceipt> {
      const job = await issueAndSettle(
        ctx,
        {
          edgeId: options.edgeId,
          kind: 'execute',
          capabilityKey: request.capabilityKey,
          target: request.target,
          payload: (request.payload ?? {}) as Record<string, unknown>,
          credentialRef: request.credentialRef,
          systemKey: request.systemKey,
          idempotencyKey: request.idempotencyKey,
          ttlSeconds,
        },
        options.drive,
      );
      // 'rejected' (permanent) and 'failed' (transient, retryable) are
      // RECEIPTS, not errors — the deep-action resume discipline keeps
      // exactly its own semantics (only 'failed' stays resumable).
      return toDeepActionReceipt(job);
    },
  };
}
