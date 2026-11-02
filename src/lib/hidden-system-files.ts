/**
 * Internal files the app keeps for itself and never shows: the per-device backup manifest
 * `Backups/{Device}/.device.json`. The backup screens read it, so it stays in place; every list
 * (Drive, Trash, search, Recents, Photos, pickers, counts) drops it through this ONE rule. The Files
 * app extension carries the same rule (`isHiddenBackupManifest` in FileProviderItem.swift).
 *
 * Recognised precisely: the name is exactly `.device.json` and the file's parent is a folder
 * directly under the protected Backups root (lib/protected-folders). A user's own file with that
 * name anywhere else stays visible. Only while the root id is not known yet does the name decide.
 */
import { getProtectedBackupsRootId } from './protected-folders';

export const DEVICE_MANIFEST_NAME = '.device.json';

type MaybeId = string | null | undefined;

/** `grandparentId` is the parent id of the file's parent folder (undefined when not known). */
export function isDeviceManifest(
  name: MaybeId,
  parentId: MaybeId,
  grandparentId: MaybeId,
  extraRootIds?: ReadonlySet<string>,
): boolean {
  if (name !== DEVICE_MANIFEST_NAME) return false;
  const rootId = getProtectedBackupsRootId();
  if (rootId === null) return true;
  if (!parentId || !grandparentId) return false;
  const grandparent = grandparentId.toLowerCase();
  return grandparent === rootId || !!extraRootIds?.has(grandparent);
}

/**
 * Entries without the device manifests. `nameOf` gives the decrypted name (null while unknown);
 * `parentOf` gives any known folder's parent id, and the entry's own when its row carries none (the
 * Trash listing has no parent ids). `extraRootIds` (lower case) names older Backups folders that
 * are no longer the current root, such as a trashed one. Returns the same array when nothing is hidden.
 */
export function hideDeviceManifests<T extends { id: string; parent_id?: string | null; is_folder?: boolean }>(
  entries: T[],
  nameOf: (entry: T) => MaybeId,
  parentOf: (id: string) => MaybeId,
  extraRootIds?: ReadonlySet<string>,
): T[] {
  const kept = entries.filter((entry) => {
    if (entry.is_folder) return true;
    const name = nameOf(entry);
    if (name !== DEVICE_MANIFEST_NAME) return true;
    const parentId = entry.parent_id ?? parentOf(entry.id) ?? null;
    return !isDeviceManifest(name, parentId, parentId ? parentOf(parentId) : null, extraRootIds);
  });
  return kept.length === entries.length ? entries : kept;
}
