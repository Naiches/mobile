// @ts-nocheck
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getTrashCount,
  knownTrashParentMap,
  projectTopLevelTrashItems,
  projectVisibleTopLevelTrashItems,
  refreshTrashCount,
  setTrashCount,
  subscribeTrashCount,
  trashRowLabel,
  shouldShowTrashRow,
} from './trash-count';
import { setProtectedBackupsRootId } from './protected-folders';

const ROOT = join(import.meta.dir, '..', '..');

beforeEach(() => setProtectedBackupsRootId(null));

describe('trash count store', () => {
  test('cached rows preserve an absent parent as unknown instead of guessing root', () => {
    const parents = knownTrashParentMap([
      { id: 'unknown' },
      { id: 'root', parent_id: null },
      { id: 'child', parent_id: 'root' },
    ]);

    expect(parents.has('unknown')).toBe(false);
    expect(parents.get('root')).toBeNull();
    expect(parents.get('child')).toBe('root');
  });

  test('projects a flat Trash response from a synchronous local parent cache', () => {
    const rows = [
      { id: 'folder', is_folder: true },
      { id: 'child-file', is_folder: false },
      { id: 'child-folder', is_folder: true },
      { id: 'grandchild', is_folder: false },
      { id: 'loose', is_folder: false },
      { id: 'nested-alone', is_folder: false },
    ];
    const parents: Record<string, string | null> = {
      folder: null,
      'child-file': 'folder',
      'child-folder': 'folder',
      grandchild: 'child-folder',
      loose: null,
      // Its active parent is not itself in Trash, so this is a top-level Trash row.
      'nested-alone': 'active-folder',
    };
    const locallyRead: string[] = [];
    const projected = projectTopLevelTrashItems(rows, (id) => {
      locallyRead.push(id);
      return parents[id];
    });

    expect(projected.topLevel.map((entry) => entry.id)).toEqual(['folder', 'loose', 'nested-alone']);
    expect(projected.count).toBe(3);
    expect(projected.complete).toBe(true);
    expect(locallyRead.sort()).toEqual(rows.map((entry) => entry.id).sort());
  });

  test('500 rows use direct parents then the local cache, synchronously with zero network calls', () => {
    const parents = new Map<string, string | null>();
    const rows = Array.from({ length: 500 }, (_, index) => {
      const id = index < 100 ? `folder-${index}` : `file-${index}`;
      const parentId = index < 100 ? null : `folder-${(index - 100) % 100}`;
      parents.set(id, parentId);
      return {
        id,
        ...(index % 2 === 0 ? { parent_id: parentId } : {}),
        is_folder: index < 100,
      };
    });
    let localLookupCalls = 0;
    let networkCalls = 0;

    const projected = projectTopLevelTrashItems(rows, (id) => {
      localLookupCalls += 1;
      if (parents.has(id)) return parents.get(id);
      networkCalls += 1; // A cache miss would need background revalidation, never first-paint I/O.
      return undefined;
    });

    expect(projected).not.toBeInstanceOf(Promise);
    expect(projected.topLevel.map((entry) => entry.id)).toEqual(
      Array.from({ length: 100 }, (_, index) => `folder-${index}`),
    );
    expect(projected.count).toBe(100);
    expect(projected.complete).toBe(true);
    expect(localLookupCalls).toBe(250);
    expect(networkCalls).toBe(0);
  });

  test('an unknown parent leaves the row paintable but makes the count unavailable', () => {
    const rows = [
      { id: 'known-root', parent_id: null },
      { id: 'unknown-parent' },
    ];
    const projected = projectTopLevelTrashItems(rows, () => undefined);

    expect(projected.topLevel.map((entry) => entry.id)).toEqual(['known-root', 'unknown-parent']);
    expect(projected.unresolvedParentIds).toEqual(['unknown-parent']);
    expect(projected.complete).toBe(false);
    expect(projected.count).toBeNull();
  });

  test('projects the same visible roots used by the Trash list and keeps hidden roots for cleanup', async () => {
    setProtectedBackupsRootId('backups-root');
    const rows = [
      { id: 'folder', is_folder: true },
      { id: 'folder-child', is_folder: false },
      { id: 'manifest', is_folder: false },
      { id: 'user-manifest', is_folder: false },
      { id: 'loose', is_folder: false },
    ];
    const parents: Record<string, string | null> = {
      folder: null,
      'folder-child': 'folder',
      manifest: 'device-folder',
      'user-manifest': null,
      loose: null,
      'device-folder': 'backups-root',
    };
    const names: Record<string, string> = {
      folder: 'Project',
      'folder-child': 'inside.txt',
      manifest: '.device.json',
      'user-manifest': '.device.json',
      loose: 'loose.txt',
    };

    const projection = await projectVisibleTopLevelTrashItems(
      rows,
      (id) => parents[id],
      async (entry) => names[entry.id] ?? null,
    );

    expect(projection.visible.map((entry) => entry.id)).toEqual(['folder', 'user-manifest', 'loose']);
    expect(projection.hidden.map((entry) => entry.id)).toEqual(['manifest']);
    expect(projection.topLevel.map((entry) => entry.id)).toEqual(['folder', 'manifest', 'user-manifest', 'loose']);
    expect(projection.count).toBe(3);
    expect(projection.complete).toBe(true);
  });

  test('visible projection reports an unavailable count when a manifest ancestry lookup is missing', async () => {
    setProtectedBackupsRootId('backups-root');
    const projection = await projectVisibleTopLevelTrashItems(
      [{ id: 'manifest', parent_id: 'device-folder', is_folder: false }],
      () => undefined,
      () => '.device.json',
    );

    expect(projection.visible.map((entry) => entry.id)).toEqual(['manifest']);
    expect(projection.unresolvedParentIds).toEqual(['device-folder']);
    expect(projection.count).toBeNull();
    expect(projection.complete).toBe(false);
  });

  test('refresh publishes the count to subscribers', async () => {
    const seen: (number | null)[] = [];
    const off = subscribeTrashCount(() => seen.push(getTrashCount()));
    await refreshTrashCount(async () => 7);
    setTrashCount(3);
    off();
    setTrashCount(9);
    expect(seen).toEqual([7, 3]);
  });

  test('a failed refresh keeps the last known count', async () => {
    setTrashCount(4);
    await refreshTrashCount(async () => { throw new Error('offline'); });
    expect(getTrashCount()).toBe(4);
  });

  test('an incomplete local projection clears a stale count instead of publishing a guess', async () => {
    setTrashCount(4);
    await refreshTrashCount(async () => null);
    expect(getTrashCount()).toBeNull();
  });

  test('an older refresh never overwrites a newer one', async () => {
    let releaseSlow: (n: number) => void = () => {};
    const slow = refreshTrashCount(() => new Promise((r) => { releaseSlow = r; }));
    await refreshTrashCount(async () => 2);
    releaseSlow(50);
    await slow;
    expect(getTrashCount()).toBe(2);
  });
});

