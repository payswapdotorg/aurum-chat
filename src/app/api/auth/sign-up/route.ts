// W058 — POST /api/auth/sign-up: create an account, open a session.

import { handleSignUp, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleSignUp(request, await parseJsonBody(request)));
}
