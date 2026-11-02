// @ts-nocheck
import { describe, expect, mock, test } from 'bun:test';

class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
mock.module('./api', () => ({
  ApiError,
  PERMANENT_DELETE_BATCH_LIMIT: 500,
  friendlyError: (error: Error) => error.message,
}));
const {
  deleteTrashItems,
  deleteTrashItemsInBatches,
  emptyTrashProgressLabel,
  trashDeleteError,
  trashDeletionMessage,
} = await import('./trash-delete');

describe('1946 Empty Trash partial refusal', () => {
  test('the single-row Trash action uses the same idempotent gone-item classifier', async () => {
    const screen = await Bun.file(new URL('../screens/TrashScreen.tsx', import.meta.url)).text();
    expect(screen).toMatch(/deleteTrashItems\(\s*\[item\.id\]/);
  });

  test('continues after both typed 409 refusals and reports what was kept', async () => {
    const visited: string[] = [];
    const result = await deleteTrashItems(['folder', 'restored', 'clean'], async id => {
      visited.push(id);
      if (id === 'folder') throw new ApiError(409, 'raw', 'has_live_descendants');
      if (id === 'restored') throw new ApiError(409, 'raw', 'not_trashed');
    });
    expect(visited).toEqual(['folder', 'restored', 'clean']);
    expect(result.deletedIds).toEqual(['clean']);
    expect(result.failedIds).toEqual(['folder', 'restored']);
    expect(trashDeletionMessage(result)).toBe("2 items couldn't be deleted. Try again.");
  });
  test('continues after an unknown failure, preserves successes and reports progress after every item', async () => {
    const visited: string[] = [];
    const progress: string[] = [];
    const error = new ApiError(503, 'Storage unavailable');
    const result = await deleteTrashItems(['clean', 'failed', 'later'], async id => {
      visited.push(id);
      if (id === 'failed') throw error;
    }, step => progress.push(emptyTrashProgressLabel(step)));
    expect(visited).toEqual(['clean', 'failed', 'later']);
    expect(result.deletedIds).toEqual(['clean', 'later']);
    expect(result.failedIds).toEqual(['failed']);
    expect(result.error).toBe(error);
    expect(progress).toEqual(['Deleting 1 of 3…', 'Deleting 2 of 3…', 'Deleting 3 of 3…']);
    expect(trashDeletionMessage(result)).toBe("1 item couldn't be deleted. Try again.");
  });
  test('single-item typed refusals do not expose raw codes', () => {
    expect(trashDeleteError(new ApiError(409, 'not_trashed', 'not_trashed'))).toBe('This item is no longer in Trash. Refresh to see its current location.');
    expect(trashDeleteError(new ApiError(409, 'has_live_descendants', 'has_live_descendants'))).toBe('This folder contains live files and was kept. Move or restore those files before permanently deleting it.');
  });
  test('all successful deletions include the completed item count', async () => {
    expect(trashDeletionMessage(await deleteTrashItems(['one', 'two'], async () => {}))).toBe('Trash emptied · 2 items');
  });
  test('the bulk fallback is visibly indeterminate and still carries the item count', () => {
    expect(emptyTrashProgressLabel({ kind: 'indeterminate', total: 120 })).toBe('Emptying Trash… 120 items');
  });
});

describe('production bulk Empty Trash batches', () => {
  test('chunks requests at 500 IDs and reports progress by settled item count', async () => {
    const ids = Array.from({ length: 1001 }, (_, index) => `file-${index}`);
    const batches: string[][] = [];
    const completed: number[] = [];

    const result = await deleteTrashItemsInBatches(ids, async batch => {
      batches.push([...batch]);
      return {
        deleted: [...batch],
        skipped_not_trashed: [],
        missing: [],
        refused: [],
        cycles: [],
      };
    }, progress => {
      if (progress.kind === 'determinate') completed.push(progress.completed);
    });

    expect(batches.map(batch => batch.length)).toEqual([500, 500, 1]);
    expect(completed).toEqual([500, 1000, 1001]);
    expect(result.deletedIds).toEqual(ids);
    expect(result.failedIds).toEqual([]);
  });

  test('reconciles deleted, missing, restored, live-folder, cycle and cascade-removed IDs', async () => {
    const ids = ['deleted', 'gone', 'restored', 'live-folder', 'cycle-folder', 'unreported'];

    const result = await deleteTrashItemsInBatches(ids, async () => ({
      deleted: ['deleted'],
      skipped_not_trashed: ['restored'],
      missing: ['gone'],
      refused: [{ id: 'live-folder', live_descendants: 1, blocking_descendants: 1 }],
      cycles: ['cycle-folder'],
    }));

    expect(result.deletedIds).toEqual(['deleted']);
    expect(result.missingIds).toEqual(['gone', 'unreported']);
    expect(result.failedIds).toEqual(['restored', 'live-folder', 'cycle-folder']);
    expect(result.noLongerTrashed).toBe(1);
    expect(result.liveFolders).toBe(1);
    expect(result.cycleFolders).toBe(1);
  });

  test('a separately listed child omitted after its folder cascade is gone, not failed', async () => {
    const result = await deleteTrashItemsInBatches(['folder', 'child'], async () => ({
      deleted: ['folder'],
      skipped_not_trashed: [],
      missing: [],
      refused: [],
      cycles: [],
    }));

    expect(result.deletedIds).toEqual(['folder']);
    expect(result.missingIds).toEqual(['child']);
    expect(result.failedIds).toEqual([]);
    expect(trashDeletionMessage(result)).toBe('Trash emptied · 2 items');
  });

  test('continues with later batches after one request fails', async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `file-${index}`);
    const error = new ApiError(503, 'Storage unavailable');
    let calls = 0;

    const result = await deleteTrashItemsInBatches(ids, async batch => {
      calls += 1;
      if (calls === 1) throw error;
      return { deleted: [...batch], skipped_not_trashed: [], missing: [], refused: [], cycles: [] };
    });

    expect(calls).toBe(2);
    expect(result.failedIds).toEqual(ids.slice(0, 500));
    expect(result.deletedIds).toEqual([ids[500]]);
    expect(result.error).toBe(error);
  });
});
