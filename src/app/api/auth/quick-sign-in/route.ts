// Auth API (post-W070 UX hardening) — POST /api/auth/quick-sign-in.
//
// One-tap sign-in for the seeded demo personas (W068 harness). The handler
// lives in the auth lib (same thin-adapter discipline as every /api/auth
// route): the server resolves the persona's fixed demo credentials and
// drives the REAL signIn contract — sessions, cookies and authority are
// identical to the password form. Fail-closed outside the demo-legal
// runtimes (see quickSignInAvailable).

import { handleQuickSignIn } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleQuickSignIn(request));
}
