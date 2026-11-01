/** The real file system and in-memory resets behind the cache page. */
import * as FileSystem from 'expo-file-system/legacy';
import { clearThumbnailCache } from './thumbnail-cache';
import { clearPreviewCache } from './photo-preview-cache';
import { forgetPhotoMemoryCache } from './photo-cache';
import { isPreviewPathLeased } from './native-decrypt';
import { offlineManager } from './offline-manager';
import type { CacheFs, CacheKind } from './cache-usage';

export const realCacheFs: CacheFs = FileSystem as unknown as CacheFs;

export const realCacheReset: Partial<Record<CacheKind, () => Promise<void>>> = {
  thumbnails: clearThumbnailCache,
  previews: clearPreviewCache,
  temporary: async () => forgetPhotoMemoryCache(),
  // Cancels running downloads and forgets the pins; safe while downloads run.
  offline: () => offlineManager.clearAll(),
};

/** Paths other features hold right now; "Clear temporary files" leaves them alone. */
export const realCacheInUse = (uri: string): boolean => isPreviewPathLeased(uri);
