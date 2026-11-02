// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

mock.module('expo-file-system/legacy', () => ({ cacheDirectory: 'file:///caches/' }));
const { CACHE_USAGE_POLL_MS, CACHE_KINDS, clearCacheKind, createCacheUsageController, measureCacheUsage, temporaryCacheNames } = await import('./cache-usage');
const { cachesEntryFor } = await import('./caches-plaintext-registry');

const DOCS = 'file:///docs/';
const CACHES = 'file:///caches/';

/** A tiny in-memory file system: path -> bytes (files) with directories implied. */
function fakeFs(files: Record<string, number>, mtimes: Record<string, number> = {}) {
  const tree = { ...files };
  const deleted: string[] = [];
  const norm = (u: string) => u.replace(/\/$/, '');
  const childrenOf = (dir: string) => {
    const prefix = `${norm(dir)}/`;
    const names = new Set<string>();
    for (const p of Object.keys(tree)) if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0]);
    return [...names];
  };
  return {
    tree, deleted,
    fs: {
      documentDirectory: DOCS,
      cacheDirectory: CACHES,
      readDirectoryAsync: async (dir: string) => childrenOf(dir),
      getInfoAsync: async (uri: string) => {
        const p = norm(uri);
        if (tree[p] != null) return { exists: true, isDirectory: false, size: tree[p], modificationTime: mtimes[p] ?? 0 };
        const prefix = `${p}/`;
        const inside = Object.keys(tree).filter((k) => k.startsWith(prefix));
        if (inside.length === 0) return { exists: false };
        return { exists: true, isDirectory: true, size: inside.reduce((n, k) => n + tree[k], 0) };
      },
      deleteAsync: async (uri: string) => {
        const p = norm(uri);
        deleted.push(p);
        for (const k of Object.keys(tree)) if (k === p || k.startsWith(`${p}/`)) delete tree[k];
      },
    },
  };
}

const world = () => ({
  [`${DOCS}beebeeb-thumbnails-v3/a.webp`]: 100,
  [`${DOCS}beebeeb-thumbnails-v3/b.webp`]: 50,
  [`${DOCS}beebeeb-thumbnails-v2/old.webp`]: 7,
  [`${CACHES}beebeeb-previews-v1/p1.jpg`]: 1000,
  [`${CACHES}beebeeb-previews-v1/samples/s.jpg`]: 500,
  [`${DOCS}offline/f1`]: 4000,
  [`${DOCS}offline/f2`]: 2000,
  [`${CACHES}preview/x.pdf`]: 30,
  [`${CACHES}zip-extract/z/a.txt`]: 20,
  [`${CACHES}beebeeb-export/Taxes.pdf`]: 10,
  [`${CACHES}beebeeb-photo-cache/id1`]: 300,
  [`${CACHES}shared_Report.pdf`]: 3,
  // never caches
  [`${DOCS}beebeeb-file-index-cache-v1.json`]: 11,
  [`${DOCS}beebeeb-name-cache-v1.json`]: 12,
  [`${CACHES}shared-publish-abc.json`]: 13,
  [`${CACHES}beebeeb-upload-chunk1`]: 14,
  [`${CACHES}device_manifest_1.json`]: 15,
  [`${CACHES}upload-copy.heic`]: 16,
  [`${CACHES}beebeeb-transfer/blob`]: 17,
  [`${CACHES}com.apple.metal/x`]: 18,
});

describe('measureCacheUsage', () => {
  test('sums real bytes per kind and the total', async () => {
    const { fs } = fakeFs(world());
    const u = await measureCacheUsage(fs);
    expect(u.thumbnails).toBe(157);
    expect(u.previews).toBe(1500);
    expect(u.offline).toBe(6000);
    expect(u.temporary).toBe(363);
    expect(u.total).toBe(157 + 1500 + 6000 + 363);
  });

  test('an empty phone is all zeros; a failing read counts as zero', async () => {
    const { fs } = fakeFs({});
    expect((await measureCacheUsage(fs)).total).toBe(0);
    const broken = { ...fs, getInfoAsync: async () => { throw new Error('x'); }, readDirectoryAsync: async () => { throw new Error('x'); } };
    expect((await measureCacheUsage(broken)).total).toBe(0);
  });
});

