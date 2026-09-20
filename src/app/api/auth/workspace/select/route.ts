// W058 — POST /api/auth/workspace/select: select the active workspace
// inside the active company.

import { handleWorkspaceSelect, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleWorkspaceSelect(request, await parseJsonBody(request)));
}
