/**
 * Files recovery after an unlock.
 *
 * After every successful unlock the app makes sure the Files app works: the session is mirrored to
 * the App Group, the extension has its key and Files' authentication throttle is lifted (both done
 * by the domain registration that `ensureFiles` runs), and the root and working set are signalled
 * when Files asked for authentication or the domain registration changed, so Files reloads on its own.
 *
 * The "Beebeeb is ready in the Files app" sheet is shown only when Files asked for it: when the
 * extension ends a request with "Authentication Required" it records a timestamp in the shared
 * cache. If the app is unlocked within 15 minutes of that, the sheet says Files can be used again.
 * Then the timestamp is cleared. The timestamp is read BEFORE the recovery runs, so the recovery
 * cannot hide the reason for it.
 *
 * Pure: every effect arrives through `FilesPostUnlockDeps`, so the order and the decision are
 * tested without the native module.
 */

export const FILES_READY_WINDOW_MS = 15 * 60 * 1000;

/** A timestamp this far in the future means the clock moved; it is not trusted. */
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

/** Whether `authRequiredAtSeconds` (Unix seconds, as the extension wrote it) is recent enough. */
export function isFilesReadyDue(authRequiredAtSeconds: number | null | undefined, nowMs: number): boolean {
  if (typeof authRequiredAtSeconds !== 'number' || !Number.isFinite(authRequiredAtSeconds) || authRequiredAtSeconds <= 0) {
    return false;
  }
  const ageMs = nowMs - authRequiredAtSeconds * 1000;
  return ageMs >= -CLOCK_SKEW_TOLERANCE_MS && ageMs <= FILES_READY_WINDOW_MS;
}

export interface FilesPostUnlockDeps {
  /** Unix seconds of the extension's last "Authentication Required", or null. */
  readAuthRequiredAt: () => Promise<number | null>;
  clearAuthRequired: () => Promise<unknown>;
  /** Copies the session to the App Group for the extension. */
  mirrorSession: () => Promise<unknown>;
  /** Registers the domain (key for the extension, lifts the authentication throttle). */
  ensureFiles: () => Promise<{ action: string; changed?: boolean } | null | undefined>;
  /** Signals the root and the working set. */
  signalEnumerators: () => Promise<unknown>;
  now: () => number;
}

export interface FilesPostUnlockResult {
  showReady: boolean;
}

async function attempt<T>(step: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await step() };
  } catch {
    return { ok: false };
  }
}

export async function runFilesPostUnlock(deps: FilesPostUnlockDeps): Promise<FilesPostUnlockResult> {
  const flag = await attempt(deps.readAuthRequiredAt);
  const authRequiredAt = flag.ok ? flag.value : null;
  const due = isFilesReadyDue(authRequiredAt, deps.now());

  await attempt(deps.mirrorSession);
  const ensured = await attempt(deps.ensureFiles);
  if (authRequiredAt != null || (ensured.ok && ensured.value?.changed === true)) {
    await attempt(deps.signalEnumerators);
  }

  const ready =
    ensured.ok &&
    !!ensured.value &&
    ensured.value.action !== 'stay-off' &&
    ensured.value.action !== 'unsupported';

  // Cleared once handled. If Files could not be made ready, the timestamp stays for the next unlock
  // (it still expires on its own after the window).
  if (authRequiredAt != null && ensured.ok) {
    await attempt(deps.clearAuthRequired);
  }
  return { showReady: due && ready };
}
