// The adapter-definition factory (W089): the template function every
// conforming provider adapter calls to adopt the SDK lifecycle/error/
// capability contract without changing its gateway-native behavior.
//
// The factory validates the descriptor ONCE (fail loudly at construction —
// a malformed adapter must never reach a gateway registry) and returns a
// ProviderAdapterDefinition whose mapError delegates to the canonical
// normalization pipeline (provider classifier first, SDK heuristics second,
// unknown_failure last).
//
// Purity: no database, no clock, no network, no provider SDKs. The
// definition has NO execution method and NO selection logic — routing and
// policy stay in the owning gateway (W089 acceptance: "provider selection
// stays outside domain logic").

import { ProviderSdkError } from './errors';
import { normalizeProviderError } from './normalization';
import type {
  ProviderAdapterDefinition,
  ProviderAdapterDefinitionInput,
  ProviderCapabilitySet,
} from './types';
import { PROVIDER_ADAPTER_SDK_VERSION } from './types';

const MAX_KEY_LENGTH = 64;

function validateKey(value: string, field: string): void {
  if (value.trim() === '') {
    throw new ProviderSdkError('invalid_definition', `adapter definition ${field} must not be empty`);
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw new ProviderSdkError(
      'invalid_definition',
      `adapter definition ${field} must be at most ${MAX_KEY_LENGTH} characters (got ${value.length})`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) {
    throw new ProviderSdkError(
      'invalid_definition',
      `adapter definition ${field} must be a lowercase kebab-case key (got '${value}')`,
    );
  }
}

/**
 * Create the canonical adapter definition for one provider of one gateway.
 * Throws ProviderSdkError('invalid_definition') on a malformed descriptor.
 */
export function createProviderAdapterDefinition(
  input: ProviderAdapterDefinitionInput,
): ProviderAdapterDefinition {
  if (typeof input.gateway !== 'string') {
    throw new ProviderSdkError('invalid_definition', 'adapter definition gateway must be a string');
  }
  if (typeof input.provider !== 'string') {
    throw new ProviderSdkError('invalid_definition', 'adapter definition provider must be a string');
  }
  validateKey(input.gateway, 'gateway');
  validateKey(input.provider, 'provider');

  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    throw new ProviderSdkError(
      'invalid_definition',
      `adapter definition ${input.gateway}/${input.provider} must declare at least one capability`,
    );
  }
  const seen = new Set<string>();
  for (const capability of input.capabilities) {
    if (typeof capability !== 'string' || capability.trim() === '') {
      throw new ProviderSdkError(
        'invalid_definition',
        `adapter definition ${input.gateway}/${input.provider} capabilities must be non-empty strings`,
      );
    }
    if (seen.has(capability)) {
      throw new ProviderSdkError(
        'invalid_definition',
        `adapter definition ${input.gateway}/${input.provider} declares duplicate capability '${capability}'`,
      );
    }
    seen.add(capability);
  }
  const capabilities = Object.freeze([...input.capabilities]);

  const capabilitySet: ProviderCapabilitySet = Object.freeze({
    sdk: 'provider-capability-set',
    gateway: input.gateway,
    provider: input.provider,
    capabilities,
  }) as ProviderCapabilitySet;

  return {
    sdk: 'provider-adapter-definition',
    sdkVersion: PROVIDER_ADAPTER_SDK_VERSION,
    gateway: input.gateway,
    provider: input.provider,
    describeCapabilities: () => capabilitySet,
    mapError: (error: unknown) =>
      normalizeProviderError(error, {
        gateway: input.gateway,
        provider: input.provider,
        classify: input.classifyError ?? null,
      }),
  };
}