describe('Drive root Trash row', () => {
  test('shown only at the root', () => {
    expect(shouldShowTrashRow({ isRoot: true, selectMode: false, searchActive: false })).toBe(true);
    expect(shouldShowTrashRow({ isRoot: false, selectMode: false, searchActive: false })).toBe(false);
    expect(shouldShowTrashRow({ isRoot: true, selectMode: true, searchActive: false })).toBe(false);
    expect(shouldShowTrashRow({ isRoot: true, selectMode: false, searchActive: true })).toBe(false);
  });
  test('label carries the count', () => {
    expect(trashRowLabel(0)).toBe('Trash · 0 items');
    expect(trashRowLabel(1)).toBe('Trash · 1 item');
    expect(trashRowLabel(120)).toBe('Trash · 120 items');
    expect(trashRowLabel(null)).toBe('Trash');
  });

  test('Trash publishes the authoritative displayed top-level total', () => {
    const screen = readFileSync(join(ROOT, 'src/screens/TrashScreen.tsx'), 'utf8');
    const filesScreen = readFileSync(join(ROOT, 'src/screens/FilesScreen.tsx'), 'utf8');
    expect(screen).toContain('projectVisibleTopLevelTrashItems(');
    expect(filesScreen).toContain('projectVisibleTopLevelTrashItems(');
    expect(screen).toContain('setTrashCount(listingComplete ? projection.count : null)');
    expect(screen).not.toContain('setTrashCount(result.length)');
  });

  test('Trash paints the first page before background pagination and never calls getFile', () => {
    const screen = readFileSync(join(ROOT, 'src/screens/TrashScreen.tsx'), 'utf8');
    expect(screen).toContain('await listFilesPage({ trashed: true })');
    expect(screen).toContain('setFiles(firstProjection.topLevel)');
    expect(screen).toContain("setLoadingMore(firstPage.next_cursor !== null)");
    expect(screen).not.toContain('getFile, resolveTrashEntryName');
    expect(screen.indexOf('setFiles(firstProjection.topLevel)')).toBeLessThan(screen.indexOf('paginateTrashInBackground({'));
  });

  test('background pagination is bounded and leaves a visible retry for partial results', () => {
    const screen = readFileSync(join(ROOT, 'src/screens/TrashScreen.tsx'), 'utf8');
    expect(screen).toContain('paginateTrashInBackground({');
    expect(screen).toContain('setPageError(friendlyError(err))');
    expect(screen).toContain('pageError ? (');
    expect(screen).toContain('onPress={() => fetchTrash(true)}');
    expect(screen).toContain('knownTrashParentMap(cached.files)');
    expect(screen).not.toContain('entry.parent_id ?? null');
  });
});
