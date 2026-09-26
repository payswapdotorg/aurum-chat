// W100 — the S003 harness's deterministic provider doubles.
//
// The "provider side" behind the composed seams: the scripted directory
// transport (what an authorized discovery source's poll delivers), the
// scripted broker backend (the fake managed-broker server speaking the
// embedded broker's wire dialect), the all-reachable verification probe,
// the scripted incumbent store (the deep-action gateway's exit seam: a
// canonical entity store that applies writes, returns OPAQUE receipt ids
// and can be seeded to skip applying — the divergence the reconciliation
// must surface), the accepting channel/cellular transports and the
// migration verification transport.
//
// NOTHING here mocks domain logic — the module services under test are
// the REAL ones; only the external provider world is scripted (the
// fixtures/doubles doctrine; the W096 executor precedent). No live
// network, no real incumbent, no real browser.

import type * as brokerContract from '@/modules/connection-broker/contract';
import type * as deepActionsContract from '@/modules/deep-actions/contract';
import type * as integrationContract from '@/modules/integration-intelligence/contract';
import type * as cellularContract from '@/modules/cellular/contract';
import type * as channelsContract from '@/modules/channels/contract';
import type * as sourcesContract from '@/modules/sources/contract';

// ---------------------------------------------------------------------------
// The directory source's transport (what runDiscovery polls)
// ---------------------------------------------------------------------------

/**
 * Serves one scripted directory listing on every fetch — the sweep
 * pattern (every authorized poll sees the full incumbent stack).
 */
export class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  readonly fetches: sourcesContract.SourceFetchRequest[] = [];
  private records: sourcesContract.CanonicalSourceRecord[] = [];

  scriptListing(records: sourcesContract.CanonicalSourceRecord[]): void {
    this.records = records;
  }

  async fetch(
    request: sourcesContract.SourceFetchRequest,
  ): Promise<sourcesContract.SourceFetchResult> {
    this.fetches.push(request);
    return { records: [...this.records], nextCursor: null, hasMore: false };
  }
}

