// @ts-nocheck
import { afterEach, beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const STORAGE_DEADLINE_MS = 2_000;
const values = new Map<string, string>();
let secureGet: (key: string) => Promise<string | null>;
let secureSet: (key: string, value: string) => Promise<void>;

mock.module('expo-secure-store', () => ({
  getItemAsync: (key: string) => secureGet(key),
  setItemAsync: (key: string, value: string) => secureSet(key, value),
  deleteItemAsync: async (key: string) => { values.delete(key); },
}));

mock.module('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  },
}));

mock.module('react-native-sse', () => ({
  default: class FakeEventSource {
    addEventListener() {}
    close() {}
  },
}));

let snapshotCalls = 0;
let snapshotImpl: () => Promise<{ seq_id: number; nodes: unknown[] }>;
let syncOpsCalls = 0;
let syncOpsImpl: (since: number) => Promise<unknown[]>;

mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'token',
  getStreamToken: async () => ({ stream_token: 'stream-token' }),
  submitSyncOps: async () => ({ applied: [], rejected: [] }),
  getSnapshot: async () => {
    snapshotCalls += 1;
    return snapshotImpl();
  },
  getSyncOps: async (since: number) => {
    syncOpsCalls += 1;
    return syncOpsImpl(since);
  },
}));

let cacheLoad: () => Promise<unknown>;
let cacheSave: (...args: unknown[]) => Promise<void>;
let cacheSaveCalls = 0;

mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: () => cacheLoad(),
  saveCachedFileIndex: (...args: unknown[]) => {
    cacheSaveCalls += 1;
    return cacheSave(...args);
  },
  fileIndexCacheWriteScope: () => ({
    epoch: { generation: 0, accountId: null },
    generation: 0,
  }),
}));

mock.module('./file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => {},
}));

mock.module('./device-identity', () => ({
  getDeviceId: async () => 'device-1',
}));

const authUser = { id: 'user-1' };
mock.module('./auth', () => ({
  useAuth: () => ({ user: authUser }),
}));

mock.module('./delete-cascade', () => ({
  onFilesDeleted: async () => {},
}));

const { SyncClient, SYNC_STORAGE_DEADLINE_MS } = await import('./sync-client');

