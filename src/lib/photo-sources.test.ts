// @ts-nocheck — bun runs this; `bun:test` types aren't in the Expo tsconfig
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let prefs: Record<string, unknown> = {};
let strictError: Error | null = null;
const setCalls: Array<[string, unknown]> = [];
mock.module('./api', () => ({
  getPreferenceValueStrict: async (key: string) => { if (strictError) throw strictError; return prefs[key] ?? null; },
  setPreferenceValue: async (key: string, value: unknown) => { setCalls.push([key, value]); prefs[key] = value; },
}));

const s = await import('./photo-sources');
const { DEFAULT_PHOTO_SOURCES } = await import('./photo-source-filter');
beforeEach(() => { strictError = null; prefs = {}; setCalls.length = 0; });

describe('parsePhotoSources', () => {
  test('a valid value round-trips', () => {
    const value = { camera_roll: { enabled: false, devices: ['d1', 'd2'] }, folders: ['f1', 'f2'] };
    expect(s.parsePhotoSources(value)).toEqual({ cameraRoll: { enabled: false, devices: ['d1', 'd2'] }, folders: ['f1', 'f2'] });
  });

  test('unset or garbage gives the defaults: camera roll on for all devices, no folders', () => {
    for (const raw of [null, undefined, 5, 'x', [], true]) {
      expect(s.parsePhotoSources(raw)).toEqual(DEFAULT_PHOTO_SOURCES);
    }
    expect(DEFAULT_PHOTO_SOURCES).toEqual({ cameraRoll: { enabled: true, devices: 'all' }, folders: [] });
  });

  test('each invalid field falls back on its own', () => {
    expect(s.parsePhotoSources({ camera_roll: { enabled: 'yes', devices: 7 }, folders: 'f1' })).toEqual(DEFAULT_PHOTO_SOURCES);
    expect(s.parsePhotoSources({ camera_roll: { enabled: false }, folders: ['f1'] })).toEqual({
      cameraRoll: { enabled: false, devices: 'all' },
      folders: ['f1'],
    });
  });

  test('non-string and blank ids are dropped, duplicates collapse', () => {
    const parsed = s.parsePhotoSources({ camera_roll: { enabled: true, devices: ['d1', 3, '', 'd1', null] }, folders: ['f1', 9, ' ', 'f1', 'f2'] });
    expect(parsed.cameraRoll.devices).toEqual(['d1']);
    expect(parsed.folders).toEqual(['f1', 'f2']);
  });

  test('a JSON string (older stored shape) is parsed; broken JSON gives the defaults', () => {
    expect(s.parsePhotoSources(JSON.stringify({ camera_roll: { enabled: false, devices: 'all' }, folders: [] })).cameraRoll.enabled).toBe(false);
    expect(s.parsePhotoSources('{nope')).toEqual(DEFAULT_PHOTO_SOURCES);
  });

  test('returns a fresh object, never the shared default', () => {
    const a = s.parsePhotoSources(null);
    a.folders.push('x');
    expect(DEFAULT_PHOTO_SOURCES.folders).toEqual([]);
  });
});

describe('load and save', () => {
  test('load answers the defaults when unset', async () => {
    expect(await s.loadPhotoSources()).toEqual(DEFAULT_PHOTO_SOURCES);
  });

  test('save writes the photo_sources key with ids only, and load reads it back', async () => {
    const sources = { cameraRoll: { enabled: true, devices: ['d1'] }, folders: ['f1'] };
    await s.savePhotoSources(sources);
    expect(setCalls).toEqual([['photo_sources', { camera_roll: { enabled: true, devices: ['d1'] }, folders: ['f1'] }]]);
    expect(await s.loadPhotoSources()).toEqual(sources);
  });

  test('save writes the default devices as the string "all"', async () => {
    await s.savePhotoSources(DEFAULT_PHOTO_SOURCES);
    expect(setCalls[0][1]).toEqual({ camera_roll: { enabled: true, devices: 'all' }, folders: [] });
  });

  test('a read failure throws so the caller keeps what it had; it does not answer the defaults', async () => {
    strictError = new Error('offline');
    await expect(s.loadPhotoSources()).rejects.toThrow('offline');
  });

  test('add and remove helpers', () => {
    const base = DEFAULT_PHOTO_SOURCES;
    const added = s.withFolderAdded(base, 'f1');
    expect(added.folders).toEqual(['f1']);
    expect(s.withFolderAdded(added, 'f1').folders).toEqual(['f1']);
    expect(s.withFolderRemoved(added, 'f1').folders).toEqual([]);
    expect(base.folders).toEqual([]);
  });

  test('picking devices: all, then a subset, then all again', () => {
    const devices = ['d1', 'd2'];
    expect(s.withDeviceToggled(DEFAULT_PHOTO_SOURCES, 'd1', devices).cameraRoll.devices).toEqual(['d2']);
    const subset = s.withDeviceToggled(DEFAULT_PHOTO_SOURCES, 'd1', devices);
    // ticking the last missing device returns to "all" so new devices join automatically
    expect(s.withDeviceToggled(subset, 'd1', devices).cameraRoll.devices).toBe('all');
  });
});
