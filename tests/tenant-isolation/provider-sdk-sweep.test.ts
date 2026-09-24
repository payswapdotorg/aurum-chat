// W044 — Tenant Isolation Verification · the provider-sdk sweep (W089).
//
// The provider-sdk module (W089 — Provider Adapter SDK and OSS Technology
// Registry) owns NO tenant-scoped state, by design:
//   * the OSS technology registry is PLATFORM REFERENCE DATA — a committed
//     JSON file versioned by Tech Lead review decisions (registry.ts: "a
//     domain table would have to be tenant-scoped; this deliberately is
//     not a table"), readable identically by every tenant;
//   * the adapter-definition factory and the hot-swap evidence builder are
//     pure functions — no database, no clock, no network — and their
//     artifacts carry no tenant binding;
//   * provider selection stays OUTSIDE the SDK (the W089 acceptance) — the
//     definition exposes no execution or selection method, so no
//     tenant-conditional routing exists here to leak.
//
// This sweep proves the tenant boundary at the APPLICATION level per the
// W044 doctrine, in this module's own idiom: two tenants side by side see
// byte-identical SDK surfaces, and no artifact the module can produce
// carries a tenant-scoped identifier. The deep per-contract proofs
// (conformance kit, evidence format, registry validation, lifecycle) live
// in the module's own suite (src/modules/provider-sdk/tests/).

import { describe, expect, it } from 'vitest';
import {
  buildHotSwapEvidence,
  createProviderAdapterDefinition,
  findTechnologyEntry,
  listTechnologyCapabilities,
  listTechnologyEntries,
  listTechnologyEntriesByCapability,
  technologyRegistryReviewSummary,
} from '@/modules/provider-sdk/contract';

// The tenant dimensions this sweep scans every artifact against. Any
// tenant-scoped field appearing in SDK output or registry data fails it.
const TENANT_KEY_PATTERN = /tenant|principal|workspace|organization|org[_-]?id/i;

function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (value === null || typeof value !== 'object') return into;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
    return into;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    into.add(key);
    collectKeys(child, into);
  }
  return into;
}

function tenantKeysOf(value: unknown): string[] {
  return [...collectKeys(value)].filter((key) => TENANT_KEY_PATTERN.test(key));
}

const EXECUTED_AT = '2026-09-24T07:00:00.000Z';

const EVIDENCE_INPUT = {
  gateway: 'llm',
  capability: 'text-generation',
  providerA: { provider: 'openai', target: 'gpt-4o', resultKind: 'completed' as const },
  providerB: { provider: 'anthropic', target: 'claude-sonnet-4-5', resultKind: 'completed' as const },
  outcome: 'equivalent' as const,
  evidenceId: '0192f0a1-0000-7000-8000-0000000000f1',
  executedAt: EXECUTED_AT,
  requestDigest: 'd'.repeat(64),
};

describe('W044 tenant isolation — the provider-sdk sweep (W089)', () => {
  it('the technology registry is platform reference data: identical for every caller, no tenant-scoped fields', () => {
    const first = listTechnologyEntries();
    const second = listTechnologyEntries();
    expect(first.length).toBeGreaterThan(0);
    // Frozen committed data — there is no per-caller (per-tenant) state to
    // diverge: two side-by-side readers always see the same registry.
    expect(second).toEqual(first);

    const keys = tenantKeysOf(first);
    expect(keys, `registry entries carry tenant-scoped keys: ${keys.join(', ')}`).toEqual([]);

    // The read API is projection-only: filters and lookups are pure over
    // the committed data (no per-tenant view can exist through them).
    const someEntry = first[0];
    if (someEntry === undefined) throw new Error('technology registry is empty');
    expect(findTechnologyEntry(someEntry.entryId)).toEqual(someEntry);
    expect(findTechnologyEntry('does-not-exist')).toBeNull();
    const capabilities = listTechnologyCapabilities();
    expect(capabilities.length).toBeGreaterThan(0);
    for (const capability of capabilities) {
      for (const entry of listTechnologyEntriesByCapability(capability)) {
        expect(entry.capability).toBe(capability);
      }
    }
  });

  it('the Tech Lead review summary is computed from the same committed data (no per-tenant view)', () => {
    const first = technologyRegistryReviewSummary();
    const second = technologyRegistryReviewSummary();
    expect(first).toEqual(second);
    expect(first.totalEntries).toBe(listTechnologyEntries().length);
    expect(tenantKeysOf(first)).toEqual([]);
  });

  it('hot-swap evidence records are tenant-inert: deterministic, no tenant binding', () => {
    const first = buildHotSwapEvidence(EVIDENCE_INPUT);
    const second = buildHotSwapEvidence(EVIDENCE_INPUT);
    // Pure builder — no ambient per-tenant state can enter the record.
    expect(second).toEqual(first);

    const keys = tenantKeysOf([first, second]);
    expect(keys, `evidence records carry tenant-scoped keys: ${keys.join(', ')}`).toEqual([]);
  });

  it('adapter definitions are tenant-inert and expose no execution/selection surface (selection stays outside the SDK)', () => {
    const input = {
      gateway: 'llm',
      provider: 'sweep-provider',
      capabilities: ['text-generation'],
    };
    const first = createProviderAdapterDefinition(input);
    const second = createProviderAdapterDefinition(input);
    // Factory-fresh instances with identical data (closures are dropped by
    // JSON; their RESULTS are compared explicitly below).
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second.describeCapabilities()).toEqual(first.describeCapabilities());

    expect(tenantKeysOf(first)).toEqual([]);

    // W089 acceptance: provider selection stays outside domain logic — the
    // definition must not expose any execution or routing member.
    for (const forbidden of ['execute', 'select', 'dispatch', 'route', 'call', 'invoke']) {
      expect(first, `adapter definition must not expose '${forbidden}'`).not.toHaveProperty(forbidden);
    }
    // The declared surface is exactly the canonical SDK contract.
    expect(Object.keys(first).sort()).toEqual([
      'describeCapabilities',
      'gateway',
      'mapError',
      'provider',
      'sdk',
      'sdkVersion',
    ]);
  });
});
