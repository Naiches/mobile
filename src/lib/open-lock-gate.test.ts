// @ts-nocheck
// Flow "iOS core journeys on the simulator", fix lane 2 (P2): a locked file
// opened from the Files tab asked for Face ID TWICE — once in
// FilesScreen.openFile's pre-navigation check, then again in PreviewScreen,
// which enforces its own gate (task 1539) and knows nothing about the first
// prompt. PhotosScreen dropped the same pre-check for the same reason
// (PhotosScreen.tsx openPhoto comment, PR #109 review).
//
// These tests drive the real Files -> Preview path: `openFilesEntry` is the
// whole of FilesScreen.openFile's decision (gate + folder/upload/Preview
// dispatch); its `openPreview` hook then runs Preview's own gate
// (checkLockedFileIds + isPagerPageGated) and tap-to-authenticate, which calls
// authenticateAsync exactly like PreviewScreen.handleUnlockCurrent.
//
// Review of PR #113: a test of the helper alone does not catch someone
// re-adding the inline `isFileLocked` + `authenticateAsync` check to
// FilesScreen.openFile itself (the original bug site). The last describe block
// reads FilesScreen.tsx and requires openFile to delegate to openFilesEntry
// with no lock check or Face ID prompt of its own.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const store = new Map<string, string>();
let authCalls = 0;
let authResult = true;

mock.module('expo-secure-store', () => ({
  getItemAsync: async (key: string) => store.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => { store.set(key, value); },
  deleteItemAsync: async (key: string) => { store.delete(key); },
}));

mock.module('expo-local-authentication', () => ({
  authenticateAsync: async () => {
    authCalls += 1;
    return { success: authResult };
  },
}));

const { createOpenFilesEntryGuard, passesOpenLockGate, openFilesEntry } = await import('./open-lock-gate');
const { checkLockedFileIds, isPagerPageGated } = await import('./preview-lock-gate');
const { lockFile } = await import('./file-locks');
const LocalAuthentication = await import('expo-local-authentication');

beforeEach(() => {
  store.clear();
  authCalls = 0;
  authResult = true;
});

/** Mirrors PreviewScreen's mount-time gate + tap-to-authenticate handler. */
async function previewUnlock(fileId: string): Promise<boolean> {
  const locked = await checkLockedFileIds([fileId]);
  const authenticated = new Set<string>();
  if (!isPagerPageGated(fileId, locked, authenticated, true)) return true;
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: 'Authenticate to open this file',
    disableDeviceFallback: true,
  });
  if (result.success) authenticated.add(fileId);
  return !isPagerPageGated(fileId, locked, authenticated, true);
}

/** Taps a row the way FilesScreen.openFile does; Preview (if pushed) then runs its own gate. */
async function tapRow(entry: { id: string; is_folder: boolean; is_uploading?: boolean }) {
  let previewVisible: boolean | null = null;
  const events: string[] = [];
  const outcome = await openFilesEntry(entry, {
    navigateToFolder: () => { events.push('folder'); },
    handlePendingUpload: async () => { events.push('pending'); },
    ensureFileReady: async () => true,
    openPreview: () => { events.push('preview'); },
  });
  if (outcome === 'preview') previewVisible = await previewUnlock(entry.id);
  return { outcome, previewVisible, events };
}

describe('Files tab -> Preview for a locked file', () => {
  test('asks for Face ID exactly once across the whole journey', async () => {
    await lockFile('locked-file');
    const { outcome, previewVisible } = await tapRow({ id: 'locked-file', is_folder: false });
    expect(outcome).toBe('preview');
    expect(previewVisible).toBe(true);
    expect(authCalls).toBe(1);
  });

  test('Files never shows plaintext itself: Preview still gates a locked file (fail-closed)', async () => {
    await lockFile('locked-file');
    expect(await passesOpenLockGate({ id: 'locked-file', is_folder: false })).toBe(true);
    const locked = await checkLockedFileIds(['locked-file']);
    expect(isPagerPageGated('locked-file', locked, new Set(), true)).toBe(true);
  });

  test('a failed Face ID in Preview keeps the file gated', async () => {
    await lockFile('locked-file');
    authResult = false;
    const { outcome, previewVisible } = await tapRow({ id: 'locked-file', is_folder: false });
    expect(outcome).toBe('preview');
    expect(previewVisible).toBe(false);
    expect(authCalls).toBe(1);
  });

  test('an unlocked file prompts zero times', async () => {
    const { outcome, previewVisible } = await tapRow({ id: 'plain', is_folder: false });
    expect(outcome).toBe('preview');
    expect(previewVisible).toBe(true);
    expect(authCalls).toBe(0);
  });

  test('a locked pending upload is dispatched without a prompt', async () => {
    await lockFile('uploading');
    const { outcome, events } = await tapRow({ id: 'uploading', is_folder: false, is_uploading: true });
    expect(outcome).toBe('pending-upload');
    expect(events).toEqual(['pending']);
    expect(authCalls).toBe(0);
  });
});

