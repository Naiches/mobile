// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
// Drive refresh guards. Mounting the screen is not what these prove (same
// source-text convention as FilesScreen.region.test.ts); they pin the wiring
// that keeps the list fresh and the pull-to-refresh spinner from sticking.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = import.meta.dir;
const screen = readFileSync(join(dir, 'FilesScreen.tsx'), 'utf-8');
const app = readFileSync(join(dir, '..', 'App.tsx'), 'utf-8');
const syncContext = readFileSync(join(dir, '..', 'lib', 'sync-context.tsx'), 'utf-8');

describe('refresh spinner can never stick', () => {
  test('every fetch-superseding bump goes through the helper that clears loading and refreshing', () => {
    expect(screen).toContain('const supersedeInFlightFetch');
    const helper = screen.slice(screen.indexOf('const supersedeInFlightFetch'));
    const helperBody = helper.slice(0, helper.indexOf('}, []);'));
    expect(helperBody).toContain('setRefreshing(false)');
    expect(helperBody).toContain('setLoading(false)');
    // Outside the helper, the generation is only bumped by fetchFiles itself
    // (pre-increment) and by the folder-change layout effect, which resets both flags.
    const bumps = screen.match(/folderFetchGenerationRef\.current \+= 1/g) ?? [];
    expect(bumps.length).toBe(2); // helper + folder-change layout effect
  });

  test('a superseded fetch cannot leave a stale in-flight flag behind', () => {
    const fetchFiles = screen.slice(screen.indexOf('const fetchFiles = useCallback'), screen.indexOf('const lastLoadedFolderRef'));
    expect(fetchFiles).toContain('isRequestStillVisible()');
    expect(fetchFiles).toContain('finally');
  });
});

describe('a failed refresh never hides rows already on screen', () => {
  test('fetchFiles only shows the full-page error when there was nothing to show', () => {
    const fetchFiles = screen.slice(screen.indexOf('const fetchFiles = useCallback'), screen.indexOf('const lastLoadedFolderRef'));
    const catchBlock = fetchFiles.slice(fetchFiles.indexOf('} catch (err)'), fetchFiles.indexOf('} finally'));
    expect(catchBlock).toContain('!hasVisibleFiles');
  });
});

describe('pull-to-refresh is present wherever the list, its empty state or its skeleton shows', () => {
  test('one shared refresh control, used by the list, the skeleton and the error branch', () => {
    expect(screen).toContain('const pullToRefreshControl');
    const uses = screen.match(/refreshControl=\{selectMode \? undefined : pullToRefreshControl\}/g) ?? [];
    expect(uses.length).toBe(3);
    expect(screen).not.toContain('onRefresh={selectMode ? undefined : handleRefresh}');
  });
});

describe('one owner of "Drive is fresh"', () => {
  test('foreground, unlock and import requests all refresh through one silent path', () => {
    expect(screen).toContain('onDriveRefreshRequest');
    expect(screen).toMatch(/AppState\.addEventListener\('change'/);
    expect(screen).toContain('silent: true');
  });

  test('the foreground refresh ignores inactive blips', () => {
    const block = screen.slice(screen.indexOf("AppState.addEventListener('change'"));
    expect(block.slice(0, 500)).toContain("next === 'background'");
    expect(block.slice(0, 500)).toContain('leftTheApp');
  });

  test('the share-sheet import tells Drive when it uploaded something', () => {
    const drain = app.slice(app.indexOf('processPendingShares({'));
    expect(drain).toContain("requestDriveRefresh('share-import')");
  });

  test('the sync context exposes when the tree was last known current', () => {
    expect(syncContext).toContain('lastSyncAt');
    expect(syncContext).toContain("'caught-up'");
    // kept in a ref and published only on status changes, so the once-a-minute catch-up
    // does not change the context value for every consumer
    expect(syncContext).toContain('lastSyncAtRef');
    expect(syncContext).not.toMatch(/event\.type === 'caught-up'\) \{\s*setLastSyncAt/);
  });
});

describe('foreground cost stays small', () => {
  test('only a long-enough background period triggers the Drive refresh', () => {
    const block = screen.slice(screen.indexOf("AppState.addEventListener('change'"));
    expect(block.slice(0, 700)).toContain('FOREGROUND_MIN_BACKGROUND_MS');
  });

  test('a foreground return leaves listing to the sync catch-up when sync is ready', () => {
    const owner = screen.slice(screen.indexOf('const freshnessRefresh = useCallback'));
    expect(owner.slice(0, 1200)).toMatch(/reason === 'foreground' && syncReadyRef\.current/);
  });

  test('a silent refresh never piles onto a fetch that is already running', () => {
    const owner = screen.slice(screen.indexOf('const freshnessRefresh = useCallback'));
    expect(owner.slice(0, 1600)).toContain('fetchesInFlightRef.current > 0');
    const fetchFiles = screen.slice(screen.indexOf('const fetchFiles = useCallback'), screen.indexOf('const lastLoadedFolderRef'));
    expect(fetchFiles).toContain('fetchesInFlightRef.current += 1');
    expect(fetchFiles).toContain('fetchesInFlightRef.current -= 1');
  });
});

describe('freshness line', () => {
  test('lives in its own small component, so the screen does not re-render on a clock', () => {
    expect(screen).toContain('function FreshnessLine(');
    const root = screen.slice(screen.indexOf('export default function FilesScreen'));
    expect(root).not.toContain('setNowTick');
    expect(root).not.toContain('NetInfo.addEventListener');
    const comp = screen.slice(screen.indexOf('function FreshnessLine('), screen.indexOf('export default function FilesScreen'));
    expect(comp).toContain('computeFreshnessLine(');
    expect(comp).toContain('testID="drive-freshness-line"');
    // the 30 s clock only runs while the list is not vouched for by a live stream
    expect(comp).toMatch(/if \(status === 'connected'\) return;/);
  });

  test('rendered inside the floating header', () => {
    const headerArea = screen.slice(screen.indexOf('end headerArea') - 400, screen.indexOf('end headerArea'));
    expect(headerArea).toContain('<FreshnessLine');
  });
});
