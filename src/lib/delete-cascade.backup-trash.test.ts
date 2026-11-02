// @ts-nocheck
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const requeued: string[][] = [];
let wakeCalls = 0;

mock.module('../services/BackupDatabase', () => ({
  resetUploadedState: async (ids: string[]) => { requeued.push(ids); return ids.length; },
}));
mock.module('../services/BackupService', () => ({ invalidateBackupFolderCacheIfDeleted: async () => {} }));
mock.module('../../modules/beebeeb-crypto', () => ({
  wakePhotoBackupDrain: async () => { wakeCalls += 1; },
}));
mock.module('./offline-manager', () => ({
  offlineManager: { offlineFolderIds: () => [], getStatus: () => null, removeFile: async () => {}, removeFolder: async () => {} },
}));
mock.module('./thumbnail-cache', () => ({
  invalidateCachedThumbnails: async () => {},
  invalidateNativeThumbnailCache: async () => {},
}));
mock.module('./name-cache', () => ({ pruneNameCache: async () => {} }));
mock.module('./account-epoch', () => ({ accountEpoch: () => ({ id: 'account-a' }) }));
mock.module('./backup-write-ticket', () => ({ backupWriteTicket: () => ({ accountId: 'account-a' }) }));

const { onFilesDeleted } = await import('./delete-cascade');

beforeEach(() => {
  requeued.length = 0;
  wakeCalls = 0;
});

describe('delete cascade photo-backup semantics', () => {
  test('moving a remote backup to Trash requeues its local photo', async () => {
    await onFilesDeleted(['remote-photo'], { kind: 'trash' });

    expect(requeued).toEqual([['remote-photo']]);
    expect(wakeCalls).toBe(1);
  });

  test('permanent deletion requeues the matching local photo for upload', async () => {
    await onFilesDeleted(['remote-photo'], { kind: 'permanent' });

    expect(requeued).toEqual([['remote-photo']]);
    expect(wakeCalls).toBe(1);
  });

  test('an unclassified sync delete also requeues instead of leaving a skipped row', async () => {
    await onFilesDeleted(['remote-photo']);

    expect(requeued).toEqual([['remote-photo']]);
    expect(wakeCalls).toBe(1);
  });
});
