// W058 — POST /api/auth/sign-out: revoke the session, clear the cookie.
// POST /api/auth/sign-out?everywhere=1 revokes every session of the
// account (the "sign out everywhere" affordance).

import { handleSignOut, handleSignOutAll } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (url.searchParams.get('everywhere') === '1') {
    return toAuthResponse(await handleSignOutAll(request));
  }
  return toAuthResponse(await handleSignOut(request));
}
