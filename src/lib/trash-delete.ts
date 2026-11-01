import {
  ApiError,
  friendlyError,
  PERMANENT_DELETE_BATCH_LIMIT,
  type BulkPermanentDeleteResult,
} from './api';

export type TrashDeletion = {
  deletedIds: string[];
  missingIds: string[];
  failedIds: string[];
  liveFolders: number;
  noLongerTrashed: number;
  cycleFolders: number;
  error?: unknown;
};

export type EmptyTrashProgress =
  | { kind: 'indeterminate'; total: number }
  | {
      kind: 'determinate';
      completed: number;
      total: number;
      deletedId?: string;
      missingId?: string;
      failedId?: string;
      deletedIds?: string[];
      missingIds?: string[];
      failedIds?: string[];
    };

export function emptyTrashProgressLabel(progress: EmptyTrashProgress): string {
  const noun = `${progress.total} item${progress.total === 1 ? '' : 's'}`;
  if (progress.kind === 'indeterminate') return `Emptying Trash… ${noun}`;
  return `Deleting ${progress.completed} of ${progress.total}…`;
}

export function trashDeleteError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    if (error.code === 'not_trashed') {
      return 'This item is no longer in Trash. Refresh to see its current location.';
    }
    if (error.code === 'has_live_descendants') {
      return 'This folder contains live files and was kept. Move or restore those files before permanently deleting it.';
    }
  }
  return friendlyError(error);
}

export async function deleteTrashItems(
  ids: readonly string[],
  remove: (id: string) => Promise<void>,
  onProgress?: (progress: EmptyTrashProgress) => void,
): Promise<TrashDeletion> {
  const result: TrashDeletion = {
    deletedIds: [],
    missingIds: [],
    failedIds: [],
    liveFolders: 0,
    noLongerTrashed: 0,
    cycleFolders: 0,
  };
  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    let deletedId: string | undefined;
    let missingId: string | undefined;
    let failedId: string | undefined;
    try {
      await remove(id);
      result.deletedIds.push(id);
      deletedId = id;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        result.missingIds.push(id);
        missingId = id;
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'has_live_descendants') {
        result.failedIds.push(id);
        failedId = id;
        result.liveFolders += 1;
        result.error ??= error;
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'not_trashed') {
        result.failedIds.push(id);
        failedId = id;
        result.noLongerTrashed += 1;
        result.error ??= error;
      } else {
        result.failedIds.push(id);
        failedId = id;
        result.error ??= error;
      }
    }
    onProgress?.({ kind: 'determinate', completed: index + 1, total: ids.length, deletedId, missingId, failedId });
  }
  return result;
}

export const EMPTY_TRASH_BATCH_SIZE = PERMANENT_DELETE_BATCH_LIMIT;

/** Run Empty Trash through production's bulk endpoint, one single-use token per batch. */
export async function deleteTrashItemsInBatches(
  ids: readonly string[],
  removeBatch: (ids: readonly string[]) => Promise<BulkPermanentDeleteResult>,
  onProgress?: (progress: EmptyTrashProgress) => void,
  trace?: (event: string, payload: Record<string, unknown>) => void,
): Promise<TrashDeletion> {
  const uniqueIds = [...new Set(ids)];
  const result: TrashDeletion = {
    deletedIds: [],
    missingIds: [],
    failedIds: [],
    liveFolders: 0,
    noLongerTrashed: 0,
    cycleFolders: 0,
  };

  for (let offset = 0; offset < uniqueIds.length; offset += EMPTY_TRASH_BATCH_SIZE) {
    const batch = uniqueIds.slice(offset, offset + EMPTY_TRASH_BATCH_SIZE);
    try {
      const response = await removeBatch(batch);
      const deletedSet = new Set(response.deleted);
      const missingSet = new Set(response.missing);
      const skippedSet = new Set(response.skipped_not_trashed);
      const refusedSet = new Set(response.refused.map((item) => item.id));
      const cycleSet = new Set(response.cycles);
      const deletedIds = batch.filter((id) => deletedSet.has(id));
      const knownFailure = (id: string) => skippedSet.has(id) || refusedSet.has(id) || cycleSet.has(id);
      // A successful/committed bulk response can omit a requested descendant
      // that disappeared with an earlier folder cascade. Only explicit kept
      // sets are failures; every other non-deleted id is already gone.
      const missingIds = batch.filter((id) => (
        !deletedSet.has(id) && (missingSet.has(id) || !knownFailure(id))
      ));
      const failedIds = batch.filter((id) => !deletedSet.has(id) && knownFailure(id));
      const unreportedGone = missingIds.filter((id) => !missingSet.has(id)).length;

      result.deletedIds.push(...deletedIds);
      result.missingIds.push(...missingIds);
      result.failedIds.push(...failedIds);
      result.noLongerTrashed += failedIds.filter((id) => skippedSet.has(id)).length;
      result.liveFolders += failedIds.filter((id) => refusedSet.has(id)).length;
      result.cycleFolders += failedIds.filter((id) => cycleSet.has(id)).length;
      trace?.('trash.empty.batch_result', {
        requested: batch.length,
        deleted: deletedIds.length,
        missing: missingIds.length,
        unreportedGone,
        failed: failedIds.length,
      });
      onProgress?.({
        kind: 'determinate',
        completed: offset + batch.length,
        total: uniqueIds.length,
        deletedIds,
        missingIds,
        failedIds,
      });
    } catch (error) {
      result.failedIds.push(...batch);
      result.error ??= error;
      trace?.('trash.empty.batch_failed', {
        requested: batch.length,
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      onProgress?.({
        kind: 'determinate',
        completed: offset + batch.length,
        total: uniqueIds.length,
        failedIds: batch,
      });
    }
  }
  return result;
}

export function goneTrashIds(result: TrashDeletion): string[] {
  return [...result.deletedIds, ...result.missingIds];
}

export function trashDeletionMessage(result: TrashDeletion): string {
  const failures = result.failedIds.length;
  if (failures > 0) return `${failures} item${failures === 1 ? '' : 's'} couldn't be deleted. Try again.`;
  const count = result.deletedIds.length + result.missingIds.length;
  return `Trash emptied · ${count} item${count === 1 ? '' : 's'}`;
}
