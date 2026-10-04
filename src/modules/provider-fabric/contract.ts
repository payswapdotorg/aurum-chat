// ============================================================================
// provider-fabric — public contract surface (W124b TL-frozen stage).
//
// Cross-module imports must target exactly '@/modules/provider-fabric/contract'.
// W132 extends this surface with the operational fabric API (definition CRUD,
// discovery, binding management, health) while keeping these exports intact.
// ============================================================================

export type {
  WireProtocolKind,
  ProviderDefinitionKind,
  ProviderDefinition,
  ModelCatalogOrigin,
  ModelCatalogEntry,
  ModelDiscoveryState,
  ModelBindingPurpose,
  ModelBinding,
  ProviderHealthState,
} from './types';
