/**
 * One-time cleanup of the retired "folders shown in Photos" exclusion list.
 * Photo sources replaced it; two opposite filters on one tab only confuse.
 * The list was a per-device SecureStore value, so it is deleted there once.
 */
export const LEGACY_EXCLUDED_FOLDERS_KEY = 'beebeeb_photos_excluded_folders';
export const PHOTO_EXCLUSION_CLEANUP_DONE_KEY = 'beebeeb:photo-exclusion-cleanup:v1';

export async function clearLegacyPhotoExclusions(deps: {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  deleteSecure: (key: string) => Promise<void>;
}): Promise<void> {
  try {
    if ((await deps.get(PHOTO_EXCLUSION_CLEANUP_DONE_KEY)) === '1') return;
    await deps.deleteSecure(LEGACY_EXCLUDED_FOLDERS_KEY);
    await deps.set(PHOTO_EXCLUSION_CLEANUP_DONE_KEY, '1');
  } catch {
    // Retried on the next launch; never blocks startup.
  }
}
