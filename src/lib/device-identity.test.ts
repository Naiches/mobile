// @ts-nocheck
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

// In-memory SecureStore so the canonical-id migration is testable without the
// native keychain module. The module under test imports `* as SecureStore`.
const store = new Map<string, string>();
let secureStoreGet: (key: string) => Promise<string | null>;
const secureStoreWrites: Array<{ key: string; value: string }> = [];
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStoreGet(key),
  setItemAsync: async (key: string, value: string) => {
    secureStoreWrites.push({ key, value });
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

// react-native's Platform — default to a native platform (not 'web') so the
// SecureStore branch is exercised.
mock.module('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const SYNC_KEY = 'bb_sync_device_id';
const BACKUP_KEY = 'beebeeb_device_id';

// Fresh module instance per test so the in-module `_inFlight` coalescing cache
// can't leak a resolved id across cases.
async function loadFresh() {
  const mod = await import(`./device-identity?bust=${Math.random()}`);
  return mod;
}

beforeEach(() => {
  store.clear();
  secureStoreWrites.length = 0;
  secureStoreGet = async (key: string) => store.get(key) ?? null;
});

afterEach(() => {
  jest.useRealTimers();
  store.clear();
  secureStoreWrites.length = 0;
});

describe('getDeviceId — canonical device identity (0863)', () => {
  test('steady state: returns the existing sync id unchanged (no churn)', async () => {
    store.set(SYNC_KEY, 'sync-uuid-existing');
    const { getDeviceId } = await loadFresh();
    expect(await getDeviceId()).toBe('sync-uuid-existing');
    // Did not overwrite the canonical key.
    expect(store.get(SYNC_KEY)).toBe('sync-uuid-existing');
  });

  test('sync id wins over a legacy backup id (PhotoKit-dedup anchor preserved)', async () => {
    store.set(SYNC_KEY, 'sync-uuid');
    store.set(BACKUP_KEY, 'backup-uuid');
    const { getDeviceId } = await loadFresh();
    expect(await getDeviceId()).toBe('sync-uuid');
  });

  test('no sync id but a legacy backup id exists: carry it forward (manifest stays stable)', async () => {
    store.set(BACKUP_KEY, 'backup-uuid-legacy');
    const { getDeviceId } = await loadFresh();
    const id = await getDeviceId();
    expect(id).toBe('backup-uuid-legacy');
    // The legacy backup id is now promoted to the canonical key.
    expect(store.get(SYNC_KEY)).toBe('backup-uuid-legacy');
  });

  test('fresh install: mints one UUID and persists it under the canonical key', async () => {
    const { getDeviceId } = await loadFresh();
    const id = await getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(store.get(SYNC_KEY)).toBe(id);
  });

  test('idempotent: repeated calls return the same value', async () => {
    const { getDeviceId } = await loadFresh();
    const a = await getDeviceId();
    const b = await getDeviceId();
    expect(a).toBe(b);
  });

  test('concurrent first-run callers coalesce to a single minted id', async () => {
    const { getDeviceId } = await loadFresh();
    const [a, b, c] = await Promise.all([getDeviceId(), getDeviceId(), getDeviceId()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    // Exactly one value persisted.
    expect(store.get(SYNC_KEY)).toBe(a);
  });

  test('a stuck secure-storage read rejects without minting and clears the in-flight call for retry', async () => {
    jest.useFakeTimers();
    secureStoreGet = async () => new Promise<string | null>(() => {});
    const {
      DEVICE_ID_STORAGE_TIMEOUT_MS,
      DeviceIdUnavailableError,
      resolveDeviceId,
    } = await loadFresh();

    const first = resolveDeviceId();
    const joined = resolveDeviceId();
    const failures = Promise.all([
      first.catch((error) => error),
      joined.catch((error) => error),
    ]);
    jest.advanceTimersByTime(DEVICE_ID_STORAGE_TIMEOUT_MS);

    const [firstError, joinedError] = await failures;
    expect(firstError).toBeInstanceOf(DeviceIdUnavailableError);
    expect(joinedError).toBeInstanceOf(DeviceIdUnavailableError);
    expect(secureStoreWrites).toHaveLength(0);

    secureStoreGet = async (key: string) => store.get(key) ?? null;
    store.set(SYNC_KEY, 'retry-device-id');
    await expect(resolveDeviceId()).resolves.toEqual({
      id: 'retry-device-id',
      source: 'stored',
      persisted: true,
    });
  });
});
