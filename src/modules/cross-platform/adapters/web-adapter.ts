// The WEB adapter double (W139) — a DETERMINISTIC SIMULATION of the web
// platform's native capability surface, documented honestly: no browser,
// no Notification API, no getUserMedia, no network. Web is the CANONICAL
// client platform (CANONICAL_CLIENT_PLATFORM = 'web'); the real web
// adapter binds the browser APIs behind the SAME frozen shape — the
// domain contracts are identical either way (the vendor/platform-removal
// clause).
//
// The declared capability surface models what a browser can honestly do:
// notifications (the Notification API), file access (file inputs /
// drag-drop), share (navigator.share) and camera (getUserMedia) are
// supported; WINDOW MANAGEMENT is not (a browser tab does not own its
// window — the honest-descriptor law, an explicit `supported: false`).
//
// Vendor identity is METADATA on the descriptor ('aurum-web-sim') and
// appears nowhere in any domain record. Every invocation is recorded in
// a read-only log for proofs; scriptable failures make the vendor path
// throw so the service can stamp the typed failure honestly.

import { newId } from '@/infra/ids';
import type { ClientPlatformKind } from '@/modules/execution/contract';
import type {
  PlatformAdapter,
  PlatformAdapterDescriptor,
  PlatformCapabilityReceipt,
  PlatformCapabilityRequest,
} from '../types';

/** Options of {@link createWebPlatformAdapter}. */
export interface WebPlatformAdapterOptions {
  adapterId?: string;
  displayName?: string;
  /** How many consecutive invoke() calls throw (the scriptable vendor failure). */
  invokeFailures?: number;
}

/** Read-only adapter state for proofs (the provider side stays behind the seam). */
export interface WebPlatformAdapterState {
  readonly invocations: readonly { domain: string; input: unknown }[];
  readonly probeCalls: number;
  readonly invokeCalls: number;
}

/** The web adapter double plus its read-only proof surface. */
export interface WebPlatformAdapter extends PlatformAdapter {
  readonly state: WebPlatformAdapterState;
}

/** The deterministic web-platform simulation (the canonical client). */
export function createWebPlatformAdapter(
  options: WebPlatformAdapterOptions = {},
): WebPlatformAdapter {
  const adapterId = options.adapterId ?? 'web-platform-sim-1';
  const displayName = options.displayName ?? 'Web platform (deterministic simulation)';
  const invocations: { domain: string; input: unknown }[] = [];
  let probeCalls = 0;
  let invokeCalls = 0;
  let invokeFailures = options.invokeFailures ?? 0;

  const descriptor = (): PlatformAdapterDescriptor => ({
    adapterId,
    platform: 'web' as ClientPlatformKind,
    displayName,
    vendor: {
      vendorName: 'aurum-web-sim',
      vendorProduct: 'deterministic web-platform simulation',
      vendorAdapterVersion: '1',
    },
    capabilities: [
      { domain: 'notifications', supported: true, note: 'browser Notification API' },
      { domain: 'file-access', supported: true, note: 'file inputs and drag-drop' },
      { domain: 'window-management', supported: false, note: 'a browser tab does not own its window' },
      { domain: 'share', supported: true, note: 'navigator.share' },
      { domain: 'camera', supported: true, note: 'getUserMedia' },
    ],
    health: 'available',
  });

  return {
    adapterId,
    platform: 'web',

    async probe(): Promise<PlatformAdapterDescriptor> {
      probeCalls += 1;
      return descriptor();
    },

    async invoke(request: PlatformCapabilityRequest): Promise<PlatformCapabilityReceipt> {
      invokeCalls += 1;
      if (invokeFailures > 0) {
        invokeFailures -= 1;
        throw new Error(`web-platform simulation: vendor failure #${invokeCalls} (scripted)`);
      }
      invocations.push({ domain: request.domain, input: request.input });
      return {
        adapterId,
        domain: request.domain,
        servedAt: new Date().toISOString(),
        output: { webEcho: true, domain: request.domain, invocationId: `web-${newId()}` },
      };
    },

    state: {
      get invocations(): readonly { domain: string; input: unknown }[] {
        return invocations;
      },
      get probeCalls(): number {
        return probeCalls;
      },
      get invokeCalls(): number {
        return invokeCalls;
      },
    },
  };
}
