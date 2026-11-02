/**
 * photo-refresh: when the Photos tab re-reads the index on its own.
 *
 * The tab stays mounted while a camera-roll backup uploads, and it only
 * re-read on focus, so new backups stayed invisible until a manual refresh.
 * It now also refreshes when the number of backed-up items goes up (at most
 * once per interval while uploads keep landing) and when the app returns to
 * the foreground.
 */

/** How often a running backup may trigger a re-read of the Photos list. */
export const BACKUP_REFRESH_INTERVAL_MS = 15_000;

/** A manual refresh always stops in bounded time, even if a server call does not. */
export const PHOTO_REFRESH_TIMEOUT_MS = 15_000;

export class PhotoRefreshTimeoutError extends Error {
  constructor() {
    super('photo refresh timed out');
    this.name = 'PhotoRefreshTimeoutError';
  }
}

/** True when the backup has completed more items than the previous reading. */
export function backupCompletedAdvanced(previous: number | undefined, next: number): boolean {
  return previous !== undefined && next > previous;
}

export interface RefreshTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: any) => void;
}

export interface RefreshDeadlineTimers extends RefreshTimers {
  now: () => number;
}

/**
 * One deadline shared by every phase of a manual refresh. Each `wait` only
 * receives the time left, so a chain of individually slow operations cannot
 * keep extending the pull spinner.
 */
export function createPhotoRefreshDeadline(
  timeoutMs = PHOTO_REFRESH_TIMEOUT_MS,
  timers: RefreshDeadlineTimers = {
    now: () => Date.now(),
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle),
  },
) {
  const expiresAt = timers.now() + Math.max(0, timeoutMs);

  return {
    wait<T>(operation: Promise<T>): Promise<T> {
      const remainingMs = Math.max(0, expiresAt - timers.now());
      if (remainingMs === 0) {
        // Observe a late rejection even though this caller has already timed out.
        void operation.catch(() => {});
        return Promise.reject(new PhotoRefreshTimeoutError());
      }

      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const handle = timers.set(() => {
          if (settled) return;
          settled = true;
          reject(new PhotoRefreshTimeoutError());
        }, remainingMs);

        operation.then(
          (value) => {
            if (settled) return;
            settled = true;
            timers.clear(handle);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            timers.clear(handle);
            reject(error);
          },
        );
      });
    },
  };
}

/**
 * Coalesces requests: the first `schedule()` starts a timer, later ones while
 * it runs add nothing, and `run` fires when it ends. So a long backup refreshes
 * every `delayMs` rather than never (a debounce would keep resetting).
 */
export function createRefreshScheduler(
  run: () => void,
  delayMs: number,
  timers: RefreshTimers = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) },
) {
  let handle: unknown = null;
  return {
    schedule(): void {
      if (handle !== null) return;
      handle = timers.set(() => {
        handle = null;
        run();
      }, delayMs);
    },
    cancel(): void {
      if (handle === null) return;
      timers.clear(handle);
      handle = null;
    },
  };
}
