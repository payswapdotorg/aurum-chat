// Platform admin API (W116) — POST /api/platform/waitlist/decline.

import { handleWaitlistDeclinePost } from '@/app/(platform)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return authApiResponse(await handleWaitlistDeclinePost(request));
}
