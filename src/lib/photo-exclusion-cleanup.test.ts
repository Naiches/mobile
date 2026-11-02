// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import {
  LEGACY_EXCLUDED_FOLDERS_KEY,
  PHOTO_EXCLUSION_CLEANUP_DONE_KEY,
  clearLegacyPhotoExclusions,
} from './photo-exclusion-cleanup';

function deps(initial: Record<string, string> = {}) {
  const store = { ...initial };
  const deleted: string[] = [];
  return {
    store,
    deleted,
    d: {
      get: async (k: string) => store[k] ?? null,
      set: async (k: string, v: string) => { store[k] = v; },
      deleteSecure: async (k: string) => { deleted.push(k); },
    },
  };
}

describe('clearLegacyPhotoExclusions', () => {
  test('removes the old per-device exclusion list once, then records it', async () => {
    const { d, deleted, store } = deps();
    await clearLegacyPhotoExclusions(d);
    expect(deleted).toEqual([LEGACY_EXCLUDED_FOLDERS_KEY]);
    expect(store[PHOTO_EXCLUSION_CLEANUP_DONE_KEY]).toBe('1');
    await clearLegacyPhotoExclusions(d);
    expect(deleted).toHaveLength(1);
  });

  test('a failed delete is retried on the next launch and never throws', async () => {
    const { d, store } = deps();
    await clearLegacyPhotoExclusions({ ...d, deleteSecure: async () => { throw new Error('locked'); } });
    expect(store[PHOTO_EXCLUSION_CLEANUP_DONE_KEY]).toBeUndefined();
  });
});
