// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * "Clear offline files" while downloads run: the in-flight jobs are cancelled,
 * they leave nothing behind, and the queue's concurrency count stays correct.
 */
import { describe, expect, mock, test } from 'bun:test';

// expo-modules-core's logger setup reads the RN global `__DEV__` and its
// EventEmitter module binds `globalThis.expo` at import time; stub both
// before anything loads (the same globals the RN runtime provides).
(globalThis as Record<string, unknown>).__DEV__ = false;
(globalThis as Record<string, unknown>).expo = {
  EventEmitter: class {
    addListener = () => ({ remove: () => {} });
    removeAllListeners = () => {};
  },
  modules: {},
};

const secureStoreCalls: Array<{ key: string; value: string }> = [];
let failSetItem: string | null = null;
const records: Array<{ name: string; fields: Record<string, unknown> }> = [];

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => secureStoreCalls.find((c) => c.key === key)?.value ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (failSetItem === key) throw new Error(' SecureStore: secure item too large');
    secureStoreCalls.push({ key, value });
  },
  deleteItemAsync: async (key: string) => {
    const idx = secureStoreCalls.findIndex((c) => c.key === key);
    if (idx >= 0) secureStoreCalls.splice(idx, 1);
  },
}));

mock.module('react-native', () => {
  const noopEmitter = { addListener: () => ({ remove: () => {} }), emit: () => {}, removeAllListeners: () => {} };
  return {
    Platform: { OS: 'android', select: (o) => o.android ?? o.default ?? o.ios },
    TurboModuleRegistry: { getEnforcing: () => ({}), get: () => null },
    AppRegistry: { registerRunnable: () => {}, getRunnable: () => null, registerComponent: () => {}, getComponent: () => null },
    NativeModules: {},
    DeviceEventEmitter: noopEmitter,
    NativeEventEmitter: class { addListener = () => ({ remove: () => {} }); removeAllListeners = () => {}; },
    InteractionManager: { runAfterInteractions: (cb) => { cb(); return { cancel: () => {} }; } },
  };
});

// Fully stub `expo-file-system/legacy` — the real legacy shim extends the
// NativeModule class, which is not constructable under bun's mock registry;
// offline-manager only touches directory/file basics here.
let getInfoImpl: () => Promise<{ exists: boolean }> = async () => ({ exists: false });

mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///documents/',
  cacheDirectory: 'file:///cache/',
  EncodingType: { Base64: 'base64', UTF8: 'utf8' },
  getInfoAsync: () => getInfoImpl(),
  makeDirectoryAsync: async () => {},
  readDirectoryAsync: async () => [],
  deleteAsync: async (uri) => { deletes.push(uri); },
  readAsStringAsync: async () => '',
  writeAsStringAsync: async () => {},
  createDownloadResumable: (url, dest, _o, onProgress) => makeResumable(url, dest, onProgress),
}));

mock.module('./api', () => ({
  getDownloadUrl: (fileId: string) => `https://api.test/download/${fileId}`,
  getToken: async () => 'test-token',
}));

mock.module('./runtime-trace', () => ({
  recordRuntimeTrace: (name: string, fields: Record<string, unknown>) => {
    records.push({ name, fields });
  },
}));

// Task 1683d: mock the crypto bridge, NOT './plaintext-storage' itself. bun's
// mock.module registrations are GLOBAL to the whole `bun test` invocation —
// a partial stub registered here would replace the real module for every
// other test file importing it (plaintext-storage.test.ts dynamically imports
// './plaintext-storage' and reads PROTECTED_LEAF_NAMES off it; a partial stub
// made those exports undefined in combined runs). The real plaintext-storage
// is safe to load here: its react-native import resolves to THIS file's
// android mock, so notePlaintextPathCreated early-returns on its own iOS gate
// (plaintext-storage.ts:77) and never reaches the bridge.
mock.module('../../modules/beebeeb-crypto', () => ({
  hardenPlaintextStorage: async () => ({}),
  auditPlaintextStorage: async () => [],
}));


