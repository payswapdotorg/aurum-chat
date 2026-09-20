// W058 — POST /api/auth/session/renew: explicit session renewal.

import { handleSessionRenew } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleSessionRenew(request));
}
