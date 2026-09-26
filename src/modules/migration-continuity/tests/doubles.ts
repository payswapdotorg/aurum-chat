// The W094 test-side provider doubles (the W096 executor's local-double
// patterns, copied per the repository's fixtures/doubles doctrine: each
// suite defines its own provider-side fakes; nothing here is a mock of
// DOMAIN logic, and no live network is touched).
//
//   * ScriptedDirectoryTransport    — the discovery source's transport,
//     serving scripted windows of canonical directory records (W036 /
//     W081 discovery);
//   * ScriptedBrokerBackend         — the fake managed-broker server
//     speaking the embedded broker's wire dialect (W082);
//   * ScriptedVerificationTransport — the provider-neutral capability
//     probe port, all-reachable by default (W081 verification);
//   * connectIncumbent()            — the FULL real chain the incumbent
//     enters through: registerSource > grantDiscoverySource >
//     runDiscovery > listRecommendations > submitRecommendationBatch >
//     decideRecommendationBatch (approve) > connectSystem >
//     initiateConnection > completeConnection > establishConnectionAccess
//     — exactly the W096 fixture chain, exercised against the real
//     module contracts.

import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import * as sourcesContract from '@/modules/sources/contract';
import * as integrationContract from '@/modules/integration-intelligence/contract';
import * as brokerContract from '@/modules/connection-broker/contract';
import * as grantsContract from '@/modules/capability-grants/contract';

/** A provider-neutral source transport that serves scripted windows. */
export class ScriptedDirectoryTransport implements sourcesContract.SourceTransport {
  readonly requests: unknown[] = [];
  private windows: sourcesContract.SourceFetchResult[] = [];

  script(...windows: sourcesContract.SourceFetchResult[]): void {
    this.windows.push(...windows);
  }

  async fetch(request: unknown): Promise<sourcesContract.SourceFetchResult> {
    this.requests.push(request);
    const next = this.windows.shift();
    if (next !== undefined) return next;
    return { records: [], nextCursor: null, hasMore: false };
  }
}

/** A fake managed-broker server (the embedded wire dialect). */
export class ScriptedBrokerBackend implements brokerContract.BrokerHttpClient {
  readonly requests: brokerContract.BrokerHttpRequest[] = [];
  private authorizations = new Map<string, string>();
  private counter = 0;

  async request(
    request: brokerContract.BrokerHttpRequest,
  ): Promise<brokerContract.BrokerHttpResponse> {
    this.requests.push(request);
    if (request.method === 'POST' && request.path === '/v1/authorizations') {
      const body = request.body as { connection_id?: string };
      this.counter += 1;
      const state = `st-${this.counter.toString().padStart(3, '0')}`;
      this.authorizations.set(body.connection_id ?? '', state);
      return {
        status: 201,
        body: {
          authorization_url: `https://broker.unit.example/oauth/${state}`,
          state,
          expires_at: new Date(Date.now() + 900_000).toISOString(),
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
          scopes: [],
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
      };
    }
    return { status: 404, body: { error: `no scripted route for ${request.method} ${request.path}` } };
  }
}

/** A verification transport with scripted per-capability reachability. */
export class ScriptedVerificationTransport implements integrationContract.VerificationTransport {
  readonly probes: string[] = [];
  private unreachable = new Set<string>();

  constructor(unreachableCapabilities: string[] = []) {
    this.unreachable = new Set(unreachableCapabilities);
  }

