/**
 * Storage page breakdown, worked out ON THE PHONE from the decrypted file
 * index. The server only knows the total; names and types never leave the
 * device. Pure: no I/O, no React.
 *
 * Backups = everything under the protected Backups root (root -> device
 * folders -> category folders -> contents). Everything else is "your files".
 * Sizes come from the index; whatever the index does not account for (trash,
 * versions, previews) is reported as `otherStorageBytes` so the numbers never
 * contradict the server's total.
 */

import { isMailBackupFolderName } from './protected-backup-folders';

export interface BreakdownRow {
  id: string;
  parentId: string | null;
  isFolder: boolean;
  size: number;
  /** Decrypted name, when known. */
  name?: string | null;
  /** Decrypted MIME type, when known. */
  mime?: string | null;
  /** The server's media flag (image or video). */
  isMedia?: boolean;
  uploading?: boolean;
}

export interface Tally {
  bytes: number;
  count: number;
}

export interface StorageBreakdown {
  byType: { photosVideos: Tally; documents: Tally; other: Tally };
  backups: {
    cameraRoll: Tally;
    contactsCalendar: Tally;
    whatsapp: Tally;
    other: Tally;
    total: Tally;
  };
  yourFiles: Tally;
  /** Server total minus what the index accounts for (never negative). */
  otherStorageBytes: number;
}

type BackupBucket = 'cameraRoll' | 'contactsCalendar' | 'whatsapp' | 'other';

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

const BUCKET_BY_FOLDER_NAME: Record<string, BackupBucket> = {
  'camera roll': 'cameraRoll',
  contacts: 'contactsCalendar',
  calendar: 'contactsCalendar',
  whatsapp: 'whatsapp',
};

const DOC_EXT = new Set([
  'pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'md', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp',
  'key', 'pages', 'numbers', 'epub', 'html', 'htm', 'json', 'xml', 'yml', 'yaml', 'tex',
]);
const MEDIA_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff', 'dng', 'raw', 'cr2', 'nef', 'arw',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp',
]);

function extensionOf(name: string | null | undefined): string {
  const n = norm(name);
  const dot = n.lastIndexOf('.');
  return dot > 0 ? n.slice(dot + 1) : '';
}

type TypeBucket = 'photosVideos' | 'documents' | 'other';

function typeOf(row: BreakdownRow): TypeBucket {
  const mime = norm(row.mime);
  if (row.isMedia === true || mime.startsWith('image/') || mime.startsWith('video/')) return 'photosVideos';
  const ext = extensionOf(row.name);
  if (MEDIA_EXT.has(ext)) return 'photosVideos';
  if (
    mime === 'application/pdf' ||
    mime.startsWith('text/') ||
    mime.includes('officedocument') ||
    mime.includes('opendocument') ||
    mime.includes('msword') ||
    mime.includes('ms-excel') ||
    mime.includes('ms-powerpoint') ||
    mime === 'application/rtf' ||
    mime === 'application/epub+zip' ||
    mime === 'application/json'
  ) {
    return 'documents';
  }
  if (DOC_EXT.has(ext)) return 'documents';
  return 'other';
}

/**
 * The Backups root: the published protected id when it is in the index,
 * otherwise a top-level folder named "Backups".
 */
export function findBackupsRoot(rows: readonly BreakdownRow[], publishedId: string | null): string | null {
  if (publishedId) {
    const wanted = publishedId.toLowerCase();
    const hit = rows.find((r) => r.isFolder && r.id.toLowerCase() === wanted);
    if (hit) return hit.id;
  }
  const named = rows.find((r) => r.isFolder && r.parentId == null && norm(r.name) === 'backups');
  return named ? named.id : null;
}

const NONE = 'none' as const;
const ROOT = 'root' as const;
const DEVICE = 'device' as const;
type Zone = typeof NONE | typeof ROOT | typeof DEVICE | BackupBucket;

export function computeStorageBreakdown(input: {
  rows: readonly BreakdownRow[];
  backupsRootId: string | null;
  totalBytes: number | null;
}): StorageBreakdown {
  const { rows, backupsRootId, totalBytes } = input;
  const tally = (): Tally => ({ bytes: 0, count: 0 });
  const out: StorageBreakdown = {
    byType: { photosVideos: tally(), documents: tally(), other: tally() },
    backups: { cameraRoll: tally(), contactsCalendar: tally(), whatsapp: tally(), other: tally(), total: tally() },
    yourFiles: tally(),
    otherStorageBytes: 0,
  };

  const rootId = backupsRootId ? backupsRootId.toLowerCase() : null;
  const byId = new Map<string, BreakdownRow>();
  for (const r of rows) byId.set(r.id.toLowerCase(), r);

  // Folder membership, computed once per folder: walk up until a known folder,
  // the root, the top, or a cycle; then fill the walked path back down.
  const zones = new Map<string, Zone>();
  const zoneOfFolder = (startId: string): Zone => {
    const known = zones.get(startId);
    if (known) return known;
    const path: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = startId;
    let base: Zone = NONE;
    while (cur) {
      const hit = zones.get(cur);
      if (hit) { base = hit; break; }
      if (seen.has(cur)) { base = NONE; break; }
      seen.add(cur);
      path.push(cur);
      if (cur === rootId) { base = ROOT; path.pop(); zones.set(cur, ROOT); break; }
      const row = byId.get(cur);
      const parent = row?.parentId ? row.parentId.toLowerCase() : null;
      if (!row || parent == null || !byId.has(parent)) { base = NONE; break; }
      cur = parent;
    }
    // A cycle never reaches the root, so everything on the path is outside Backups.
    let zone: Zone = base;
    for (let i = path.length - 1; i >= 0; i--) {
      const id = path[i]!;
      let z: Zone;
      if (zone === NONE) z = NONE;
      else if (zone === ROOT) {
        const name = byId.get(id)?.name;
        z = isMailBackupFolderName(name) ? 'other' : norm(name) === 'whatsapp' ? 'whatsapp' : DEVICE;
      }
      else if (zone === DEVICE) z = BUCKET_BY_FOLDER_NAME[norm(byId.get(id)?.name)] ?? 'other';
      else z = zone;
      zones.set(id, z);
      zone = z;
    }
    return zones.get(startId) ?? NONE;
  };

  let indexed = 0;
  for (const row of rows) {
    if (row.isFolder || row.uploading) continue;
    const size = Number.isFinite(row.size) && row.size > 0 ? row.size : 0;
    indexed += size;

    const t = out.byType[typeOf(row)];
    t.bytes += size;
    t.count += 1;

    const parent = row.parentId ? row.parentId.toLowerCase() : null;
    const zone: Zone = parent && byId.has(parent) ? zoneOfFolder(parent) : NONE;
    if (zone === NONE) {
      out.yourFiles.bytes += size;
      out.yourFiles.count += 1;
      continue;
    }
    // Files directly under the root or a device folder (the manifest) are "other" backups.
    const bucket: BackupBucket = zone === ROOT || zone === DEVICE ? 'other' : zone;
    out.backups[bucket].bytes += size;
    out.backups[bucket].count += 1;
    out.backups.total.bytes += size;
    out.backups.total.count += 1;
  }

  out.otherStorageBytes = totalBytes != null && totalBytes > indexed ? totalBytes - indexed : 0;
  return out;
}
