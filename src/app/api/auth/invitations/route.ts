// W058 — GET  /api/auth/invitations: the active company's invitation
//               roster (owner/admin).
//        POST /api/auth/invitations: issue an invitation (the raw invite
//               token is returned exactly once).

import {
  handleInvitationCreate,
  handleInvitationsGet,
  parseJsonBody,
} from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return toAuthResponse(await handleInvitationsGet(request));
}

export async function POST(request: Request) {
  return toAuthResponse(await handleInvitationCreate(request, await parseJsonBody(request)));
}
