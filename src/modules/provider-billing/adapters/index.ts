// First-party settlement adapters of the provider-billing module.
//
// Both adapters are conforming W089 ProviderAdapterDefinitions with
// materially different billing mechanics (charge-on-account vs prepaid
// draw-down) — the two-adapter pluggability proof the W089 SDK template
// mandates, applied to the settlement seam (the connection-broker module's
// nango/embedded precedent). No OSS dependency is introduced: both speak
// injected HTTP client ports, so the open-source reuse gate
// (TECHNOLOGY-RESEARCH-2026-09-23 / the W089 registry) records no new
// entry — nothing outside the repository is depended upon.

export {
  createPlatformAccountSettlementAdapter,
  PLATFORM_ACCOUNT_ADAPTER_KEY,
} from './platform-account';
export type { PlatformAccountAdapterConfig } from './platform-account';

export {
  createPrepaidBalanceSettlementAdapter,
  PREPAID_BALANCE_ADAPTER_KEY,
} from './prepaid-balance';
export type { PrepaidBalanceAdapterConfig } from './prepaid-balance';

export {
  SETTLEMENT_ADAPTER_CAPABILITIES,
  SETTLEMENT_GATEWAY,
  SettlementAdapterError,
  categoryForHttpStatus,
  createSettlementDialectHelpers,
  performRequest,
} from './shared';
export type {
  SettlementDialectHelpers,
  SettlementHttpClient,
  SettlementHttpRequest,
  SettlementHttpResponse,
} from './shared';
