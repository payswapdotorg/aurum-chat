// W058 — POST /api/auth/invitations/accept: join the inviting company
// (the grant runs with the inviter's authority inside the organizations
// contract) and switch the session to it.

import { handleInvitationAccept, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleInvitationAccept(request, await parseJsonBody(request)));
}
