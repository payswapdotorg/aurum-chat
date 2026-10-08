// The DESKTOP adapter double (W139) — a DETERMINISTIC SIMULATION of the
// desktop power client's native capability surface, documented honestly:
// no Tauri 2 runtime, no OS notification center, no filesystem touch.
// Desktop is the POWER client (Tauri 2 is the product decision — recorded
// as vendor METADATA only, never a type); the real desktop adapter binds
// the Tauri plugin surface behind the SAME frozen shape.
//
// The declared capability surface models what a desktop shell honestly
// does: notifications (OS notification center), file access (native file
// dialogs / full workspace filesystem), window management (the desktop
// owns its windows) and camera are supported; SHARE is not (OS-level
// share sheets are mobile-first — the honest `supported: false`).
//
// Every invocation is recorded in a read-only log for proofs; scriptable
// failures make the vendor path throw so the service can stamp the typed
// failure honestly.

import { newId } from '@/infra/ids';
import type { ClientPlatformKind } from '@/modules/execution/contract';
import type {
  PlatformAdapter,
  PlatformAdapterDescriptor,
  PlatformCapabilityReceipt,
  PlatformCapabilityRequest,
} from '../types';

/** Options of {@link createDesktopPlatformAdapter}. */
export interface DesktopPlatformAdapterOptions {
  adapterId?: string;
  displayName?: string;
  /** How many consecutive invoke() calls throw (the scriptable vendor failure). */
  invokeFailures?: number;
}

/** Read-only adapter state for proofs (the provider side stays behind the seam). */
export interface DesktopPlatformAdapterState {
  readonly invocations: readonly { domain: string; input: unknown }[];
  readonly probeCalls: number;
  readonly invokeCalls: number;
}

/** The desktop adapter double plus its read-only proof surface. */
export interface DesktopPlatformAdapter extends PlatformAdapter {
  readonly state: DesktopPlatformAdapterState;
}

/** The deterministic desktop-platform simulation (the power client). */
export function createDesktopPlatformAdapter(
  options: DesktopPlatformAdapterOptions = {},
): DesktopPlatformAdapter {
  const adapterId = options.adapterId ?? 'desktop-platform-sim-1';
  const displayName = options.displayName ?? 'Desktop power client (deterministic simulation)';
  const invocations: { domain: string; input: unknown }[] = [];
  let probeCalls = 0;
  let invokeCalls = 0;
  let invokeFailures = options.invokeFailures ?? 0;

  const descriptor = (): PlatformAdapterDescriptor => ({
    adapterId,
    platform: 'desktop' as ClientPlatformKind,
    displayName,
    vendor: {
      vendorName: 'aurum-desktop-sim',
      vendorProduct: 'deterministic desktop-platform simulation (Tauri 2-shaped surface)',
      vendorAdapterVersion: '1',
    },
    capabilities: [
      { domain: 'notifications', supported: true, note: 'OS notification center' },
      { domain: 'file-access', supported: true, note: 'native file dialogs + workspace filesystem' },
      { domain: 'window-management', supported: true, note: 'the desktop owns its windows' },
      { domain: 'share', supported: false, note: 'no OS share sheet on the desktop path' },
      { domain: 'camera', supported: true, note: 'device camera capture' },
    ],
    health: 'available',
  });

  return {
    adapterId,
    platform: 'desktop',

    async probe(): Promise<PlatformAdapterDescriptor> {
      probeCalls += 1;
      return descriptor();
    },

    async invoke(request: PlatformCapabilityRequest): Promise<PlatformCapabilityReceipt> {
      invokeCalls += 1;
      if (invokeFailures > 0) {
        invokeFailures -= 1;
        throw new Error(`desktop-platform simulation: vendor failure #${invokeCalls} (scripted)`);
      }
      invocations.push({ domain: request.domain, input: request.input });
      return {
        adapterId,
        domain: request.domain,
        servedAt: new Date().toISOString(),
        output: { desktopEcho: true, domain: request.domain, invocationId: `dtk-${newId()}` },
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
