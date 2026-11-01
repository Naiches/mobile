/**
 * Real local cache usage on this iPhone, per kind, and clearing one kind.
 *
 *   thumbnails  Documents/beebeeb-thumbnails-v3 (+ older layouts)
 *   previews    Library/Caches/beebeeb-previews-v1
 *   offline     Documents/offline  (files the user kept available offline)
 *   temporary   transient decrypted copies in Library/Caches, picked by an
 *               allowlist of names from caches-plaintext-registry.ts
 *
 * Clearing a kind deletes only that kind's paths. Nothing here touches user
 * files, keys, the file index, the name cache or backup state, and in-flight
 * work (pending uploads, publish retries, backup manifests) is never on the
 * temporary list. Dependency-light so it runs in the isolated test runner.
 */
import { THUMB_CACHE_DIR_NAME, LEGACY_THUMB_CACHE_DIR_NAMES } from './thumbnail-policy';

export type CacheKind = 'thumbnails' | 'previews' | 'offline' | 'temporary';
export const CACHE_KINDS: readonly CacheKind[] = ['thumbnails', 'previews', 'offline', 'temporary'];

export interface CacheUsage extends Record<CacheKind, number> {
  total: number;
}

export interface CacheFs {
  documentDirectory: string | null;
  cacheDirectory: string | null;
  readDirectoryAsync: (uri: string) => Promise<string[]>;
  getInfoAsync: (uri: string) => Promise<{ exists: boolean; isDirectory?: boolean; size?: number; modificationTime?: number }>;
  deleteAsync: (uri: string, options?: { idempotent?: boolean }) => Promise<void>;
}

const PREVIEWS_DIR = 'beebeeb-previews-v1';
const OFFLINE_DIR = 'offline';

/** Top-level Library/Caches names holding transient, re-creatable decrypted copies. */
const TEMP_EXACT = new Set(['preview', 'zip-extract', 'beebeeb-export', 'beebeeb-photo-cache']);
const TEMP_PREFIXES = ['shared_', 'thumb_', 'beebeeb-photos-', 'beebeeb-data-export-', 'beebeeb-proof-'];
const LEGACY_ID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_/i;

export function temporaryCacheNames(topLevelNames: readonly string[]): string[] {
  return topLevelNames.filter((n) => {
    const name = n.replace(/\/$/, '');
    return (
      TEMP_EXACT.has(name) ||
      TEMP_PREFIXES.some((p) => name.startsWith(p)) ||
      LEGACY_ID_PREFIX.test(name) ||
      /\.beebeeb\.enc$/.test(name)
    );
  });
}

function thumbnailPaths(fs: CacheFs): string[] {
  const docs = fs.documentDirectory;
  if (!docs) return [];
  return [THUMB_CACHE_DIR_NAME, ...LEGACY_THUMB_CACHE_DIR_NAMES].map((n) => `${docs}${n}`);
}

async function pathsFor(kind: CacheKind, fs: CacheFs): Promise<string[]> {
  switch (kind) {
    case 'thumbnails':
      return thumbnailPaths(fs);
    case 'previews': {
      // Measured and cleared here, never written (photo-preview-cache.ts is the gated writer).
      const dir = fs.cacheDirectory;
      return dir ? [`${dir}${PREVIEWS_DIR}`] : [];
    }
    case 'offline':
      return fs.documentDirectory ? [`${fs.documentDirectory}${OFFLINE_DIR}`] : [];
    case 'temporary': {
      const dir = fs.cacheDirectory;
      if (!dir) return [];
      const names = await fs.readDirectoryAsync(dir).catch(() => [] as string[]);
      return temporaryCacheNames(names).map((n) => `${dir}${n}`);
    }
  }
}

async function sizeOf(fs: CacheFs, uri: string): Promise<number> {
  try {
    const info = await fs.getInfoAsync(uri);
    // On iOS a directory's `size` is the recursive total of what it holds.
    return info.exists && typeof info.size === 'number' && info.size > 0 ? info.size : 0;
  } catch {
    return 0;
  }
}

export async function measureCacheUsage(fs: CacheFs): Promise<CacheUsage> {
  const sizes = await Promise.all(
    CACHE_KINDS.map(async (kind) => {
      const paths = await pathsFor(kind, fs).catch(() => [] as string[]);
      return (await Promise.all(paths.map((p) => sizeOf(fs, p)))).reduce((a, b) => a + b, 0);
    }),
  );
  const usage = { total: 0 } as CacheUsage;
  CACHE_KINDS.forEach((kind, i) => {
    usage[kind] = sizes[i]!;
    usage.total += sizes[i]!;
  });
  return usage;
}

