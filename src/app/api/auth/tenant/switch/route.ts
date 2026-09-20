// W058 — POST /api/auth/tenant/switch: switch the session's active
// company (membership-verified in the auth contract).

import { handleTenantSwitch, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleTenantSwitch(request, await parseJsonBody(request)));
}
