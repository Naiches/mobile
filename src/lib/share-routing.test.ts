// @ts-nocheck
/**
 * Where a file shared to Beebeeb lands. A chat export from a known app goes to Backups › <App>
 * (rules table, WhatsApp the only row); every other shared file keeps its normal destination.
 * Drives the real processPendingShares with the native bridge and the upload mocked.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const uploads: Array<{ name: string; parentId?: string }> = [];
let pending: Array<{ id: string; filename: string }> = [];
let parentMap: Record<string, string> = {};

mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('expo-file-system/legacy', () => ({ deleteAsync: async () => {} }));
mock.module('expo-file-system', () => ({
  File: class { exists = false; },
  Paths: { appleSharedContainers: {} },
}));
mock.module('../../modules/beebeeb-crypto', () => ({
  listPendingShares: async () => pending,
  consumePendingShare: async (id: string) => ({ uri: `file:///tmp/${id}`, filename: pending.find((p) => p.id === id)!.filename, mimeType: 'application/zip' }),
  acknowledgePendingShare: async () => {},
  clearAllPendingShares: async () => 0,
}));
mock.module('./encrypted-upload', () => ({
  encryptedUpload: async (args: { name: string; parentId?: string }) => { uploads.push({ name: args.name, parentId: args.parentId }); return { id: 'x' }; },
  generateFileId: async () => 'fid',
}));

const { matchShareRoute, shareImportMessage } = await import('./share-routing');
const { processPendingShares } = await import('../../plugins/share-extension/PendingSharesHandler');

const crypto = { vaultUnlocked: true, encryptChunkFn: async () => ({}), encryptMetadataFn: async () => ({}) } as never;

beforeEach(() => {
  uploads.length = 0;
  pending = [];
  parentMap = {};
});

describe('the rules table', () => {
  test('recognises WhatsApp chat exports by name, ignoring case', () => {
    for (const name of ['WhatsApp Chat - Family.zip', 'WhatsApp Chat - Anna B.txt', 'whatsapp chat - x.ZIP', 'WHATSAPP CHAT - X.TXT']) {
      expect(matchShareRoute(name)?.app).toBe('WhatsApp');
    }
  });

  test('other names are not routed', () => {
    for (const name of ['holiday.zip', 'WhatsApp Image 2026-01-01.jpg', 'WhatsApp Chat - Family.pdf', 'notes WhatsApp Chat - x.zip', 'WhatsApp Chat -.zip', '']) {
      expect(matchShareRoute(name)).toBeNull();
    }
  });
});

describe('processPendingShares routing', () => {
  test('a WhatsApp export goes to the app folder; another file is unchanged', async () => {
    pending = [{ id: 's1', filename: 'WhatsApp Chat - Family.zip' }, { id: 's2', filename: 'taxes.pdf' }];
    const resolved: string[] = [];
    const result = await processPendingShares({
      ...crypto,
      resolveAppFolder: async (app: string) => { resolved.push(app); return 'wa-folder'; },
    });
    expect(uploads).toEqual([
      { name: 'WhatsApp Chat - Family.zip', parentId: 'wa-folder' },
      { name: 'taxes.pdf', parentId: undefined },
    ]);
    expect(resolved).toEqual(['WhatsApp']);
    expect(result.uploaded).toBe(2);
    expect(result.routed).toEqual({ WhatsApp: 1 });
  });

  test('the folder is resolved once per app for several exports', async () => {
    pending = [{ id: 's1', filename: 'WhatsApp Chat - A.zip' }, { id: 's2', filename: 'WhatsApp Chat - B.txt' }];
    let calls = 0;
    const result = await processPendingShares({ ...crypto, resolveAppFolder: async () => { calls += 1; return 'wa-folder'; } });
    expect(calls).toBe(1);
    expect(uploads.map((u) => u.parentId)).toEqual(['wa-folder', 'wa-folder']);
    expect(result.routed).toEqual({ WhatsApp: 2 });
  });

  test('without a resolver, or when it fails, the export lands where it did before', async () => {
    pending = [{ id: 's1', filename: 'WhatsApp Chat - A.zip' }];
    const none = await processPendingShares({ ...crypto });
    expect(uploads[0].parentId).toBeUndefined();
    expect(none.routed).toEqual({});

    uploads.length = 0;
    pending = [{ id: 's2', filename: 'WhatsApp Chat - B.zip' }];
    const failed = await processPendingShares({ ...crypto, resolveAppFolder: async () => { throw new Error('locked'); } });
    expect(uploads).toEqual([{ name: 'WhatsApp Chat - B.zip', parentId: undefined }]);
    expect(failed.uploaded).toBe(1);
    expect(failed.routed).toEqual({});
  });
});

describe('the toast', () => {
  const base = { uploaded: 1, failed: 0, skipped: 0 };
  test('says where the file went', () => {
    expect(shareImportMessage({ ...base, routed: { WhatsApp: 1 } })).toBe('Saved to Backups › WhatsApp');
    expect(shareImportMessage({ ...base, uploaded: 2, routed: { WhatsApp: 2 } })).toBe('2 files saved to Backups › WhatsApp');
  });
  test('keeps the old wording when nothing was routed', () => {
    expect(shareImportMessage({ ...base, routed: {} })).toBe('1 file imported from share sheet');
    expect(shareImportMessage({ ...base, uploaded: 3, routed: {} })).toBe('3 files imported from share sheet');
  });
  test('mixes both when only some were routed', () => {
    expect(shareImportMessage({ ...base, uploaded: 3, routed: { WhatsApp: 1 } })).toBe('3 files imported from share sheet (1 saved to Backups › WhatsApp)');
  });
});