export interface ClearDeps {
  fs: CacheFs;
  /** Runs after the files are gone: drop in-memory indexes/manifests for that kind. */
  reset?: Partial<Record<CacheKind, () => Promise<void>>>;
  /** True for a path another feature holds right now (an open preview's copy). */
  inUse?: (uri: string) => boolean;
  now?: () => number;
}

/** A temporary file written this recently may belong to work still running (a share zip, a thumbnail repair). */
export const TEMP_RECENT_MS = 10 * 60 * 1000;

/**
 * Delete a temporary file or folder unless it is in use or was written
 * moments ago. Returns true when it is fully gone.
 */
async function deleteUnlessBusy(uri: string, deps: ClearDeps): Promise<boolean> {
  const { fs } = deps;
  if (deps.inUse?.(uri)) return false;
  let info: Awaited<ReturnType<CacheFs['getInfoAsync']>>;
  try {
    info = await fs.getInfoAsync(uri);
  } catch {
    return false;
  }
  if (!info.exists) return true;
  if (info.isDirectory) {
    const base = uri.replace(/\/$/, '');
    const children = await fs.readDirectoryAsync(base).catch(() => null);
    if (!children) return false;
    let allGone = true;
    for (const child of children) {
      if (!(await deleteUnlessBusy(`${base}/${child}`, deps))) allGone = false;
    }
    if (allGone) await fs.deleteAsync(base, { idempotent: true }).catch(() => { allGone = false; });
    return allGone;
  }
  const modified = (info.modificationTime ?? 0) * 1000;
  if ((deps.now ?? Date.now)() - modified < TEMP_RECENT_MS) return false;
  await fs.deleteAsync(uri, { idempotent: true }).catch(() => {});
  return true;
}

export async function clearCacheKind(kind: CacheKind, deps: ClearDeps): Promise<void> {
  const paths = await pathsFor(kind, deps.fs);
  if (kind === 'temporary') {
    for (const p of paths) await deleteUnlessBusy(p, deps);
  } else {
    await Promise.all(paths.map((p) => deps.fs.deleteAsync(p, { idempotent: true }).catch(() => {})));
  }
  await deps.reset?.[kind]?.().catch(() => {});
}

export interface CacheUsageController {
  start(): void;
  stop(): void;
  refresh(): Promise<CacheUsage>;
  clear(kind: CacheKind): Promise<void>;
}

// A directory's size is a walk over every file in it (tens of thousands of
// thumbnails), so the open page re-measures slowly; it also measures on open,
// after each Clear and on pull-to-refresh.
export const CACHE_USAGE_POLL_MS = 30000;

export function createCacheUsageController(opts: {
  fs: CacheFs;
  reset?: ClearDeps['reset'];
  inUse?: ClearDeps['inUse'];
  onChange: (usage: CacheUsage) => void;
  pollMs?: number;
  /** The poll does nothing while this answers false (app in the background). */
  isActive?: () => boolean;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}): CacheUsageController {
  const setTimer = opts.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
  const clearTimer = opts.clearInterval ?? ((h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>));
  let inflight: Promise<CacheUsage> | null = null;
  let timer: unknown = null;
  let stopped = false;

  const measure = (): Promise<CacheUsage> => {
    const run = measureCacheUsage(opts.fs)
      .then((u) => {
        if (!stopped) opts.onChange(u);
        return u;
      })
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  };

  return {
    start() {
      stopped = false;
      if (timer != null) return;
      timer = setTimer(() => {
        if (opts.isActive && !opts.isActive()) return;
        void this.refresh();
      }, opts.pollMs ?? CACHE_USAGE_POLL_MS);
    },
    stop() {
      stopped = true;
      if (timer != null) clearTimer(timer);
      timer = null;
    },
    refresh() {
      return inflight ?? measure();
    },
    async clear(kind) {
      await clearCacheKind(kind, { fs: opts.fs, reset: opts.reset, inUse: opts.inUse });
      // A measurement that started before the clear would show stale numbers.
      if (inflight) await inflight.catch(() => {});
      await measure();
    },
  };
}
