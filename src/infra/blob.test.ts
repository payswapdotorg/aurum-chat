// Unit tests for the object-storage port (W069): memory backend round
// trip, the per-object size guardrail, input validation, and the
// Vercel Blob adapter boundary (SDK stubbed at the module seam — no
// network, no token).
//
// Provider credentials in tests are assembled from fragments at runtime
// (never a realistic full token literal in source — push protection).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeBlobStore, getBlobStore, putBlobObject } from './blob';

const blobSdkMock = vi.hoisted(() => ({
  put: vi.fn(),
  del: vi.fn(),
}));
vi.mock('@vercel/blob', () => blobSdkMock);

beforeEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  closeBlobStore();
  blobSdkMock.put.mockReset();
  blobSdkMock.del.mockReset();
});

afterEach(() => {
  delete process.env.BLOB_READ_WRITE_TOKEN;
  closeBlobStore();
});

const DATA = new Uint8Array([1, 2, 3, 4, 5]);

describe('memory backend (default dev/test path)', () => {
  it('round-trips put/get/del by the returned URL', async () => {
    const stored = await getBlobStore().put({ key: 'evidence/report-1', data: DATA, contentType: 'application/pdf' });
    expect(stored).toMatchObject({
      key: 'evidence/report-1',
      size: 5,
      provider: 'memory',
    });
    expect(stored.url).toBe('memory://blob/evidence/report-1');

    const fetched = await getBlobStore().get(stored.url);
    expect(fetched).toEqual(DATA);

    await getBlobStore().del(stored.url);
    expect(await getBlobStore().get(stored.url)).toBeNull();
    // Deletes are idempotent.
    await expect(getBlobStore().del(stored.url)).resolves.toBeUndefined();
  });

  it('closeBlobStore resets the store (dev objects are never durable state)', async () => {
    const stored = await getBlobStore().put({ key: 'tmp/scratch', data: DATA });
    closeBlobStore();
    expect(await getBlobStore().get(stored.url)).toBeNull();
  });
});

describe('input validation + size guardrail', () => {
  it('rejects malformed keys, data and content types', async () => {
    await expect(putBlobObject({ key: '/leading-slash', data: DATA }, 1024)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(putBlobObject({ key: 'has spaces', data: DATA }, 1024)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      putBlobObject({ key: 'ok', data: 'nope' as unknown as Uint8Array }, 1024),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      putBlobObject({ key: 'ok', data: DATA, contentType: 'not a type' }, 1024),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects objects past the per-object cap before any backend call', async () => {
    await expect(putBlobObject({ key: 'big/object', data: DATA }, 4)).rejects.toMatchObject({
      code: 'too_large',
      message: expect.stringContaining('5 bytes'),
    });
    // Nothing was stored.
    expect(await getBlobStore().get('memory://blob/big/object')).toBeNull();
  });

  it('maxBytes 0 disables the cap', async () => {
    const stored = await putBlobObject({ key: 'unlimited/object', data: DATA }, 0);
    expect(stored.size).toBe(5);
  });
});

describe('Vercel Blob adapter boundary (SDK stub — no network)', () => {
  function assembleToken(): string {
    // Fragment assembly: never a realistic full token literal in source.
    return ['vercel_', 'blob', '_rw_placeholder'].join('');
  }

  it('delegates put/del to the SDK with deterministic keys and the token', async () => {
    const token = assembleToken();
    process.env.BLOB_READ_WRITE_TOKEN = token;
    closeBlobStore();

    blobSdkMock.put.mockResolvedValue({
      url: 'https://example.blob.storage.dev/evidence/report-1',
      pathname: 'evidence/report-1',
    });
    blobSdkMock.del.mockResolvedValue(undefined);

    const stored = await getBlobStore().put({ key: 'evidence/report-1', data: DATA, contentType: 'application/pdf' });
    expect(stored).toMatchObject({
      url: 'https://example.blob.storage.dev/evidence/report-1',
      key: 'evidence/report-1',
      size: 5,
      provider: 'vercel-blob',
    });
    expect(blobSdkMock.put).toHaveBeenCalledWith('evidence/report-1', DATA, {
      access: 'public',
      token,
      contentType: 'application/pdf',
      addRandomSuffix: false,
    });

    await getBlobStore().del(stored.url);
    expect(blobSdkMock.del).toHaveBeenCalledWith(stored.url, { token });
  });

  it('maps SDK failures to provider_error', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = assembleToken();
    closeBlobStore();
    blobSdkMock.put.mockRejectedValue(new Error('store suspended'));

    await expect(getBlobStore().put({ key: 'x/y', data: DATA })).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('store suspended'),
    });
  });
});
