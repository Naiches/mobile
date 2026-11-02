// @ts-nocheck
// Task 2096 — SSE resync / reconnect catch-up. Derived from the 1686 harness.
// Task 1686 — iOS idle heat: the SSE reconnect busy-loop. RED-first tests for
// the three properties the fix must have:
//
//   1. Honest backoff — reconnectDelayMs caps at RECONNECT_MAX_DELAY_MS and
//      only ever jitters DOWNWARD from the exponential curve (every sample in
//      [curve×0.8, curve]), so backoff is bounded and de-synchronized.
//   2. Background pause — a reconnect failure while the app is
//      backgrounded/locked schedules NO timer; returning to foreground
//      replays exactly one reconnect (never one per skipped tick).
//   3. Flapping guard — a stream that dies between token fetch and open
//      keeps the backoff ladder climbing instead of resetting to the 1.5 s
//      floor every cycle.
//
// Same isolation rules as sync-client.test.ts: this file mocks every native
// module it needs itself (task 0877).
import { beforeEach, describe, expect, jest, mock, test } from 'bun:test';

const secureStore = new Map<string, string>();
let lastSeqWrites = 0;

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
    if (key === 'bb_sync_last_seq') lastSeqWrites += 1;
  },
  deleteItemAsync: async (key: string) => { secureStore.delete(key); },
}));

// Controllable fake AppState — sync-client imports AppState from
// 'react-native' for the foreground-resume wiring in start().
let currentState = 'active';
type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();

mock.module('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: {
    get currentState() {
      return currentState;
    },
    addEventListener: (_type: string, listener: AppStateListener) => {
      appStateListeners.add(listener);
      return { remove: () => appStateListeners.delete(listener) };
    },
  },
}));

// Fake EventSource that records its listeners so tests can fire 'open' /
// 'error' explicitly. Constructed fresh per openStream() call; all instances
// are kept so tests can reach the most recent one.
type ESListener = (event?: { data?: string }) => void;
let lastFakeES: { listeners: Map<string, ESListener> } | null = null;
mock.module('react-native-sse', () => ({
  default: class FakeEventSource {
    listeners = new Map<string, ESListener>();
    constructor() {
      lastFakeES = this;
    }
    addEventListener(type: string, listener: ESListener) {
      this.listeners.set(type, listener);
    }
    close() {}
    fire(type: string, event?: { data?: string }) {
      this.listeners.get(type)?.(event);
    }
  },
}));

let getStreamTokenCalls = 0;
let getSyncOpsCalls = 0;
let getSyncOpsImpl = async () => [];
mock.module('./api', () => ({
  getApiUrl: () => 'https://api.test',
  getToken: async () => 'session-token',
  getStreamToken: async () => {
    getStreamTokenCalls += 1;
    return { stream_token: 'tok', expires_at: '2099-01-01T00:00:00Z' };
  },
  submitSyncOps: async () => ({ applied: [], rejected: [] }),
  getSnapshot: async () => ({ seq_id: 0, nodes: [] }),
  getSyncOps: async () => { getSyncOpsCalls += 1; return getSyncOpsImpl(); },
}));

mock.module('./file-index-cache', () => ({
  loadCachedFileIndex: async () => null,
  saveCachedFileIndex: async () => {},
  clearCachedFileIndex: async () => {},
  fileIndexCacheWriteScope: () => ({ epoch: { generation: 0, accountId: null }, generation: 0 }),
}));

mock.module('./file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => {},
}));

mock.module('./device-identity', () => ({
  getDeviceId: async () => 'device-1',
}));

const { SyncClient, setSyncClientAppState } = await import('./sync-client');


