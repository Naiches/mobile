/**
 * photo-camera-roll-devices: how a row is recognised as a camera-roll backup.
 *
 * BackupService writes  Backups (protected root) > <device name> > Camera Roll > files.
 * Folder names are encrypted, so the device list is found by walking the folder
 * rows of the file index: device folders are the children of the Backups root,
 * and a device's camera-roll folder is its child whose decrypted name is the
 * category name. A "Camera Roll" folder anywhere else is an ordinary Drive folder.
 *
 * Decrypted names are cached by folder id for the session (a folder id's name
 * does not change underneath us, and a rename only matters for the label).
 */
import { onAccountEpochAdvance } from './account-epoch';
import type { CameraRollDevice, SourceTreeRow } from './photo-source-filter';

/** Must match CATEGORY_FOLDERS.camera_roll in BackupService. */
export const CAMERA_ROLL_FOLDER_NAME = 'Camera Roll';

export interface DeviceFolderRow extends SourceTreeRow {
  name_encrypted?: string;
}

const nameCache = new Map<string, string>();
// Plaintext names belong to the account that decrypted them.
onAccountEpochAdvance(() => nameCache.clear());

export function resetCameraRollNameCacheForTests(): void {
  nameCache.clear();
}

async function nameOf(
  row: DeviceFolderRow,
  decryptName: (row: DeviceFolderRow) => Promise<string | null>,
): Promise<string | null> {
  const cached = nameCache.get(row.id);
  if (cached !== undefined) return cached;
  let name: string | null = null;
  try { name = await decryptName(row); } catch { name = null; }
  if (name) nameCache.set(row.id, name);
  return name;
}

export async function resolveCameraRollDevices(args: {
  rows: DeviceFolderRow[];
  backupsRootId: string | null;
  decryptName: (row: DeviceFolderRow) => Promise<string | null>;
}): Promise<CameraRollDevice[]> {
  const { rows, backupsRootId, decryptName } = args;
  if (!backupsRootId) return [];
  const rootKey = backupsRootId.toLowerCase();
  const folders = rows.filter((r) => r.is_folder && !r.is_trashed);
  const childrenOf = new Map<string, DeviceFolderRow[]>();
  for (const f of folders) {
    if (!f.parent_id) continue;
    const key = f.parent_id.toLowerCase();
    const list = childrenOf.get(key);
    if (list) list.push(f);
    else childrenOf.set(key, [f]);
  }

  const devices: CameraRollDevice[] = [];
  for (const device of childrenOf.get(rootKey) ?? []) {
    const cameraRollFolderIds: string[] = [];
    for (const child of childrenOf.get(device.id.toLowerCase()) ?? []) {
      if ((await nameOf(child, decryptName)) === CAMERA_ROLL_FOLDER_NAME) cameraRollFolderIds.push(child.id);
    }
    if (cameraRollFolderIds.length === 0) continue;
    const name = await nameOf(device, decryptName);
    if (!name) continue;
    devices.push({ id: device.id, name, cameraRollFolderIds });
  }
  return devices;
}
