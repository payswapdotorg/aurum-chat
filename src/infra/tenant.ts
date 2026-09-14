// Tenant context: the explicit execution context every module contract call
// receives (tenant id + principal + authority claims).
//
// IMPLEMENTATION-STACK §8: "every contract call takes an explicit
// TenantContext ...; no ambient global" — `withTenant` therefore only passes
// the context explicitly; it never stores it anywhere.

export interface TenantContext {
  tenantId: string;
  principalId: string;
  authority: string[];
}

/** Tiny helper (mainly for tests/adapters): run `fn` with an explicit context. */
export async function withTenant<T>(
  context: TenantContext,
  fn: (context: TenantContext) => Promise<T>,
): Promise<T> {
  return fn(context);
}
