// W044 — Tenant Isolation Verification · application-boundary sweep for the
// platform-surface modules: api (W038 — the versioned public API with
// tenant-scoped API keys and webhooks) and marketplace (W028 — the governed
// ExtensionPackage/AgentPackage catalog with a vendor and a platform side).
//
// Two REAL tenants are provisioned through the organizations contract (the
// platform operation), then both module contracts are driven for both
// tenants (cross-module imports go through `@/modules/<m>/contract` only).
// The sweep proves, per ADR-0001 plus the two modules' own platform
// doctrines:
//
//   * api keys are tenant-scoped end to end — issuance, listing and
//     revocation never cross tenants, and a key minted to act as one
//     tenant's principal cannot be minted by another;
//   * authentication-by-presented-key is the DOCUMENTED global invariant
//     (api_keys.key_hash is globally unique so a presented key resolves
//     onto exactly one tenant — migrations/001): the sweep pins the
//     positive control (each tenant's key authenticates onto its own
//     tenant context and sees only that tenant) plus per-tenant revocation
//     (revoking in A disables A's key while B's stays valid); the invariant
//     itself is never asserted as a defect;
//   * webhook subscriptions carry a per-tenant URL namespace
//     (UNIQUE (tenant_id, url)); deliveries, fanout and redelivery are
//     tenant-scoped; the dispatch pump only ever hands the transport its
//     own tenant's envelopes;
//   * marketplace packages below PUBLISHED are invisible to every other
//     tenant — uniform package_not_found on reads AND writes, evidence
//     trails included — while the DELIBERATELY global surfaces are pinned
//     as such: the public catalog (exactly PUBLISHED/INSTALLABLE versions)
//     and the administer-claimed platform pipeline (verification, review,
//     publication, installation-gating, review queue) may see across
//     tenants by design (ARCHITECTURE.md §3 platform-level operations; the
//     marketplace tables are platform tables in scripts/arch-allowlist.json);
//   * the vendor hand-off (submit) is owner-scoped — no claim set, not
//     even every authority claim in the repository plus both marketplace
//     claims, lets tenant B hand off tenant A's package;
//   * the platform review enforces separation of duties — the vendor
//     tenant cannot review its own package even holding every claim;
//   * authority claims never bypass tenant scope where tenant scope
//     applies (the omnipotent principal of tenant B is still blind to
//     tenant A's keys and webhooks; for the marketplace, everything except
//     the two deliberate platform surfaces above).

process.env.AURUM_DB = 'embedded';
process.env.AURUM_DB_MEMORY = '1';
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/infra/db';
import { newId } from '@/infra/ids';
import type { TenantContext } from '@/infra/tenant';
import { appendEvent } from '@/modules/events/contract';
import {
  addTenantMember,
  ORGANIZATIONS_AUTHORITY_PROVISION,
  provisionTenant,
} from '@/modules/organizations/contract';
import {
  createApiKey,
  createWebhookSubscription,
  deactivateWebhookSubscription,
  dispatchWebhookDeliveries,
  fanoutEvent,
  getWebhookDelivery,
  getWebhookSubscription,
  handleApiRequest,
  listApiKeys,
  listWebhookDeliveries,
  listWebhookSubscriptions,
  redeliverWebhookDelivery,
  revokeApiKey,
  sendWebhookTest,
  setApiWebhookTransport,
  type WebhookTransport,
  type WebhookTransportReceipt,
  type WebhookTransportRequest,
} from '@/modules/api/contract';
import {
  createPackage,
  getPackage,
  getPackageVerification,
  listCatalogPackages,
  listPackageLifecycleEvents,
  listPackageReviews,
  listPackageVerifications,
  listPackages,
  listReviewQueue,
  makePackageInstallable,
  MARKETPLACE_AUTHORITY_ADMINISTER,
  MARKETPLACE_AUTHORITY_SUBMIT,
  publishPackage,
  reviewPackage,
  runAutomatedVerification,
  submitPackage,
  type CreateAgentPackageInput,
} from '@/modules/marketplace/contract';
import {
  registerExtensionManifest,
  type RegisterExtensionManifestInput,
} from '@/modules/extensions/contract';
import {
  assertTenantPartition,
  expectUniformNotFound,
  member,
  memberWith,
  OMNIPOTENT_AUTHORITY,
  omnipotent,
  runMigrations,
} from './harness';

const platform = { principalId: newId(), authority: [ORGANIZATIONS_AUTHORITY_PROVISION] };

interface TenantFixture {
  tenantId: string;
  owner: TenantContext;
  plain: TenantContext;
}

let tenantA: TenantFixture;
let tenantB: TenantFixture;

