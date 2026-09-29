// Auth API (W116) — POST /api/auth/password/change.
//
// Thin adapter: all logic lives in the (auth) group's lib/api.ts.

import { handlePasswordChangePost } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handlePasswordChangePost(request));
}
