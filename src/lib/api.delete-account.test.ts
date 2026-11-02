// @ts-nocheck
/**
 * Request-builder test for `requestAccountDeletion`: POST
 * /api/v1/account/delete/request with the step-up token in `X-Confirm-Token`
 * and the 2FA code in the body only when there is one. The server only sends
 * an email; nothing is deleted by this call.
 */
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
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('../../modules/beebeeb-crypto', () => ({
  mirrorBackupClientSession: async () => true,
  mirrorSessionToAppGroup: async () => true,
  isNativeUploadAvailable: () => false,
  planUploadChunksNative: () => ({ chunkSizeBytes: 0, chunkCount: 0 }),
  uploadChunksNative: async () => { throw new Error('native upload not mocked'); },
  opaqueLoginStart: async () => { throw new Error('opaque not mocked in this test'); },
}));
mock.module('./file-index-cache', () => ({ clearCachedFileIndex: async () => {} }));
mock.module('./sync-client', () => ({ getDeviceId: async () => 'device-1' }));
mock.module('./announcement-context', () => ({ setAnnouncement: () => {}, clearAnnouncement: () => {} }));
mock.module('./rate-limited-fetch', () => ({
  rateLimitedFetch: async (url: string, init: RequestInit) => {
    fetchCalls.push({ url, init });
    const next = fetchQueue.shift();
    if (!next) throw new Error(`unexpected fetch: ${url}`);
    return next();
  },
}));

const TOKEN_KEY = 'beebeeb_session_token';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const loadFreshApi = () => import(`./api?deleteRequestTest=${Math.random()}`);

beforeEach(() => {
  store.clear();
  fetchCalls.length = 0;
  fetchQueue = [];
});

describe('requestAccountDeletion', () => {
  test('posts to the request endpoint with the step-up header and no body code when 2FA is off', async () => {
    store.set(TOKEN_KEY, 'session-token');
    fetchQueue.push(async () => json({ status: 'email_sent' }));
    const { requestAccountDeletion } = await loadFreshApi();
    const result = await requestAccountDeletion('confirm-token-abc');
    const { url, init } = fetchCalls[0];
    expect(url).toBe('https://api.test/api/v1/account/delete/request');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['X-Confirm-Token']).toBe('confirm-token-abc');
    expect(JSON.parse((init.body as string) ?? '{}')).toEqual({});
    expect(result).toEqual({ status: 'email_sent' });
  });

  test('sends the 2FA code in the body when given', async () => {
    store.set(TOKEN_KEY, 'session-token');
    fetchQueue.push(async () => json({ status: 'email_sent' }));
    const { requestAccountDeletion } = await loadFreshApi();
    await requestAccountDeletion('t', '123456');
    expect(JSON.parse(fetchCalls[0].init.body as string)).toEqual({ totp_code: '123456' });
  });

  test('typed errors carry the server code and are not retried', async () => {
    store.set(TOKEN_KEY, 'session-token');
    fetchQueue.push(async () => json({ error: 'totp_code_required', message: 'x' }, 400));
    const { requestAccountDeletion } = await loadFreshApi();
    const err = await requestAccountDeletion('t').catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.code).toBe('totp_code_required');
    expect(fetchCalls).toHaveLength(1);
  });

  test('the old DELETE endpoint is no longer exported', async () => {
    const api = await loadFreshApi();
    expect(api.deleteAccountPermanently).toBeUndefined();
  });
});
