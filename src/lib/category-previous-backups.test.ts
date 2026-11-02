// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import {
  buildCategoryActivity,
  latestVerificationAttempt,
  loadPreviousBackups,
} from './category-previous-backups';

const T = (iso: string) => iso;

describe('loadPreviousBackups', () => {
  const versions = {
    f1: [
      { id: 'a', version_number: 1, size_bytes: 500, chunk_count: 1, created_at: T('2026-10-29T08:00:00Z'), source: 'object_version' },
      { id: 'b', version_number: 2, size_bytes: 600, chunk_count: 1, created_at: T('2026-10-30T08:00:00Z'), source: 'object_version' },
      { id: 'c', version_number: 3, size_bytes: 700, chunk_count: 1, created_at: T('2026-10-31T08:00:00Z'), source: 'object_version' },
    ],
  };

  test('reads the version history of the files in the category folder, newest first', async () => {
    const asked: string[] = [];
    const list = await loadPreviousBackups({
      parentFolderId: 'folder-1',
      runs: [{ at: T('2026-10-30T08:00:30Z'), count: 41, bytes: 600 }],
      listFiles: async (parent) => {
        asked.push(parent);
        return [
          { id: 'f1', is_folder: false },
          { id: 'sub', is_folder: true },
        ];
      },
      listFileVersions: async (id) => versions[id] ?? [],
    });
    expect(asked).toEqual(['folder-1']);
    expect(list.map((e) => e.sizeBytes)).toEqual([700, 600, 500]);
    expect(list[1].count).toBe(41);
    expect(list[0].count).toBeNull();
  });

  test('no folder yet gives an empty list without calling the server', async () => {
    let called = false;
    const list = await loadPreviousBackups({
      parentFolderId: null,
      runs: [],
      listFiles: async () => { called = true; return []; },
      listFileVersions: async () => { called = true; return []; },
    });
    expect(list).toEqual([]);
    expect(called).toBe(false);
  });

  test('a failed version read for one file does not hide the others', async () => {
    const list = await loadPreviousBackups({
      parentFolderId: 'folder-1',
      runs: [],
      listFiles: async () => [{ id: 'bad', is_folder: false }, { id: 'f1', is_folder: false }],
      listFileVersions: async (id) => { if (id === 'bad') throw new Error('nope'); return versions.f1; },
    });
    expect(list.length).toBe(3);
  });
});

describe('buildCategoryActivity', () => {
  test('merges the runs of both categories, newest first, capped', () => {
    const out = buildCategoryActivity(
      [{ at: T('2026-10-30T10:00:00Z'), count: 5, bytes: 1 }, { at: T('2026-10-28T10:00:00Z'), count: 4, bytes: 1 }],
      [{ at: T('2026-10-31T10:00:00Z'), count: 9, bytes: 1 }],
      2,
    );
    expect(out.map((e) => [e.kind, e.count])).toEqual([['calendar', 9], ['contacts', 5]]);
  });
});

describe('latestVerificationAttempt', () => {
  test('a newer failed photo check replaces an older successful category check', () => {
    const attempt = latestVerificationAttempt({
      photo: { verifiedAt: '2026-10-31 10:00:00', success: false },
      contacts: { verifiedAt: '2026-10-30T10:00:00Z' },
    });
    expect(attempt).toEqual({
      at: '2026-10-31T10:00:00.000Z',
      kind: 'photo',
      success: false,
    });
  });

  test('a newer category verify_failed run replaces an older photo success', () => {
    const attempt = latestVerificationAttempt({
      photo: { verifiedAt: '2026-10-29T10:00:00Z', success: true },
      calendar: {
        verifiedAt: '2026-10-28T10:00:00Z',
        lastRunStatus: 'failed',
        lastRunAt: '2026-10-31T10:00:00Z',
        lastError: 'verify_failed',
      },
    });
    expect(attempt).toEqual({
      at: '2026-10-31T10:00:00.000Z',
      kind: 'calendar',
      success: false,
    });
  });

  test('a newer successful check replaces an older failure', () => {
    const attempt = latestVerificationAttempt({
      photo: { verifiedAt: '2026-10-31T10:00:00Z', success: true },
      contacts: {
        lastRunStatus: 'failed',
        lastRunAt: '2026-10-30T10:00:00Z',
        lastError: 'verify_failed',
      },
    });
    expect(attempt?.success).toBe(true);
    expect(attempt?.kind).toBe('photo');
  });

  test('does not treat unrelated category run failures as verification attempts', () => {
    const attempt = latestVerificationAttempt({
      contacts: {
        verifiedAt: '2026-10-29T10:00:00Z',
        lastRunStatus: 'failed',
        lastRunAt: '2026-10-31T10:00:00Z',
        lastError: 'upload_failed',
      },
    });
    expect(attempt).toEqual({
      at: '2026-10-29T10:00:00.000Z',
      kind: 'contacts',
      success: true,
    });
  });

  test('ignores invalid timestamps and is null when nothing was checked', () => {
    expect(latestVerificationAttempt({
      photo: { verifiedAt: 'not-a-date', success: false },
      contacts: { verifiedAt: null },
      calendar: { lastRunStatus: 'failed', lastRunAt: 'also-bad', lastError: 'verify_failed' },
    })).toBeNull();
  });
});
