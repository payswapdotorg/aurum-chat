// Platform admin API (W116) — GET /api/platform/waitlist (the review queue).

import { handleWaitlistListGet } from '@/app/(platform)/lib/api';
import { authApiResponse } from '@/app/(auth)/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return authApiResponse(await handleWaitlistListGet(request));
}
