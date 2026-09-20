// W058 — POST /api/auth/invitations/inspect: what an invite link reveals
// to its holder (public — the token itself is the authorization).

import { handleInvitationInspect, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleInvitationInspect(request, await parseJsonBody(request)));
}
