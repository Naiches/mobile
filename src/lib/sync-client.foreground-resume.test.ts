// @ts-nocheck
// Foreground resume: iOS silently kills a backgrounded app's sockets, so a
// stream that still reads `connected` after a long background is dead. Every
// return to the foreground must pull the missed ops and re-open the stream,
// not only when a reconnect was already pending. Same isolation rules as the
// other sync-client tests: every native module is mocked in this file.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const secureStore = new Map<string, string>();

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { secureStore.set(key, value); },
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


describe('SyncClient foreground resume', () => {
  beforeEach(() => {
    secureStore.clear();
    getStreamTokenCalls = 0;
    getSyncOpsCalls = 0;
    getSyncOpsImpl = async () => [];
    appStateListeners.clear();
    lastFakeES = null;
    currentState = 'active';
    setSyncClientAppState('active');
  });

  function emitAppState(next: string) {
    currentState = next;
    for (const l of [...appStateListeners]) l(next);
  }

  // Fake clock so tests can say how long the app was in the background.
  const realNow = Date.now;
  let clock = 1_800_000_000_000;
  beforeEach(() => { clock = 1_800_000_000_000; Date.now = () => clock; });
  afterEach(() => { Date.now = realNow; });
  function backgroundFor(ms: number) {
    emitAppState('background');
    clock += ms;
    emitAppState('active');
  }

  test('returning to the foreground with a stream that looks connected pulls missed ops and re-opens the stream', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('open'));
    const tokensBefore = getStreamTokenCalls;
    withCapturedTimers(() => backgroundFor(31_000));
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
    expect(getStreamTokenCalls).toBe(tokensBefore + 1);
  });

  test('a pending deferred reconnect plus foreground still yields exactly one catch-up', async () => {
    await started();
    withCapturedTimers(() => emitAppState('background'));
    withCapturedTimers(() => lastFakeES!.fire('error'));
    expect(capturedTimers.length).toBe(0);
    withCapturedTimers(() => emitAppState('active'));
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('inactive -> active (Face ID sheet, Control Center, app switcher peek) does nothing', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('open'));
    const tokensBefore = getStreamTokenCalls;
    withCapturedTimers(() => {
      emitAppState('inactive');
      emitAppState('active');
    });
    await runTimers();
    expect(getSyncOpsCalls).toBe(0);
    expect(getStreamTokenCalls).toBe(tokensBefore);
  });

  test('a short trip to the background (under 30 s) does not tear down the stream', async () => {
    await started();
    withCapturedTimers(() => lastFakeES!.fire('open'));
    const tokensBefore = getStreamTokenCalls;
    withCapturedTimers(() => backgroundFor(10_000));
    await runTimers();
    expect(getSyncOpsCalls).toBe(0);
    expect(getStreamTokenCalls).toBe(tokensBefore);
  });

  test('background -> inactive -> active reconnects exactly once', async () => {
    await started();
    withCapturedTimers(() => {
      emitAppState('background');
      emitAppState('inactive');
      clock += 31_000;
      emitAppState('active');
    });
    await runTimers();
    expect(getSyncOpsCalls).toBe(1);
  });

  test('a foreground catch-up emits caught-up so Drive can stamp freshness', async () => {
    const client = await started();
    const seen: string[] = [];
    client.subscribe((e) => seen.push(e.type));
    withCapturedTimers(() => backgroundFor(31_000));
    await runTimers();
    expect(seen).toContain('caught-up');
  });
});
