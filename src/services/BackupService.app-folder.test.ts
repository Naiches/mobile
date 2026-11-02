// @ts-nocheck
/**
 * `Backups › <App>` for shared chat exports: one folder per account, created on first use inside
 * the protected Backups root, reused afterwards, and merged when two devices create it at once.
 * Drives the real exported `ensureAppBackupFolder`; every dependency is mocked.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Task 2233: this service now reads installed app identity through appVersion().
mock.module('expo-constants', () => ({ default: { expoConfig: { version: '0.9.0' } } }));
mock.module('expo-application', () => ({ nativeApplicationVersion: '1.0.1', nativeBuildVersion: '8' }));

type Entry = { id: string; parent_id: string | null; is_folder: boolean; name_encrypted: string; created_at: string; size_bytes?: number };

let idCounter = 0;
const listings = new Map<string, Entry[]>();
const created: Array<{ parentId: string | undefined; id: string }> = [];
const readable = new Map<string, string>();
const moves: Array<{ id: string; parentId: string }> = [];
const renames: string[] = [];
const deleted: string[] = [];
const trashed: string[] = [];
const listedParents: string[] = [];

function sealed(id: string, parent: string | null, isFolder = true): Entry {
  return {
    id,
    parent_id: parent,
    is_folder: isFolder,
    name_encrypted: JSON.stringify({ nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUFBQUFBQUFBQUFBQUFBQUFBQUE=' }),
    created_at: '2026-09-26T11:05:57Z',
  };
}

function plaintext(id: string, parent: string | null, name: string, isFolder: boolean): Entry {
  return { id, parent_id: parent, is_folder: isFolder, name_encrypted: name, created_at: '2026-05-03T00:00:00Z' };
}

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
    multiRemove: async () => {},
    getAllKeys: async () => [],
  },
}));
mock.module('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///tmp/docs/',
  cacheDirectory: 'file:///tmp/cache/',
  writeAsStringAsync: async () => {},
  deleteAsync: async () => {},
}));
const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo-device', () => ({ deviceName: 'beebeeb Mail Backup', modelName: 'iPhone 17 Pro', osName: 'iOS', osVersion: '27.0' }));

mock.module('../lib/api', () => ({
  createFolder: async (_nameEncrypted: string, parentId: string | undefined, folderId: string) => {
    created.push({ parentId, id: folderId });
    await Promise.resolve();
    listings.set(parentId ?? 'root', [...(listings.get(parentId ?? 'root') ?? []), sealed(folderId, parentId ?? null)]);
    return { id: folderId, parent_id: parentId ?? null };
  },
  deleteFile: async (id: string) => { deleted.push(id); },
  downloadFile: async () => { throw new Error('not used'); },
  listAllFiles: async (parentId?: string) => {
    listedParents.push(parentId ?? 'root');
    return [...(listings.get(parentId ?? 'root') ?? [])];
  },
  findFile: async (parentId: string | undefined, match: (f: Entry) => boolean | Promise<boolean>) => {
    for (const f of listings.get(parentId ?? 'root') ?? []) {
      if (await match(f)) return f;
    }
    return undefined;
  },
  moveFile: async (id: string, parentId: string) => {
    moves.push({ id, parentId });
    for (const [parent, entries] of listings) {
      const at = entries.findIndex((e) => e.id === id);
      if (at >= 0) {
        const [entry] = entries.splice(at, 1);
        listings.set(parent, entries);
        listings.set(parentId, [...(listings.get(parentId) ?? []), { ...entry, parent_id: parentId }]);
      }
    }
  },
  renameFile: async (id: string) => { renames.push(id); },
  trashFiles: async (ids: string[]) => {
    trashed.push(...ids);
    for (const [parent, entries] of listings) listings.set(parent, entries.filter((e) => !ids.includes(e.id)));
    return { trashed: ids, already_trashed: [], missing: [] };
  },
  getFileIndex: async () => ({ changed: false }),
}));
// Task 1959: the reconcile reads the index through file-index-loader, whose
// cache module writes to the documents directory — keep it in memory here.
mock.module('../lib/file-index-cache', () => ({
  loadCachedFileIndex: async () => null,
  saveCachedFileIndex: async () => {},
  clearCachedFileIndex: async () => {},
  fileIndexCacheGeneration: () => 0,
  cachedFileIndexEpoch: () => undefined,
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  getContactsBackupStatus: async () => ({ hasKnownBackupState: false }),
  getCalendarBackupStatus: async () => ({ hasKnownBackupState: false }),
  resetContactsBackup: async () => {},
  resetCalendarBackup: async () => {},
  wakePhotoBackupDrain: async () => {},
}));
mock.module('../lib/encrypted-upload', () => ({
  encryptedUpload: async () => ({ id: 'manifest' }),
  generateFileId: async () => `new-${++idCounter}`,
}));
mock.module('./BackupDatabase', () => ({
  getAllUploadedRemoteIds: async () => new Set(),
  resetUploadedState: async () => 0,
}));
mock.module('../lib/offline-manager', () => ({
  offlineManager: { offlineFileIds: () => [], offlineFolderIds: () => [], removeFile: async () => {}, removeFolder: async () => {} },
}));
mock.module('../lib/thumbnail-cache', () => ({
  pruneThumbnailsForRemoteFiles: async () => {},
  invalidateCachedThumbnails: async () => {},
  invalidateNativeThumbnailCache: async () => {},
}));
mock.module('../lib/name-cache', () => ({ loadNameCache: async () => ({}), pruneNameCache: async () => {} }));
mock.module('../lib/device-identity', () => ({ getDeviceId: async () => 'device-1' }));
const traces: Array<{ name: string; fields: Record<string, unknown> }> = [];
mock.module('../lib/file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async () => 0,
  removeFromFileProviderCache: async () => {},
  setFileProviderProtectedBackupsRoot: async () => {},
}));
mock.module('../lib/runtime-trace', () => ({
  recordRuntimeTrace: (name: string, fields: Record<string, unknown> = {}) => { traces.push({ name, fields }); return null; },
}));


const {
  ensureAppBackupFolder,
  ensureBackupFolders,
  setBackupEncryption,
  updateDeviceManifest,
} = await import('./BackupService');

const names = (parent: string) => (listings.get(parent) ?? []).map((e) => readable.get(e.id));

beforeEach(() => {
  listings.clear();
  created.length = 0;
  readable.clear();
  moves.length = 0;
  renames.length = 0;
  deleted.length = 0;
  trashed.length = 0;
  listedParents.length = 0;
  secure.clear();
  idCounter = 0;
  setBackupEncryption({
    encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
    decryptChunkFn: async () => new Uint8Array(),
    // The folder name travels in the metadata; remember it so the listing can read it back.
    encryptMetadataFn: async (fileId: string, meta: string) => {
      readable.set(fileId, JSON.parse(meta).name);
      return { nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' };
    },
    decryptMetadataFn: async (fileId: string) => {
      const name = readable.get(fileId);
      if (name == null) throw new Error('decryption failed: ciphertext is invalid or key is wrong');
      return JSON.stringify({ name, mime_type: null });
    },
  });
});

function existingBackups() {
  listings.set('root', [sealed('backups', null)]);
  readable.set('backups', 'Backups');
  listings.set('backups', []);
}

describe('reserved mail backup folder', () => {
  test('repair and device cleanup leave it alone while repairing other duplicates', async () => {
    existingBackups();
    listings.set('backups', [
      { ...sealed('mail-old', 'backups'), created_at: '2026-09-01T00:00:00Z' },
      { ...sealed('mail-new', 'backups'), created_at: '2026-09-02T00:00:00Z' },
      { ...sealed('phone-old', 'backups'), created_at: '2026-09-01T00:00:00Z' },
      { ...sealed('phone-new', 'backups'), created_at: '2026-09-02T00:00:00Z' },
    ]);
    readable.set('mail-old', 'beebeeb Mail Backup');
    readable.set('mail-new', 'beebeeb Mail Backup');
    readable.set('phone-old', 'Other Phone');
    readable.set('phone-new', 'Other Phone');

    const opaqueMailFile = { ...sealed('opaque-mail-file', 'mail-new', false), size_bytes: 512 };
    const mailManifest = { ...sealed('mail-manifest', 'mail-old', false), size_bytes: 512 };
    readable.set('mail-manifest', '.device.json');
    listings.set('mail-old', [mailManifest]);
    listings.set('mail-new', [opaqueMailFile]);
    listings.set('phone-old', []);
    listings.set('phone-new', [plaintext('regular-child', 'phone-new', 'photo.jpg', false)]);

    const { deviceFolderId } = await ensureBackupFolders('camera_roll');
    await updateDeviceManifest({ keep_vault_unlocked: true });

    expect(deviceFolderId).not.toBe('mail-old');
    expect(deviceFolderId).not.toBe('mail-new');
    expect(readable.get(deviceFolderId)).toBe('beebeeb Mail Backup (Device)');
    expect(listedParents).not.toContain('mail-old');
    expect(listedParents).not.toContain('mail-new');
    expect(moves).not.toContainEqual({ id: 'opaque-mail-file', parentId: 'mail-old' });
    expect(trashed).not.toContain('mail-new');
    expect(deleted).not.toContain('opaque-mail-file');
    expect(deleted).not.toContain('mail-manifest');

    expect(moves).toContainEqual({ id: 'regular-child', parentId: 'phone-old' });
    expect(trashed).toContain('phone-new');
  });
});

describe('ensureAppBackupFolder', () => {
  test('creates Backups › WhatsApp on first use, then reuses it', async () => {
    existingBackups();
    const first = await ensureAppBackupFolder('WhatsApp');
    expect(created).toEqual([{ parentId: 'backups', id: first }]);
    expect(names('backups')).toEqual(['WhatsApp']);
    const second = await ensureAppBackupFolder('WhatsApp');
    expect(second).toBe(first);
    expect(created.length).toBe(1);
  });

  test('creates the Backups root too when the account has none yet', async () => {
    const id = await ensureAppBackupFolder('WhatsApp');
    expect(created.map((c) => c.parentId)).toEqual([undefined, created[0].id]);
    expect(created[1].id).toBe(id);
    expect(names('root')).toEqual(['Backups']);
  });

  test('concurrent first use ends with one folder', async () => {
    existingBackups();
    const ids = await Promise.all([ensureAppBackupFolder('WhatsApp'), ensureAppBackupFolder('WhatsApp'), ensureAppBackupFolder('WhatsApp')]);
    expect(new Set(ids).size).toBe(1);
    expect(names('backups')).toEqual(['WhatsApp']);
  });

  test('two devices creating it at the same moment end with one folder, and both get the same id', async () => {
    existingBackups();
    // The other device\'s copy is already there when this one looks again after creating its own.
    const other = { ...sealed('other-device-wa', 'backups'), created_at: '2026-09-26T10:00:00Z' };
    readable.set('other-device-wa', 'WhatsApp');
    listings.set('backups', []);
    const realList = listings.get.bind(listings);
    let first = true;
    listings.get = (key: string) => {
      const value = realList(key);
      if (key === 'backups' && value && value.some((e) => readable.get(e.id) === 'WhatsApp' && e.id !== 'other-device-wa') && first) {
        first = false;
        listings.set('backups', [...value, other]);
        return realList(key);
      }
      return value;
    };
    const id = await ensureAppBackupFolder('WhatsApp');
    expect(id).toBe('other-device-wa');
    expect(names('backups')).toEqual(['WhatsApp']);
  });

  test('a duplicate that already exists is merged into the oldest one', async () => {
    existingBackups();
    listings.set('backups', [
      { ...sealed('wa-new', 'backups'), created_at: '2026-09-27T00:00:00Z' },
      { ...sealed('wa-old', 'backups'), created_at: '2026-09-26T00:00:00Z' },
    ]);
    readable.set('wa-new', 'WhatsApp');
    readable.set('wa-old', 'WhatsApp');
    expect(await ensureAppBackupFolder('WhatsApp')).toBe('wa-old');
    expect(created).toEqual([]);
    expect(names('backups')).toEqual(['WhatsApp']);
  });
});