let capturedTimers: Array<{ fn: () => void; ms: number }> = [];
const realSetTimeout = globalThis.setTimeout;
function withCapturedTimers<T>(fn: () => T): T {
  capturedTimers = [];
  globalThis.setTimeout = ((inner: () => void, ms?: number) => {
    // The 60 s stream-liveness check is covered by sync-client.liveness.test.ts.
    if ((ms ?? 0) !== 60_000) capturedTimers.push({ fn: inner, ms: ms ?? 0 });
    return capturedTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    return fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}
async function drain(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
async function runTimers() {
  const timers = capturedTimers;
  capturedTimers = [];
  for (const t of timers) t.fn();
  await drain();
}

async function started() {
  const client = new SyncClient();
  await client.start();
  await drain();
  getSyncOpsCalls = 0; // ignore start()'s own catch-up
  return client;
}

describe('SyncClient catch-up on reconnect / resync (task 2096)', () => {
  beforeEach(() => {
    secureStore.clear();
    lastSeqWrites = 0;
    getStreamTokenCalls = 0;
    getSyncOpsCalls = 0;
    getSyncOpsImpl = async () => [];
    appStateListeners.clear();
    lastFakeES = null;
    currentState = 'active';
    setSyncClientAppState('active');
  });

  test('stream error -> reconnect runs exactly one catch-up', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('error'));
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('server ends the stream cleanly (close event) -> reconnect with exactly one catch-up', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('close'));
    expect(capturedTimers.length).toBe(1);
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('close followed by error on the same stream still yields one catch-up', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('close');
      lastFakeES!.fire('error');
    });
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('a second open on the same stream (library silent re-open after a clean server end) -> one debounced catch-up', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('open');          // first open: nothing to catch up
    });
    expect(capturedTimers.length).toBe(0);
    withCapturedTimers(() => {
      lastFakeES!.fire('open');          // library re-opened after clean end
      lastFakeES!.fire('open');
    });
    expect(getSyncOpsCalls).toBe(0);
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('legacy guessed shapes are inert: named resync event and {type:resync} message do nothing', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('resync', { data: '{}' });
      lastFakeES!.fire('message', { data: JSON.stringify({ type: 'resync' }) });
    });
    expect(capturedTimers.length).toBe(0);
    await drain();
    expect(getSyncOpsCalls).toBe(0);
  });

  test('heartbeats and non-sync notifications do nothing', async () => {
    await started();
    withCapturedTimers(() => {
      lastFakeES!.fire('ping', { data: '' });
      lastFakeES!.fire('heartbeat', { data: '' });
      lastFakeES!.fire('message', { data: JSON.stringify({ type: 'heartbeat' }) });
      lastFakeES!.fire('message', { data: JSON.stringify({ type: 'file.created' }) });
      lastFakeES!.fire('message', { data: ': keepalive' });
    });
    expect(capturedTimers.length).toBe(0);
    await drain();
    expect(getSyncOpsCalls).toBe(0);
  });

  test('a later re-open after the first catch-up ran triggers another catch-up', async () => {
    await started();
    withCapturedTimers(() => { lastFakeES!.fire('open'); lastFakeES!.fire('open'); });
    await runTimers();
    withCapturedTimers(() => lastFakeES!.fire('open'));
    await runTimers();
    expect(getSyncOpsCalls).toBe(2);
  });
});

test('live ops wait behind catch-up so their higher cursor cannot skip missed ops', async () => {
  const client = await started();
  let resolve;
  getSyncOpsImpl = () => new Promise(r => { resolve = r; });
  const catchingUp = (client as any).catchUp('test'); await drain();
  const op = (seq_id, id) => ({seq_id,op_type:'file_create',payload:{id,name_encrypted:'enc'},created_at:'2026-10-26T00:00:00Z'});
  lastFakeES!.fire('message',{data:JSON.stringify(op(2,'live'))}); await drain();
  resolve([op(1,'missed')]); await catchingUp; await drain();
  expect(client.getAllNodes().map(x=>x.id).sort()).toEqual(['live','missed']);
  expect(client.getLastSeq()).toBe(2); client.stop();
});

test('a large catch-up publishes one settled tree event instead of one React update per operation', async () => {
  const client = await started();
  const events: string[] = [];
  client.subscribe((event) => events.push(event.type));
  getSyncOpsImpl = async () => Array.from({ length: 5_000 }, (_, i) => ({
    seq_id: i + 1,
    op_type: 'file_create',
    payload: { id: `file-${i}`, name_encrypted: `file-${i}` },
    created_at: '2026-10-26T00:00:00Z',
  }));

  await (client as any).catchUp('scale-test');

  expect(client.getAllNodes()).toHaveLength(5_000);
  expect(events.filter((event) => event === 'op')).toHaveLength(0);
  expect(events.filter((event) => event === 'caught-up')).toHaveLength(1);
  client.stop();
});

