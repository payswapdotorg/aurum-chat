// Auth API (W058) — POST /api/auth/invite (create) and GET (roster).

import { handleInviteCreatePost, handleInviteListGet } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleInviteCreatePost(request));
}

export async function GET(request: Request) {
  return authApiResponse(await handleInviteListGet(request));
}
