// @ts-nocheck — bun runs this; `bun:test` types are not in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import {
  STALE_AFTER_MS,
  FOREGROUND_MIN_BACKGROUND_MS,
  computeFreshnessLine,
  createForegroundReturnTracker,
  requestDriveRefresh,
  onDriveRefreshRequest,
  shouldRunFreshnessRefresh,
} from './drive-freshness';

const NOW = 1_000_000_000;
const MIN = 60_000;

describe('computeFreshnessLine', () => {
  test('offline wins over everything', () => {
    const line = computeFreshnessLine({ online: false, syncStatus: 'reconnecting', lastFreshAt: NOW - 10 * MIN, now: NOW });
    expect(line).toEqual({ kind: 'offline', text: 'Offline · showing saved list' });
  });

  test('reconnecting while online', () => {
    for (const syncStatus of ['reconnecting', 'connecting', 'disconnected']) {
      const line = computeFreshnessLine({ online: true, syncStatus, lastFreshAt: NOW, now: NOW });
      expect(line).toEqual({ kind: 'reconnecting', text: 'Reconnecting…' });
    }
  });

  test('connected and recent shows nothing', () => {
    expect(computeFreshnessLine({ online: true, syncStatus: 'connected', lastFreshAt: NOW - 10 * MIN, now: NOW })).toBeNull();
  });

  test('no live stream and fresher than 2 minutes shows nothing', () => {
    expect(computeFreshnessLine({ online: true, syncStatus: 'idle', lastFreshAt: NOW - STALE_AFTER_MS + 1, now: NOW })).toBeNull();
  });

  test('no live stream and older than 2 minutes shows Updated N min ago', () => {
    expect(computeFreshnessLine({ online: true, syncStatus: 'idle', lastFreshAt: NOW - 5 * MIN, now: NOW }))
      .toEqual({ kind: 'stale', text: 'Updated 5 min ago' });
    expect(computeFreshnessLine({ online: true, syncStatus: 'idle', lastFreshAt: NOW - 3 * 60 * MIN, now: NOW }))
      .toEqual({ kind: 'stale', text: 'Updated 3 h ago' });
  });

  test('never refreshed and no stream shows nothing (nothing to be stale about yet)', () => {
    expect(computeFreshnessLine({ online: true, syncStatus: 'idle', lastFreshAt: null, now: NOW })).toBeNull();
  });
});

describe('shouldRunFreshnessRefresh', () => {
  test('throttles bursts but lets the first and later ones through', () => {
    expect(shouldRunFreshnessRefresh({ lastRunAt: null, now: NOW })).toBe(true);
    expect(shouldRunFreshnessRefresh({ lastRunAt: NOW - 500, now: NOW })).toBe(false);
    expect(shouldRunFreshnessRefresh({ lastRunAt: NOW - 5000, now: NOW })).toBe(true);
  });
});

describe('drive refresh requests', () => {
  test('listeners hear requests and can unsubscribe', () => {
    const seen: string[] = [];
    const off = onDriveRefreshRequest((reason) => seen.push(reason));
    requestDriveRefresh('share-import');
    off();
    requestDriveRefresh('share-import');
    expect(seen).toEqual(['share-import']);
  });
});

describe('createForegroundReturnTracker', () => {
  test('only a return after a real background period counts', () => {
    let t = NOW;
    const track = createForegroundReturnTracker(() => t);
    track('inactive');
    t += 5_000;
    expect(track('active')).toBe(false); // Face ID or Control Center blip
    track('background');
    t += FOREGROUND_MIN_BACKGROUND_MS - 1;
    expect(track('active')).toBe(false); // too short
    track('background');
    t += FOREGROUND_MIN_BACKGROUND_MS;
    expect(track('active')).toBe(true);
    expect(track('active')).toBe(false); // one return, one answer
  });

  test('inactive between background and active does not restart the clock', () => {
    let t = NOW;
    const track = createForegroundReturnTracker(() => t);
    track('background');
    t += 20_000;
    track('inactive');
    t += 20_000;
    expect(track('active')).toBe(true);
  });
});
