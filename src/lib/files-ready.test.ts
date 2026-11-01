// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
/**
 * After every successful unlock the app makes sure the Files app works (session and key
 * material for the extension, root and working set signalled, an earlier "Authentication
 * Required" cleared). The "ready" sheet is shown only when Files asked for it: the extension
 * recorded a -1000 within the last 15 minutes.
 */
import { describe, expect, test } from 'bun:test';
import {
  FILES_READY_WINDOW_MS,
  isFilesReadyDue,
  runFilesPostUnlock,
  type FilesPostUnlockDeps,
} from './files-ready';

const NOW = 1_800_000_000_000;
const seconds = (msAgo: number) => (NOW - msAgo) / 1000;

function fakes(overrides: Partial<FilesPostUnlockDeps> & { flag?: number | null } = {}) {
  const calls: string[] = [];
  const deps: FilesPostUnlockDeps = {
    readAuthRequiredAt: async () => { calls.push('read'); return overrides.flag ?? null; },
    clearAuthRequired: async () => { calls.push('clear'); return true; },
    mirrorSession: async () => { calls.push('mirror'); return true; },
    ensureFiles: async () => { calls.push('ensure'); return { action: 'register', changed: true }; },
    signalEnumerators: async () => { calls.push('signal'); return true; },
    now: () => NOW,
    ...overrides,
  };
  return { deps, calls };
}

describe('isFilesReadyDue', () => {
  test('due only when the flag is within the 15 minute window', () => {
    expect(FILES_READY_WINDOW_MS).toBe(15 * 60 * 1000);
    expect(isFilesReadyDue(seconds(1_000), NOW)).toBe(true);
    expect(isFilesReadyDue(seconds(FILES_READY_WINDOW_MS - 1_000), NOW)).toBe(true);
    expect(isFilesReadyDue(seconds(FILES_READY_WINDOW_MS + 1_000), NOW)).toBe(false);
  });

  test('never due without a usable timestamp', () => {
    expect(isFilesReadyDue(null, NOW)).toBe(false);
    expect(isFilesReadyDue(undefined, NOW)).toBe(false);
    expect(isFilesReadyDue(Number.NaN, NOW)).toBe(false);
    expect(isFilesReadyDue(0, NOW)).toBe(false);
  });

  test('a timestamp far in the future (clock moved) is not trusted', () => {
    expect(isFilesReadyDue(seconds(-60 * 60 * 1000), NOW)).toBe(false);
  });
});

describe('runFilesPostUnlock', () => {
  test('mirrors the session, ensures Files, then signals the enumerators, in that order', async () => {
    const { deps, calls } = fakes();
    await runFilesPostUnlock(deps);
    expect(calls.filter((c) => c !== 'read')).toEqual(['mirror', 'ensure', 'signal']);
  });

  test('does not signal Files when there was no authentication request and the domain did not change', async () => {
    const { deps, calls } = fakes({
      ensureFiles: async () => { calls.push('ensure'); return { action: 'already-mounted', changed: false }; },
    });
    await runFilesPostUnlock(deps);
    expect(calls).toEqual(['read', 'mirror', 'ensure']);
  });

  test('an authentication request still signals when the domain was already mounted', async () => {
    const { deps, calls } = fakes({
      flag: seconds(1_000),
      ensureFiles: async () => { calls.push('ensure'); return { action: 'already-mounted', changed: false }; },
    });
    await runFilesPostUnlock(deps);
    expect(calls).toContain('signal');
  });

  test('a recent flag shows the sheet once and clears the flag', async () => {
    const { deps, calls } = fakes({ flag: seconds(60_000) });
    const result = await runFilesPostUnlock(deps);
    expect(result.showReady).toBe(true);
    expect(calls.filter((c) => c === 'clear')).toHaveLength(1);
    expect(calls.indexOf('clear')).toBeGreaterThan(calls.indexOf('ensure'));
  });

  test('the flag is read before recovery runs, so recovery cannot hide the sheet', async () => {
    const { deps, calls } = fakes({ flag: seconds(60_000) });
    await runFilesPostUnlock(deps);
    expect(calls.indexOf('read')).toBeLessThan(calls.indexOf('mirror'));
  });

  test('no flag: no sheet, nothing to clear', async () => {
    const { deps, calls } = fakes({ flag: null });
    const result = await runFilesPostUnlock(deps);
    expect(result.showReady).toBe(false);
    expect(calls).not.toContain('clear');
  });

  test('a stale flag (older than 15 minutes) shows no sheet and is cleared', async () => {
    const { deps, calls } = fakes({ flag: seconds(FILES_READY_WINDOW_MS + 60_000) });
    const result = await runFilesPostUnlock(deps);
    expect(result.showReady).toBe(false);
    expect(calls).toContain('clear');
  });

  test('Files is off for this account: no sheet', async () => {
    const { deps } = fakes({ flag: seconds(1_000), ensureFiles: async () => ({ action: 'stay-off' }) });
    expect((await runFilesPostUnlock(deps)).showReady).toBe(false);
  });

  test('when Files could not be made ready, no sheet and the flag stays for the next unlock', async () => {
    const { deps, calls } = fakes({
      flag: seconds(1_000),
      ensureFiles: async () => { throw new Error('registration failed'); },
    });
    const result = await runFilesPostUnlock(deps);
    expect(result.showReady).toBe(false);
    expect(calls).not.toContain('clear');
  });

  test('a failing step never throws out of the unlock path', async () => {
    const { deps } = fakes({
      flag: seconds(1_000),
      readAuthRequiredAt: async () => { throw new Error('db'); },
      mirrorSession: async () => { throw new Error('keychain'); },
      signalEnumerators: async () => { throw new Error('fileproviderd'); },
    });
    await expect(runFilesPostUnlock(deps)).resolves.toEqual({ showReady: false });
  });
});