describe('clearCacheKind only touches its own directories', () => {
  const protectedPaths = [
    `${DOCS}beebeeb-file-index-cache-v1.json`,
    `${DOCS}beebeeb-name-cache-v1.json`,
    `${CACHES}shared-publish-abc.json`,
    `${CACHES}beebeeb-upload-chunk1`,
    `${CACHES}device_manifest_1.json`,
    `${CACHES}upload-copy.heic`,
    `${CACHES}beebeeb-transfer/blob`,
    `${CACHES}com.apple.metal/x`,
  ];

  for (const kind of CACHE_KINDS) {
    test(kind, async () => {
      const w = fakeFs(world());
      const before = Object.keys(w.tree);
      await clearCacheKind(kind, { fs: w.fs });
      const gone = before.filter((k) => !(k in w.tree));
      expect(gone.length).toBeGreaterThan(0);
      for (const p of protectedPaths) expect(w.tree[p]).toBeDefined();
      const usage = await measureCacheUsage(w.fs);
      expect(usage[kind]).toBe(0);
      for (const other of CACHE_KINDS.filter((k) => k !== kind)) {
        const fresh = await measureCacheUsage(fakeFs(world()).fs);
        expect(usage[other]).toBe(fresh[other]);
      }
    });
  }

  test('the in-memory reset for that kind runs after the files are gone', async () => {
    const w = fakeFs(world());
    const order: string[] = [];
    await clearCacheKind('thumbnails', {
      fs: w.fs,
      reset: { thumbnails: async () => { order.push(`reset files=${Object.keys(w.tree).some((k) => k.includes('thumbnails-v3'))}`); } },
    });
    expect(order).toEqual(['reset files=false']);
  });
});

describe('Clear temporary files skips what is in use', () => {
  const NOW = 10_000_000;
  const base = () => ({
    [`${CACHES}preview/open.pdf`]: 100,
    [`${CACHES}preview/old.pdf`]: 50,
    [`${CACHES}preview/fresh.mp4`]: 70,
    [`${CACHES}beebeeb-photos-1.zip`]: 40,
    [`${CACHES}thumb_source_1`]: 30,
  });
  const mt = { [`${CACHES}preview/fresh.mp4`]: NOW / 1000 - 60, [`${CACHES}beebeeb-photos-1.zip`]: NOW / 1000 - 5 };

  test('a leased preview copy and recently written files stay; the rest goes', async () => {
    const w = fakeFs(base(), mt);
    await clearCacheKind('temporary', { fs: w.fs, inUse: (u) => u === `${CACHES}preview/open.pdf`, now: () => NOW });
    expect(Object.keys(w.tree).sort()).toEqual([
      `${CACHES}beebeeb-photos-1.zip`,
      `${CACHES}preview/fresh.mp4`,
      `${CACHES}preview/open.pdf`,
    ].sort());
  });

  test('older files go once nothing holds them', async () => {
    const w = fakeFs(base(), mt);
    await clearCacheKind('temporary', { fs: w.fs, now: () => NOW + 60 * 60 * 1000 });
    expect(Object.keys(w.tree)).toEqual([]);
  });

  test('other kinds are not slowed by the in-use rule', async () => {
    const w = fakeFs(world(), { [`${DOCS}offline/f1`]: 9_999_999 });
    await clearCacheKind('offline', { fs: w.fs, inUse: () => true, now: () => NOW });
    expect(Object.keys(w.tree).some((k) => k.includes('/offline/'))).toBe(false);
  });
});