async function flushFakeTimerTurns(turns = 30) {
  for (let turn = 0; turn < turns; turn += 1) {
    jest.advanceTimersByTime(0);
    await drain(100);
  }
}

test('a rapid live SSE burst applies in order, persists one cursor, and publishes one settled tree event', async () => {
  jest.useFakeTimers();
  let client: SyncClient | null = null;
  try {
    client = await started();
    await drain();
    lastSeqWrites = 0;
    const events: Array<{ type: string; deletedIds?: string[] }> = [];
    client.subscribe((event) => events.push(event));
    events.length = 0; // discard the subscribe() status replay

    for (let index = 0; index < 500; index += 1) {
      lastFakeES!.fire('message', {
        data: JSON.stringify({
          seq_id: index + 1,
          op_type: 'file_create',
          payload: { id: `live-${index}`, name_encrypted: `enc-${index}`, parent_id: null },
          created_at: '2026-10-26T00:00:00Z',
        }),
      });
    }

    // Live delivery is deferred only until the next event-loop turn, leaving
    // the current native-input turn free even for a very large SSE frame burst.
    expect(client.getAllNodes()).toHaveLength(0);
    jest.advanceTimersByTime(50); // begin the yielding drain
    lastFakeES!.fire('message', {
      data: JSON.stringify({
        seq_id: 501,
        op_type: 'file_create',
        payload: { id: 'live-500', name_encrypted: 'enc-500', parent_id: null },
        created_at: '2026-10-26T00:00:00Z',
      }),
    });
    await flushFakeTimerTurns();

    // The event delivered while replay was yielding joins the same settled
    // publication instead of starting a concurrent cursor write.
    expect(client.getAllNodes()).toHaveLength(501);
    expect(client.getLastSeq()).toBe(501);
    expect(events.filter((event) => event.type === 'op')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'caught-up')).toHaveLength(1);
    expect(lastSeqWrites).toBe(1);

    events.length = 0;
    lastSeqWrites = 0;
    for (let index = 0; index < 501; index += 1) {
      lastFakeES!.fire('message', {
        data: JSON.stringify({
          seq_id: index + 502,
          op_type: 'file_trash',
          payload: { id: `live-${index}` },
          created_at: '2026-10-26T00:00:01Z',
        }),
      });
    }
    jest.advanceTimersByTime(50);
    await flushFakeTimerTurns();

    const settled = events.filter((event) => event.type === 'caught-up');
    expect(settled).toHaveLength(1);
    expect(new Set(settled[0]!.deletedIds)).toEqual(
      new Set(Array.from({ length: 501 }, (_, index) => `live-${index}`)),
    );
    expect(client.getLastSeq()).toBe(1_002);
    expect(lastSeqWrites).toBe(1);
  } finally {
    client?.stop();
    jest.useRealTimers();
  }
});

