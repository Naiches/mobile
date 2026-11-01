/**
 * photo-sources-view: ties the pieces of the Photos tab's source choice
 * together: devices found in the folder tree, membership, the visible rows,
 * and the readable folder names and paths the screens show.
 */
import { onAccountEpochAdvance } from './account-epoch';
import { encryptedMetadataPayloadToBytes } from './encrypted-metadata';
import {
  resolveCameraRollDevices,
  type DeviceFolderRow,
} from './photo-camera-roll-devices';
import {
  applyPhotoSources,
  buildSourceMembership,
  type CameraRollDevice,
  type PhotoSources,
} from './photo-source-filter';

export type FolderNameDecryptor = (row: DeviceFolderRow) => Promise<string | null>;

export interface VisiblePhotos<T> {
  photos: T[];
  sourceById: Map<string, string[]>;
  devices: CameraRollDevice[];
}

export async function computeVisiblePhotos<T extends { id: string; parent_id?: string | null }>(args: {
  candidates: T[];
  /** Null when the server has no folder tree (legacy endpoint): nothing to filter by. */
  folders: DeviceFolderRow[] | null;
  sources: PhotoSources;
  backupsRootId: string | null;
  decryptName: FolderNameDecryptor;
}): Promise<VisiblePhotos<T>> {
  const { candidates, folders, sources, backupsRootId, decryptName } = args;
  if (!folders) return { photos: candidates, sourceById: new Map(), devices: [] };
  // Without the Backups root the camera-roll folders cannot be found. Showing
  // nothing would hide every photo, so show all media instead.
  if (!backupsRootId && sources.cameraRoll.enabled) {
    return { photos: candidates, sourceById: new Map(), devices: [] };
  }
  const devices = await resolveCameraRollDevices({ rows: folders, backupsRootId, decryptName });
  const membership = buildSourceMembership(folders, sources, devices);
  const { photos, sourceById } = applyPhotoSources(candidates, membership);
  return { photos, sourceById, devices };
}

const folderNameCache = new Map<string, string>();
// Plaintext names belong to the account that decrypted them.
onAccountEpochAdvance(() => folderNameCache.clear());

/** Decrypted names for the given folder ids (those that are still in the tree and readable). */
export async function resolveFolderNames(
  ids: string[],
  rows: DeviceFolderRow[],
  decryptName: FolderNameDecryptor,
): Promise<Map<string, string>> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = new Map<string, string>();
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) continue;
    const cached = folderNameCache.get(id);
    if (cached) { out.set(id, cached); continue; }
    let name: string | null = null;
    try { name = await decryptName(row); } catch { name = null; }
    if (name) {
      folderNameCache.set(id, name);
      out.set(id, name);
    }
  }
  return out;
}

const MAX_PATH_DEPTH = 64;

/** ['Drive', 'Camera', '2025']: names from the root down, ending safely on a cycle. */
export function buildFolderPath(
  id: string,
  rows: Array<{ id: string; parent_id?: string | null }>,
  names: ReadonlyMap<string, string>,
): string[] {
  const parentById = new Map(rows.map((r) => [r.id, r.parent_id ?? null]));
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current && !seen.has(current) && path.length < MAX_PATH_DEPTH) {
    seen.add(current);
    path.push(names.get(current) ?? 'Folder');
    current = parentById.get(current) ?? null;
  }
  return ['Drive', ...path.reverse()];
}

/** Plaintext of a folder name's metadata blob: {"name": "..."} or a bare name. */
export function folderNameFromPlaintext(plaintext: string): string | null {
  try {
    const meta = JSON.parse(plaintext) as { name?: unknown };
    if (meta && typeof meta === 'object' && typeof meta.name === 'string' && meta.name.trim()) {
      return meta.name.trim();
    }
  } catch {
    // Legacy format: plaintext is the bare folder name.
  }
  return plaintext.trim() || null;
}

/** A name decryptor over the vault's metadata key (`decryptMetadata` from the crypto context). */
export function makeFolderNameDecryptor(
  decryptMetadata: (id: string, nonce: Uint8Array, ciphertext: Uint8Array) => Promise<string>,
): FolderNameDecryptor {
  return async (row) => {
    const raw = row.name_encrypted ?? '';
    if (!raw.startsWith('{')) return raw.trim() || null;
    const payload = encryptedMetadataPayloadToBytes(raw);
    if (!payload) return null;
    return folderNameFromPlaintext(await decryptMetadata(row.id, payload.nonce, payload.ciphertext));
  };
}
