// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { normalizeCompletedUpload, reconcileCompletedUploadRows } from './upload-complete';

const known = {
  id: 'file-1',
  nameEncrypted: '{"ciphertext":[1]}',
  sizeBytes: 10_000,
  chunkCount: 1,
  parentId: 'folder-1',
  nowIso: '2026-11-01T10:00:00.000Z',
};

describe('upload completion response compatibility', () => {
  test('fills fields omitted by the production v2 completion response', () => {
    const entry = normalizeCompletedUpload({
      id: 'file-1',
      name_encrypted: known.nameEncrypted,
      size_bytes: 10_000,
      chunk_count: 1,
      storage_pool_id: 'pool-1',
      created_at: '2026-11-01T09:59:59.000Z',
      updated_at: '2026-11-01T09:59:59.500Z',
    }, known);

    expect(entry).toMatchObject({
      id: 'file-1',
      is_folder: false,
      is_uploading: false,
      parent_id: 'folder-1',
      storage_pool_id: 'pool-1',
    });
  });

  test('turns the minimal idempotent acknowledgement into a usable local row', () => {
    const entry = normalizeCompletedUpload({
      id: 'file-1',
      status: 'completed',
      already_completed: true,
    }, known);

    expect(entry).toMatchObject({
      id: 'file-1',
      name_encrypted: known.nameEncrypted,
      size_bytes: 10_000,
      chunk_count: 1,
      is_folder: false,
      is_uploading: false,
      parent_id: 'folder-1',
      created_at: known.nowIso,
      updated_at: known.nowIso,
    });
  });
});

describe('optimistic upload row reconciliation', () => {
  test('removes a stale client-id placeholder when an older server returns a different id', () => {
    const pending = normalizeCompletedUpload({}, { ...known, id: 'client-id' });
    const completed = normalizeCompletedUpload({}, { ...known, id: 'server-id' });

    const rows = reconcileCompletedUploadRows([pending], 'client-id', completed, false);

    expect(rows.map((row) => row.id)).toEqual(['server-id']);
  });

  test('restores a replaced row when a server unexpectedly completes under a different id', () => {
    const replaced = { ...normalizeCompletedUpload({}, { ...known, id: 'existing-id' }), is_uploading: true };
    const completed = normalizeCompletedUpload({}, { ...known, id: 'server-id' });

    const rows = reconcileCompletedUploadRows([replaced], 'existing-id', completed, true);

    expect(rows.map((row) => [row.id, row.is_uploading])).toEqual([
      ['server-id', false],
      ['existing-id', false],
    ]);
  });
});
