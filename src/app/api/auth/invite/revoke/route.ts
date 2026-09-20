// Auth API (W058) — POST /api/auth/invite/revoke.

import { handleInviteRevokePost } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleInviteRevokePost(request));
}
