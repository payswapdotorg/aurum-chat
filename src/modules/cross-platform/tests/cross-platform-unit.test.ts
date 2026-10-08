// Unit proofs for the cross-platform module (W139) — the PURE layer:
// validation, canonical serialization/digests, vocabulary pins and the
// deterministic platform adapter doubles. No database, no clock, no
// network (the org-lab discipline: everything proven here is
// infrastructure-free by construction).
//
// Proofs map to the W139 acceptance clauses:
//   * canonicalJson/digestOf determinism — the content-addressing that
//     makes "same authoritative state across clients" verifiable by any
//     client kind (key order never decides a digest);
//   * vocabulary pins — the frozen W131 client vocabulary, the W057
//     product-area mirror and the vendor-neutral capability domains
//     (no 'tauri'/'expo' type-system citizen — the W131 law applied to
//     client platforms);
//   * validation guards — the typed input/query gates incl. the focus
//     rules (focusSeam iff background-work), draft bounds, capability
//     input canonicalizability;
//   * adapter doubles — deterministic probe/invoke, scriptable vendor
//     failures, and the removal-neutral registry behavior.

import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_WORK_PHASES,
  BACKGROUND_WORK_SEAMS,
  CLIENT_SESSION_STATES,
  HANDOFF_EVIDENCE_KINDS,
  HANDOFF_FOCUS_KINDS,
  MAX_DRAFT_CHARS,
  PLATFORM_CAPABILITY_DOMAINS,
  PLATFORM_KINDS,
  PRODUCT_AREA_IDS,
  TOWER_SURFACE_SLUGS,
  canonicalJson,
  digestOf,
  isCapabilityDomain,
  isPlatformKind,
} from '../contract';
import { CrossPlatformError } from '../errors';
import type { CrossPlatformErrorCode } from '../errors';
import {
  validateHandoffWorkingContext,
  validateInvokePlatformCapabilityInput,
  validateOpenHandoffSessionInput,
  validateReadShellModelQuery,
} from '../validation';
import { createWebPlatformAdapter } from '../adapters/web-adapter';
import { createDesktopPlatformAdapter } from '../adapters/desktop-adapter';
import { createMobilePlatformAdapter } from '../adapters/mobile-adapter';

function expectCode(code: CrossPlatformErrorCode, fn: () => unknown): CrossPlatformError {
  try {
    fn();
    expect.unreachable();
  } catch (error) {
    expect(error).toBeInstanceOf(CrossPlatformError);
    const typed = error as CrossPlatformError;
    expect(typed.code).toBe(code);
    return typed;
  }
}

// ---------------------------------------------------------------------------
// Canonical serialization + digest (the projection content-addressing)
// ---------------------------------------------------------------------------

