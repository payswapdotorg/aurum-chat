// W058 — POST /api/auth/company: create a company (onboarding).

import { handleCompanyCreate, parseJsonBody } from '@/app/(auth)/lib/auth-api';
import { toAuthResponse } from '@/app/(auth)/lib/auth-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return toAuthResponse(await handleCompanyCreate(request, await parseJsonBody(request)));
}