describe('locked folders still gate navigation in FilesScreen (no Preview behind them)', () => {
  test('locked folder: one prompt, navigation proceeds on success', async () => {
    await lockFile('locked-folder');
    const { outcome, events } = await tapRow({ id: 'locked-folder', is_folder: true });
    expect(outcome).toBe('folder');
    expect(events).toEqual(['folder']);
    expect(authCalls).toBe(1);
  });

  test('locked folder: failed Face ID blocks navigation', async () => {
    await lockFile('locked-folder');
    authResult = false;
    const { outcome, events } = await tapRow({ id: 'locked-folder', is_folder: true });
    expect(outcome).toBe('blocked');
    expect(events).toEqual([]);
    expect(authCalls).toBe(1);
  });

  test('unlocked folder: no prompt', async () => {
    const { outcome } = await tapRow({ id: 'plain-folder', is_folder: true });
    expect(outcome).toBe('folder');
    expect(authCalls).toBe(0);
  });
});

describe('FilesScreen per-entry open single-flight', () => {
  test('two overlapping taps on the same id run readiness and navigation once', async () => {
    let releaseReady!: (ready: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { releaseReady = resolve; });
    let readinessCalls = 0;
    let previewCalls = 0;
    const guard = createOpenFilesEntryGuard();
    const entry = { id: 'same-file', is_folder: false };
    const deps = {
      navigateToFolder: () => {},
      handlePendingUpload: async () => {},
      ensureFileReady: async () => {
        readinessCalls += 1;
        return ready;
      },
      openPreview: () => { previewCalls += 1; },
    };

    const first = guard(entry, deps);
    const second = guard(entry, deps);
    expect(second).toBe(first);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readinessCalls).toBe(1);

    releaseReady(true);
    expect(await Promise.all([first, second])).toEqual(['preview', 'preview']);
    expect(previewCalls).toBe(1);

    // Settling releases the key, so a later intentional tap can open again.
    expect(await guard(entry, deps)).toBe('preview');
    expect(readinessCalls).toBe(2);
    expect(previewCalls).toBe(2);
  });

  test('different ids are not serialized behind each other', async () => {
    const releases = new Map<string, (ready: boolean) => void>();
    const started: string[] = [];
    const opened: string[] = [];
    const guard = createOpenFilesEntryGuard<{ id: string; is_folder: boolean }>();
    const deps = {
      navigateToFolder: () => {},
      handlePendingUpload: async () => {},
      ensureFileReady: (entry: { id: string }) => {
        started.push(entry.id);
        return new Promise<boolean>((resolve) => { releases.set(entry.id, resolve); });
      },
      openPreview: (entry: { id: string }) => { opened.push(entry.id); },
    };

    const first = guard({ id: 'first', is_folder: false }, deps);
    const second = guard({ id: 'second', is_folder: false }, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(['first', 'second']);

    releases.get('second')!(true);
    expect(await second).toBe('preview');
    expect(opened).toEqual(['second']);
    releases.get('first')!(true);
    expect(await first).toBe('preview');
    expect(opened).toEqual(['second', 'first']);
  });

  test('a rejection releases the id so the next tap can retry', async () => {
    let attempts = 0;
    const guard = createOpenFilesEntryGuard();
    const entry = { id: 'retry-file', is_folder: false };
    const deps = {
      navigateToFolder: () => {},
      handlePendingUpload: async () => {},
      ensureFileReady: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('readiness failed');
        return true;
      },
      openPreview: () => {},
    };

    await expect(guard(entry, deps)).rejects.toThrow('readiness failed');
    await expect(guard(entry, deps)).resolves.toBe('preview');
    expect(attempts).toBe(2);
  });
});

describe('FilesScreen.openFile (the original bug site) delegates to openFilesEntry', () => {
  const src = readFileSync(new URL('../screens/FilesScreen.tsx', import.meta.url), 'utf8');
  const start = src.indexOf('const openFile = useCallback(');
  const end = src.indexOf('const handleRefresh = useCallback(', start);
  const body = start >= 0 && end > start ? src.slice(start, end) : '';
  const readinessStart = src.indexOf('const ensureFileReady = useCallback(');
  const readinessEnd = src.indexOf('const openFile = useCallback(', readinessStart);
  const readinessBody = readinessStart >= 0 && readinessEnd > readinessStart
    ? src.slice(readinessStart, readinessEnd)
    : '';

  test('the openFile body was found (this check did something)', () => {
    expect(body.length).toBeGreaterThan(200);
    expect(body).toContain("navigation.navigate('Preview'");
  });

  test('openFile routes the tap through the stable per-entry guard', () => {
    expect(body).toContain('await openFilesEntryGuardRef.current!(file,');
  });

  test('openFile has no lock check or Face ID prompt of its own', () => {
    expect(body).not.toMatch(/\bisFileLocked\s*\(/);
    expect(body).not.toMatch(/\bauthenticateAsync\s*\(/);
    expect(body).not.toMatch(/\bpassesOpenLockGate\s*\(/);
  });

  test('cached rows do not make a status request before opening', () => {
    expect(readinessBody.length).toBeGreaterThan(100);
    expect(readinessBody).not.toContain('getUploadStatus(');
  });
});
