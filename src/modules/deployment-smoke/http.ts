// The smoke driver's HTTP client (transport-only, no domain knowledge).
//
// A deliberately small fetch wrapper with the three properties a
// post-deployment smoke driver needs and a normal app client does not:
//
//   * MANUAL redirects — routing checks must observe the 307/308 chain
//     itself (Location header), never follow it silently;
//   * EXPLICIT cookies — the driver juggles several identities (the
//     fresh sign-up, the seeded manager persona, signed-out anonymous);
//     each request carries exactly the cookie the caller chooses, so no
//     session can leak between steps;
//   * HARD timeouts — a hosted dogfood on a free tier behind an
//     autosuspended database (Neon) may take seconds to wake; the driver
//     still must terminate deterministically (AbortSignal.timeout).
//
// Responses normalize what the evaluators consume: status, headers (as a
// plain record), the raw text, a best-effort parsed JSON body, the
// resolved redirect target, and every Set-Cookie header (verbatim, so
// session-cookie assertions see the exact flags).

/** One observed HTTP response. */
export interface SmokeHttpResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  /** The raw response body as text ('' when empty). */
  text: string;
  /** Parsed JSON body when the response is valid JSON, else null. */
  body: unknown;
  /** The Location header resolved against the base URL (null when absent). */
  location: string | null;
  /** Every Set-Cookie header value, in order. */
  setCookies: string[];
  /** Network/timeout failure (never thrown — observations, not exceptions). */
  error: string | null;
}

export interface SmokeHttpClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** Injectable fetch (unit tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function resolveUrl(baseUrl: string, path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

/** A response that could not be made at all (network/timeout/DNS). */
function unreachableResponse(url: string, error: unknown): SmokeHttpResponse {
  return {
    url,
    status: 0,
    headers: {},
    text: '',
    body: null,
    location: null,
    setCookies: [],
    error: error instanceof Error ? error.message : String(error),
  };
}

/** The smoke HTTP client (manual redirects, explicit cookies, hard timeouts). */
export class SmokeHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SmokeHttpClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get base(): string {
    return this.baseUrl;
  }

  /** Issue one request. Cookies are passed explicitly via headers. */
  async request(
    method: string,
    path: string,
    init: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<SmokeHttpResponse> {
    const url = resolveUrl(this.baseUrl, path);
    const headers: Record<string, string> = { ...init.headers };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      if (headers['content-type'] === undefined && headers['Content-Type'] === undefined) {
        headers['content-type'] = 'application/json';
      }
    }
    const fetchInit: RequestInit = {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, fetchInit as RequestInit);
    } catch (error) {
      return unreachableResponse(url, error);
    }
    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = null;
    }
    const headerRecord: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      headerRecord[key.toLowerCase()] = value;
    }
    const setCookies: string[] = [];
    // getSetCookie() preserves multiple Set-Cookie headers (Node 20+/Bun).
    if (typeof response.headers.getSetCookie === 'function') {
      setCookies.push(...response.headers.getSetCookie());
    } else if (headerRecord['set-cookie'] !== undefined) {
      setCookies.push(headerRecord['set-cookie']);
    }
    const locationHeader = response.headers.get('location');
    return {
      url,
      status: response.status,
      headers: headerRecord,
      text,
      body: parsed,
      location:
        locationHeader === null
          ? null
          : locationHeader.startsWith('http://') || locationHeader.startsWith('https://')
            ? locationHeader
            : resolveUrl(this.baseUrl, locationHeader),
      setCookies,
      error: null,
    };
  }

  get(path: string, headers?: Record<string, string>): Promise<SmokeHttpResponse> {
    return this.request('GET', path, { headers });
  }

  post(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<SmokeHttpResponse> {
    return this.request('POST', path, { body, headers });
  }
}

/** Extract the session token from a Set-Cookie value ('' when absent). */
export function sessionTokenFromSetCookie(setCookies: readonly string[]): string | null {
  for (const cookie of setCookies) {
    const match = /^aurum_session=([^;]+)/.exec(cookie);
    if (match !== null) {
      const token = match[1] ?? '';
      return token === '' ? null : token;
    }
  }
  return null;
}

/** The Cookie header value that presents one session token. */
export function sessionCookieHeader(token: string | null): Record<string, string> {
  return token === null ? {} : { cookie: `aurum_session=${token}` };
}
