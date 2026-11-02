// @ts-nocheck
// Stream liveness: a stream can die without any event (the server's keepalive
// is an SSE comment the library never surfaces). While the app is active, a
// light catch-up runs every minute; if it finds ops the stream never
// delivered, the stream is declared dead and reopened. Same isolation rules as
// the other sync-client tests.
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
let closeCalls = 0;
mock.module('react-native-sse', () => ({
  default: class FakeEventSource {
    listeners = new Map<string, ESListener>();
    constructor() {
      lastFakeES = this;
    }
    addEventListener(type: string, listener: ESListener) {
      this.listeners.set(type, listener);
    }
    close() { closeCalls += 1; }
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

const { SyncClient, setSyncClientAppState, setSyncTraceSink, LIVENESS_INTERVAL_MS } = await import('./sync-client');


let capturedTimers: Array<{ fn: () => void; ms: number }> = [];
const realSetTimeout = globalThis.setTimeout;
function withCapturedTimers<T>(fn: () => T): T {
  capturedTimers = [];
  globalThis.setTimeout = ((inner: () => void, ms?: number) => {
    capturedTimers.push({ fn: inner, ms: ms ?? 0 });
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



let timers: Array<{ id: number; fn: () => void; ms: number; cleared: boolean }> = [];
const realClear = globalThis.clearTimeout;
function installTimers() {
  timers = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const t = { id: timers.length + 1, fn, ms: ms ?? 0, cleared: false };
    timers.push(t);
    return t.id as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  }) as typeof clearTimeout;
}
function restoreTimers() {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClear;
}
function livenessTimers() {
  return timers.filter((t) => !t.cleared && t.ms >= LIVENESS_INTERVAL_MS);
}
async function fireLiveness() {
  const t = livenessTimers().pop()!;
  t.cleared = true;
  t.fn();
  await drain(60);
}
const op = (seq_id: number, id: string) => ({
  seq_id, op_type: 'file_create', payload: { id, name_encrypted: 'enc' }, created_at: '2026-10-31T00:00:00Z',
});

describe('SyncClient stream liveness', () => {
  let traces: Array<{ name: string; fields: any }> = [];
  beforeEach(() => {
    secureStore.clear();
    getStreamTokenCalls = 0;
    getSyncOpsCalls = 0;
    getSyncOpsImpl = async () => [];
    appStateListeners.clear();
    lastFakeES = null;
    currentState = 'active';
    setSyncClientAppState('active');
    traces = [];
    closeCalls = 0;
    setSyncTraceSink((name, fields) => traces.push({ name, fields }));
    installTimers();
  });
  afterEach(() => restoreTimers());

  async function boot() {
    const client = new SyncClient();
    await client.start();
    await drain();
    getSyncOpsCalls = 0;
    getStreamTokenCalls = 0;
    return client;
  }

  function emitAppState(next: string) {
    currentState = next;
    for (const l of [...appStateListeners]) l(next);
  }

  test('schedules one liveness check a minute out while active', async () => {
    await boot();
    expect(livenessTimers().length).toBe(1);
    expect(livenessTimers()[0].ms).toBe(LIVENESS_INTERVAL_MS);
  });

  test('a quiet minute costs one ops request and no reopen', async () => {
    await boot();
    await fireLiveness();
    expect(getSyncOpsCalls).toBe(1);
    expect(getStreamTokenCalls).toBe(0);
    expect(traces.length).toBe(0);
    expect(livenessTimers().length).toBe(1); // next check armed
  });

  test('a subscriber mounted after the stream opens immediately receives the current status', async () => {
    const client = await boot();
    lastFakeES!.listeners.get('open')?.();

    const statuses: string[] = [];
    client.subscribe((event) => {
      if (event.type === 'status' && event.status) statuses.push(event.status);
    });

    expect(statuses).toEqual(['connected']);
  });

  test('ops the stream never delivered mark it dead: reconnecting status, reopen, trace', async () => {
    const client = await boot();
    const statuses: string[] = [];
    client.subscribe((e) => { if (e.type === 'status') statuses.push(e.status); });
    getSyncOpsImpl = async () => [op(1, 'missed-1')];
    await fireLiveness();
    expect(statuses).toContain('reconnecting');
    expect(getStreamTokenCalls).toBe(1);
    expect(traces).toEqual([{ name: 'sync.stream_reopen', fields: { reason: 'missed-ops' } }]);
    expect(client.getNode('missed-1')).toBeDefined();
  });

  test('no timer while backgrounded or inactive; one comes back on foreground', async () => {
    await boot();
    emitAppState('inactive');
    expect(livenessTimers().length).toBe(0);
    emitAppState('background');
    expect(livenessTimers().length).toBe(0);
    emitAppState('active');
    expect(livenessTimers().length).toBe(1);
  });

  test('a catch-up already running is not doubled', async () => {
    await boot();
    let release: () => void;
    getSyncOpsImpl = () => new Promise((r) => { release = () => r([]); });
    const t = livenessTimers().pop()!;
    t.cleared = true;
    t.fn();
    await drain();
    // second tick while the first is in flight
    const again = timers.filter((x) => !x.cleared && x.ms >= LIVENESS_INTERVAL_MS).pop();
    if (again) { again.cleared = true; again.fn(); await drain(); }
    expect(getSyncOpsCalls).toBe(1);
    release!();
    await drain(60);
  });

  test('a failed liveness catch-up backs off but leaves a healthy stream alone', async () => {
    const client = await boot();
    const statuses: string[] = [];
    client.subscribe((e) => { if (e.type === 'status') statuses.push(e.status); });
    getSyncOpsImpl = async () => { throw new Error('503'); };
    await fireLiveness();
    expect(closeCalls).toBe(0);
    expect(statuses).not.toContain('reconnecting');
    expect(getStreamTokenCalls).toBe(0);
    expect(livenessTimers().pop()!.ms).toBe(LIVENESS_INTERVAL_MS * 2);
  });

  test('ops committed moments ago (still in flight on the stream, or our own echo) are not a dead stream', async () => {
    await boot();
    getSyncOpsImpl = async () => [{ ...op(1, 'fresh-1'), created_at: new Date().toISOString() }];
    await fireLiveness();
    expect(getStreamTokenCalls).toBe(0);
    expect(traces.length).toBe(0);
  });

  test('repeated errors keep doubling the interval up to the cap, one request each', async () => {
    await boot();
    getSyncOpsImpl = async () => { throw new Error('down'); };
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      getSyncOpsCalls = 0;
      await fireLiveness();
      expect(getSyncOpsCalls).toBe(1);
      seen.push(livenessTimers().pop()!.ms);
      timers.forEach((t) => { if (t.ms >= LIVENESS_INTERVAL_MS) t.cleared = false; });
    }
    expect(seen.slice(0, 3)).toEqual([2, 4, 8].map((n) => n * LIVENESS_INTERVAL_MS));
    expect(Math.max(...seen)).toBe(8 * LIVENESS_INTERVAL_MS);
  });

  test('stop() clears the timer', async () => {
    const client = await boot();
    client.stop();
    expect(livenessTimers().length).toBe(0);
  });
});