const deletes: string[] = [];
const started: string[] = [];
const releases = new Map<string, (r: any) => void>();
let paused = 0;
let pauseImpl: () => Promise<void> = async () => { paused += 1; };
function makeResumable(url: string, dest: string, onProgress: any) {
  started.push(dest);
  return {
    downloadAsync: () => new Promise((resolve) => { releases.set(dest, resolve); onProgress?.({ totalBytesWritten: 5, totalBytesExpectedToWrite: 10 }); }),
    pauseAsync: () => pauseImpl(),
  };
}

const { offlineManager } = await import('./offline-manager');
const tick = () => new Promise((r) => setTimeout(r, 5));
const path = (id: string) => `file:///documents/offline/${id}`;

describe('clearAll', () => {
  test('cancels in-flight downloads, leaves no files or status, and keeps the concurrency limit', async () => {
    offlineManager.makeFilesAvailable([1, 2, 3, 4, 5].map((n) => ({ id: `f${n}`, name: `n${n}` })));
    await tick();
    expect(started).toHaveLength(3); // MAX_CONCURRENT

    await offlineManager.clearAll();
    // the cancelled jobs finish late with a good response: they must not re-add anything
    for (const id of ['f1', 'f2', 'f3']) releases.get(path(id))?.({ status: 200, headers: {} });
    await tick();

    for (const id of ['f1', 'f2', 'f3', 'f4', 'f5']) {
      expect(offlineManager.getStatus(id)).toBeUndefined();
      expect(offlineManager.isAvailable(id)).toBe(false);
    }
    expect(offlineManager.offlineFileIds()).toEqual([]);
    expect(deletes).toContain(path('f1'));
    expect(paused).toBeGreaterThanOrEqual(3);
    expect(started).toHaveLength(3); // the queued f4, f5 were dropped, nothing new started

    // the count is intact: a fresh batch starts exactly MAX_CONCURRENT downloads
    started.length = 0;
    offlineManager.makeFilesAvailable([6, 7, 8, 9, 10].map((n) => ({ id: `g${n}`, name: `n${n}` })));
    await tick();
    expect(started).toHaveLength(3);
    await offlineManager.clearAll();
  });

  test('clear during startup prevents a stale job from creating or starting a download', async () => {
    started.length = 0;
    deletes.length = 0;
    let releaseInfo!: (value: { exists: boolean }) => void;
    getInfoImpl = () => new Promise((resolve) => { releaseInfo = resolve; });

    offlineManager.makeFilesAvailable([{ id: 'startup-race', name: 'race' }]);
    await tick();
    expect(started).toEqual([]);
    await offlineManager.clearAll();
    releaseInfo({ exists: false });
    await tick();

    expect(started).toEqual([]);
    expect(offlineManager.getStatus('startup-race')).toBeUndefined();
    expect(deletes).not.toContain(path('startup-race'));
    getInfoImpl = async () => ({ exists: false });
  });

  test('an active download is paused before clear deletes its files', async () => {
    started.length = 0;
    deletes.length = 0;
    getInfoImpl = async () => ({ exists: true });
    let finishPause!: () => void;
    pauseImpl = () => new Promise<void>((resolve) => { finishPause = resolve; });

    offlineManager.makeFilesAvailable([{ id: 'pause-race', name: 'race' }]);
    await tick();
    expect(started).toEqual([path('pause-race')]);
    const clearing = offlineManager.clearAll();
    await tick();
    expect(deletes).not.toContain(path('pause-race'));
    expect(deletes).not.toContain('file:///documents/offline/');

    finishPause();
    await clearing;
    await tick();
    expect(deletes).toContain('file:///documents/offline/');
    pauseImpl = async () => { paused += 1; };
    getInfoImpl = async () => ({ exists: false });
  });
});
