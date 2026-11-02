// @ts-nocheck
import { beforeEach, describe, expect, test } from 'bun:test';
import { setProtectedBackupsRootId } from './protected-folders';
import { DEVICE_MANIFEST_NAME, hideDeviceManifests, isDeviceManifest } from './hidden-system-files';

beforeEach(() => setProtectedBackupsRootId(null));

// Tree: root(B) > device(D) > .device.json(m); and the user's own copies elsewhere.
const parents: Record<string, string | null> = { D: 'B', m: 'D', own: null, ownIn: 'T', T: null, deep: 'E', E: 'D' };
const parentOf = (id: string) => parents[id];

describe('isDeviceManifest', () => {
  test('a manifest in a device folder under the Backups root is hidden', () => {
    setProtectedBackupsRootId('B');
    expect(isDeviceManifest(DEVICE_MANIFEST_NAME, 'D', 'B')).toBe(true);
  });

  test('root id match ignores letter case', () => {
    setProtectedBackupsRootId('b');
    expect(isDeviceManifest('.device.json', 'D', 'B')).toBe(true);
  });

  test('a user file with the same name anywhere else is not hidden', () => {
    setProtectedBackupsRootId('B');
    expect(isDeviceManifest('.device.json', null, null)).toBe(false);
    expect(isDeviceManifest('.device.json', 'T', null)).toBe(false);
    expect(isDeviceManifest('.device.json', 'E', 'D')).toBe(false);
    expect(isDeviceManifest('.device.json', 'B', null)).toBe(false);
    expect(isDeviceManifest('.device.json', 'D', undefined)).toBe(false);
  });

  test('other names are never hidden, even in a device folder', () => {
    setProtectedBackupsRootId('B');
    expect(isDeviceManifest('device.json', 'D', 'B')).toBe(false);
    expect(isDeviceManifest('.device.json.bak', 'D', 'B')).toBe(false);
    expect(isDeviceManifest(null, 'D', 'B')).toBe(false);
  });

  test('before the root id is known the name alone decides', () => {
    expect(isDeviceManifest('.device.json', 'T', null)).toBe(true);
    expect(isDeviceManifest('notes.txt', 'T', null)).toBe(false);
  });
});

describe('hideDeviceManifests', () => {
  const rows = [
    { id: 'm', parent_id: 'D', is_folder: false },
    { id: 'own', parent_id: null, is_folder: false },
    { id: 'ownIn', parent_id: 'T', is_folder: false },
    { id: 'deep', parent_id: 'E', is_folder: false },
    { id: 'D', parent_id: 'B', is_folder: true },
  ];
  const names = { m: '.device.json', own: '.device.json', ownIn: '.device.json', deep: '.device.json', D: '.device.json' };
  const nameOf = (r) => names[r.id];

  test('drops only the real manifest once the root is known', () => {
    setProtectedBackupsRootId('B');
    expect(hideDeviceManifests(rows, nameOf, parentOf).map((r) => r.id)).toEqual(['own', 'ownIn', 'deep', 'D']);
  });

  test('before the root is known every file with that name is dropped, folders stay', () => {
    expect(hideDeviceManifests(rows, nameOf, parentOf).map((r) => r.id)).toEqual(['D']);
  });

  test('returns the same array when nothing is hidden', () => {
    const plain = [{ id: 'a', parent_id: null, is_folder: false }];
    expect(hideDeviceManifests(plain, () => 'a.txt', parentOf)).toBe(plain);
  });

  test('a row without a parent id (the Trash listing) takes it from the lookup', () => {
    setProtectedBackupsRootId('B');
    const bare = [{ id: 'm' }, { id: 'own' }];
    expect(hideDeviceManifests(bare, () => '.device.json', parentOf).map((r) => r.id)).toEqual(['own']);
  });

  test('an old Backups tree that is no longer the current root can be named by the caller', () => {
    setProtectedBackupsRootId('B');
    const old = { ...parents, oldDev: 'oldRoot', mOld: 'oldDev' };
    const rowsOld = [{ id: 'mOld', parent_id: 'oldDev', is_folder: false }];
    const lookup = (id: string) => old[id];
    expect(hideDeviceManifests(rowsOld, () => '.device.json', lookup).length).toBe(1);
    expect(hideDeviceManifests(rowsOld, () => '.device.json', lookup, new Set(['oldroot'])).length).toBe(0);
  });
});