function node(id: string) {
  return {
    id,
    name_encrypted: `encrypted-${id}`,
    parent_id: null,
    is_folder: false,
    size_bytes: 1,
    content_hash: null,
    version_number: 1,
    has_thumbnail: false,
    storage_pool_id: null,
    is_trashed: false,
    is_starred: false,
    chunk_count: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

function cachedFile(id: string) {
  return {
    id,
    name_encrypted: `encrypted-${id}`,
    parent_id: null,
    is_folder: false,
    size_bytes: 1,
    chunk_count: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
  };
}

async function drainMicrotasks(turns = 30): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
}

async function passStorageDeadline(count = 1): Promise<void> {
  jest.advanceTimersByTime(STORAGE_DEADLINE_MS * count);
  await drainMicrotasks();
}

beforeEach(() => {
  jest.useFakeTimers();
  values.clear();
  secureGet = async (key) => values.get(key) ?? null;
  secureSet = async (key, value) => { values.set(key, value); };
  snapshotCalls = 0;
  snapshotImpl = async () => ({ seq_id: 1, nodes: [node('snapshot')] });
  syncOpsCalls = 0;
  syncOpsImpl = async () => [];
  cacheLoad = async () => null;
  cacheSave = async () => {};
  cacheSaveCalls = 0;
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SyncClient storage deadlines', () => {
  test('uses a short, explicit deadline for local sync storage', () => {
    expect(SYNC_STORAGE_DEADLINE_MS).toBe(STORAGE_DEADLINE_MS);
  });

  test('a stuck cursor read falls back to a snapshot and lets startup finish', async () => {
    secureGet = async (key) => key === 'bb_sync_last_seq'
      ? new Promise<string | null>(() => {})
      : values.get(key) ?? null;

    const client = new SyncClient();
    let settled = false;
    const start = client.start().then(() => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);

    await passStorageDeadline();
    expect(settled).toBe(true);
    expect(snapshotCalls).toBe(1);
    expect(client.getAllNodes().map((entry) => entry.id)).toEqual(['snapshot']);
    await start;
    client.stop();
  });

  test('a stuck pending-op read cannot leave SyncProvider loading', async () => {
    let pendingReadCalls = 0;
    secureGet = async (key) => {
      if (key === 'bb_sync_pending_ops') {
        pendingReadCalls += 1;
        return new Promise<string | null>(() => {});
      }
      return values.get(key) ?? null;
    };
    const React = await import('react');
    const { default: TestRenderer, act } = await import('react-test-renderer');
    const { SyncProvider, useSync } = await import('./sync-context');
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    let latest;
    let renderer;
    function Consumer() {
      latest = useSync();
      return null;
    }

    try {
      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(SyncProvider, null, React.createElement(Consumer)),
        );
        await drainMicrotasks();
      });
      await act(async () => { await drainMicrotasks(); });
      expect(latest.loading).toBe(true);
      expect(pendingReadCalls).toBe(1);

      await act(async () => { await passStorageDeadline(); });
      await act(async () => { await drainMicrotasks(); });
      expect(latest.loading).toBe(false);
      expect(latest.ready).toBe(true);
      expect(snapshotCalls).toBe(1);
    } finally {
      await act(async () => { renderer?.unmount(); });
    }
  });

  test('a stuck cache read uses a snapshot, and a failed startup remains retryable', async () => {
    values.set('bb_sync_last_seq', '5');
    cacheLoad = async () => new Promise(() => {});
    snapshotImpl = async () => { throw new Error('snapshot unavailable'); };
    const client = new SyncClient();

    const firstStart = client.start();
    let firstError: unknown;
    void firstStart.catch((error) => { firstError = error; });
    await drainMicrotasks();
    await passStorageDeadline();
    expect(firstError).toBeInstanceOf(Error);
    await expect(firstStart).rejects.toThrow('snapshot unavailable');

    cacheLoad = async () => ({
      hash: 'retry-cache',
      storedAt: Date.now(),
      seq: 5,
      files: [cachedFile('cached')],
    });
    snapshotImpl = async () => ({ seq_id: 6, nodes: [node('unused')] });
    await client.start();
    expect(client.getAllNodes().map((entry) => entry.id)).toEqual(['cached']);
    expect(snapshotCalls).toBe(1);
    client.stop();
  });

  test('a stuck cursor save releases the shared catch-up and allows another pull', async () => {
    const client = new SyncClient();
    await client.start();
    syncOpsImpl = async () => [{
      seq_id: 2,
      op_type: 'file_create',
      payload: { id: 'remote', name_encrypted: 'encrypted-remote', parent_id: null },
      created_at: '2026-10-31T00:00:00.000Z',
    }];
    secureSet = async (key, value) => {
      if (key === 'bb_sync_last_seq') return new Promise<void>(() => {});
      values.set(key, value);
    };

    const first = (client as any).catchUp('test');
    const joined = (client as any).catchUp('test');
    expect(joined).toBe(first);
    let settled = false;
    void first.then(() => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);

    await passStorageDeadline();
    expect(await first).toBe(true);
    expect(settled).toBe(true);

    secureSet = async (key, value) => { values.set(key, value); };
    syncOpsImpl = async () => [];
    await expect((client as any).catchUp('retry')).resolves.toBe(true);
    expect(syncOpsCalls).toBe(2);
    client.stop();
  });

  test('a stuck pending-op save cannot pin catch-up', async () => {
    const client = new SyncClient();
    await client.start();
    (client as any).pendingOps = [{
      client_op_id: 'pending-1',
      op_type: 'file_create',
      payload: { id: 'remote' },
      target_id: 'remote',
    }];
    syncOpsImpl = async () => [{
      seq_id: 2,
      client_op_id: 'pending-1',
      op_type: 'file_create',
      payload: { id: 'remote', name_encrypted: 'encrypted-remote', parent_id: null },
      created_at: '2026-10-31T00:00:00.000Z',
    }];
    secureSet = async (key, value) => {
      if (key === 'bb_sync_pending_ops') return new Promise<void>(() => {});
      values.set(key, value);
    };

    const catchUp = (client as any).catchUp('test');
    let settled = false;
    void catchUp.then(() => { settled = true; });
    await drainMicrotasks();
    expect(settled).toBe(false);

    await passStorageDeadline();
    expect(await catchUp).toBe(true);
    expect(settled).toBe(true);
    client.stop();
  });

  test('stuck cache reads and saves are best-effort and do not prevent retry', async () => {
    const client = new SyncClient();
    await client.start();
    if ((client as any).cachePersistTimer) {
      clearTimeout((client as any).cachePersistTimer);
      (client as any).cachePersistTimer = null;
    }

    cacheLoad = async () => new Promise(() => {});
    const stuckRead = (client as any).persistCacheNow();
    let readSettled = false;
    void stuckRead.then(() => { readSettled = true; });
    await drainMicrotasks();
    await passStorageDeadline();
    expect(readSettled).toBe(true);

    (client as any).dirtyParents.add(null);
    cacheLoad = async () => null;
    cacheSave = async () => new Promise<void>(() => {});
    const stuckSave = (client as any).persistCacheNow();
    let saveSettled = false;
    void stuckSave.then(() => { saveSettled = true; });
    await drainMicrotasks();
    await passStorageDeadline();
    expect(saveSettled).toBe(true);

    (client as any).dirtyParents.add(null);
    cacheSave = async () => {};
    const callsBeforeRetry = cacheSaveCalls;
    await (client as any).persistCacheNow();
    expect(cacheSaveCalls).toBe(callsBeforeRetry + 1);
    client.stop();
  });
});
