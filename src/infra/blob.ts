// Blob port: object storage for large artifacts ONLY (documents, evidence
// artifacts, extension packages, generated files — plan §7) — never domain
// truth. Domain state lives in PostgreSQL (lock 35); a blob URL stored in
// a domain row is an opaque reference, exactly like any other external
// resource reference.
//
// Backends (W069 — plan §7 free-tier dogfood stack):
//   * `vercel-blob` — BLOB_READ_WRITE_TOKEN set: the official `@vercel/blob`
//     SDK, imported lazily so the memory path stays dependency-free (the
//     same discipline as ioredis in the queue port). Deterministic keys
//     (addRandomSuffix: false) so an artifact's URL is reproducible from
//     its key; objects are addressed by the URL the provider returns.
//   * `memory` — default dev/test: an in-process store addressed by
//     `memory://blob/<key>` URLs. Objects do not survive the process —
//     fine for dev because blob content is never authoritative state.
//
// Usage guardrail (plan §7 "usage guardrails"): each put is capped at
// AURUM_BLOB_MAX_BYTES (default 8 MiB) so a single upload cannot consume
// the Hobby-tier store budget (1 GB total).

import { envString } from './config';
import { now } from './clock';

/** Input of one object put. */
export interface BlobPutInput {
  /** Object key: 1..512 chars of [A-Za-z0-9/._-], no leading '/'. */
  key: string;
  data: Uint8Array;
  contentType?: string;
}

/** What a successful put stored (no content echo). */
export interface BlobStored {
  url: string;
  key: string;
  size: number;
  provider: 'memory' | 'vercel-blob';
  storedAt: string;
}

export type BlobErrorCode = 'invalid_input' | 'too_large' | 'provider_error';

export class BlobError extends Error {
  constructor(
    public readonly code: BlobErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'BlobError';
  }
}

export interface BlobPort {
  put(input: BlobPutInput): Promise<BlobStored>;
  /** Fetch one object by its URL; null when it does not exist. */
  get(url: string): Promise<Uint8Array | null>;
  /** Delete one object by its URL (idempotent). */
  del(url: string): Promise<void>;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,511}$/;

function isValidKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

function isValidContentType(contentType: unknown): boolean {
  return (
    contentType === undefined ||
    (typeof contentType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(contentType))
  );
}

function assertPutInput(input: unknown): BlobPutInput {
  if (typeof input !== 'object' || input === null) {
    throw new BlobError('invalid_input', 'blob put requires an input object');
  }
  const candidate = input as Partial<BlobPutInput>;
  if (!isValidKey(candidate.key)) {
    throw new BlobError(
      'invalid_input',
      "blob key must match [A-Za-z0-9][A-Za-z0-9/._-]{0,511} (no leading '/')",
    );
  }
  if (!(candidate.data instanceof Uint8Array)) {
    throw new BlobError('invalid_input', 'blob data must be a Uint8Array');
  }
  if (!isValidContentType(candidate.contentType)) {
    throw new BlobError('invalid_input', 'blob contentType must look like type/subtype');
  }
  return candidate as BlobPutInput;
}

interface MemoryStore {
  objects: Map<string, { data: Uint8Array; contentType: string | undefined }>;
}

function memoryUrl(key: string): string {
  return `memory://blob/${key}`;
}

function memoryBlobBackend(store: MemoryStore): BlobPort {
  return {
    async put(input) {
      const url = memoryUrl(input.key);
      store.objects.set(url, { data: input.data, contentType: input.contentType });
      return {
        url,
        key: input.key,
        size: input.data.byteLength,
        provider: 'memory',
        storedAt: now().toISOString(),
      };
    },
    async get(url) {
      const object = store.objects.get(url);
      return object === undefined ? null : object.data;
    },
    async del(url) {
      store.objects.delete(url);
    },
  };
}

interface VercelBlobApi {
  put(
    pathname: string,
    data: Uint8Array,
    options: {
      access: 'public';
      token: string;
      contentType?: string;
      addRandomSuffix: false;
    },
  ): Promise<{ url: string; pathname: string }>;
  del(url: string, options: { token: string }): Promise<unknown>;
}

async function vercelBlobBackend(token: string): Promise<BlobPort> {
  const sdk = (await import('@vercel/blob')) as unknown as VercelBlobApi;
  return {
    async put(input) {
      let stored: { url: string; pathname: string };
      try {
        stored = await sdk.put(input.key, input.data, {
          access: 'public',
          token,
          contentType: input.contentType,
          // Deterministic keys: an artifact URL must be reproducible from
          // its key (evidence deep-links, extension artifacts).
          addRandomSuffix: false,
        });
      } catch (error) {
        throw new BlobError(
          'provider_error',
          `vercel blob put failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
      return {
        url: stored.url,
        key: input.key,
        size: input.data.byteLength,
        provider: 'vercel-blob',
        storedAt: now().toISOString(),
      };
    },
    async get(url) {
      let response: Response;
      try {
        response = await fetch(url);
      } catch (error) {
        throw new BlobError(
          'provider_error',
          `blob get failed: ${error instanceof Error ? error.message : 'network error'}`,
        );
      }
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new BlobError('provider_error', `blob get failed (HTTP ${response.status})`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async del(url) {
      try {
        await sdk.del(url, { token });
      } catch (error) {
        throw new BlobError(
          'provider_error',
          `vercel blob del failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    },
  };
}

interface BlobGlobal {
  __aurumBlobPort?: BlobPort;
  __aurumBlobStore?: MemoryStore;
}
const blobGlobal = globalThis as unknown as BlobGlobal;

/**
 * The object-storage port (singleton; backend chosen once from the
 * environment — BLOB_READ_WRITE_TOKEN selects Vercel Blob, otherwise
 * memory).
 */
export function getBlobStore(): BlobPort {
  blobGlobal.__aurumBlobPort ??= (() => {
    const token = envString('BLOB_READ_WRITE_TOKEN');
    if (token === undefined) {
      const store: MemoryStore = { objects: new Map() };
      blobGlobal.__aurumBlobStore = store;
      return memoryBlobBackend(store);
    }
    // The lazy SDK import is async; expose a port that awaits it once.
    let backendPromise: Promise<BlobPort> | null = null;
    return {
      put(input) {
        backendPromise ??= vercelBlobBackend(token);
        return backendPromise.then((backend) => backend.put(input));
      },
      get(url) {
        backendPromise ??= vercelBlobBackend(token);
        return backendPromise.then((backend) => backend.get(url));
      },
      del(url) {
        backendPromise ??= vercelBlobBackend(token);
        return backendPromise.then((backend) => backend.del(url));
      },
    };
  })();
  return blobGlobal.__aurumBlobPort;
}

/** Reset the singleton (and the memory store) — tests and process shutdown. */
export function closeBlobStore(): void {
  blobGlobal.__aurumBlobPort = undefined;
  blobGlobal.__aurumBlobStore = undefined;
}

/**
 * Store one object with the per-object size guardrail applied
 * (`maxBytes` from the deployment guardrails; non-positive disables).
 */
export async function putBlobObject(
  input: BlobPutInput,
  maxBytes: number,
): Promise<BlobStored> {
  const validated = assertPutInput(input);
  if (maxBytes > 0 && validated.data.byteLength > maxBytes) {
    throw new BlobError(
      'too_large',
      `object '${validated.key}' is ${validated.data.byteLength} bytes — the per-object cap is ${maxBytes} (AURUM_BLOB_MAX_BYTES)`,
    );
  }
  return getBlobStore().put(validated);
}
