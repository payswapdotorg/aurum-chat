// The external-participation egress port of the extensions module
// (W026 — General-Purpose Extension Runtime).
//
// §17 gives the runtime "scoped external participants": an extension's
// declared https origins are the ONLY destinations it may call, and the
// calls themselves are executed through THIS port — the host wires it,
// the runtime never reaches for ambient network access. That keeps
// egress an infrastructure concern (like db/queue/lock in src/infra,
// but extension-runtime-specific, so it lives with its only consumer),
// keeps tests deterministic (fakes injected via setExtensionHttpPort),
// and keeps the domain operation — validate scope, enforce quota,
// record the outcome — pure of transport details.
//
// The default port performs a real, bounded HTTPS call (timeout; the
// response body is read fully but only the first
// MAX_RESPONSE_BODY_CHARS characters are retained — the recorded
// detail of a call is never the payload firehose). Tests and hosts that
// want no network replace it with their own.

import type { ExtensionHttpMethod } from './runtime';

/** How long the default port waits before aborting an external call. */
export const EXTENSION_HTTP_TIMEOUT_MS = 10_000;

/** How much of a response body the runtime ever retains. */
export const MAX_RESPONSE_BODY_CHARS = 4_096;

/** One outbound external-participation request (already scope-checked). */
export interface ExtensionHttpCall {
  /** `origin + path` of the call — origin is a declared participant. */
  url: string;
  method: ExtensionHttpMethod;
  /** Bounded, plain string map; never recorded in call evidence. */
  headers: Record<string, string>;
  /** Serialized JSON body (null when the method carries none). */
  body: string | null;
}

/** The bounded response the runtime records outcomes from. */
export interface ExtensionHttpResponse {
  status: number;
  /** First ≤ MAX_RESPONSE_BODY_CHARS characters of the body, or null. */
  bodyText: string | null;
}

/**
 * The egress port. A port that cannot reach the participant throws —
 * the runtime records the call with outcome 'failed' and the error's
 * bounded message.
 */
export type ExtensionHttpPort = (call: ExtensionHttpCall) => Promise<ExtensionHttpResponse>;

async function defaultFetchPort(call: ExtensionHttpCall): Promise<ExtensionHttpResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTENSION_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(call.url, {
      method: call.method,
      headers: call.headers,
      body: call.body,
      signal: controller.signal,
      redirect: 'error',
    });
    let bodyText: string | null = null;
    try {
      const text = await response.text();
      bodyText = text.slice(0, MAX_RESPONSE_BODY_CHARS);
    } catch {
      bodyText = null;
    }
    return { status: response.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

let currentPort: ExtensionHttpPort = defaultFetchPort;

/**
 * Replace the egress port (tests inject fakes; hosts wire their own
 * transport). Passing null restores the default bounded fetch port.
 */
export function setExtensionHttpPort(port: ExtensionHttpPort | null): void {
  currentPort = port === null ? defaultFetchPort : port;
}

/** The active egress port (the runtime's only network touchpoint). */
export function extensionHttpPort(): ExtensionHttpPort {
  return currentPort;
}
