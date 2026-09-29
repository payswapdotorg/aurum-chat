// Platform admin API (W116) — POST /api/platform/waitlist/accept.

import { handleWaitlistAcceptPost } from '@/app/(platform)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleWaitlistAcceptPost(request));
}