test('stopping before the scheduled live drain cancels it without advancing the cursor', async () => {
  jest.useFakeTimers();
  try {
    const client = await started();
    await drain();
    lastSeqWrites = 0;
    lastFakeES!.fire('message', {
      data: JSON.stringify({
        seq_id: 1,
        op_type: 'file_create',
        payload: { id: 'cancelled-live', name_encrypted: 'enc', parent_id: null },
        created_at: '2026-10-26T00:00:00Z',
      }),
    });

    client.stop();
    await flushFakeTimerTurns(2);

    expect(client.getAllNodes()).toHaveLength(0);
    expect(client.getLastSeq()).toBe(0);
    expect(lastSeqWrites).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('catch-up absorbs a scheduled live op so a higher live cursor cannot skip a missed op', async () => {
  jest.useFakeTimers();
  let client: SyncClient | null = null;
  try {
    client = await started();
    const op = (seq_id: number, id: string) => ({
      seq_id,
      op_type: 'file_create',
      payload: { id, name_encrypted: 'enc', parent_id: null },
      created_at: '2026-10-26T00:00:00Z',
    });

    // seq 2 is queued for the next turn when a reconnect pull begins. The pull
    // must apply missed seq 1 first, then the buffered live frame.
    lastFakeES!.fire('message', { data: JSON.stringify(op(2, 'live')) });
    getSyncOpsImpl = async () => [op(1, 'missed')];
    const catchingUp = (client as any).catchUp('test');
    await drain(100);
    await catchingUp;
    await flushFakeTimerTurns(2);

    expect(client.getAllNodes().map((node) => node.id).sort()).toEqual(['live', 'missed']);
    expect(client.getLastSeq()).toBe(2);
  } finally {
    client?.stop();
    jest.useRealTimers();
  }
});

test('a failed liveness pull returns its buffered live op before a later cursor can advance past it', async () => {
  jest.useFakeTimers();
  let client: SyncClient | null = null;
  try {
    client = await started();
    const op = (seq_id: number, id: string) => ({
      seq_id,
      op_type: 'file_create',
      payload: { id, name_encrypted: 'enc', parent_id: null },
      created_at: '2026-10-26T00:00:00Z',
    });

    // seq 1 is waiting for its next-turn drain when the liveness pull takes
    // ownership of that queue. A failed pull must not discard the frame.
    lastFakeES!.fire('message', { data: JSON.stringify(op(1, 'before-failure')) });
    getSyncOpsImpl = async () => { throw new Error('probe failed'); };
    expect(await (client as any).catchUp('liveness')).toBe(false);

    // If seq 1 was dropped, applying seq 2 advances lastSeq beyond it forever.
    lastFakeES!.fire('message', { data: JSON.stringify(op(2, 'after-failure')) });
    jest.advanceTimersByTime(50);
    await flushFakeTimerTurns(4);

    expect(client.getAllNodes().map((node) => node.id)).toEqual([
      'before-failure',
      'after-failure',
    ]);
    expect(client.getLastSeq()).toBe(2);
  } finally {
    client?.stop();
    jest.useRealTimers();
  }
});

test('an isolated live op uses a bounded coalescence window', async () => {
  jest.useFakeTimers();
  let client: SyncClient | null = null;
  try {
    client = await started();
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    events.length = 0;
    lastFakeES!.fire('message', {
      data: JSON.stringify({
        seq_id: 1,
        op_type: 'file_create',
        payload: { id: 'single-live', name_encrypted: 'enc', parent_id: null },
        created_at: '2026-10-26T00:00:00Z',
      }),
    });

    jest.advanceTimersByTime(49);
    await drain(100);
    expect(client.getAllNodes()).toHaveLength(0);
    expect(events.filter((event) => event === 'caught-up')).toHaveLength(0);

    jest.advanceTimersByTime(1);
    await drain(100);
    expect(client.getAllNodes()).toHaveLength(1);
    expect(events.filter((event) => event === 'caught-up')).toHaveLength(1);
  } finally {
    client?.stop();
    jest.useRealTimers();
  }
});

test('a moderate continuous SSE stream has bounded React publications', async () => {
  jest.useFakeTimers();
  let client: SyncClient | null = null;
  try {
    client = await started();
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    events.length = 0;

    for (let index = 0; index < 30; index += 1) {
      lastFakeES!.fire('message', {
        data: JSON.stringify({
          seq_id: index + 1,
          op_type: 'file_create',
          payload: { id: `cadence-${index}`, name_encrypted: 'enc', parent_id: null },
          created_at: '2026-10-26T00:00:00Z',
        }),
      });
      jest.advanceTimersByTime(16);
      await drain(100);
    }
    jest.advanceTimersByTime(50);
    await drain(100);

    expect(client.getAllNodes()).toHaveLength(30);
    const publications = events.filter((event) => event === 'caught-up');
    expect(publications).toHaveLength(6);
  } finally {
    client?.stop();
    jest.useRealTimers();
  }
});
