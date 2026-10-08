// The MOBILE adapter double (W139) — a DETERMINISTIC SIMULATION of the
// mobile field client's native capability surface, documented honestly:
// no Expo/React Native runtime, no push service, no camera hardware.
// Mobile is the FIELD client (Expo/React Native is the product decision
// — recorded as vendor METADATA only, never a type); the real mobile
// adapter binds the Expo APIs behind the SAME frozen shape.
//
// The declared capability surface models what a phone honestly does:
// notifications (push), share (the OS share sheet) and camera are
// supported; WINDOW MANAGEMENT is not (a phone app never owns its
// window); FILE ACCESS is declared 'restricted' semantics via the note
// (the document picker only — a bounded, honest subset of the domain,
// still `supported: true` with the limit stated in non-sensitive
// metadata, per the W131 limits discipline).
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

/** Options of {@link createMobilePlatformAdapter}. */
export interface MobilePlatformAdapterOptions {
  adapterId?: string;
  displayName?: string;
  /** How many consecutive invoke() calls throw (the scriptable vendor failure). */
  invokeFailures?: number;
}

/** Read-only adapter state for proofs (the provider side stays behind the seam). */
export interface MobilePlatformAdapterState {
  readonly invocations: readonly { domain: string; input: unknown }[];
  readonly probeCalls: number;
  readonly invokeCalls: number;
}

/** The mobile adapter double plus its read-only proof surface. */
export interface MobilePlatformAdapter extends PlatformAdapter {
  readonly state: MobilePlatformAdapterState;
}

/** The deterministic mobile-platform simulation (the field client). */
export function createMobilePlatformAdapter(
  options: MobilePlatformAdapterOptions = {},
): MobilePlatformAdapter {
  const adapterId = options.adapterId ?? 'mobile-platform-sim-1';
  const displayName = options.displayName ?? 'Mobile field client (deterministic simulation)';
  const invocations: { domain: string; input: unknown }[] = [];
  let probeCalls = 0;
  let invokeCalls = 0;
  let invokeFailures = options.invokeFailures ?? 0;

  const descriptor = (): PlatformAdapterDescriptor => ({
    adapterId,
    platform: 'mobile' as ClientPlatformKind,
    displayName,
    vendor: {
      vendorName: 'aurum-mobile-sim',
      vendorProduct: 'deterministic mobile-platform simulation (Expo/RN-shaped surface)',
      vendorAdapterVersion: '1',
    },
    capabilities: [
      { domain: 'notifications', supported: true, note: 'push notifications' },
      { domain: 'file-access', supported: true, note: 'document picker only (restricted subset)' },
      { domain: 'window-management', supported: false, note: 'a phone app never owns its window' },
      { domain: 'share', supported: true, note: 'OS share sheet' },
      { domain: 'camera', supported: true, note: 'device camera capture' },
    ],
    health: 'available',
  });

  return {
    adapterId,
    platform: 'mobile',

    async probe(): Promise<PlatformAdapterDescriptor> {
      probeCalls += 1;
      return descriptor();
    },

    async invoke(request: PlatformCapabilityRequest): Promise<PlatformCapabilityReceipt> {
      invokeCalls += 1;
      if (invokeFailures > 0) {
        invokeFailures -= 1;
        throw new Error(`mobile-platform simulation: vendor failure #${invokeCalls} (scripted)`);
      }
      invocations.push({ domain: request.domain, input: request.input });
      return {
        adapterId,
        domain: request.domain,
        servedAt: new Date().toISOString(),
        output: { mobileEcho: true, domain: request.domain, invocationId: `mob-${newId()}` },
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
