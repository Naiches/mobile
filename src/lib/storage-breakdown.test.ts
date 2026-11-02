// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { describe, expect, test } from 'bun:test';
import { computeStorageBreakdown, findBackupsRoot, type BreakdownRow } from './storage-breakdown';

const folder = (id: string, parentId: string | null, name: string): BreakdownRow => ({ id, parentId, isFolder: true, size: 0, name });
const file = (id: string, parentId: string | null, size: number, name: string, extra: Partial<BreakdownRow> = {}): BreakdownRow => ({
  id, parentId, isFolder: false, size, name, ...extra,
});

const backupTree = [
  folder('root', null, 'Backups'),
  folder('dev', 'root', 'My iPhone'),
  folder('cam', 'dev', 'Camera Roll'),
  folder('con', 'dev', 'Contacts'),
  folder('cal', 'dev', 'Calendar'),
  folder('wa', 'dev', 'WhatsApp'),
  folder('misc', 'dev', 'Something else'),
  folder('sub', 'cam', '2026'),
];

describe('computeStorageBreakdown', () => {
  test('an empty account has zeros and no remainder', () => {
    const b = computeStorageBreakdown({ rows: [], backupsRootId: null, totalBytes: 0 });
    expect(b.byType.photosVideos).toEqual({ bytes: 0, count: 0 });
    expect(b.byType.documents).toEqual({ bytes: 0, count: 0 });
    expect(b.byType.other).toEqual({ bytes: 0, count: 0 });
    expect(b.backups.total).toEqual({ bytes: 0, count: 0 });
    expect(b.yourFiles).toEqual({ bytes: 0, count: 0 });
    expect(b.otherStorageBytes).toBe(0);
  });

  test('splits by type from the decrypted mime type, extension and the media flag', () => {
    const rows = [
      file('a', null, 100, 'x.bin', { mime: 'image/jpeg' }),
      file('b', null, 50, 'clip.mov'),
      file('c', null, 25, 'noname', { isMedia: true }),
      file('d', null, 10, 'report.pdf'),
      file('e', null, 20, 'notes', { mime: 'text/plain' }),
      file('f', null, 7, 'archive.zip'),
      file('g', null, 3, 'mystery'),
    ];
    const b = computeStorageBreakdown({ rows, backupsRootId: null, totalBytes: 215 });
    expect(b.byType.photosVideos).toEqual({ bytes: 175, count: 3 });
    expect(b.byType.documents).toEqual({ bytes: 30, count: 2 });
    expect(b.byType.other).toEqual({ bytes: 10, count: 2 });
    expect(b.otherStorageBytes).toBe(0);
  });

  test('backups are split by category folder, the rest is your files', () => {
    const rows = [
      ...backupTree,
      file('p1', 'cam', 1000, 'IMG_1.heic'),
      file('p2', 'sub', 500, 'IMG_2.heic'),
      file('c1', 'con', 40, 'contacts.vcf'),
      file('c2', 'cal', 60, 'calendar.ics'),
      file('w1', 'wa', 300, 'chat.zip'),
      file('m1', 'misc', 20, 'odd.dat'),
      file('man', 'dev', 5, '.device.json'),
      file('mine', null, 700, 'taxes.pdf'),
    ];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 2625 });
    expect(b.backups.cameraRoll).toEqual({ bytes: 1500, count: 2 });
    expect(b.backups.contactsCalendar).toEqual({ bytes: 100, count: 2 });
    expect(b.backups.whatsapp).toEqual({ bytes: 300, count: 1 });
    expect(b.backups.other).toEqual({ bytes: 25, count: 2 });
    expect(b.backups.total).toEqual({ bytes: 1925, count: 7 });
    expect(b.yourFiles).toEqual({ bytes: 700, count: 1 });
    expect(b.otherStorageBytes).toBe(0);
  });

  test('the manifest counts as backups even when its name is unknown', () => {
    const rows = [...backupTree, file('man', 'dev', 5, undefined)];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 5 });
    expect(b.backups.other).toEqual({ bytes: 5, count: 1 });
    expect(b.yourFiles.count).toBe(0);
  });

  test('the beebeeb Mail Backup subtree is other backup data, not a device', () => {
    const rows = [
      folder('root', null, 'Backups'),
      folder('mail', 'root', 'beebeeb Mail Backup'),
      // Account ids are opaque to mobile and can happen to match category names.
      folder('account', 'mail', 'Contacts'),
      folder('nested', 'account', 'Camera Roll'),
      file('bundle-a', 'account', 40, 'mail-1.zip'),
      file('bundle-b', 'nested', 60, 'mail-2.zip'),
    ];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 100 });
    expect(b.backups.other).toEqual({ bytes: 100, count: 2 });
    expect(b.backups.contactsCalendar).toEqual({ bytes: 0, count: 0 });
    expect(b.backups.cameraRoll).toEqual({ bytes: 0, count: 0 });
    expect(b.backups.total).toEqual({ bytes: 100, count: 2 });
    expect(b.yourFiles.count).toBe(0);
  });

  test('a file named like a category outside Backups is a normal file', () => {
    const rows = [...backupTree, folder('c2', null, 'Camera Roll'), file('x', 'c2', 9, 'a.jpg')];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 9 });
    expect(b.yourFiles).toEqual({ bytes: 9, count: 1 });
    expect(b.backups.total.count).toBe(0);
  });

  test('the remainder to the server total shows as Other storage, never negative', () => {
    const rows = [file('a', null, 100, 'a.pdf')];
    expect(computeStorageBreakdown({ rows, backupsRootId: null, totalBytes: 250 }).otherStorageBytes).toBe(150);
    expect(computeStorageBreakdown({ rows, backupsRootId: null, totalBytes: 40 }).otherStorageBytes).toBe(0);
    expect(computeStorageBreakdown({ rows, backupsRootId: null, totalBytes: null }).otherStorageBytes).toBe(0);
  });

  test('folder cycles terminate and do not count as backups', () => {
    const rows = [
      folder('a', 'b', 'Backups'),
      folder('b', 'a', 'Loop'),
      file('f', 'a', 12, 'x.txt'),
      folder('r', null, 'Backups'),
      folder('self', 'self', 'Self'),
      file('g', 'self', 4, 'y.txt'),
    ];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'r', totalBytes: 16 });
    expect(b.yourFiles).toEqual({ bytes: 16, count: 2 });
  });

  test('uploading rows, folders and negative sizes are ignored', () => {
    const rows = [file('u', null, 100, 'a.pdf', { uploading: true }), file('n', null, -5, 'b.pdf'), folder('f', null, 'F')];
    const b = computeStorageBreakdown({ rows, backupsRootId: null, totalBytes: 0 });
    expect(b.yourFiles.count).toBe(1);
    expect(b.yourFiles.bytes).toBe(0);
  });

  test('is fast on tens of thousands of rows', () => {
    const rows = [...backupTree];
    for (let i = 0; i < 60000; i++) rows.push(file(`f${i}`, i % 2 ? 'sub' : null, 10, `f${i}.jpg`));
    const t = performance.now();
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 600000 });
    expect(performance.now() - t).toBeLessThan(500);
    expect(b.backups.cameraRoll.count).toBe(30000);
  });
});

