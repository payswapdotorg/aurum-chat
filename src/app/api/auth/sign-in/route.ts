// W058 — POST /api/auth/sign-in: verify credentials, open a session.

import { handleSignIn, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleSignIn(request, await parseJsonBody(request)));
}