describe('temporaryCacheNames', () => {
  test('picks transient decrypted copies, never in-flight work or system caches', () => {
    const names = [
      'preview', 'zip-extract', 'beebeeb-export', 'beebeeb-photo-cache', 'shared_A.pdf', 'thumb_source_1', 'beebeeb-data-export-1.zip',
      'shared-publish-x', 'beebeeb-upload-1', 'device_manifest_1.json', 'upload-1.heic', 'new-1.txt', 'beebeeb-scan-1.pdf', 'beebeeb-transfer', 'com.apple.x',
      'beebeeb-previews-v1',
    ];
    expect(temporaryCacheNames(names).sort()).toEqual(
      ['beebeeb-data-export-1.zip', 'beebeeb-export', 'beebeeb-photo-cache', 'preview', 'shared_A.pdf', 'thumb_source_1', 'zip-extract'].sort(),
    );
  });

  test('every temporary name is registered as plaintext in the caches registry', () => {
    for (const name of ['preview', 'zip-extract', 'beebeeb-export', 'beebeeb-photo-cache', 'shared_A.pdf', 'thumb_source_1', 'beebeeb-data-export-1.zip']) {
      expect(cachesEntryFor(name)?.plaintext).toBe(true);
    }
  });
});

describe('directory names match their writers', () => {
  const src = (f: string) => readFileSync(join(import.meta.dir, f), 'utf8');
  test('offline, previews and thumbnails', () => {
    expect(src('offline-manager.ts')).toContain('${FileSystem.documentDirectory}offline/');
    expect(src('photo-preview-cache.ts')).toContain("const DIR_NAME = 'beebeeb-previews-v1'");
    expect(src('thumbnail-policy.ts')).toContain("THUMB_CACHE_DIR_NAME = 'beebeeb-thumbnails-v3'");
  });
});

describe('live usage controller', () => {
  test('refreshes on start, after each clear, and while it stays open', async () => {
    const w = fakeFs(world());
    const seen: number[] = [];
    let tick: (() => void) | null = null;
    const c = createCacheUsageController({
      fs: w.fs,
      onChange: (u) => seen.push(u.thumbnails),
      setInterval: (fn) => { tick = fn; return 1; },
      clearInterval: () => { tick = null; },
    });
    c.start();
    await c.refresh();
    expect(seen.at(-1)).toBe(157);

    // browsing writes a new thumbnail: the next poll shows it
    w.tree[`${DOCS}beebeeb-thumbnails-v3/c.webp`] = 43;
    tick();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen.at(-1)).toBe(200);

    await c.clear('thumbnails');
    expect(seen.at(-1)).toBe(0);

    c.stop();
    expect(tick).toBeNull();
  });

  test('the poll is slow (directory sizes are a full walk) and pauses while the app is inactive', async () => {
    expect(CACHE_USAGE_POLL_MS).toBeGreaterThanOrEqual(30000);
    const w = fakeFs(world());
    let ms = 0;
    let tick: (() => void) | null = null;
    let active = true;
    let measured = 0;
    const c = createCacheUsageController({
      fs: w.fs,
      onChange: () => { measured += 1; },
      isActive: () => active,
      setInterval: (fn, m) => { tick = fn; ms = m; return 1; },
      clearInterval: () => {},
    });
    c.start();
    expect(ms).toBe(CACHE_USAGE_POLL_MS);
    active = false;
    tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(measured).toBe(0);
    active = true;
    tick();
    await new Promise((r) => setTimeout(r, 5));
    expect(measured).toBe(1);
  });

  test('overlapping polls do not stack up', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const slow = {
      documentDirectory: DOCS, cacheDirectory: CACHES,
      readDirectoryAsync: async () => { calls += 1; await new Promise<void>((r) => { release = r; }); return []; },
      getInfoAsync: async () => ({ exists: false }),
      deleteAsync: async () => {},
    };
    const c = createCacheUsageController({ fs: slow, onChange: () => {}, setInterval: () => 1, clearInterval: () => {} });
    const a = c.refresh();
    const b = c.refresh();
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });
});
