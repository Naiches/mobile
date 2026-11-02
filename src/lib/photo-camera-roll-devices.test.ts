// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { beforeEach, describe, expect, test } from 'bun:test';
import { resolveCameraRollDevices, resetCameraRollNameCacheForTests } from './photo-camera-roll-devices';

const folder = (id, parent, name) => ({ id, parent_id: parent, is_folder: true, name_encrypted: `enc:${name}` });
const decrypt = async (row) => (row.name_encrypted.startsWith('enc:') ? row.name_encrypted.slice(4) : null);

beforeEach(() => resetCameraRollNameCacheForTests());

describe('resolveCameraRollDevices', () => {
  const rows = [
    folder('root', null, 'Backups'),
    folder('d1', 'root', 'Anna iPhone'),
    folder('d1-cr', 'd1', 'Camera Roll'),
    folder('d1-ct', 'd1', 'Contacts'),
    folder('d2', 'root', 'iPad'),
    folder('d2-ct', 'd2', 'Contacts'),
    folder('d3', 'root', 'Old phone'),
    folder('d3-cr', 'd3', 'Camera Roll'),
    folder('mine', null, 'Camera Roll'),
    { id: 'file', parent_id: 'root', is_folder: false, name_encrypted: 'enc:x' },
  ];

  test('lists each device folder under the Backups root with its Camera Roll folder', async () => {
    const devices = await resolveCameraRollDevices({ rows, backupsRootId: 'root', decryptName: decrypt });
    expect(devices).toEqual([
      { id: 'd1', name: 'Anna iPhone', cameraRollFolderIds: ['d1-cr'] },
      { id: 'd3', name: 'Old phone', cameraRollFolderIds: ['d3-cr'] },
    ]);
  });

  test('a device with no Camera Roll folder yet is not a camera-roll device', async () => {
    const devices = await resolveCameraRollDevices({ rows, backupsRootId: 'root', decryptName: decrypt });
    expect(devices.map((d) => d.id)).not.toContain('d2');
  });

  test('a Camera Roll folder outside Backups is a plain Drive folder, not a camera-roll backup', async () => {
    const devices = await resolveCameraRollDevices({ rows, backupsRootId: 'root', decryptName: decrypt });
    expect(devices.flatMap((d) => d.cameraRollFolderIds)).not.toContain('mine');
  });

  test('no Backups root means no devices', async () => {
    expect(await resolveCameraRollDevices({ rows, backupsRootId: null, decryptName: decrypt })).toEqual([]);
  });

  test('duplicate Camera Roll folders of one device are all kept', async () => {
    const dup = [...rows, folder('d1-cr2', 'd1', 'Camera Roll')];
    const devices = await resolveCameraRollDevices({ rows: dup, backupsRootId: 'root', decryptName: decrypt });
    expect(devices[0].cameraRollFolderIds).toEqual(['d1-cr', 'd1-cr2']);
  });

  test('a name that will not decrypt is skipped, not fatal; names are decrypted once', async () => {
    let calls = 0;
    const flaky = async (row) => { calls += 1; return row.id === 'd3' ? null : decrypt(row); };
    const first = await resolveCameraRollDevices({ rows, backupsRootId: 'root', decryptName: flaky });
    expect(first.map((d) => d.id)).toEqual(['d1']);
    const callsAfterFirst = calls;
    await resolveCameraRollDevices({ rows, backupsRootId: 'root', decryptName: flaky });
    // only the one that failed is asked again
    expect(calls - callsAfterFirst).toBe(1);
  });

  test('the root id compares case-insensitively', async () => {
    const devices = await resolveCameraRollDevices({ rows, backupsRootId: 'ROOT', decryptName: decrypt });
    expect(devices).toHaveLength(2);
  });
});