// api: key administration is administer-grade ('api:administer') and the
// grantee membership is re-verified through the organizations contract, so
// the minting principal must be a REAL member — the fixture owner is.
let apiAdminA: TenantContext;
let apiAdminB: TenantContext;
// api: plain webhook-surface contexts.
let ctxA: TenantContext;
let ctxB: TenantContext;
// marketplace: the vendor side (submit claim) and the platform side
// (administer claim) get one principal per tenant per side, so the vendor
// chain and the cross-tenant platform chain are driven by distinct
// principals (separation of duties keys on BOTH tenant and principal).
let vendorA: TenantContext;
let vendorB: TenantContext;
let operatorA: TenantContext;
let operatorB: TenantContext;
let plainA: TenantContext;
let plainB: TenantContext;

beforeAll(async () => {
  await runMigrations(getDb());
  const provision = async (name: string): Promise<TenantFixture> => {
    const ownerPrincipalId = newId();
    const tenant = await provisionTenant(platform, {
      name: `${name} ${newId().slice(0, 8)}`,
      ownerPrincipalId,
    });
    const owner: TenantContext = { tenantId: tenant.id, principalId: ownerPrincipalId, authority: [] };
    // A second, plain member so low-privilege probes have a real principal.
    const plainPrincipalId = newId();
    await addTenantMember(owner, { principalId: plainPrincipalId, role: 'member' });
    return { tenantId: tenant.id, owner, plain: { tenantId: tenant.id, principalId: plainPrincipalId, authority: [] } };
  };
  tenantA = await provision('Alpha Platform');
  tenantB = await provision('Beta Platform');

  apiAdminA = { tenantId: tenantA.tenantId, principalId: tenantA.owner.principalId, authority: ['api:administer'] };
  apiAdminB = { tenantId: tenantB.tenantId, principalId: tenantB.owner.principalId, authority: ['api:administer'] };
  ctxA = member(tenantA.tenantId);
  ctxB = member(tenantB.tenantId);
  vendorA = memberWith(tenantA.tenantId, [MARKETPLACE_AUTHORITY_SUBMIT]);
  vendorB = memberWith(tenantB.tenantId, [MARKETPLACE_AUTHORITY_SUBMIT]);
  operatorA = memberWith(tenantA.tenantId, [MARKETPLACE_AUTHORITY_ADMINISTER]);
  operatorB = memberWith(tenantB.tenantId, [MARKETPLACE_AUTHORITY_ADMINISTER]);
  plainA = member(tenantA.tenantId);
  plainB = member(tenantB.tenantId);
});

afterAll(async () => {
  setApiWebhookTransport(null);
  await closeDb();
});

// ---------------------------------------------------------------------------
// api (W038) — tenant-scoped API keys
// ---------------------------------------------------------------------------

