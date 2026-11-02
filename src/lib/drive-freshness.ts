/**
 * Drive freshness: the one place that decides whether the Drive list may be
 * out of date, and the one channel other parts of the app use to ask Drive to
 * re-check itself (a share-sheet import that just uploaded, for example).
 */
import type { ConnectionStatus } from './sync-client';

/** A list older than this, with no live stream vouching for it, is called out. */
export const STALE_AFTER_MS = 2 * 60_000;
/** Foreground / unlock / import triggers inside this window collapse into one. */
export const REFRESH_MIN_GAP_MS = 2_000;

/** A return from the background shorter than this does not refresh anything: the
 *  sockets are fine and the 60 s liveness check covers the rest. */
export const FOREGROUND_MIN_BACKGROUND_MS = 30_000;

/**
 * Feed every AppState change in; the result is true only for the `active` that
 * ends a background period of at least `FOREGROUND_MIN_BACKGROUND_MS`. A bare
 * `inactive` (Face ID, Control Center, the app switcher peek) never counts.
 */
export function createForegroundReturnTracker(now: () => number = Date.now): (next: string) => boolean {
  let leftTheAppAt: number | null = null;
  return (next) => {
    if (next === 'background' && leftTheAppAt === null) leftTheAppAt = now();
    if (next !== 'active') return false;
    const real = leftTheAppAt !== null && now() - leftTheAppAt >= FOREGROUND_MIN_BACKGROUND_MS;
    leftTheAppAt = null;
    return real;
  };
}

export type FreshnessLine =
  | { kind: 'offline'; text: string }
  | { kind: 'reconnecting'; text: string }
  | { kind: 'stale'; text: string };

export function computeFreshnessLine(input: {
  online: boolean;
  syncStatus: ConnectionStatus;
  /** Last successful refresh or sync catch-up, epoch ms; null if none yet. */
  lastFreshAt: number | null;
  now: number;
}): FreshnessLine | null {
  const { online, syncStatus, lastFreshAt, now } = input;
  if (!online) return { kind: 'offline', text: 'Offline · showing saved list' };
  if (syncStatus === 'reconnecting' || syncStatus === 'connecting' || syncStatus === 'disconnected') {
    return { kind: 'reconnecting', text: 'Reconnecting…' };
  }
  // A live stream means every change arrives as it happens.
  if (syncStatus === 'connected') return null;
  if (lastFreshAt == null) return null;
  const age = now - lastFreshAt;
  if (age <= STALE_AFTER_MS) return null;
  const mins = Math.floor(age / 60_000);
  if (mins >= 60) return { kind: 'stale', text: `Updated ${Math.floor(mins / 60)} h ago` };
  return { kind: 'stale', text: `Updated ${mins} min ago` };
}

export function shouldRunFreshnessRefresh(input: { lastRunAt: number | null; now: number }): boolean {
  return input.lastRunAt == null || input.now - input.lastRunAt >= REFRESH_MIN_GAP_MS;
}

export type DriveRefreshReason = 'share-import' | 'foreground' | 'unlock';

const listeners = new Set<(reason: DriveRefreshReason) => void>();

export function onDriveRefreshRequest(fn: (reason: DriveRefreshReason) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function requestDriveRefresh(reason: DriveRefreshReason): void {
  for (const fn of [...listeners]) {
    try {
      fn(reason);
    } catch {
      // a listener must never break the caller
    }
  }
}
