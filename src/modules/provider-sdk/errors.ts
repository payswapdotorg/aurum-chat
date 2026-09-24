// Typed errors of the provider-sdk module. Consumers catch `ProviderSdkError`
// and branch on `code`; messages are for humans/logs, never for control flow.

export type ProviderSdkErrorCode =
  /** A ProviderAdapterDefinition (or its inputs) is malformed. */
  | 'invalid_definition'
  /** A lifecycle dispatch violates the canonical transition table. */
  | 'illegal_lifecycle_transition'
  /** A capability set is malformed. */
  | 'invalid_capability_set'
  /** Hot-swap evidence (or its inputs) is malformed. */
  | 'invalid_evidence'
  /** A technology registry entry is malformed. */
  | 'invalid_registry_entry';

export class ProviderSdkError extends Error {
  constructor(
    public readonly code: ProviderSdkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderSdkError';
  }
}
