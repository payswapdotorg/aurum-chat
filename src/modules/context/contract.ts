// ============================================================================
// context — public contract surface (W124b TL-frozen stage).
//
// Cross-module imports must target exactly '@/modules/context/contract'.
// W134 extends this surface with the operational fingerprint derivation API
// while keeping these exports intact.
// ============================================================================

export type {
  SeasonalContext,
  DurationClass,
  DurationContext,
  StaffingContext,
  WorkloadLevel,
  CapabilityAvailabilityContext,
  EnvironmentContext,
  ConstraintContext,
  EvidenceFreshnessContext,
  ContextFingerprint,
  ContextFingerprintSummary,
} from './types';