describe('account-wide WhatsApp folder', () => {
  test('a folder named WhatsApp directly under the Backups root counts as WhatsApp', () => {
    const rows = [
      folder('root', null, 'Backups'),
      folder('wa', 'root', 'WhatsApp'),
      folder('chat', 'wa', 'Family'),
      file('a', 'wa', 100, 'export.zip'),
      file('b', 'chat', 50, 'chat.zip'),
      folder('dev', 'root', 'My iPhone'),
      file('c', 'dev', 5, '.device.json'),
    ];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 155 });
    expect(b.backups.whatsapp).toEqual({ bytes: 150, count: 2 });
    expect(b.backups.other).toEqual({ bytes: 5, count: 1 });
    expect(b.yourFiles.count).toBe(0);
  });

  test('a WhatsApp folder elsewhere is not a backup', () => {
    const rows = [folder('root', null, 'Backups'), folder('wa', null, 'WhatsApp'), file('a', 'wa', 9, 'x.zip')];
    const b = computeStorageBreakdown({ rows, backupsRootId: 'root', totalBytes: 9 });
    expect(b.yourFiles).toEqual({ bytes: 9, count: 1 });
  });
});

describe('findBackupsRoot', () => {
  test('prefers the published id, else a top-level folder named Backups', () => {
    const rows = [folder('x', null, 'Backups'), folder('y', 'x', 'Backups'), folder('z', null, 'Other')];
    expect(findBackupsRoot(rows, 'Z')).toBe('z');
    expect(findBackupsRoot(rows, 'gone')).toBe('x');
    expect(findBackupsRoot(rows, null)).toBe('x');
    expect(findBackupsRoot([folder('y', 'x', 'Backups')], null)).toBeNull();
  });
});
