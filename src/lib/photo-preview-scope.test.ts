// @ts-nocheck
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergePreviewScopeMimes,
  partitionPreviewScope,
  remainingPreviewScopeBudget,
} from './photo-preview-scope';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'file-1',
  name_encrypted: '{"nonce":"abc"}',
  is_folder: false,
  is_uploading: false,
  ...overrides,
});

describe('partitionPreviewScope', () => {
  test('keeps production media rows before encrypted metadata is opened', () => {
    const local = new Map([['file-1', 'photo-kit-id']]);
    const result = partitionPreviewScope([row({ is_media: true })], local);
    expect(result.files).toEqual([{ entry: row({ is_media: true }), mime: null }]);
    expect(result.localEncrypted).toEqual([row({ is_media: true })]);
  });

  test('renders known rows immediately and decrypts only ambiguous rows on this phone', () => {
    const known = row({ id: 'known', mime_type: 'image/jpeg', name_encrypted: 'photo.jpg' });
    const localUnknown = row({ id: 'local', is_media: true });
    const remoteUnknown = row({ id: 'remote', is_media: true });
    const video = row({ id: 'video', mime_type: 'video/mp4', name_encrypted: 'clip.mp4' });
    const local = new Map([['local', 'asset']]);
    const result = partitionPreviewScope([remoteUnknown, localUnknown, video, known], local);
    expect(result.files.map((x) => [x.entry.id, x.mime])).toEqual([
      ['known', 'image/jpeg'],
      ['video', 'video/mp4'],
      ['local', null],
      ['remote', null],
    ]);
    expect(result.localEncrypted.map((x) => x.id)).toEqual(['local']);
  });

  test('excludes folders, uploads, and non-media documents', () => {
    const result = partitionPreviewScope([
      row({ id: 'folder', is_folder: true, is_media: true }),
      row({ id: 'upload', is_uploading: true, is_media: true }),
      row({ id: 'doc', name_encrypted: 'notes.pdf' }),
      row({ id: 'thumb', has_thumbnail: true }),
    ], new Map());
    expect(result.files.map((x) => x.entry.id)).toEqual(['thumb']);
  });

  test('uses one whole-operation deadline instead of restarting a timeout per batch', () => {
    expect(remainingPreviewScopeBudget(1_000, 1_000, 8_000, 4_000)).toBe(4_000);
    expect(remainingPreviewScopeBudget(1_000, 7_500, 8_000, 4_000)).toBe(1_500);
    expect(remainingPreviewScopeBudget(1_000, 9_000, 8_000, 4_000)).toBe(0);
    expect(remainingPreviewScopeBudget(1_000, 12_000, 8_000, 4_000)).toBe(0);
  });

  test('merges a collected MIME map in one linear pass without changing untouched rows', () => {
    const first = { id: 'first', mime_type: null, has_preview: false };
    const second = { id: 'second', mime_type: 'video/mp4', has_preview: false };
    const merged = mergePreviewScopeMimes(
      [first, second],
      new Map([['first', 'image/heic']]),
    );

    expect(merged).toEqual([
      { ...first, mime_type: 'image/heic' },
      second,
    ]);
    expect(merged[1]).toBe(second);
  });

  test('screen accumulates batch results instead of remapping all files after every batch', () => {
    const screen = readFileSync(join(import.meta.dir, '..', 'screens', 'PhotoPreviewsScreen.tsx'), 'utf8');
    expect(screen).toContain('remainingPreviewScopeBudget');
    expect(screen).toContain('mergePreviewScopeMimes');
    expect(screen).not.toContain('setFiles((current) => current.map');
  });
});