describe('canonical serialization + digest', () => {
  it('key order never decides a digest (structurally equal values are byte-identical)', () => {
    const a = { z: 1, a: { y: [1, { b: 2, a: 1 }], x: 's' }, m: null };
    const b = { m: null, a: { x: 's', y: [1, { a: 1, b: 2 }] }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(digestOf(a)).toBe(digestOf(b));
  });

  it('array order IS semantic (a reordered array is different content)', () => {
    expect(digestOf({ list: [1, 2] })).not.toBe(digestOf({ list: [2, 1] }));
  });

  it('rejects non-JSON values (undefined, functions, non-finite numbers)', () => {
    expect(() => canonicalJson({ bad: undefined })).toThrow(CrossPlatformError);
    expect(() => canonicalJson({ bad: Number.NaN })).toThrow(CrossPlatformError);
    expect(() => canonicalJson({ bad: () => 1 })).toThrow(CrossPlatformError);
  });

  it('digests are stable sha256 hex with the prefix (recomputable by any client kind)', () => {
    const digest = digestOf({ hello: 'aurum', n: 42, nested: { deep: true } });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digestOf({ hello: 'aurum', n: 42, nested: { deep: true } })).toBe(digest);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary pins (frozen sources of truth)
// ---------------------------------------------------------------------------

describe('vocabulary pins', () => {
  it('the frozen W131 client vocabulary: three platform kinds, web/desktop/mobile', () => {
    expect([...PLATFORM_KINDS]).toEqual(['web', 'desktop', 'mobile']);
    expect([...CLIENT_SESSION_STATES]).toEqual(['active', 'expired', 'revoked']);
    expect(isPlatformKind('web')).toBe(true);
    expect(isPlatformKind('tauri')).toBe(false);
    expect(isPlatformKind('expo')).toBe(false);
  });

  it('the platform capability domains are VENDOR-NEUTRAL (no tauri/expo/notify-io citizen)', () => {
    expect([...PLATFORM_CAPABILITY_DOMAINS]).toEqual([
      'notifications',
      'file-access',
      'window-management',
      'share',
      'camera',
    ]);
    expect(isCapabilityDomain('tauri-notification')).toBe(false);
    expect(isCapabilityDomain('expo-camera')).toBe(false);
  });

  it('the W057 product-area mirror: the seven areas in plan order', () => {
    expect([...PRODUCT_AREA_IDS]).toEqual([
      'chat',
      'today',
      'intelligence',
      'people',
      'connections',
      'marketplace',
      'more',
    ]);
  });

  it('the tower drill-down mirror: the fifteen surface slugs (W033/W057)', () => {
    expect(TOWER_SURFACE_SLUGS).toHaveLength(15);
    expect(TOWER_SURFACE_SLUGS[0]).toBe('today');
    expect(TOWER_SURFACE_SLUGS[14]).toBe('approvals');
  });

  it('the background-work + handoff vocabularies are closed', () => {
    expect([...BACKGROUND_WORK_SEAMS]).toEqual(['mission', 'execution-run', 'fabric-lease']);
    expect(BACKGROUND_WORK_PHASES).toHaveLength(7);
    expect([...HANDOFF_FOCUS_KINDS]).toEqual(['conversation', 'background-work', 'mission']);
    expect(HANDOFF_EVIDENCE_KINDS).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Validation guards (the typed input gates)
// ---------------------------------------------------------------------------

describe('validation guards', () => {
  it('the working context: focusSeam is required IFF the focus is background work', () => {
    expectCode('invalid_handoff_input', () =>
      validateHandoffWorkingContext(
        { focusKind: 'background-work', focusRef: 'run-1', draft: null, navigation: { area: 'chat' } },
        'invalid_handoff_input',
      ),
    );
    expectCode('invalid_handoff_input', () =>
      validateHandoffWorkingContext(
        {
          focusKind: 'conversation',
          focusRef: 'c-1',
          focusSeam: 'mission',
          draft: null,
          navigation: { area: 'chat' },
        },
        'invalid_handoff_input',
      ),
    );
    const valid = validateHandoffWorkingContext(
      {
        focusKind: 'background-work',
        focusRef: 'run-1',
        focusSeam: 'execution-run',
        draft: 'half-written',
        navigation: { area: 'intelligence', towerSurface: 'goals', focusRef: 'g-1' },
      },
      'invalid_handoff_input',
    );
    expect(valid.focusSeam).toBe('execution-run');
    expect(valid.draft).toBe('half-written');
    expect(valid.navigation.towerSurface).toBe('goals');
  });

  it('the working context: navigation must be a product area (optionally a tower slug)', () => {
    expectCode('invalid_handoff_input', () =>
      validateHandoffWorkingContext(
        { focusKind: 'mission', focusRef: 'm-1', draft: null, navigation: { area: 'spa' } },
        'invalid_handoff_input',
      ),
    );
    expectCode('invalid_handoff_input', () =>
      validateHandoffWorkingContext(
        {
          focusKind: 'mission',
          focusRef: 'm-1',
          draft: null,
          navigation: { area: 'today', towerSurface: 'not-a-surface' },
        },
        'invalid_handoff_input',
      ),
    );
  });

  it('the working context: draft is bounded and focus refs are bounded', () => {
    expectCode('invalid_handoff_input', () =>
      validateHandoffWorkingContext(
        {
          focusKind: 'conversation',
          focusRef: 'c-1',
          draft: 'x'.repeat(MAX_DRAFT_CHARS + 1),
          navigation: { area: 'chat' },
        },
        'invalid_handoff_input',
      ),
    );
    expectCode('invalid_handoff_input', () =>
      validateHandoffWorkingContext(
        { focusKind: 'conversation', focusRef: '', draft: null, navigation: { area: 'chat' } },
        'invalid_handoff_input',
      ),
    );
  });

  it('openHandoffSession input: the client session must be a uuid and the context valid', () => {
    expectCode('invalid_handoff_input', () =>
      validateOpenHandoffSessionInput({ clientSessionId: 'not-a-uuid', context: {} }),
    );
    const valid = validateOpenHandoffSessionInput({
      clientSessionId: '00000000-0000-4000-8000-0000000000a1',
      context: { focusKind: 'mission', focusRef: '00000000-0000-4000-8000-0000000000b2', draft: null, navigation: { area: 'intelligence' } },
    });
    expect(valid.context.focusKind).toBe('mission');
  });

  it('invokePlatformCapability: the input must canonicalize within bounds', () => {
    expectCode('invalid_capability_input', () =>
      validateInvokePlatformCapabilityInput({ platform: 'web', domain: 'camera', input: () => 1 }),
    );
    expectCode('invalid_capability_input', () =>
      validateInvokePlatformCapabilityInput({ platform: 'web', domain: 'telepathy', input: {} }),
    );
    expectCode('invalid_capability_input', () =>
      validateInvokePlatformCapabilityInput({ platform: 'watchos', domain: 'camera', input: {} }),
    );
    const valid = validateInvokePlatformCapabilityInput({
      platform: 'mobile',
      domain: 'share',
      input: { text: 'look at this' },
    });
    expect(valid.platform).toBe('mobile');
    expect(valid.domain).toBe('share');
  });

  it('readShellModel: the optional focus follows the same focus rules', () => {
    expectCode('invalid_query', () =>
      validateReadShellModelQuery({ focus: { focusKind: 'background-work', focusRef: 'x' } }),
    );
    const valid = validateReadShellModelQuery({
      focus: { focusKind: 'background-work', focusRef: 'x', focusSeam: 'fabric-lease' },
    });
    expect(valid.focus?.focusSeam).toBe('fabric-lease');
    expect(validateReadShellModelQuery({}).focus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The deterministic platform adapter doubles
// ---------------------------------------------------------------------------

describe('platform adapter doubles', () => {
  it('web double: honest descriptor — window-management unsupported, the rest served', async () => {
    const adapter = createWebPlatformAdapter();
    const descriptor = await adapter.probe();
    expect(descriptor.platform).toBe('web');
    expect(descriptor.health).toBe('available');
    const byDomain = new Map(descriptor.capabilities.map((entry) => [entry.domain, entry.supported]));
    expect(byDomain.get('window-management')).toBe(false);
    expect(byDomain.get('notifications')).toBe(true);
    expect(byDomain.get('file-access')).toBe(true);
    expect(byDomain.get('share')).toBe(true);
    expect(byDomain.get('camera')).toBe(true);
  });

  it('desktop double: window-management served, share refused (the power-client surface)', async () => {
    const descriptor = await createDesktopPlatformAdapter().probe();
    expect(descriptor.platform).toBe('desktop');
    const byDomain = new Map(descriptor.capabilities.map((entry) => [entry.domain, entry.supported]));
    expect(byDomain.get('window-management')).toBe(true);
    expect(byDomain.get('share')).toBe(false);
  });

  it('mobile double: share + camera served, window-management refused (the field-client surface)', async () => {
    const descriptor = await createMobilePlatformAdapter().probe();
    expect(descriptor.platform).toBe('mobile');
    const byDomain = new Map(descriptor.capabilities.map((entry) => [entry.domain, entry.supported]));
    expect(byDomain.get('share')).toBe(true);
    expect(byDomain.get('camera')).toBe(true);
    expect(byDomain.get('window-management')).toBe(false);
  });

  it('invocations are served deterministically and recorded in the read-only proof log', async () => {
    const adapter = createWebPlatformAdapter();
    const receipt = await adapter.invoke({ domain: 'notifications', input: { title: 'hi' } });
    expect(receipt.adapterId).toBe('web-platform-sim-1');
    expect(receipt.domain).toBe('notifications');
    expect(typeof receipt.servedAt).toBe('string');
    expect(adapter.state.invocations).toEqual([{ domain: 'notifications', input: { title: 'hi' } }]);
    expect(adapter.state.invokeCalls).toBe(1);
  });

  it('scriptable vendor failures throw honestly (never a fabricated receipt)', async () => {
    const adapter = createMobilePlatformAdapter({ invokeFailures: 1 });
    await expect(adapter.invoke({ domain: 'camera', input: {} })).rejects.toThrow(/scripted/);
    const receipt = await adapter.invoke({ domain: 'camera', input: {} });
    expect(receipt.domain).toBe('camera');
    expect(adapter.state.invokeCalls).toBe(2);
    expect(adapter.state.invocations).toHaveLength(1);
  });

  it('vendor identity is METADATA only — descriptor strings, never typed vocabulary', async () => {
    const descriptors = await Promise.all([
      createWebPlatformAdapter().probe(),
      createDesktopPlatformAdapter().probe(),
      createMobilePlatformAdapter().probe(),
    ]);
    for (const descriptor of descriptors) {
      expect(descriptor.vendor.vendorName).toMatch(/^aurum-(web|desktop|mobile)-sim$/);
      // The typed vocabulary stays vendor-neutral (the W131 law).
      for (const capability of descriptor.capabilities) {
        expect(PLATFORM_CAPABILITY_DOMAINS).toContain(capability.domain);
      }
    }
  });
});
