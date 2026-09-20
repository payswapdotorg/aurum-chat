// W058 — GET /api/auth/session: the current session + reachable
// companies (the chrome's account/switcher data).

import { handleSessionGet } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return toAuthResponse(await handleSessionGet(request));
}
