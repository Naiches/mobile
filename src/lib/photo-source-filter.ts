/**
 * photo-source-filter: which media rows the Photos tab shows, given the
 * sources the user chose. Pure and dependency-free.
 *
 * A source is either the camera-roll backups (the "Camera Roll" folder of each
 * chosen device under the protected Backups root) or a Drive folder the user
 * added. A folder source always includes its subfolders.
 *
 * Membership is computed once per tree change (`buildSourceMembership`: one
 * downward walk per source, a visited set per walk so cycles end) and applied
 * to rows with one map lookup each (`applyPhotoSources`). Nothing walks per row.
 */

export const CAMERA_ROLL_SOURCE = 'camera_roll';
export const ALL_SOURCES = 'all';

export interface CameraRollSource {
  enabled: boolean;
  /** 'all' = every device on the account, now and later; otherwise device folder ids. */
  devices: 'all' | string[];
}

export interface PhotoSources {
  cameraRoll: CameraRollSource;
  /** Drive folder ids. Names are encrypted, so ids only. */
  folders: string[];
}

export const DEFAULT_PHOTO_SOURCES: PhotoSources = {
  cameraRoll: { enabled: true, devices: 'all' },
  folders: [],
};

export interface SourceTreeRow {
  id: string;
  parent_id?: string | null;
  is_folder?: boolean;
  is_trashed?: boolean;
}

/** A device folder under the Backups root and its camera-roll folder(s). */
export interface CameraRollDevice {
  /** The device folder id. */
  id: string;
  name: string;
  /** Normally one; more than one only while duplicate folders await a merge. */
  cameraRollFolderIds: string[];
}

/** folder id -> keys of the sources it belongs to. */
export type SourceMembership = Map<string, string[]>;

function liveFolders(rows: SourceTreeRow[]): SourceTreeRow[] {
  return rows.filter((r) => r.is_folder && !r.is_trashed);
}

function selectedDevices(sources: PhotoSources, devices: CameraRollDevice[]): CameraRollDevice[] {
  if (!sources.cameraRoll.enabled) return [];
  const wanted = sources.cameraRoll.devices;
  if (wanted === 'all') return devices;
  const set = new Set(wanted);
  return devices.filter((d) => set.has(d.id));
}

export function buildSourceMembership(
  rows: SourceTreeRow[],
  sources: PhotoSources,
  devices: CameraRollDevice[],
): SourceMembership {
  const folders = liveFolders(rows);
  const folderIds = new Set(folders.map((f) => f.id));
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parent_id) continue;
    const list = children.get(f.parent_id);
    if (list) list.push(f.id);
    else children.set(f.parent_id, [f.id]);
  }

  const membership: SourceMembership = new Map();
  const mark = (key: string, rootIds: string[]) => {
    const visited = new Set<string>();
    const stack = rootIds.filter((id) => folderIds.has(id));
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const keys = membership.get(id);
      if (keys) {
        if (!keys.includes(key)) keys.push(key);
      } else {
        membership.set(id, [key]);
      }
      for (const child of children.get(id) ?? []) stack.push(child);
    }
  };

  mark(CAMERA_ROLL_SOURCE, selectedDevices(sources, devices).flatMap((d) => d.cameraRollFolderIds));
  for (const folderId of sources.folders) mark(folderId, [folderId]);
  return membership;
}

export interface PhotoSourceResult<T> {
  photos: T[];
  /** photo id -> source keys it belongs to (never empty). */
  sourceById: Map<string, string[]>;
}

/** Keeps the rows inside a chosen source, each once, in input order. */
export function applyPhotoSources<T extends { id: string; parent_id?: string | null }>(
  rows: T[],
  membership: SourceMembership,
): PhotoSourceResult<T> {
  const photos: T[] = [];
  const sourceById = new Map<string, string[]>();
  if (membership.size === 0) return { photos, sourceById };
  for (const row of rows) {
    const parent = row.parent_id;
    if (!parent) continue;
    const keys = membership.get(parent);
    if (!keys) continue;
    photos.push(row);
    sourceById.set(row.id, keys);
  }
  return { photos, sourceById };
}

/** For each folder source: is the folder still there (not deleted, not trashed)? */
export function sourceFolderStatus(rows: SourceTreeRow[], sources: PhotoSources): Map<string, boolean> {
  const live = new Set(liveFolders(rows).map((f) => f.id));
  return new Map(sources.folders.map((id) => [id, live.has(id)]));
}

export interface SourceChip {
  key: string;
  label: string;
}

/** Chips only when there is more than one source. */
export function buildSourceChips(sources: PhotoSources, folderNames: ReadonlyMap<string, string>): SourceChip[] {
  const count = (sources.cameraRoll.enabled ? 1 : 0) + sources.folders.length;
  if (count < 2) return [];
  const chips: SourceChip[] = [{ key: ALL_SOURCES, label: 'All' }];
  if (sources.cameraRoll.enabled) chips.push({ key: CAMERA_ROLL_SOURCE, label: 'Camera roll' });
  for (const id of sources.folders) chips.push({ key: id, label: folderNames.get(id) ?? 'Folder' });
  return chips;
}

/** One chip's view of the grid. The screen resets a chip that is no longer offered to All. */
export function filterBySourceKey<T extends { id: string }>(result: PhotoSourceResult<T>, key: string): T[] {
  if (key === ALL_SOURCES) return result.photos;
  return result.photos.filter((p) => result.sourceById.get(p.id)?.includes(key));
}