  async probe(request: {
    capabilityKey: string;
  }): Promise<{ reachable: boolean; detail: string | null }> {
    this.probes.push(request.capabilityKey);
    return this.unreachable.has(request.capabilityKey)
      ? { reachable: false, detail: 'the capability endpoint refused the read probe' }
      : { reachable: true, detail: null };
  }
}

/** One directory record served by the scripted discovery source. */
export interface DirectorySystemSpec {
  externalId: string;
  displayName: string;
  capabilityClasses: string[];
}

function directoryRecordOf(
  record: DirectorySystemSpec,
): sourcesContract.CanonicalSourceRecord {
  return {
    providerRecordId: `dir-${record.externalId}`,
    kind: integrationContract.DISCOVERY_RECORD_KIND,
    payload: {
      externalId: record.externalId,
      displayName: record.displayName,
      capabilityClasses: record.capabilityClasses,
    },
    occurredAt: '2026-10-01T10:00:00Z',
  };
}

/**
 * Runs the FULL real entry chain for the incumbent system and returns
 * the connected inventory system + the live broker connection — the
 * seams stageMigration validates against.
 */
export async function connectIncumbent(
  actors: {
    admin: TenantContext; // integration-intelligence:administer
    member: TenantContext; // the operating member
    approver: TenantContext; // actions:approve
  },
  incumbent: DirectorySystemSpec,
  options: { connectionKey: string; directory: ScriptedDirectoryTransport },
): Promise<{
  system: integrationContract.InventorySystem;
  connection: brokerContract.BrokerConnection;
}> {
  const { admin, member, approver } = actors;

  // W036: register the directory source, then W081: grant + discover.
  const registered = await sourcesContract.registerSource(admin, {
    provider: 'salesforce' as sourcesContract.SourceProvider,
    providerAccountId: `w094-${incumbent.externalId}`,
    displayName: `${incumbent.displayName} directory`,
    authKind: 'credentials',
    credentialRef: ['secret-store://', 'w094/', `${incumbent.externalId}/`, 'ref'].join(''),
  });
  await integrationContract.grantDiscoverySource(admin, { sourceId: registered.source.id });
  options.directory.script({
    records: [directoryRecordOf(incumbent)],
    nextCursor: null,
    hasMore: false,
  });
  await integrationContract.runDiscovery(member, { sourceId: registered.source.id });

  // W081: recommend > approve > connect.
  const systems = await integrationContract.listSystems(member, {});
  const system = systems.find((entry) => entry.displayName === incumbent.displayName);
  if (system === undefined) {
    throw new Error(`the incumbent '${incumbent.displayName}' was not discovered`);
  }
  const recommendations = await integrationContract.listRecommendations(member, {});
  const recommendation = recommendations.find((entry) => entry.systemId === system.id);
  if (recommendation === undefined) {
    throw new Error(`no recommendation for '${incumbent.displayName}'`);
  }
  const batch = await integrationContract.submitRecommendationBatch(member, {
    recommendationIds: [recommendation.id],
  });
  await integrationContract.decideRecommendationBatch(approver, {
    batchId: batch.id,
    decision: 'approve',
    note: 'the incumbent is the system of record being migrated',
  });
  await integrationContract.connectSystem(member, { recommendationId: recommendation.id });

  // W082: the brokered connection the whole migration rides.
  const initiation = await brokerContract.initiateConnection(member, {
    provider: 'salesforce' as brokerContract.BrokerProvider,
    connectionKey: options.connectionKey,
    displayName: incumbent.displayName,
    inventorySystemId: system.id,
  });
  await brokerContract.completeConnection(member, {
    connectionId: initiation.connection.id,
    state: initiation.authorization.state,
  });
  const connection = await brokerContract.getConnection(member, {
    connectionId: initiation.connection.id,
  });

  // W083: the safe read-only start (the floor every incumbent read rides).
  await grantsContract.establishConnectionAccess(member, { connectionId: connection.id });

  return { system, connection };
}

/** Grants the migration's write capability through the W083 ask + W009 decision. */
export async function grantWriteCapability(
  actors: { member: TenantContext; approver: TenantContext },
  input: { connectionId: string; capabilityKey: string; taskDescription: string },
): Promise<void> {
  const ask = await grantsContract.requestCapabilityAuthority(actors.member, {
    connectionId: input.connectionId,
    capabilityKeys: [input.capabilityKey],
    taskContext: { description: input.taskDescription, requestedFor: 'the migration' },
  });
  if (ask.request !== null && ask.request !== undefined) {
    await grantsContract.decideGrantRequest(actors.approver, {
      requestId: ask.request.id,
      decision: 'approve',
      note: 'the migration back-writes Aurum-side advances into the incumbent',
    });
  }
}

/** Fresh tenant ids and actor contexts (the sweep/fixture helpers). */
export function memberOf(tenantId: string, authority: string[] = []): TenantContext {
  return { tenantId, principalId: newId(), authority };
}
