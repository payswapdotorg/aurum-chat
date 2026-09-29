// Auth API (W116) — POST /api/auth/sign-out-everywhere (revoke every session).

import { handleSignOutEverywherePost } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleSignOutEverywherePost(request));
}