describe('W044 api — tenant-scoped API keys for the public surface', () => {
  it('mints independent keys per tenant with disjoint management listings', async () => {
    const issuanceA = await createApiKey(apiAdminA, {
      label: 'Alpha integration',
      scopes: ['goals:read'],
    });
    const issuanceB = await createApiKey(apiAdminB, {
      label: 'Beta integration',
      scopes: ['goals:read'],
    });
    // Two tenants, two credentials: distinct rows and distinct raw keys
    // (the raw key is returned exactly once, at issuance).
    expect(issuanceA.apiKey.id).not.toBe(issuanceB.apiKey.id);
    expect(issuanceA.key).not.toBe(issuanceB.key);
    expect(issuanceA.key.startsWith('aurum_')).toBe(true);
    expect(issuanceA.apiKey.tenantId).toBe(tenantA.tenantId);
    expect(issuanceB.apiKey.tenantId).toBe(tenantB.tenantId);

    // Management listings stay per-tenant and never re-expose a credential
    // (only sha-256 hashes persist; listings carry key metadata only).
    const aKeys = await listApiKeys(apiAdminA);
    const bKeys = await listApiKeys(apiAdminB);
    expect(aKeys.map((key) => key.id)).toContain(issuanceA.apiKey.id);
    expect(aKeys.map((key) => key.id)).not.toContain(issuanceB.apiKey.id);
    expect(bKeys.map((key) => key.id)).toContain(issuanceB.apiKey.id);
    expect(bKeys.map((key) => key.id)).not.toContain(issuanceA.apiKey.id);
    expect(JSON.stringify(aKeys)).not.toContain(issuanceA.key);
    expect(JSON.stringify(bKeys)).not.toContain(issuanceB.key);
  });

  it('makes cross-tenant key revocation uniform not-found and never revokes the foreign key', async () => {
    const keyA = await createApiKey(apiAdminA, { label: 'Guard Key A', scopes: ['goals:read'] });

    // B's key administrator cannot even see A's key: a foreign key id is
    // indistinguishable from a missing one.
    await expectUniformNotFound(
      'api_key_not_found',
      () => revokeApiKey(apiAdminB, { keyId: keyA.apiKey.id }),
      () => revokeApiKey(apiAdminB, { keyId: newId() }),
    );
    // The omnipotent principal of B — holding every claim in the repository
    // PLUS this module's own 'api:administer' — is still blind to A's key:
    // authority authorizes key management, never tenant scope.
    const omniKeyB = memberWith(tenantB.tenantId, [...OMNIPOTENT_AUTHORITY, 'api:administer']);
    await expect(revokeApiKey(omniKeyB, { keyId: keyA.apiKey.id })).rejects.toMatchObject({
      code: 'api_key_not_found',
    });
    // A's key is untouched by the foreign probes.
    const afterProbes = (await listApiKeys(apiAdminA)).find((key) => key.id === keyA.apiKey.id);
    expect(afterProbes?.status).toBe('active');
    expect(afterProbes?.revokedAt).toBeNull();

    // B cannot mint a credential that acts as A's principal either: grantee
    // membership is per-tenant (principal_not_member — never a B-tenant key).
    await expect(
      createApiKey(apiAdminB, {
        label: 'B key for A principal',
        scopes: ['goals:read'],
        principalId: tenantA.owner.principalId,
      }),
    ).rejects.toMatchObject({ code: 'principal_not_member' });

    // A's own revocation works and is idempotent.
    const revoked = await revokeApiKey(apiAdminA, { keyId: keyA.apiKey.id });
    expect(revoked.status).toBe('revoked');
    const again = await revokeApiKey(apiAdminA, { keyId: keyA.apiKey.id });
    expect(again.status).toBe('revoked');
  });

  it('resolves a presented key onto its own tenant only; revocation is per-tenant', async () => {
    // Keys whose grant covers the api-keys surface itself (fail-closed
    // double gate: the route's 'api:administer' scope plus the key's
    // 'api:administer' authority claim).
    const issuanceA = await createApiKey(apiAdminA, {
      label: 'Kernel Key A',
      scopes: ['api:administer'],
      authority: ['api:administer'],
    });
    const issuanceB = await createApiKey(apiAdminB, {
      label: 'Kernel Key B',
      scopes: ['api:administer'],
      authority: ['api:administer'],
    });

    const listKeysWith = (rawKey: string) =>
      handleApiRequest({
        method: 'GET',
        path: '/api/v1/api-keys',
        headers: { authorization: `Bearer ${rawKey}` },
        query: {},
      });

    // POSITIVE CONTROL — the documented auth invariant: the key_hash lookup
    // is GLOBAL by design so a presented key resolves onto exactly ONE
    // tenant (migrations/001). The delegated operation then runs under that
    // tenant's explicit context and sees only that tenant's keys.
    const resA = await listKeysWith(issuanceA.key);
    expect(resA.status).toBe(200);
    expect(resA.headers?.['x-aurum-api-version']).toBe('v1');
    const itemsA = (resA.body as { items: Array<{ id: string; tenantId: string }> }).items;
    expect(itemsA.map((key) => key.id)).toContain(issuanceA.apiKey.id);
    expect(itemsA.map((key) => key.id)).not.toContain(issuanceB.apiKey.id);
    expect(itemsA.every((key) => key.tenantId === tenantA.tenantId)).toBe(true);

    const resB = await listKeysWith(issuanceB.key);
    expect(resB.status).toBe(200);
    const itemsB = (resB.body as { items: Array<{ id: string; tenantId: string }> }).items;
    expect(itemsB.map((key) => key.id)).toContain(issuanceB.apiKey.id);
    expect(itemsB.map((key) => key.id)).not.toContain(issuanceA.apiKey.id);
    expect(itemsB.every((key) => key.tenantId === tenantB.tenantId)).toBe(true);

    // Malformed and unknown bearers are uniformly unauthenticated — no
    // existence leak about which key might exist.
    for (const bad of [`aurum_${'x'.repeat(43)}`, 'not-a-key']) {
      const rejected = await listKeysWith(bad);
      expect(rejected.status).toBe(401);
      expect((rejected.body as { error: { code: string } }).error.code).toBe('unauthenticated');
    }
    const absent = await handleApiRequest({
      method: 'GET',
      path: '/api/v1/api-keys',
      headers: {},
      query: {},
    });
    expect(absent.status).toBe(401);
    expect((absent.body as { error: { code: string } }).error.code).toBe('unauthenticated');

    // Revoking in A disables A's key only; B's key remains valid.
    await revokeApiKey(apiAdminA, { keyId: issuanceA.apiKey.id });
    const revokedA = await listKeysWith(issuanceA.key);
    expect(revokedA.status).toBe(401);
    expect((revokedA.body as { error: { code: string } }).error.code).toBe('unauthenticated');
    const stillB = await listKeysWith(issuanceB.key);
    expect(stillB.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// api (W038) — tenant-scoped webhook subscriptions and deliveries
// ---------------------------------------------------------------------------

/** Deterministic fake delivery transport (no network, records every envelope). */
class FakeWebhookTransport implements WebhookTransport {
  readonly requests: WebhookTransportRequest[] = [];
  async deliver(request: WebhookTransportRequest): Promise<WebhookTransportReceipt> {
    this.requests.push(request);
    return { ok: true, statusCode: 200, error: null, latencyMs: 4 };
  }
}

describe('W044 api — tenant-scoped webhook subscriptions and deliveries', () => {
  it('namespaces webhook URLs per tenant and keeps subscription listings disjoint', async () => {
    const url = 'https://hooks.example.com/w044-shared-endpoint';
    const subA = await createWebhookSubscription(ctxA, {
      label: 'Alpha hook',
      url,
      eventTypes: ['channel.message.*'],
    });
    const subB = await createWebhookSubscription(ctxB, {
      label: 'Beta hook',
      url,
      eventTypes: ['channel.message.*'],
    });
    // The same endpoint URL coexists independently per tenant —
    // UNIQUE (tenant_id, url) namespaces the URL per tenant.
    expect(subA.id).not.toBe(subB.id);
    expect(subA.tenantId).toBe(tenantA.tenantId);
    expect(subB.tenantId).toBe(tenantB.tenantId);

    // A second subscription for the same URL conflicts only in-tenant.
    await expect(
      createWebhookSubscription(ctxA, { label: 'Alpha hook 2', url, eventTypes: ['*'] }),
    ).rejects.toMatchObject({ code: 'webhook_conflict' });

    const aSubs = await listWebhookSubscriptions(ctxA);
    const bSubs = await listWebhookSubscriptions(ctxB);
    expect(aSubs.map((sub) => sub.id)).toContain(subA.id);
    expect(aSubs.map((sub) => sub.id)).not.toContain(subB.id);
    expect(bSubs.map((sub) => sub.id)).toContain(subB.id);
    expect(bSubs.map((sub) => sub.id)).not.toContain(subA.id);
  });

  it('makes cross-tenant webhook reads and writes uniform not-found', async () => {
    const subA = await createWebhookSubscription(ctxA, {
      label: 'Guard Hook A',
      url: 'https://hooks.example.com/guard-a',
      eventTypes: ['*'],
    });

    await expectUniformNotFound(
      'webhook_not_found',
      () => getWebhookSubscription(ctxB, { subscriptionId: subA.id }),
      () => getWebhookSubscription(ctxB, { subscriptionId: newId() }),
    );
    // Deactivating or pinging another tenant's subscription fails the same
    // way — and never mutates A's subscription.
    await expect(
      deactivateWebhookSubscription(ctxB, { subscriptionId: subA.id }),
    ).rejects.toMatchObject({ code: 'webhook_not_found' });
    await expect(
      sendWebhookTest(ctxB, { subscriptionId: subA.id }),
    ).rejects.toMatchObject({ code: 'webhook_not_found' });
    // The omnipotent principal of B is equally blind: the webhook surfaces
    // have no claim gate at all — tenant scope is all there is.
    await expect(
      getWebhookSubscription(omnipotent(tenantB.tenantId), { subscriptionId: subA.id }),
    ).rejects.toMatchObject({ code: 'webhook_not_found' });

    const untouched = await getWebhookSubscription(ctxA, { subscriptionId: subA.id });
    expect(untouched.status).toBe('active');
    expect(untouched.deactivatedAt).toBeNull();
  });

  it('keeps fanout, delivery reads and redelivery per-tenant', async () => {
    const subA = await createWebhookSubscription(ctxA, {
      label: 'Delivery Hook A',
      url: 'https://hooks.example.com/deliveries-a',
      eventTypes: ['channel.message.*'],
    });
    const subB = await createWebhookSubscription(ctxB, {
      label: 'Delivery Hook B',
      url: 'https://hooks.example.com/deliveries-b',
      eventTypes: ['channel.message.*'],
    });
    const eventInput = () => ({
      type: 'channel.message.received',
      payload: { text: 'w044 platform sweep' },
      occurredAt: '2026-09-14T09:15:00Z',
      actor: { kind: 'person' as const, label: 'sweep' },
      source: { kind: 'channel' as const, label: 'whatsapp' },
    });

    // Fanout enqueues deliveries for the CALLING tenant's subscriptions.
    const eventA = await appendEvent(ctxA, eventInput());
    const fanoutA = await fanoutEvent(ctxA, { eventId: eventA.id });
    expect(fanoutA.matched).toBeGreaterThanOrEqual(1);
    const eventB = await appendEvent(ctxB, eventInput());
    const fanoutB = await fanoutEvent(ctxB, { eventId: eventB.id });
    expect(fanoutB.matched).toBeGreaterThanOrEqual(1);
    // Each subscription received exactly its own event's delivery.
    const aSubDeliveries = await listWebhookDeliveries(ctxA, { subscriptionId: subA.id });
    expect(aSubDeliveries).toHaveLength(1);
    const bSubDeliveries = await listWebhookDeliveries(ctxB, { subscriptionId: subB.id });
    expect(bSubDeliveries).toHaveLength(1);
    const deliveryA = aSubDeliveries[0]!;
    expect(bSubDeliveries.map((delivery) => delivery.id)).not.toContain(deliveryA.id);

    // B cannot fan out A's event: the event read is tenant-scoped, so a
    // foreign event id is uniformly not-found (the events module's code
    // propagates through the api fanout operation).
    await expectUniformNotFound(
      'event_not_found',
      () => fanoutEvent(ctxB, { eventId: eventA.id }),
      () => fanoutEvent(ctxB, { eventId: newId() }),
    );

    // A foreign subscription filter is uniformly not-found for B.
    await expect(
      listWebhookDeliveries(ctxB, { subscriptionId: subA.id }),
    ).rejects.toMatchObject({ code: 'webhook_not_found' });

    await expectUniformNotFound(
      'webhook_delivery_not_found',
      () => getWebhookDelivery(ctxB, { deliveryId: deliveryA.id }),
      () => getWebhookDelivery(ctxB, { deliveryId: newId() }),
    );

    // Redelivering A's delivery from B fails uniformly and leaves A's
    // delivery untouched; A's own redelivery works (append-only clone).
    await expect(
      redeliverWebhookDelivery(ctxB, { deliveryId: deliveryA.id }),
    ).rejects.toMatchObject({ code: 'webhook_delivery_not_found' });
    const afterForeign = await getWebhookDelivery(ctxA, { deliveryId: deliveryA.id });
    expect(afterForeign.delivery.attempts).toBe(0);
    expect(afterForeign.delivery.status).toBe('pending');

    const clone = await redeliverWebhookDelivery(ctxA, { deliveryId: deliveryA.id });
    expect(clone.redeliveryOf).toBe(deliveryA.id);
    expect(clone.status).toBe('pending');
  });

  it('dispatches only its own tenant pending deliveries through the transport', async () => {
    // Distinct endpoints per tenant so the transport log can prove whose
    // envelopes it saw.
    const subA = await createWebhookSubscription(ctxA, {
      label: 'Pump Hook A',
      url: 'https://hooks.alpha.example.com/pump',
      eventTypes: ['*'],
    });
    const subB = await createWebhookSubscription(ctxB, {
      label: 'Pump Hook B',
      url: 'https://hooks.beta.example.com/pump',
      eventTypes: ['*'],
    });
    const pingA = await sendWebhookTest(ctxA, { subscriptionId: subA.id });
    const pingB = await sendWebhookTest(ctxB, { subscriptionId: subB.id });
    expect(pingA.status).toBe('pending');
    expect(pingB.status).toBe('pending');

    const transport = new FakeWebhookTransport();
    setApiWebhookTransport(transport);

    // A's pump run delivers A's due deliveries and never touches B's: the
    // due-delivery selection is tenant-scoped, so no B envelope ever
    // reaches the provider transport through A's context.
    const pumpedA = await dispatchWebhookDeliveries(ctxA, {});
    expect(pumpedA.dispatched.map((outcome) => outcome.deliveryId)).toContain(pingA.id);
    for (const outcome of pumpedA.dispatched) {
      expect(outcome.outcome).toBe('delivered');
    }
    expect(transport.requests.length).toBeGreaterThanOrEqual(1);
    expect(transport.requests.every((request) => request.subscriptionId !== subB.id)).toBe(true);
    expect(
      transport.requests.every((request) => request.url !== 'https://hooks.beta.example.com/pump'),
    ).toBe(true);

    const bStillPending = await getWebhookDelivery(ctxB, { deliveryId: pingB.id });
    expect(bStillPending.delivery.status).toBe('pending');
    expect(bStillPending.delivery.attempts).toBe(0);

    // B's own pump run then delivers B's delivery.
    const pumpedB = await dispatchWebhookDeliveries(ctxB, {});
    expect(pumpedB.dispatched.map((outcome) => outcome.deliveryId)).toContain(pingB.id);
    const bDelivered = await getWebhookDelivery(ctxB, { deliveryId: pingB.id });
    expect(bDelivered.delivery.status).toBe('delivered');
    expect(bDelivered.delivery.attempts).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// marketplace (W028) — governed vendor packages on the platform catalog
// ---------------------------------------------------------------------------

describe('W044 marketplace — vendor packages are tenant-isolated until publication', () => {
  const agentPackageInput = (overrides: Partial<CreateAgentPackageInput> = {}): CreateAgentPackageInput => ({
    kind: 'agent',
    packageKey: `iso-agent-${newId().slice(0, 8)}`,
    version: '1.0.0',
    displayName: 'Isolation Analyst',
    description: 'W044 platform sweep fixture',
    role: 'conversation triage',
    instructions: 'Triage inbound conversations and draft replies.',
    provider: 'openai-assistants',
    permissions: ['observe', 'analyze'],
    ...overrides,
  });

  it('runs both vendors through the governed chain with cross-tenant platform review', async () => {
    const pkgA = await createPackage(vendorA, agentPackageInput());
    expect(pkgA.state).toBe('DRAFT');
    expect(pkgA.vendorTenant).toBe(tenantA.tenantId);
    await submitPackage(vendorA, { packageId: pkgA.id });
    // The platform side is deliberately cross-tenant: an administer-claimed
    // principal of ANOTHER tenant runs verification, review, publication
    // and installation-gating (separation of duties against the vendor
    // tenant is probed separately below).
    const verified = await runAutomatedVerification(operatorB, { packageId: pkgA.id });
    expect(verified.run.outcome).toBe('verified');
    expect(verified.package.state).toBe('PENDING_REVIEW');
    const approved = await reviewPackage(operatorB, { packageId: pkgA.id, decision: 'approve' });
    expect(approved.package.state).toBe('APPROVED');
    expect(approved.review.reviewedByTenant).toBe(tenantB.tenantId);
    const published = await publishPackage(operatorB, { packageId: pkgA.id });
    expect(published.state).toBe('PUBLISHED');
    const installable = await makePackageInstallable(operatorB, { packageId: pkgA.id });
    expect(installable.state).toBe('INSTALLABLE');

    // The mirror chain: B's package reviewed by A's platform principal.
    const pkgB = await createPackage(vendorB, agentPackageInput());
    await submitPackage(vendorB, { packageId: pkgB.id });
    await runAutomatedVerification(operatorA, { packageId: pkgB.id });
    await reviewPackage(operatorA, { packageId: pkgB.id, decision: 'approve' });
    await publishPackage(operatorA, { packageId: pkgB.id });
    await makePackageInstallable(operatorA, { packageId: pkgB.id });

    // Vendor listings stay per-tenant (the vendor view: own packages only).
    const aPackages = await listPackages(vendorA, {});
    const bPackages = await listPackages(vendorB, {});
    expect(aPackages.map((pkg) => pkg.id)).toContain(pkgA.id);
    expect(aPackages.map((pkg) => pkg.id)).not.toContain(pkgB.id);
    expect(bPackages.map((pkg) => pkg.id)).toContain(pkgB.id);
    expect(bPackages.map((pkg) => pkg.id)).not.toContain(pkgA.id);

    // The public catalog is the DELIBERATELY global surface: exactly
    // PUBLISHED/INSTALLABLE versions, readable by every tenant
    // (ARCHITECTURE.md §3 platform-level operations — a published package
    // is the vendor's offered artifact, never tenant business data).
    const catalogA = await listCatalogPackages(plainA, {});
    const catalogB = await listCatalogPackages(plainB, {});
    for (const catalog of [catalogA, catalogB]) {
      expect(catalog.map((pkg) => pkg.id)).toContain(pkgA.id);
      expect(catalog.map((pkg) => pkg.id)).toContain(pkgB.id);
      expect(catalog.every((pkg) => pkg.state === 'PUBLISHED' || pkg.state === 'INSTALLABLE')).toBe(true);
    }
  });

  it('makes foreign pre-publication packages and their evidence uniform not-found', async () => {
    const draftA = await createPackage(vendorA, agentPackageInput());
    const submittedA = await createPackage(vendorA, agentPackageInput());
    await submitPackage(vendorA, { packageId: submittedA.id });
    // A rejected package is terminal evidence — still vendor+platform only.
    const rejectedA = await createPackage(vendorA, agentPackageInput());
    await submitPackage(vendorA, { packageId: rejectedA.id });
    await runAutomatedVerification(operatorB, { packageId: rejectedA.id });
    await reviewPackage(operatorB, { packageId: rejectedA.id, decision: 'reject', reason: 'not suitable' });

    // Reads: a foreign package id is indistinguishable from a missing one
    // in EVERY pre-publication state.
    for (const pkg of [draftA, submittedA, rejectedA]) {
      await expectUniformNotFound(
        'package_not_found',
        () => getPackage(plainB, { packageId: pkg.id }),
        () => getPackage(plainB, { packageId: newId() }),
      );
    }
    // Evidence trails are equally invisible (verification runs, review
    // decisions, lifecycle events, derived verification posture).
    await expectUniformNotFound(
      'package_not_found',
      () => listPackageVerifications(plainB, { packageId: submittedA.id }),
      () => listPackageVerifications(plainB, { packageId: newId() }),
    );
    await expectUniformNotFound(
      'package_not_found',
      () => listPackageReviews(plainB, { packageId: rejectedA.id }),
      () => listPackageReviews(plainB, { packageId: newId() }),
    );
    await expectUniformNotFound(
      'package_not_found',
      () => listPackageLifecycleEvents(plainB, { packageId: submittedA.id }),
      () => listPackageLifecycleEvents(plainB, { packageId: newId() }),
    );
    await expectUniformNotFound(
      'package_not_found',
      () => getPackageVerification(plainB, { packageId: submittedA.id }),
      () => getPackageVerification(plainB, { packageId: newId() }),
    );

    // The vendor submit claim grants NO cross-tenant visibility: a B
    // principal holding every claim in the repository except the one
    // deliberate platform-operator exception is still blind to A's draft.
    // (OMNIPOTENT_AUTHORITY now carries 'marketplace:administer' because
    // the central list must hold every claim the repository checks; that
    // claim intentionally carries cross-tenant platform visibility — the
    // surface probed by the review-queue check below — so this probe
    // subtracts it back out.)
    const omniVendorB = memberWith(tenantB.tenantId, [
      ...OMNIPOTENT_AUTHORITY.filter(
        (claim) => claim !== MARKETPLACE_AUTHORITY_ADMINISTER,
      ),
      MARKETPLACE_AUTHORITY_SUBMIT,
    ]);
    await expect(getPackage(omniVendorB, { packageId: draftA.id })).rejects.toMatchObject({
      code: 'package_not_found',
    });

    // The platform pipeline view is claim-gated (the deliberate
    // platform-side surface): B's administer-claimed operator sees A's
    // submitted package in the review queue, while a plain B principal is
    // forbidden outright.
    const queue = await listReviewQueue(operatorB, {});
    expect(queue.map((pkg) => pkg.id)).toContain(submittedA.id);
    await expect(listReviewQueue(plainB, {})).rejects.toMatchObject({ code: 'forbidden' });

    // Nothing pre-publication (and nothing rejected) ever reaches the
    // public catalog.
    const catalogB = await listCatalogPackages(plainB, {});
    expect(catalogB.map((pkg) => pkg.id)).not.toContain(draftA.id);
    expect(catalogB.map((pkg) => pkg.id)).not.toContain(submittedA.id);
    expect(catalogB.map((pkg) => pkg.id)).not.toContain(rejectedA.id);
  });

  it('keeps the vendor hand-off owner-scoped (no claim set confers vendor ownership)', async () => {
    const draftA = await createPackage(vendorA, agentPackageInput());

    // B's vendor cannot hand off A's draft: uniformly not-found.
    await expectUniformNotFound(
      'package_not_found',
      () => submitPackage(vendorB, { packageId: draftA.id }),
      () => submitPackage(vendorB, { packageId: newId() }),
    );
    // Even a B principal holding EVERY claim in the repository — including
    // both marketplace claims — cannot submit on A's behalf: the platform
    // operator may SEE the package, but the hand-off stays the vendor's
    // move (submitter and reviewer are kept provably distinct).
    const omniAllB = memberWith(tenantB.tenantId, [
      ...OMNIPOTENT_AUTHORITY,
      MARKETPLACE_AUTHORITY_SUBMIT,
      MARKETPLACE_AUTHORITY_ADMINISTER,
    ]);
    await expect(submitPackage(omniAllB, { packageId: draftA.id })).rejects.toMatchObject({
      code: 'package_not_found',
    });

    // A's draft is untouched by the foreign probes; A's own submit works.
    expect((await getPackage(vendorA, { packageId: draftA.id })).state).toBe('DRAFT');
    const submitted = await submitPackage(vendorA, { packageId: draftA.id });
    expect(submitted.state).toBe('SUBMITTED');
  });

  it('enforces separation of duties on the platform review decision', async () => {
    const pkgA = await createPackage(vendorA, agentPackageInput());
    await submitPackage(vendorA, { packageId: pkgA.id });
    await runAutomatedVerification(operatorB, { packageId: pkgA.id });

    // The vendor TENANT cannot review its own package — not even a
    // principal of tenant A holding 'marketplace:administer'.
    await expect(
      reviewPackage(operatorA, { packageId: pkgA.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'separation_of_duties' });
    // Nor the fully-claimed principal of the vendor tenant: claims never
    // buy the vendor a self-approval path (a storage trigger makes the bad
    // review row unrepresentable even for callers bypassing the service).
    const omniVendorA = memberWith(tenantA.tenantId, [
      ...OMNIPOTENT_AUTHORITY,
      MARKETPLACE_AUTHORITY_ADMINISTER,
      MARKETPLACE_AUTHORITY_SUBMIT,
    ]);
    await expect(
      reviewPackage(omniVendorA, { packageId: pkgA.id, decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'separation_of_duties' });
    // The failed probes moved nothing.
    expect((await getPackage(vendorA, { packageId: pkgA.id })).state).toBe('PENDING_REVIEW');
    // The cross-tenant platform reviewer decides fine.
    const approved = await reviewPackage(operatorB, { packageId: pkgA.id, decision: 'approve' });
    expect(approved.package.state).toBe('APPROVED');

    // Mirror probe: B's own package cannot be reviewed by tenant B either.
    const pkgB = await createPackage(vendorB, agentPackageInput());
    await submitPackage(vendorB, { packageId: pkgB.id });
    await runAutomatedVerification(operatorA, { packageId: pkgB.id });
    await expect(
      reviewPackage(operatorB, { packageId: pkgB.id, decision: 'reject', reason: 'self review' }),
    ).rejects.toMatchObject({ code: 'separation_of_duties' });
    expect((await getPackage(vendorB, { packageId: pkgB.id })).state).toBe('PENDING_REVIEW');
  });

  it('keeps the global catalog key namespace while vendor listings stay per-tenant', async () => {
    const sharedKey = `shared-helper-${newId().slice(0, 8)}`;
    const inA = await createPackage(vendorA, agentPackageInput({ packageKey: sharedKey, version: '1.0.0' }));
    // The (kind, package_key, version) namespace is GLOBAL — the platform
    // catalog is one worldwide chain per key (marketplace_packages has no
    // tenant column; scripts/arch-allowlist.json): the second vendor's
    // identical key+version collides with package_conflict, never a silent
    // second row.
    await expect(
      createPackage(vendorB, agentPackageInput({ packageKey: sharedKey, version: '1.0.0' })),
    ).rejects.toMatchObject({ code: 'package_conflict' });
    // A strictly higher version of the same catalog key is a legitimate
    // new artifact version of the global chain.
    const inB = await createPackage(
      vendorB,
      agentPackageInput({ packageKey: sharedKey, version: '1.1.0', displayName: 'Shared Helper B' }),
    );
    expect(inA.id).not.toBe(inB.id);
    expect(inA.vendorTenant).toBe(tenantA.tenantId);
    expect(inB.vendorTenant).toBe(tenantB.tenantId);

    // Vendor listings still partition by vendor tenant.
    const aPackages = await listPackages(vendorA, {});
    const bPackages = await listPackages(vendorB, {});
    expect(aPackages.map((pkg) => pkg.id)).toContain(inA.id);
    expect(aPackages.map((pkg) => pkg.id)).not.toContain(inB.id);
    expect(bPackages.map((pkg) => pkg.id)).toContain(inB.id);
    expect(bPackages.map((pkg) => pkg.id)).not.toContain(inA.id);
  });

  it('freezes extension manifests under the vendor context only (uniform invalid_manifest_ref)', async () => {
    const extAdminA = memberWith(tenantA.tenantId, ['extensions:administer']);
    const extensionKey = `iso-ext-${newId().slice(0, 8)}`;
    const manifestInput: RegisterExtensionManifestInput = {
      extensionKey,
      version: '1.0.0',
      manifestSchemaVersion: 1,
      displayName: 'Isolation Extension',
      description: 'W044 platform sweep fixture manifest',
      requestedPermissions: [
        'state:read',
        'state:write',
        'ui:render',
        'schedule:run',
        'events:subscribe',
        'external:participate',
        'telemetry:emit',
      ],
      stateScope: 'tenant',
      uiSurfaces: ['control-tower-panel'],
      schedules: [{ name: 'nightly-sync', cron: '0 2 * * *' }],
      eventSubscriptions: ['invoice.received', 'invoice.paid'],
      externalParticipants: [{ label: 'Invoices API', origin: 'https://api.invoices.example.com' }],
      telemetry: true,
      quotas: { maxStateBytes: 1_048_576, maxScheduleInvocationsPerDay: 3, maxExternalCallsPerDay: 2 },
      hostRuntime: { minVersion: '1.0.0', maxVersion: '3.0.0' },
    };
    const { manifest } = await registerExtensionManifest(extAdminA, manifestInput);

    // A's vendor freezes its own registry artifact into the catalog (the
    // one validated cross-module read, under the vendor's own context).
    const pkgA = await createPackage(vendorA, { kind: 'extension', manifestId: manifest.id });
    expect(pkgA.state).toBe('DRAFT');
    expect(pkgA.kind).toBe('extension');
    expect(pkgA.vendorTenant).toBe(tenantA.tenantId);

    // B's vendor cannot freeze A's manifest: the manifest read runs under
    // the CALLER's tenant context, so a foreign manifest id is
    // indistinguishable from a missing one.
    await expectUniformNotFound(
      'invalid_manifest_ref',
      () => createPackage(vendorB, { kind: 'extension', manifestId: manifest.id }),
      () => createPackage(vendorB, { kind: 'extension', manifestId: newId() }),
    );
  });
});

// ---------------------------------------------------------------------------
// Row-partition integrity over the whole migrated schema
// ---------------------------------------------------------------------------

describe('W044 repository boundary — row partition integrity', () => {
  it('stores every row of every tenant-scoped table under a sweep tenant only', async () => {
    // The marketplace tables are platform tables (no tenant_id column —
    // scripts/arch-allowlist.json) and are deliberately outside this row
    // partition; every tenant-scoped table the sweep touched — api keys,
    // webhook subscriptions/deliveries/attempts, events audit rows,
    // extensions manifests — must hold only sweep-tenant rows.
    await assertTenantPartition([tenantA.tenantId, tenantB.tenantId]);
  });
});
