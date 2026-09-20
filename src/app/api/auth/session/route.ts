// Auth API (W058) — GET /api/auth/session.

import { handleSessionGet } from '@/app/(auth)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return authApiResponse(await handleSessionGet(request));
}
