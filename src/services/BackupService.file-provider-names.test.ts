// @ts-nocheck
/**
 * A backup folder the app creates reaches the shared File Provider cache with its decrypted
 * name. Without it the Files app lists the row as "Encrypted item" until the extension's own
 * refresh fills the name in.
 *
 * Drives the real exported `ensureBackupFolders`; every dependency is mocked.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Task 2233: this service now reads installed app identity through appVersion().
mock.module('expo-constants', () => ({ default: { expoConfig: { version: '0.9.0' } } }));
mock.module('expo-application', () => ({ nativeApplicationVersion: '1.0.1', nativeBuildVersion: '8' }));

type Entry = { id: string; parent_id: string | null; is_folder: boolean; name_encrypted: string; created_at: string };

// Folder listings by parent id ('root' = the vault root).
const listings = new Map<string, Entry[]>();
const created: Array<{ parentId: string | undefined; id: string }> = [];
// The names this (possibly wrong) key can read, by file id.
const readable = new Map<string, string>();

function sealed(id: string, parent: string | null): Entry {
  // A real encrypted-metadata envelope shape so the service tries to decrypt it.
  return {
    id,
    parent_id: parent,
    is_folder: true,
    name_encrypted: JSON.stringify({ nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'QUFBQUFBQUFBQUFBQUFBQUFBQUE=' }),
    created_at: '2026-09-26T11:05:57Z',
  };
}

// Task 1594 round 6 (Codex P1, BackupService.ts:440): a LEGACY PLAINTEXT
// folder name — `name_encrypted` is a bare string, not a `{nonce,ciphertext}`
// envelope, so `encryptedMetadataPayloadToBytes` returns null and the name is
// used as-is without ever calling `decryptMetadataFn`. This must never count
// as proof the currently-loaded key belongs to this account.
function plaintextLegacy(id: string, parent: string | null, name: string): Entry {
  return {
    id,
    parent_id: parent,
    is_folder: true,
    name_encrypted: name,
    created_at: '2020-01-01T00:00:00Z',
  };
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
mock.module('expo-file-system/legacy', () => ({ documentDirectory: 'file:///tmp/docs/', cacheDirectory: 'file:///tmp/cache/' }));
const secure = new Map<string, string>();
mock.module('expo-secure-store', () => ({
  getItemAsync: async (k: string) => secure.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { secure.set(k, v); },
  deleteItemAsync: async (k: string) => { secure.delete(k); },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo-device', () => ({ deviceName: 'bb-ios27', modelName: 'iPhone 17 Pro', osName: 'iOS', osVersion: '27.0' }));

mock.module('../lib/api', () => ({
  createFolder: async (_nameEncrypted: string, parentId: string | undefined, folderId: string) => {
    created.push({ parentId, id: folderId });
    return { id: folderId };
  },
  deleteFile: async () => {},
  downloadFile: async () => { throw new Error('not used'); },
  listAllFiles: async (parentId?: string) => listings.get(parentId ?? 'root') ?? [],
  findFile: async (parentId: string | undefined, match: (f: Entry) => boolean | Promise<boolean>) => {
    for (const f of listings.get(parentId ?? 'root') ?? []) {
      if (await match(f)) return f;
    }
    return undefined;
  },
  moveFile: async () => {},
  renameFile: async () => {},
  trashFiles: async () => {},
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
  generateFileId: async () => `new-${created.length + 1}`,
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
mock.module('../lib/runtime-trace', () => ({
  recordRuntimeTrace: (name: string, fields: Record<string, unknown> = {}) => { traces.push({ name, fields }); return null; },
}));

type PushCall = { files: Array<{ id: string; parent_id: string | null; is_folder: boolean }>; names: Record<string, string>; parentId: string | null | undefined };
const pushes: PushCall[] = [];
const removals: string[][] = [];
const published: Array<string | null> = [];
mock.module('../lib/file-provider-mount', () => ({
  syncDecryptedEntriesToFileProvider: async (files: PushCall['files'], names: Record<string, string>, parentId?: string | null) => {
    pushes.push({ files, names, parentId });
    return files.length;
  },
  removeFromFileProviderCache: async (ids: string[]) => { removals.push(ids); },
  setFileProviderProtectedBackupsRoot: async (id: string | null) => { published.push(id); },
}));

const { ensureBackupFolders, setBackupEncryption, resolveProtectedBackupsRoot } = await import('./BackupService');
const { isProtectedBackupsRoot, setProtectedBackupsRootId } = await import('../lib/protected-folders');

// Task 1594 round 2 (F2): fileIds in this set throw a non-decryption
// exception on their NEXT decrypt attempt only (then behave per `readable`),
// simulating a bridge/lifecycle fault (e.g. a released native handle) rather
// than a real wrong-key AEAD failure.
const flakyOnce = new Set<string>();

beforeEach(() => {
  listings.clear();
  created.length = 0;
  readable.clear();
  flakyOnce.clear();
  traces.length = 0;
  pushes.length = 0;
  removals.length = 0;
  published.length = 0;
  setProtectedBackupsRootId(null);
  secure.clear();
  setBackupEncryption({
    encryptChunkFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16) }),
    decryptChunkFn: async () => new Uint8Array(),
    encryptMetadataFn: async () => ({ nonce: new Uint8Array(12), ciphertext: new Uint8Array(16), cipherSuite: 'aes-256-gcm' }),
    // Decrypts only what this key "owns"; everything else fails like AES-GCM.
    decryptMetadataFn: async (fileId: string) => {
      if (flakyOnce.has(fileId)) {
        flakyOnce.delete(fileId);
        // NOT an auth-failure message — a bridge/lifecycle fault, e.g. a
        // released native handle mid-flight (BeebeebCryptoModule.getHandle's
        // "Invalid master key handle ID").
        throw new Error('Invalid master key handle ID: 3');
      }
      const name = readable.get(fileId);
      // The real (and only) native decrypt-failure message
      // (repos/core/beebeeb-core/src/error.rs `CoreError::Decryption`).
      if (name == null) throw new Error('decryption failed: ciphertext is invalid or key is wrong');
      return JSON.stringify({ name, mime_type: null });
    },
  });
});


describe('backup folders the app creates carry their decrypted name into the File Provider cache', () => {
  test('creating the tree pushes each new folder with its plain name and parent', async () => {
    await ensureBackupFolders('camera_roll');
    await Promise.resolve();

    const byId = new Map(pushes.flatMap((p) => p.files.map((f) => [f.id, p] as const)));
    const nameOf = (id: string) => byId.get(id)?.names[id];
    expect(created.length).toBe(5);
    expect(nameOf(created[0].id)).toBe('Backups');
    expect(nameOf(created[1].id)).toBe('bb-ios27');
    expect(created.slice(2).map((c) => nameOf(c.id)).sort()).toEqual(['Calendar', 'Camera Roll', 'Contacts']);
    expect(byId.get(created[0].id)?.parentId).toBeNull();
    expect(byId.get(created[1].id)?.parentId).toBe(created[0].id);
    expect(byId.get(created[0].id)?.files[0].is_folder).toBe(true);
  });

  test('reusing existing folders pushes nothing', async () => {
    listings.set('root', [sealed('backups-real', null)]);
    readable.set('backups-real', 'Backups');
    listings.set('backups-real', [sealed('device-a', 'backups-real')]);
    readable.set('device-a', 'bb-ios27');
    listings.set('device-a', [sealed('cam', 'device-a'), sealed('con', 'device-a'), sealed('cal', 'device-a')]);
    readable.set('cam', 'Camera Roll');
    readable.set('con', 'Contacts');
    readable.set('cal', 'Calendar');

    await ensureBackupFolders('camera_roll');
    expect(pushes).toEqual([]);
  });
});

function seedExistingTree() {
  listings.set('root', [sealed('backups-real', null), sealed('taxes', null)]);
  readable.set('backups-real', 'Backups');
  readable.set('taxes', 'Taxes');
  listings.set('backups-real', [sealed('device-a', 'backups-real')]);
  readable.set('device-a', 'bb-ios27');
  listings.set('device-a', [sealed('cam', 'device-a'), sealed('con', 'device-a'), sealed('cal', 'device-a')]);
  readable.set('cam', 'Camera Roll');
  readable.set('con', 'Contacts');
  readable.set('cal', 'Calendar');
}

describe('the root Backups folder is protected, by id', () => {
  test('ensureBackupFolders protects the root it resolved and tells the Files app extension', async () => {
    seedExistingTree();
    await ensureBackupFolders('camera_roll');
    expect(isProtectedBackupsRoot('backups-real')).toBe(true);
    expect(isProtectedBackupsRoot('taxes')).toBe(false);
    expect(isProtectedBackupsRoot('device-a')).toBe(false);
    expect(published).toContain('backups-real');
  });

  test('a freshly created root is protected too', async () => {
    await ensureBackupFolders('camera_roll');
    expect(isProtectedBackupsRoot(created[0].id)).toBe(true);
    expect(published).toContain(created[0].id);
  });

  test('on a device that never ran a backup, the existing root is found without creating anything', async () => {
    seedExistingTree();
    const id = await resolveProtectedBackupsRoot();
    expect(id).toBe('backups-real');
    expect(isProtectedBackupsRoot('backups-real')).toBe(true);
    expect(published).toEqual(['backups-real']);
    expect(created).toEqual([]);
  });

  test('with no Backups folder at all nothing is protected and nothing is created', async () => {
    listings.set('root', [sealed('taxes', null)]);
    readable.set('taxes', 'Taxes');
    expect(await resolveProtectedBackupsRoot()).toBeNull();
    expect(isProtectedBackupsRoot('taxes')).toBe(false);
    expect(created).toEqual([]);
  });

  test('a locked vault keeps whatever is already protected', async () => {
    setProtectedBackupsRootId('backups-real');
    setBackupEncryption(null);
    await resolveProtectedBackupsRoot();
    expect(isProtectedBackupsRoot('backups-real')).toBe(true);
  });
});
