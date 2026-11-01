// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { beforeEach, describe, expect, test } from 'bun:test';
import { resetCameraRollNameCacheForTests } from './photo-camera-roll-devices';
import { buildFolderPath, computeVisiblePhotos, resolveFolderNames } from './photo-sources-view';
import { DEFAULT_PHOTO_SOURCES } from './photo-source-filter';
import { advanceAccountEpoch } from './account-epoch';

const folder = (id, parent, name) => ({ id, parent_id: parent, is_folder: true, name_encrypted: `enc:${name}` });
const photo = (id, parent) => ({ id, parent_id: parent, is_folder: false, name_encrypted: 'x' });
const decryptName = async (row) => (row.name_encrypted.startsWith('enc:') ? row.name_encrypted.slice(4) : null);
beforeEach(() => resetCameraRollNameCacheForTests());

const folders = [
  folder('backups', null, 'Backups'), folder('phone', 'backups', 'Phone'), folder('cr', 'phone', 'Camera Roll'),
  folder('trips', null, 'Trips'), folder('t25', 'trips', '2025'),
];
const candidates = [photo('a', 'cr'), photo('b', 't25'), photo('c', 'trips'), photo('d', null)];

describe('computeVisiblePhotos', () => {
  test('defaults: only camera-roll backups, hand-uploaded media stays out', async () => {
    const out = await computeVisiblePhotos({ candidates, folders, sources: DEFAULT_PHOTO_SOURCES, backupsRootId: 'backups', decryptName });
    expect(out.photos.map((p) => p.id)).toEqual(['a']);
    expect(out.devices.map((d) => d.name)).toEqual(['Phone']);
  });

  test('adding a Drive folder brings in its subfolders', async () => {
    const sources = { ...DEFAULT_PHOTO_SOURCES, folders: ['trips'] };
    const out = await computeVisiblePhotos({ candidates, folders, sources, backupsRootId: 'backups', decryptName });
    expect(out.photos.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    expect(out.sourceById.get('b')).toEqual(['trips']);
  });

  test('no folder tree (legacy endpoint): everything shows, no source tags', async () => {
    const out = await computeVisiblePhotos({ candidates, folders: null, sources: DEFAULT_PHOTO_SOURCES, backupsRootId: null, decryptName });
    expect(out.photos).toBe(candidates);
    expect(out.sourceById.size).toBe(0);
  });

  test('Backups root not known: camera roll cannot be told apart, so all media shows', async () => {
    const out = await computeVisiblePhotos({ candidates, folders, sources: DEFAULT_PHOTO_SOURCES, backupsRootId: null, decryptName });
    expect(out.photos).toBe(candidates);
    expect(out.sourceById.size).toBe(0);
  });

  test('Backups root not known but camera roll off: only chosen folders show', async () => {
    const sources = { cameraRoll: { enabled: false, devices: 'all' }, folders: ['trips'] };
    const out = await computeVisiblePhotos({ candidates, folders, sources, backupsRootId: null, decryptName });
    expect(out.photos.map((p) => p.id).sort()).toEqual(['b', 'c']);
  });
});

describe('folder names and paths', () => {
  test('resolveFolderNames decrypts only the asked folders', async () => {
    const asked = [];
    const names = await resolveFolderNames(['t25', 'missing'], folders, async (row) => { asked.push(row.id); return decryptName(row); });
    expect([...names.entries()]).toEqual([['t25', '2025']]);
    expect(asked).toEqual(['t25']);
  });

  test('buildFolderPath walks up to Drive and ends on a cycle', () => {
    const rows = [{ id: 'a', parent_id: null }, { id: 'b', parent_id: 'a' }, { id: 'c', parent_id: 'b' }];
    const names = new Map([['a', 'Camera'], ['b', '2025'], ['c', 'Trip']]);
    expect(buildFolderPath('c', rows, names)).toEqual(['Drive', 'Camera', '2025', 'Trip']);
    const cyc = [{ id: 'x', parent_id: 'y' }, { id: 'y', parent_id: 'x' }];
    expect(buildFolderPath('x', cyc, new Map([['x', 'X'], ['y', 'Y']])).length).toBeLessThan(10);
  });

  test('an unreadable name shows as a plain label', () => {
    expect(buildFolderPath('a', [{ id: 'a', parent_id: null }], new Map())).toEqual(['Drive', 'Folder']);
  });
});

describe('decrypted folder names do not outlive the account', () => {
  test('folder names are decrypted again after the account epoch advances', async () => {
    advanceAccountEpoch();
    let calls = 0;
    const counting = async (row) => { calls += 1; return decryptName(row); };
    await resolveFolderNames(['t25'], folders, counting);
    await resolveFolderNames(['t25'], folders, counting);
    expect(calls).toBe(1);
    advanceAccountEpoch();
    await resolveFolderNames(['t25'], folders, counting);
    expect(calls).toBe(2);
  });

  test('camera-roll device names are decrypted again after the account epoch advances', async () => {
    let calls = 0;
    const counting = async (row) => { calls += 1; return decryptName(row); };
    const args = { candidates, folders, sources: DEFAULT_PHOTO_SOURCES, backupsRootId: 'backups', decryptName: counting };
    await computeVisiblePhotos(args);
    const first = calls;
    await computeVisiblePhotos(args);
    expect(calls).toBe(first);
    advanceAccountEpoch();
    await computeVisiblePhotos(args);
    expect(calls).toBe(first * 2);
  });
});
