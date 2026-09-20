// W058 — POST /api/auth/invitations/revoke: withdraw an open invitation.

import { handleInvitationRevoke, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleInvitationRevoke(request, await parseJsonBody(request)));
}
