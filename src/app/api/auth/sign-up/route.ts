// Auth API (W058) — POST /api/auth/sign-up.
//
// Thin adapter: all logic lives in the (auth) group's lib/api.ts.

import { handleSignUp } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleSignUp(request));
}