/** One canonical directory-system record for an incumbent stack entry. */
export function directoryRecord(
  externalId: string,
  displayName: string,
  capabilityClasses: readonly string[],
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${externalId}`,
    kind: 'directory.system.discovered',
    payload: { externalId, displayName, capabilityClasses: [...capabilityClasses] },
    occurredAt: '2026-09-29T10:00:00Z',
  };
}

// ---------------------------------------------------------------------------
// The embedded broker's HTTP backend (the fake managed-broker server)
// ---------------------------------------------------------------------------

/** The deterministic broker backend: authorize → callback → connected. */
export class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  private authorizations = new Map<string, string>();
  private counter = 0;

  constructor(private readonly nowProvider: () => Date) {}

  async request(
    request: brokerContract.BrokerHttpRequest,
  ): Promise<brokerContract.BrokerHttpResponse> {
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.s003.example/oauth/${state}`,
          state,
          expires_at: new Date(this.nowProvider().getTime() + 900_000).toISOString(),
        },
      };
    }
    const callback = /^\/v1\/authorizations\/([^/]+)\/callback$/.exec(request.path);
    if (request.method === 'POST' && callback !== null) {
      const connectionId = decodeURIComponent(callback[1]!);
      const body = request.body as { state?: string };
      if (this.authorizations.get(connectionId) !== body.state) {
        return { status: 401, body: { error: 'authorization session unknown or expired' } };
      }
      this.counter += 1;
      const embId = `emb-${this.counter.toString().padStart(3, '0')}`;
      return {
        status: 200,
        body: {
          broker_connection_id: embId,
          provider_account_id: `eacct-${embId}`,
          credential_ref: `embedded-connection:${embId}`,
          scopes: ['read'],
          expires_at: new Date(this.nowProvider().getTime() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

// ---------------------------------------------------------------------------
// The integration verification probe (provider-neutral capability probes)
// ---------------------------------------------------------------------------

/** Every promised read capability verifies reachable. */
export class AllReachableVerificationTransport implements integrationContract.VerificationTransport {
  readonly probes: integrationContract.CapabilityProbeRequest[] = [];

  async probe(
    request: integrationContract.CapabilityProbeRequest,
  ): Promise<integrationContract.CapabilityProbeResult> {
    this.probes.push(request);
    return { reachable: true, detail: 'scripted probe: reachable' };
  }
}

// ---------------------------------------------------------------------------
// The incumbent entity store behind the deep-action gateway
// ---------------------------------------------------------------------------

/**
 * The scripted incumbent world behind the DeepActionTransport port: a
 * canonical entity store keyed by (connectionId, target) that applies
 * writes and returns OPAQUE receipt ids. `skipApplyTargets` names the
 * targets whose writes are ACKNOWLEDGED but not applied — the downstream
 * divergence the W084 reconciliation must surface as a mismatch (never a
 * silent success).
 */
export class ScriptedIncumbentStore implements deepActionsContract.DeepActionTransport {
  readonly inspectRequests: deepActionsContract.DeepActionInspectRequest[] = [];
  readonly executeRequests: deepActionsContract.DeepActionExecuteRequest[] = [];
  private states = new Map<string, unknown>();
  private receiptCounter = 0;
  private readonly skipApply: Set<string>;

  constructor(skipApplyTargets: readonly string[] = []) {
    this.skipApply = new Set(skipApplyTargets);
  }

  private key(connectionId: string, target: string): string {
    return `${connectionId}:${target}`;
  }

  seed(connectionId: string, target: string, state: unknown): void {
    this.states.set(this.key(connectionId, target), state);
  }

  stateOf(connectionId: string, target: string): unknown {
    return this.states.get(this.key(connectionId, target));
  }

  async inspect(
    request: deepActionsContract.DeepActionInspectRequest,
  ): Promise<deepActionsContract.DeepActionState> {
    this.inspectRequests.push(request);
    const state = this.states.get(this.key(request.connectionId, request.target));
    return { found: state !== undefined, state: state ?? null };
  }

  async execute(
    request: deepActionsContract.DeepActionExecuteRequest,
  ): Promise<deepActionsContract.DeepActionReceipt> {
    this.executeRequests.push(request);
    this.receiptCounter += 1;
    const receiptId = `rcpt-${this.receiptCounter.toString().padStart(4, '0')}`;
    if (!this.skipApply.has(request.target)) {
      const current = this.states.get(this.key(request.connectionId, request.target));
      const base =
        typeof current === 'object' && current !== null && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      this.states.set(this.key(request.connectionId, request.target), {
        ...base,
        ...(request.payload as Record<string, unknown>),
      });
    }
    return { status: 'accepted', receiptId, detail: null };
  }
}

// ---------------------------------------------------------------------------
// The migration verification transport (inspect-only; the canary discipline)
// ---------------------------------------------------------------------------

/**
 * The W084/W088-composed verification read for the migration's commit:
 * answers each staged record's re-read from the fixture incumbent's
 * payloads. Its EXECUTE side throws — the migration module must never
 * write back to the incumbent through this path (the canary discipline).
 */
export class MigrationVerificationTransport implements deepActionsContract.DeepActionTransport {
  readonly inspectRequests: deepActionsContract.DeepActionInspectRequest[] = [];
  private states = new Map<string, unknown>();

  seedByExternalId(externalId: string, state: unknown): void {
    this.states.set(externalId, state);
  }

  async inspect(
    request: deepActionsContract.DeepActionInspectRequest,
  ): Promise<deepActionsContract.DeepActionState> {
    this.inspectRequests.push(request);
    const state = this.states.get(request.target);
    return { found: state !== undefined, state: state ?? null };
  }

  async execute(): Promise<deepActionsContract.DeepActionReceipt> {
    throw new Error(
      'CANARY: the migration verification transport must never execute a write',
    );
  }
}

// ---------------------------------------------------------------------------
// The channel + cellular provider transports
// ---------------------------------------------------------------------------

/** Accepts every canonical delivery (the provider side of sendOutbound). */
export class AcceptingChannelTransport implements channelsContract.ChannelTransport {
  readonly deliveries: channelsContract.CanonicalDeliveryRequest[] = [];
  private counter = 0;

  async deliver(
    request: channelsContract.CanonicalDeliveryRequest,
  ): Promise<channelsContract.TransportReceipt> {
    this.deliveries.push(request);
    this.counter += 1;
    return {
      status: 'delivered',
      providerMessageId: `s003-email-${this.counter.toString().padStart(4, '0')}`,
      detail: null,
    };
  }
}

/** Accepts every SMS; never places voice calls in the harness. */
export class AcceptingCellularTransport implements cellularContract.CellularTransport {
  readonly provider: cellularContract.CellularProvider = 'twilio';
  readonly smsRequests: cellularContract.CellularSmsRequest[] = [];

  async sendSms(
    request: cellularContract.CellularSmsRequest,
  ): Promise<cellularContract.CellularSmsReceipt> {
    this.smsRequests.push(request);
    return { status: 'accepted', providerMessageId: `s003-sms-${this.smsRequests.length}`, detail: null };
  }

  async placeVoiceCall(
    _request: cellularContract.CellularVoiceRequest,
  ): Promise<cellularContract.CellularVoiceReceipt> {
    return { status: 'no_answer', providerCallId: null, detail: 'harness: voice not placed' };
  }
}
