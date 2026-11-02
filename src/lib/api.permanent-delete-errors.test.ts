// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const store = new Map<string, string>();
const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
let fetchQueue: Array<() => Promise<Response>> = [];

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));

mock.module('expo-constants', () => ({
  default: { expoConfig: { extra: { apiUrl: 'https://api.test' } } },
}));

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-file-system/legacy', () => ({}));

mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  isNativeAvailable: true,
  opaqueLoginStart: async () => ({ state: new Uint8Array([1]), message: new Uint8Array([2]) }),
  opaqueLoginFinish: async () => ({ message: new Uint8Array([3]) }),
}));

mock.module('./file-index-cache', () => ({
  clearCachedFileIndex: async () => {},
}));

mock.module('./sync-client', () => ({
  getDeviceId: async () => 'device-1',
}));

mock.module('./announcement-context', () => ({
  setAnnouncement: () => {},
  clearAnnouncement: () => {},
}));

mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

const TOKEN_KEY = 'beebeeb_session_token';
const FILE_ID = '11111111-1111-4111-8111-111111111111';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function loadFreshApi() {
  return import(`./api?permanentDeleteErrorsTest=${Math.random()}`);
}

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
  store.set(TOKEN_KEY, 'session-token');
});

describe('permanent delete conflict codes', () => {
  for (const code of ['has_live_descendants', 'not_trashed']) {
    test(`preserves ${code} on ApiError`, async () => {
      fetchQueue.push(async () => jsonResponse({
        error: code,
        message: `Permanent delete refused: ${code}`,
      }, 409));

      const { ApiError, permanentDeleteFile } = await loadFreshApi();
      const err = await permanentDeleteFile(FILE_ID, 'confirmation-token').catch((caught) => caught);

      expect(err).toBeInstanceOf(ApiError);
      expect(err.status).toBe(409);
      expect(err.code).toBe(code);
      expect(err.message).toBe(`Permanent delete refused: ${code}`);

      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toBe(`https://api.test/api/v1/files/${FILE_ID}/permanent`);
      expect(fetchCalls[0].init.method).toBe('DELETE');
      expect(fetchCalls[0].init.headers).toMatchObject({
        'X-Confirm-Token': 'confirmation-token',
      });
    });
  }
});

describe('restore response completion state', () => {
  test('normalizes the synchronous 200 body as complete', async () => {
    fetchQueue.push(async () => jsonResponse({
      message: 'restored',
      restored_count: 3,
      rehomed_to_root: true,
    }));

    const { restoreFile } = await loadFreshApi();

    await expect(restoreFile(FILE_ID)).resolves.toEqual({
      complete: true,
      restored_count: 3,
      remaining: 0,
      rehomed_to_root: true,
    });
  });

  test('preserves the asynchronous 202 body as incomplete', async () => {
    fetchQueue.push(async () => jsonResponse({
      message: 'restoring',
      restored_count: 500,
      remaining: 750,
      complete: false,
      job_id: 'restore-job-1',
      rehomed_to_root: false,
    }, 202));

    const { restoreFile } = await loadFreshApi();

    await expect(restoreFile(FILE_ID)).resolves.toEqual({
      complete: false,
      restored_count: 500,
      remaining: 750,
      job_id: 'restore-job-1',
      rehomed_to_root: false,
    });
  });
});

describe('bulk permanent delete production contract', () => {
  test('sends one confirmed POST and returns the per-item success sets', async () => {
    fetchQueue.push(async () => jsonResponse({
      deleted: ['deleted'],
      skipped_not_trashed: ['restored'],
      missing: ['gone'],
    }));

    const { permanentDeleteFiles } = await loadFreshApi();
    const result = await permanentDeleteFiles(
      ['deleted', 'restored', 'gone'],
      'confirmation-token',
    );

    expect(result).toEqual({
      deleted: ['deleted'],
      skipped_not_trashed: ['restored'],
      missing: ['gone'],
      refused: [],
      cycles: [],
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({
      url: 'https://api.test/api/v1/files/permanent',
      init: {
        method: 'POST',
        headers: { 'X-Confirm-Token': 'confirmation-token' },
        body: JSON.stringify({ ids: ['deleted', 'restored', 'gone'] }),
      },
    });
  });

  test('returns partial success and refused IDs from a production 409 body', async () => {
    fetchQueue.push(async () => jsonResponse({
      error: 'has_live_descendants',
      message: 'One folder was kept. Everything else was deleted.',
      deleted: ['deleted'],
      skipped_not_trashed: ['restored'],
      missing: ['gone'],
      refused: [{ id: 'live-folder', live_descendants: 2, blocking_descendants: 2 }],
      cycles: ['cyclic-folder'],
    }, 409));

    const { permanentDeleteFiles } = await loadFreshApi();

    await expect(permanentDeleteFiles(
      ['deleted', 'restored', 'gone', 'live-folder', 'cyclic-folder'],
      'confirmation-token',
    )).resolves.toEqual({
      deleted: ['deleted'],
      skipped_not_trashed: ['restored'],
      missing: ['gone'],
      refused: [{ id: 'live-folder', live_descendants: 2, blocking_descendants: 2 }],
      cycles: ['cyclic-folder'],
    });
  });

  test('refuses to send more than the production 500-ID maximum', async () => {
    const { ApiError, permanentDeleteFiles } = await loadFreshApi();
    const ids = Array.from({ length: 501 }, (_, index) => `file-${index}`);

    const err = await permanentDeleteFiles(ids, 'confirmation-token').catch((caught) => caught);

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });
});
